import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refresh } from "../src/snapshot";
import { catalog, getState, invalidate } from "../src/state";
import { addProvider, readOnly, tool, unique } from "./helpers";
import { mockUpstream, type Server } from "./mock-upstream";

const PRIMARY = "primary-key-0001";
const BACKUP = "backup-key-0002";
const AUTH = { header: "X-Key", format: "{key}" };

let servers: Record<string, Server>;
let mock: ReturnType<typeof mockUpstream>;
beforeEach(() => {
  servers = {};
  mock = mockUpstream(servers);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  catalog.splice(catalogLength);
});
const catalogLength = catalog.length;

/** A provider with both keys and its tool list; `refused` maps a key to the status it gets. */
async function provider(refused: Record<string, number> = {}, onlyFor?: string) {
  const { id, host } = unique("b");
  servers[host] = {
    era: "session",
    tools: [readOnly("look")],
    refuse: (headers, method) =>
      onlyFor && method !== onlyFor ? undefined : refused[String(headers.get("X-Key"))],
  };
  await addProvider(id, host, { key: PRIMARY, backup: BACKUP, auth: AUTH });
  return { id, host, refused };
}

const row = (id: string) =>
  env.DB.prepare("SELECT on_backup, switched_at FROM providers WHERE id = ?")
    .bind(id)
    .first<{ on_backup: number; switched_at: number | null }>();
const version = () =>
  env.DB.prepare("SELECT value FROM settings WHERE key = 'version'").first<string>("value");
const lastCall = () =>
  env.DB.prepare("SELECT status, backup FROM calls ORDER BY id DESC LIMIT 1").first();
/** What the upstream saw for this host: method, key and session of each request. */
const sent = (host: string) =>
  mock.log
    .filter((e) => e.host === host)
    .map((e) => [e.method, e.headers.get("X-Key"), e.headers.get("Mcp-Session-Id")]);

async function ready(id: string) {
  expect(await refresh(env, id)).toBeNull();
  invalidate();
  mock.log.length = 0;
}

