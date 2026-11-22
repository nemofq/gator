import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../catalog/catalog.json";
import { encryptKey, keys } from "../src/crypto";
import { refresh } from "../src/snapshot";
import { bumpVersion, getState, invalidate, listProviders } from "../src/state";
import { instructions, summary } from "../src/text";
import { addProvider, mcp, readOnly, send, signIn, tool, unique } from "./helpers";
import { mockUpstream } from "./mock-upstream";

/** How many times the index's tool definitions were read through this spy. */
const toolReads = (prepare: { mock: { calls: unknown[][] } }) =>
  prepare.mock.calls.filter(([sql]) => String(sql).includes("json_group_array")).length;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("state", () => {
  it("reads D1 only when the version check is due, and reloads when the version changed", async () => {
    const ctx = createExecutionContext();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    invalidate();
    const first = await getState(env, ctx);
    const prepare = vi.spyOn(env.DB, "prepare");

    await env.DB.batch([bumpVersion(env.DB)]); // another isolate's dashboard write
    prepare.mockClear();
    clock.mockReturnValue(start + 10_000);
    expect(await getState(env, ctx)).toBe(first);
    expect(prepare).not.toHaveBeenCalled();

    clock.mockReturnValue(start + 20_000); // checked in the background, current state served
    expect(await getState(env, ctx)).toBe(first);
    await waitOnExecutionContext(ctx);
    expect(prepare).toHaveBeenCalled();
    const second = await getState(env, ctx);
    expect(second.version).toBe(first.version + 1);

    prepare.mockClear();
    clock.mockReturnValue(start + 100_000); // idle isolate: waits for the check; nothing changed
    expect(await getState(env, ctx)).toBe(second);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("summarises the providers the index lists, without building it", async () => {
    const { id, host } = unique();
    const keyless = unique();
    const auth = { header: "X-Key", format: "{key}" };
    mockUpstream({ [host]: { era: "stateless", tools: [readOnly("look")] } });
    await addProvider(id, host);
    await addProvider(keyless.id, keyless.host, { auth }); // enabled, but needs a key it lacks
    await refresh(env, id);
    // A tool of the provider without its key, so the index can show that it holds that provider.
    await env.DB.prepare(
      `INSERT INTO tools (provider_id, name, enabled, approved, approved_hash, latest_hash)
       VALUES (?, 'look', 1, '{"description":"d","input_schema":{"type":"object"}}', 'h', 'h')`,
    )
      .bind(keyless.id)
      .run();
    const prepare = vi.spyOn(env.DB, "prepare");
    const state = await getState(env, createExecutionContext());
    expect(toolReads(prepare)).toBe(0);
    const [search] = JSON.parse(state.toolList);
    expect(search.description).toContain(`Data from ${id} (${id})`);
    expect(state.instructions).not.toContain(keyless.id);

    const index = await state.indexed();
    const listed = JSON.parse(index.search("", undefined, 1)).providers;
    expect(state.instructions).toBe(instructions(summary(listed)));
    expect(JSON.parse(index.describe(`${keyless.id}.look`))).toMatchObject({
      error: "missing_key",
    });
  });

  it("builds the index on first use, once per state version, and keeps the previous one usable", async () => {
    const { id, host } = unique();
    mockUpstream({ [host]: { era: "stateless", tools: [readOnly("look")] } });
    await addProvider(id, host);
    await refresh(env, id);
    const prepare = vi.spyOn(env.DB, "prepare");
    const first = await getState(env, createExecutionContext());
    expect(toolReads(prepare)).toBe(0);
    expect((await tool("search_tools", { query: "look", provider: id })).content[0].text).toContain(
      `"${id}.look"`,
    );
    expect((await tool("describe_tool", { id: `${id}.look` })).isError).toBeUndefined();
    expect(toolReads(prepare)).toBe(1);
    const index = await first.indexed();

    await env.DB.batch([bumpVersion(env.DB)]);
    invalidate();
    const second = await getState(env, createExecutionContext());
    expect(second.version).toBe(first.version + 1);
    expect(toolReads(prepare)).toBe(1);
    await tool("search_tools", { query: "look" });
    expect(toolReads(prepare)).toBe(2);
    expect(await second.indexed()).not.toBe(index);
    const found = JSON.parse(index.search("look", id, 5));
    expect(found.tools.map((t: { id: string }) => t.id)).toEqual([`${id}.look`]);
  });

  it("does not read the index for initialize, tools/list or a dashboard route", async () => {
    const { cookie } = await signIn();
    invalidate();
    const prepare = vi.spyOn(env.DB, "prepare");
    const initialize = { protocolVersion: "2025-11-25", capabilities: {} };
    expect(
      (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize })).status,
    ).toBe(200);
    expect((await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(200);
    invalidate();
    expect((await send("/api/session", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(prepare).toHaveBeenCalled();
    expect(toolReads(prepare)).toBe(0);
  });

  it("fails only the tools while the index cannot be built, and builds it on the next use", async () => {
    const { id, host } = unique();
    mockUpstream({ [host]: { era: "stateless", tools: [readOnly("look")] } });
    await addProvider(id, host);
    await refresh(env, id);
    const approved = env.DB.prepare("UPDATE tools SET approved = ? WHERE provider_id = ?");
    const good = await env.DB.prepare("SELECT approved FROM tools WHERE provider_id = ?")
      .bind(id)
      .first<string>("approved");
    await approved.bind("not json", id).run();
    invalidate();
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    await expect(tool("search_tools", { query: "look" })).rejects.toThrow();
    await approved.bind(good, id).run();
    expect((await tool("search_tools", { query: "look" })).content[0].text).toContain(
      `"${id}.look"`,
    );
  });
});

describe("a changed MASTER_KEY", () => {
  it("makes the key count as missing, deletes nothing and throws nothing", async () => {
    const { id, host } = unique();
    mockUpstream({ [host]: { era: "stateless", tools: [readOnly("look")] } });
    await addProvider(id, host, { key: "secret-1234", auth: { header: "X-Key", format: "{key}" } });
    await refresh(env, id);
    const other = await keys({ ...env, MASTER_KEY: "e".repeat(64) });
    await env.DB.prepare("UPDATE providers SET key = ?, key_check = ? WHERE id = ?")
      .bind(await encryptKey(other, id, "secret-1234"), other.check, id)
      .run();
    invalidate();
    const state = await getState(env, createExecutionContext());
    expect(state.keys.has(id)).toBe(false);
    expect(await tool("call_tool", { id: `${id}.look` })).toEqual({
      content: [
        { type: "text", text: `No API key is set for Name ${id}. Add one in the Gator dashboard.` },
      ],
      isError: true,
    });
    const provider = (await listProviders(env)).find((p) => p.id === id);
    expect(provider).toMatchObject({ key_ok: false, key_last4: "1234", enabled: true });
    expect(
      await env.DB.prepare("SELECT key FROM providers WHERE id = ?").bind(id).first("key"),
    ).not.toBeNull();
  });
});

describe("listProviders", () => {
  it("lists the catalog in order, then custom providers, without keys", async () => {
    const { id, host } = unique("z");
    await addProvider(id, host, {
      key: "abcd-5678",
      auth: { header: "X-Key", format: "{key}" },
      enabled: false,
    });
    const providers = await listProviders(env);
    expect(providers.slice(0, catalog.length).map((p) => p.id)).toEqual(catalog.map((m) => m.id));
    const mine = providers.find((p) => p.id === id);
    expect(mine).toEqual({
      id,
      name: `Name ${id}`,
      description: `Data from ${id}`,
      mcp_url: `https://${host}/mcp`,
      auth: { header: "X-Key", format: "{key}" },
      category: [],
      read_only: false,
      key_required: true,
      custom: true,
      enabled: false,
      key_last4: "5678",
      key_ok: true,
      timeout_ms: null,
      refreshed_at: null,
      refresh_error: null,
      tools: { total: 0, enabled: 0, changed: 0, new: 0 },
      backup_last4: null,
      backup_ok: true,
      on_backup: false,
      switched_at: null,
      key_same: false,
      review: false,
      status: "off",
      status_reason: null,
    });
    expect(JSON.stringify(providers)).not.toContain("abcd-5678");
    const tavily = providers.find((p) => p.id === "tavily");
    expect(tavily).toMatchObject({ custom: false, enabled: false, key_last4: null, key_ok: true });
    expect(tavily).not.toHaveProperty("default_enabled_tools");
  });
});