describe("the backup key", () => {
  for (const status of [429, 402]) {
    it(`takes over on ${status}: one repeat on a fresh connection, then it stays in use`, async () => {
      const { id, host, refused } = await provider();
      await ready(id);
      await tool("call_tool", { id: `${id}.look` }); // on the primary's session from the refresh
      const before = await version();
      refused[PRIMARY] = status;
      expect(await tool("call_tool", { id: `${id}.look` })).toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      expect(sent(host)).toEqual([
        ["tools/call", PRIMARY, "session-1"],
        ["tools/call", PRIMARY, "session-1"],
        ["initialize", BACKUP, null],
        ["notifications/initialized", BACKUP, "session-2"],
        ["tools/call", BACKUP, "session-2"],
      ]);
      expect(await row(id)).toMatchObject({ on_backup: 1, switched_at: expect.any(Number) });
      expect(await version()).toBe(before);
      expect(await lastCall()).toEqual({ status: "ok", backup: 1 });

      mock.log.length = 0;
      await tool("call_tool", { id: `${id}.look` });
      expect(sent(host)).toEqual([["tools/call", BACKUP, "session-2"]]);
    });
  }

  it("is not used on 401 or 403: a wrong key is shown, not papered over", async () => {
    for (const status of [401, 403]) {
      const { id, host } = await provider({ [PRIMARY]: status }, "tools/call");
      await ready(id);
      const result = await tool("call_tool", { id: `${id}.look` });
      expect(result.content[0].text).toMatch(/rejected its API key/);
      expect(sent(host).map(([, key]) => key)).not.toContain(BACKUP);
      expect(await row(id)).toEqual({ on_backup: 0, switched_at: null });
      expect(await lastCall()).toEqual({ status: "auth", backup: 0 });
    }
  });

  it("switches once: when both keys are refused the agent gets the quota error", async () => {
    const { id, host, refused } = await provider();
    await ready(id);
    refused[PRIMARY] = 429;
    refused[BACKUP] = 402;
    expect(await tool("call_tool", { id: `${id}.look` })).toEqual({
      content: [
        {
          type: "text",
          text: `Name ${id} says its rate limit or quota is used up. Try again later.`,
        },
      ],
      isError: true,
    });
    expect(sent(host).map(([method, key]) => [method, key])).toEqual([
      ["tools/call", PRIMARY],
      ["initialize", BACKUP],
    ]);
    expect(await lastCall()).toEqual({ status: "rate_limited", backup: 1 });
    expect((await row(id))?.on_backup).toBe(1);
  });

  it("switches harmlessly again in an isolate that has not seen the switch, and follows D1 at its next load", async () => {
    const { id, host, refused } = await provider();
    await ready(id);
    refused[PRIMARY] = 429;
    await tool("call_tool", { id: `${id}.look` });
    const switched = await row(id);
    expect(switched?.on_backup).toBe(1);

    // A second isolate: the same loaded state, with its in-memory choice still the primary, while
    // D1 already says backup. (The test pool runs one isolate, so the other one is simulated.)
    const state = await getState(env, createExecutionContext());
    const keys = state.keys.get(id);
    if (!keys) throw new Error("no keys");
    keys.onBackup = false;
    mock.log.length = 0;
    // A later clock, so a second write would show in switched_at.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
    expect((await tool("call_tool", { id: `${id}.look` })).content[0].text).toBe("ok");
    expect(sent(host).map(([method, key]) => [method, key])).toEqual([
      ["tools/call", PRIMARY],
      ["initialize", BACKUP],
      ["notifications/initialized", BACKUP],
      ["tools/call", BACKUP],
    ]);
    // The write changed nothing: the row already said backup.
    expect(await row(id)).toEqual(switched);
    expect(await lastCall()).toEqual({ status: "ok", backup: 1 });

    // At its next state load the isolate takes D1's choice and asks the backup first.
    keys.onBackup = false;
    invalidate();
    mock.log.length = 0;
    await tool("call_tool", { id: `${id}.look` });
    expect(sent(host).map(([method, key]) => [method, key])).toEqual([["tools/call", BACKUP]]);
  });

  it("ends on the backup when concurrent calls are refused with the primary", async () => {
    const { id, host, refused } = await provider();
    await ready(id);
    await getState(env, createExecutionContext()); // loaded once, as in a warm isolate
    refused[PRIMARY] = 429;
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => tool("call_tool", { id: `${id}.look` })),
    );
    expect(results.map((r) => r.content[0].text)).toEqual(["ok", "ok", "ok", "ok"]);
    expect((await getState(env, createExecutionContext())).keys.get(id)?.onBackup).toBe(true);
    mock.log.length = 0;
    await tool("call_tool", { id: `${id}.look` });
    expect(sent(host).map(([method, key]) => [method, key])).toEqual([["tools/call", BACKUP]]);
  });

  it("is used when a refresh is refused for quota, and the switch is written before it returns", async () => {
    const { id, host } = await provider({ [PRIMARY]: 429 }, "tools/list");
    const before = await version();
    expect(await refresh(env, id)).toBeNull();
    expect(sent(host).map(([method, key]) => [method, key])).toEqual([
      ["initialize", PRIMARY],
      ["notifications/initialized", PRIMARY],
      ["tools/list", PRIMARY],
      ["initialize", BACKUP],
      ["notifications/initialized", BACKUP],
      ["tools/list", BACKUP],
    ]);
    expect((await row(id))?.on_backup).toBe(1);
    // The new tools bump the version once; the switch adds nothing.
    expect(Number(await version())).toBe(Number(before) + 1);
  });

  it("stays unused while the primary works, and a provider with one key never switches", async () => {
    const { id, host } = await provider();
    await ready(id);
    await tool("call_tool", { id: `${id}.look` });
    expect(sent(host).map(([, key]) => key)).not.toContain(BACKUP);

    const single = unique("b");
    servers[single.host] = {
      era: "stateless",
      tools: [readOnly("look")],
      refuse: (_, method) => (method === "tools/call" ? 429 : undefined),
    };
    await addProvider(single.id, single.host, { key: PRIMARY, auth: AUTH });
    await ready(single.id);
    const result = await tool("call_tool", { id: `${single.id}.look` });
    expect(result.content[0].text).toMatch(/rate limit or quota is used up/);
    expect(sent(single.host).filter(([method]) => method === "tools/call")).toHaveLength(1);
    expect(await lastCall()).toEqual({ status: "rate_limited", backup: 0 });
  });
});

const SIGNAL = "Test plan allowance used up";
/** A short result that carries the signal, as a provider might send for an exhausted key. */
const refusal = (isError?: boolean) => ({
  content: [{ type: "text", text: `{"error":"Request failed","detail":"${SIGNAL}."}` }],
  ...(isError === undefined ? {} : { isError }),
});
const details = () =>
  env.DB.prepare("SELECT status, backup, detail FROM calls ORDER BY id DESC LIMIT 1").first();

/**
 * A provider the test adds to the catalog, declaring SIGNAL unless `signals` is false. Its answer
 * to `tools/call` depends on the key; a key with no answer gets "ok".
 */
async function signalled(options: { backup?: boolean; signals?: boolean } = {}) {
  const { id, host } = unique("q");
  const answers: Record<string, unknown> = {};
  catalog.push({
    id,
    name: `Name ${id}`,
    description: `Data from ${id}`,
    mcp_url: `https://${host}/mcp`,
    read_only: true,
    auth: AUTH,
    ...(options.signals === false ? {} : { quota_signals: [SIGNAL] }),
  });
  servers[host] = {
    era: "session",
    tools: [readOnly("look")],
    call: (_, __, headers) => answers[String(headers.get("X-Key"))],
  };
  const backup = options.backup === false ? undefined : BACKUP;
  await addProvider(id, host, { key: PRIMARY, backup, auth: AUTH, catalog: true });
  await ready(id);
  return { id, host, answers };
}

describe("quota signals", () => {
  for (const isError of [false, true]) {
    it(`treat a short result with a signal as a 429 (isError ${isError}): switch, repeat once, answer`, async () => {
      const { id, host, answers } = await signalled();
      answers[PRIMARY] = refusal(isError);
      expect(await tool("call_tool", { id: `${id}.look` })).toEqual({
        content: [{ type: "text", text: "ok" }],
      });
      expect(sent(host).map(([method, key]) => [method, key])).toEqual([
        ["tools/call", PRIMARY],
        ["initialize", BACKUP],
        ["notifications/initialized", BACKUP],
        ["tools/call", BACKUP],
      ]);
      expect(await details()).toEqual({ status: "ok", backup: 1, detail: null });
      expect((await row(id))?.on_backup).toBe(1);
    });
  }

  it("give the quota sentence, not the provider's text, without a backup, and record the text", async () => {
    const { id, answers } = await signalled({ backup: false });
    answers[PRIMARY] = refusal(false);
    expect(await tool("call_tool", { id: `${id}.look` })).toEqual({
      content: [
        {
          type: "text",
          text: `Name ${id} says its rate limit or quota is used up. Try again later.`,
        },
      ],
      isError: true,
    });
    expect(await details()).toEqual({
      status: "rate_limited",
      backup: 0,
      detail: refusal().content[0].text,
    });
  });

  it("leave a long result with the signal, a provider without signals, and a custom provider alone", async () => {
    const long = { content: [{ type: "text", text: `${SIGNAL} ${"x".repeat(2_000)}` }] };
    const first = await signalled();
    first.answers[PRIMARY] = long;
    expect(await tool("call_tool", { id: `${first.id}.look` })).toEqual(long);

    const plain = await signalled({ signals: false });
    plain.answers[PRIMARY] = refusal(false);
    expect(await tool("call_tool", { id: `${plain.id}.look` })).toEqual(refusal());

    // A stored custom manifest that carries the field is not read for it.
    const custom = await provider();
    await env.DB.prepare(
      "UPDATE providers SET manifest = json_set(manifest, '$.quota_signals', json_array(?)) WHERE id = ?",
    )
      .bind(SIGNAL, custom.id)
      .run();
    await ready(custom.id);
    servers[custom.host].call = () => refusal(false);
    expect(await tool("call_tool", { id: `${custom.id}.look` })).toEqual(refusal());

    for (const { host } of [first, plain, custom]) {
      expect(sent(host).map(([, key]) => key)).not.toContain(BACKUP);
    }
    expect(await details()).toEqual({ status: "ok", backup: 0, detail: null });
  });
});

describe("the detail of a failed call", () => {
  it("is the short text of a tool error or an upstream error, cut at a word with the cut recorded, and nothing else", async () => {
    const { id, host } = await provider();
    await ready(id);
    const recorded = async (answer: unknown, toolId = `${id}.look`) => {
      servers[host].call = () => answer;
      await tool("call_tool", { id: toolId });
      return details();
    };
    expect(
      await recorded({ content: [{ type: "text", text: "No such video." }], isError: true }),
    ).toEqual({ status: "tool_error", backup: 0, detail: "No such video." });
    const capped = () =>
      env.DB.prepare("SELECT detail_capped FROM calls ORDER BY id DESC LIMIT 1").first(
        "detail_capped",
      );
    expect(await capped()).toBe(0);
    const error = Response.json({ error: { message: "e".repeat(400) } }, { status: 500 });
    expect(await recorded(error)).toEqual({
      status: "upstream_error",
      backup: 0,
      detail: "e".repeat(300),
    });
    expect(await capped()).toBe(1);
    const text = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });
    // Back to the last word that fits; but not 40+ characters back, as inside a long URL.
    expect((await recorded(text("word ".repeat(70))))?.detail).toBe("word ".repeat(60).trimEnd());
    const url = `see https://example.com/${"a".repeat(400)}`;
    expect((await recorded(text(url)))?.detail).toBe(url.slice(0, 300));
    expect(await capped()).toBe(1);
    expect((await recorded(text("s".repeat(300))))?.detail).toBe("s".repeat(300));
    expect(await capped()).toBe(0);
    const long = { content: [{ type: "text", text: "x".repeat(2_001) }], isError: true };
    expect((await recorded(long))?.detail).toBeNull();
    expect((await recorded({ content: [{ type: "text", text: "fine" }] }))?.detail).toBeNull();
    expect((await recorded(undefined, `${id}.missing`)) as object).toEqual({
      status: "unknown_tool",
      backup: 0,
      detail: null,
    });
  });
});
