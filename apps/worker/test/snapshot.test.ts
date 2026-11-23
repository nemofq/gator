import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../catalog/catalog.json";
import { encryptKey, keys } from "../src/crypto";
import worker from "../src/index";
import { cron, refresh, testProvider } from "../src/snapshot";
import { invalidate, listProviders } from "../src/state";
import { addProvider, readOnly, signIn, tool, unique } from "./helpers";
import { mockUpstream, type Server } from "./mock-upstream";

let servers: Record<string, Server>;
let mock: ReturnType<typeof mockUpstream>;
beforeEach(() => {
  servers = {};
  mock = mockUpstream(servers);
});
afterEach(() => vi.unstubAllGlobals());

const writer = (name: string) => ({
  name,
  description: `Changes ${name}`,
  inputSchema: { type: "object" },
});
const rows = async (id: string) =>
  (
    await env.DB.prepare(
      "SELECT name, enabled, removed, approved, latest, approved_hash = latest_hash AS same FROM tools WHERE provider_id = ? ORDER BY name",
    )
      .bind(id)
      .all()
  ).results;
const version = () =>
  env.DB.prepare("SELECT value FROM settings WHERE key = 'version'").first<string>("value");
const counts = async (id: string) => (await listProviders(env)).find((p) => p.id === id)?.tools;
const describeText = async (id: string) =>
  JSON.parse((await tool("describe_tool", { id })).content[0].text);

async function custom(server: Partial<Server>, review = false) {
  const { id, host } = unique("c");
  const upstream: Server = { era: "stateless", tools: [], ...server };
  servers[host] = upstream;
  await addProvider(id, host, { review });
  return { id, upstream };
}

describe("refresh", () => {
  it("turns on only read-only tools of a new custom provider", async () => {
    const { id } = await custom({ tools: [readOnly("look"), writer("post")] });
    expect(await refresh(env, id)).toBeNull();
    expect((await rows(id)).map((r) => [r.name, r.enabled])).toEqual([
      ["look", 1],
      ["post", 0],
    ]);
    expect(await counts(id)).toEqual({ total: 2, enabled: 1, changed: 0, new: 0 });
    const found = JSON.parse((await tool("search_tools", { query: "look" })).content[0].text);
    expect(found.tools.map((t: { id: string }) => t.id)).toEqual([`${id}.look`]);
  });

  it("applies the catalog's default tools to tavily", async () => {
    const manifest = catalog.find((m) => m.id === "tavily");
    expect(manifest).toBeDefined();
    const names = [
      "tavily_search",
      "tavily_extract",
      "tavily_crawl",
      "tavily_map",
      "tavily_research",
    ];
    servers["mcp.tavily.com"] = {
      era: "session",
      tools: names.map((n) => readOnly(n)),
      key: ["Authorization", "Bearer tvly-1"],
    };
    const k = await keys(env);
    await env.DB.prepare(
      "INSERT INTO providers (id, enabled, key, key_check, key_last4) VALUES ('tavily', 1, ?, ?, '-1')",
    )
      .bind(await encryptKey(k, "tavily", "tvly-1"), k.check)
      .run();
    expect(await refresh(env, "tavily")).toBeNull();
    const enabled = (await rows("tavily")).filter((r) => r.enabled).map((r) => r.name);
    expect(enabled.sort()).toEqual(["tavily_extract", "tavily_search"]);
    const result = await tool("call_tool", { id: "tavily.tavily_search", arguments: { q: "x" } });
    expect(result.content[0].text).toBe("ok");
  });

  it("with review on, keeps serving the approved version of a changed tool until it is approved, and notices a change back", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("look", "Old text")] }, true);
    await refresh(env, id);
    const before = Number(await version());

    upstream.tools = [readOnly("look", "New text"), readOnly("later")];
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before + 1);
    const [later, look] = await rows(id);
    expect(later).toMatchObject({ name: "later", enabled: 0, latest: null, same: 1 });
    expect(look).toMatchObject({ enabled: 1, same: 0 });
    expect(JSON.parse(String(look.latest)).description).toBe("New text");
    expect(await counts(id)).toEqual({ total: 2, enabled: 1, changed: 1, new: 1 });
    expect((await describeText(`${id}.look`)).description).toBe("Old text");

    upstream.tools = [readOnly("look", "Old text"), readOnly("later")];
    await refresh(env, id);
    expect((await rows(id))[1]).toMatchObject({ name: "look", latest: null, same: 1 });

    upstream.tools = [readOnly("look", "New text"), readOnly("later")];
    await refresh(env, id);
    await env.DB.prepare(
      "UPDATE tools SET approved = latest, approved_hash = latest_hash, latest = NULL WHERE provider_id = ? AND name = 'look'",
    )
      .bind(id)
      .run();
    invalidate();
    expect((await describeText(`${id}.look`)).description).toBe("New text");
  });

  it("with review on, updates a switched-off tool's text without review or a version bump", async () => {
    const { call } = await signIn();
    const { id, upstream } = await custom(
      { tools: [readOnly("look", "Old look"), writer("post")] },
      true,
    );
    await refresh(env, id);
    const before = Number(await version());

    upstream.tools = [readOnly("look", "Old look"), { ...writer("post"), description: "New post" }];
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before);
    expect(await counts(id)).toEqual({ total: 2, enabled: 1, changed: 0, new: 0 });
    const [, post] = await rows(id);
    expect(post).toMatchObject({ enabled: 0, latest: null, same: 1 });
    expect(JSON.parse(String(post.approved)).description).toBe("New post");

    upstream.tools = [readOnly("look", "New look"), { ...writer("post"), description: "Newer" }];
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before + 1);
    expect((await rows(id)).map((r) => [r.name, r.same, r.latest === null])).toEqual([
      ["look", 0, false],
      ["post", 1, true],
    ]);

    const on = await call("PATCH", `/api/providers/${id}/tools/post`, { enabled: true });
    expect(on.body).toMatchObject({ status: "ok", approved: { description: "Newer" } });
    expect((await describeText(`${id}.post`)).description).toBe("Newer");
    const found = JSON.parse((await tool("search_tools", { query: "newer" })).content[0].text);
    expect(found.tools.map((t: { id: string }) => t.id)).toContain(`${id}.post`);
  });

  it("marks removed tools and brings them back", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("look"), readOnly("gone")] });
    await refresh(env, id);
    upstream.tools = [readOnly("look")];
    await refresh(env, id);
    expect((await rows(id)).map((r) => [r.name, r.removed])).toEqual([
      ["gone", 1],
      ["look", 0],
    ]);
    expect(await counts(id)).toEqual({ total: 1, enabled: 1, changed: 0, new: 0 });
    expect((await tool("call_tool", { id: `${id}.gone` })).isError).toBe(true);
    upstream.tools = [readOnly("look"), readOnly("gone")];
    await refresh(env, id);
    expect((await rows(id)).map((r) => r.removed)).toEqual([0, 0]);
    expect((await tool("call_tool", { id: `${id}.gone` })).content[0].text).toBe("ok");
  });

  it("records only the error when the provider cannot be reached", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("look")] });
    await refresh(env, id);
    const before = await version();
    upstream.key = ["X-Key", "missing"];
    // Refresh errors are for the owner, already in the dashboard; agents' errors say where to go.
    const rejected = `Name ${id} rejected this API key. Check it and try again.`;
    const tried = Date.now();
    expect(await refresh(env, id)).toBe(rejected);
    const row = await env.DB.prepare(
      "SELECT refresh_error, refreshed_at FROM providers WHERE id = ?",
    )
      .bind(id)
      .first<{ refresh_error: string; refreshed_at: number }>();
    expect(row?.refresh_error).toBe(rejected);
    expect(row?.refreshed_at).toBeGreaterThanOrEqual(tried);
    expect(await version()).toBe(before);
    expect((await rows(id)).map((r) => r.name)).toEqual(["look"]);
    upstream.key = undefined;
    upstream.tools = [{ name: "broken" } as never];
    expect(await refresh(env, id)).toContain("returned an error: a tool list Gator cannot read");
  });

  it("tests a connection without storing anything", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("a"), readOnly("b")] });
    expect(await testProvider(env, id)).toEqual({ ok: true, tools: 2 });
    expect(await rows(id)).toEqual([]);
    upstream.call = undefined;
    upstream.redirect = "https://elsewhere.example.com/";
    expect(await testProvider(env, id)).toEqual({
      ok: false,
      error: `Name ${id} returned an error: HTTP 302`,
    });
    expect(await testProvider(env, "nope")).toEqual({
      ok: false,
      error: "There is no such provider.",
    });
  });
});

describe("review off (the default) and the change log", () => {
  const log = async (id: string) =>
    (
      await env.DB.prepare(
        "SELECT name, kind FROM tool_changes WHERE provider_id = ? ORDER BY ts, name",
      )
        .bind(id)
        .all()
    ).results;

  it("serves a switched-on tool's new text at once, bumps the version and logs it", async () => {
    const { id, upstream } = await custom({
      tools: [readOnly("look", "Old text"), writer("post")],
    });
    await refresh(env, id);
    expect(await log(id)).toEqual([]); // the first listing is not a change
    const before = Number(await version());

    upstream.tools = [readOnly("look", "New text"), writer("post")];
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before + 1);
    expect((await rows(id))[0]).toMatchObject({ name: "look", latest: null, same: 1 });
    expect(await counts(id)).toEqual({ total: 2, enabled: 1, changed: 0, new: 0 });
    expect((await describeText(`${id}.look`)).description).toBe("New text");
    expect(await log(id)).toEqual([{ name: "look", kind: "modified" }]);

    // A switched-off tool's new text is taken silently: no log row, no bump.
    upstream.tools = [readOnly("look", "New text"), { ...writer("post"), description: "New post" }];
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before + 1);
    expect(JSON.parse(String((await rows(id))[1].approved)).description).toBe("New post");
    expect(await log(id)).toHaveLength(1);
  });

  it("logs a tool that is added, one that disappears and one that comes back, once each", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("a"), readOnly("b")] });
    await refresh(env, id);
    upstream.tools = [readOnly("a"), readOnly("c")];
    await refresh(env, id);
    // Back, and with new text: still one row, `added`.
    upstream.tools = [readOnly("a"), readOnly("b", "Back"), readOnly("c")];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1);
    await refresh(env, id);
    vi.restoreAllMocks();
    expect(await log(id)).toEqual([
      { name: "b", kind: "removed" },
      { name: "c", kind: "added" },
      { name: "b", kind: "added" },
    ]);
  });

  it("with review on, holds the change as before and logs it too", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("look", "Old")] }, true);
    await refresh(env, id);
    upstream.tools = [readOnly("look", "New")];
    await refresh(env, id);
    expect((await rows(id))[0]).toMatchObject({ same: 0 });
    expect((await describeText(`${id}.look`)).description).toBe("Old");
    expect(await log(id)).toEqual([{ name: "look", kind: "modified" }]);
  });

  it("approves what waited when review is turned off, and shows the newest 20 changes", async () => {
    const { call } = await signIn();
    const { id, upstream } = await custom({ tools: [readOnly("look", "Old")] }, true);
    await refresh(env, id);
    upstream.tools = [readOnly("look", "New")];
    await refresh(env, id);
    expect((await call("GET", `/api/providers/${id}`)).body).toMatchObject({
      review: true,
      tools: { changed: 1 },
    });
    const before = Number(await version());
    expect((await call("PATCH", `/api/providers/${id}`, { review: "no" })).status).toBe(400);
    const off = await call("PATCH", `/api/providers/${id}`, { review: false });
    expect(off.body).toMatchObject({ review: false, tools: { changed: 0 } });
    expect(Number(await version())).toBe(before + 1);
    expect((await describeText(`${id}.look`)).description).toBe("New");
    // Turning it on again changes nothing stored.
    await call("PATCH", `/api/providers/${id}`, { review: true });
    expect((await rows(id))[0]).toMatchObject({ latest: null, same: 1 });

    const insert = env.DB.prepare("INSERT INTO tool_changes VALUES (?, ?, ?, 'added')");
    await env.DB.batch(
      Array.from({ length: 25 }, (_, n) => insert.bind(id, n < 24 ? n : 23, `t${n}`)),
    );
    const { changes } = (await call("GET", `/api/providers/${id}`)).body;
    expect(changes).toHaveLength(20);
    // The refresh's own row is newest; then newest first, names in order within one time.
    expect(changes.slice(0, 4)).toMatchObject([
      { name: "look", kind: "modified" },
      { ts: 23, name: "t23", kind: "added" },
      { ts: 23, name: "t24" },
      { ts: 22, name: "t22" },
    ]);
  });
});

describe("a tool added after the first listing", () => {
  const fresh = async (id: string) =>
    (
      await env.DB.prepare(
        "SELECT name, enabled, fresh FROM tools WHERE provider_id = ? ORDER BY name",
      )
        .bind(id)
        .all()
    ).results;

  it("starts off and new until the owner has seen the provider, which bumps nothing", async () => {
    const { call } = await signIn();
    const { id, upstream } = await custom({ tools: [readOnly("look")] });
    await refresh(env, id);
    expect(await fresh(id)).toEqual([{ name: "look", enabled: 1, fresh: 0 }]);
    upstream.tools = [readOnly("look"), readOnly("later")];
    await refresh(env, id);
    expect(await fresh(id)).toEqual([
      { name: "later", enabled: 0, fresh: 1 },
      { name: "look", enabled: 1, fresh: 0 },
    ]);
    const shown = (await call("GET", `/api/providers/${id}`)).body;
    expect(shown.tools).toMatchObject({ total: 2, enabled: 1, new: 1 });
    expect(shown.tool_list.map((t: { new: boolean }) => t.new)).toEqual([true, false]);

    // Switching it on does not clear it; opening the provider does, without a version bump.
    await call("PATCH", `/api/providers/${id}/tools/later`, { enabled: true });
    expect((await fresh(id))[0]).toMatchObject({ enabled: 1, fresh: 1 });
    const before = await version();
    expect((await call("POST", `/api/providers/${id}/seen`)).status).toBe(204);
    expect(await version()).toBe(before);
    expect((await call("GET", `/api/providers/${id}`)).body.tools.new).toBe(0);
  });

  it("starts off even when the catalog's defaults name it", async () => {
    const manifest = catalog.find((m) => m.id === "fmp");
    servers[new URL(String(manifest?.mcp_url)).host] = {
      era: "stateless",
      tools: [readOnly("search")],
      key: ["X-API-Key", "fmp-1"],
    };
    const k = await keys(env);
    await env.DB.prepare(
      "INSERT INTO providers (id, enabled, key, key_check, key_last4) VALUES ('fmp', 1, ?, ?, '')",
    )
      .bind(await encryptKey(k, "fmp", "fmp-1"), k.check)
      .run();
    await refresh(env, "fmp");
    servers[new URL(String(manifest?.mcp_url)).host].tools = [
      readOnly("search"),
      readOnly("quote"),
    ];
    await refresh(env, "fmp");
    expect(await fresh("fmp")).toEqual([
      { name: "quote", enabled: 0, fresh: 1 },
      { name: "search", enabled: 1, fresh: 0 },
    ]);
  });

  it("is not a tool that returns: that one keeps its switch and is not new", async () => {
    const { call } = await signIn();
    const { id, upstream } = await custom({ tools: [readOnly("a"), readOnly("b")] });
    await refresh(env, id);
    await call("PATCH", `/api/providers/${id}/tools/b`, { enabled: false });
    upstream.tools = [];
    await refresh(env, id);
    upstream.tools = [readOnly("a"), readOnly("b")];
    await refresh(env, id);
    expect(await fresh(id)).toEqual([
      { name: "a", enabled: 1, fresh: 0 },
      { name: "b", enabled: 0, fresh: 0 },
    ]);
  });
});

describe("an unchanged tool list", () => {
  it("writes only the refresh time, does not read the list again, and ignores the request id", async () => {
    const marker = "Marker 7f3a";
    const { id, upstream } = await custom({ era: "session", tools: [readOnly("look", marker)] });
    await refresh(env, id);
    await env.DB.prepare(
      "UPDATE providers SET refresh_error = 'old', refreshed_at = 1 WHERE id = ?",
    )
      .bind(id)
      .run();
    const before = { version: await version(), rows: await rows(id) };
    // The page is parsed once (for its cursor); handing the list to the core would serialise it.
    const parse = vi.spyOn(JSON, "parse");
    const stringify = vi.spyOn(JSON, "stringify");
    const withMarker = (texts: unknown[]) => texts.filter((t) => String(t).includes(marker));
    expect(await refresh(env, id)).toBeNull();
    expect(withMarker(parse.mock.calls.map(([text]) => text))).toHaveLength(1);
    expect(withMarker(stringify.mock.results.map((r) => r.value))).toHaveLength(0);
    expect({ version: await version(), rows: await rows(id) }).toEqual(before);
    const row = await env.DB.prepare(
      "SELECT refresh_error, refreshed_at FROM providers WHERE id = ?",
    )
      .bind(id)
      .first<{ refresh_error: string | null; refreshed_at: number }>();
    expect(row?.refresh_error).toBeNull();
    expect(row?.refreshed_at).toBeGreaterThan(1);
    const ids = mock.log.filter((e) => e.method === "tools/list").map((e) => e.body);
    expect(new Set(ids.map((body) => (body as { id: number }).id)).size).toBe(2);

    // The control: a changed list goes to the core, which the spy sees.
    upstream.tools = [readOnly("look", `${marker} edited`)];
    expect(await refresh(env, id)).toBeNull();
    expect(withMarker(stringify.mock.results.map((r) => r.value)).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
    expect(Number(await version())).toBe(Number(before.version) + 1);
  });

  it("still sees an edited description, an added tool and a removed tool", async () => {
    const { id, upstream } = await custom({ tools: [readOnly("a"), readOnly("b")] }, true);
    await refresh(env, id);
    const edited = readOnly("a", "Edited");
    for (const tools of [
      [edited, readOnly("b")],
      [edited, readOnly("b"), readOnly("c")],
      [edited, readOnly("c")],
    ]) {
      const before = Number(await version());
      upstream.tools = tools;
      expect(await refresh(env, id)).toBeNull();
      expect(Number(await version())).toBe(before + 1);
    }
    expect((await rows(id)).map((r) => [r.name, r.removed, r.same])).toEqual([
      ["a", 0, 0],
      ["b", 1, 1],
      ["c", 0, 1],
    ]);
  });

  it("is recognised in a paginated event stream, and a change on a later page is not", async () => {
    const tools = ["a", "b", "c"].map((name) => readOnly(name));
    const { id, upstream } = await custom({ era: "session", sse: true, pageSize: 2, tools });
    expect(await refresh(env, id)).toBeNull();
    expect((await rows(id)).map((r) => r.name)).toEqual(["a", "b", "c"]);
    const before = Number(await version());
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before);
    upstream.tools = [...tools, readOnly("d")];
    expect(await refresh(env, id)).toBeNull();
    expect(Number(await version())).toBe(before + 1);
    expect((await rows(id)).map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
    expect(mock.log.filter((e) => e.method === "tools/list")).toHaveLength(6);
  });
});

describe("keys", () => {
  const zoodata = catalog.find((m) => m.id === "zoodata");
  const missing = `No API key is set for ${zoodata?.name}. Add one in the Gator dashboard.`;

  it("does not contact a provider that needs a key it does not have, and refreshes it once the key is set", async () => {
    const { call } = await signIn();
    const host = new URL(String(zoodata?.mcp_url)).host;
    servers[host] = {
      era: "stateless",
      tools: [readOnly("openapi_v2_products_search")],
      key: ["Authorization", "Bearer zd-0123456789"],
    };
    const enabled = await call("PATCH", "/api/providers/zoodata", { enabled: true });
    expect(enabled.body).toMatchObject({
      enabled: true,
      refresh_error: missing,
      tools: { total: 0 },
    });
    expect(await testProvider(env, "zoodata")).toEqual({ ok: false, error: missing });
    expect(await refresh(env, "zoodata")).toBe(missing);
    expect(mock.log).toHaveLength(0);
    const called = await tool("call_tool", {
      id: "zoodata.openapi_v2_products_search",
      arguments: {},
    });
    expect(called).toEqual({ content: [{ type: "text", text: missing }], isError: true });
    const listed = (await tool("search_tools", { query: "" })).content[0].text;
    expect(listed).not.toContain(String(zoodata?.name));

    const keyed = await call("PATCH", "/api/providers/zoodata", { key: "zd-0123456789" });
    expect(keyed.body).toMatchObject({ refresh_error: null, tools: { total: 1 } });
    expect(mock.log.map((e) => e.method)).toContain("tools/list");
    const ok = await tool("call_tool", { id: "zoodata.openapi_v2_products_search", arguments: {} });
    expect(ok.content[0].text).toBe("ok");
  });

  it("contacts a provider that works without a key, and lists it fully once a key adds tools", async () => {
    const { call } = await signIn();
    const redlisten = catalog.find((m) => m.id === "redlisten");
    const upstream: Server = { era: "session", tools: [readOnly("reddit_preview")] };
    servers[new URL(String(redlisten?.mcp_url)).host] = upstream;
    const enabled = await call("PATCH", "/api/providers/redlisten", { enabled: true });
    expect(enabled.body).toMatchObject({ refresh_error: null, tools: { total: 1 } });
    const before = Number(await version());
    upstream.keyedTools = ["Authorization", [readOnly("reddit_search")]];
    const keyed = await call("PATCH", "/api/providers/redlisten", { key: "rl-0123456789" });
    expect(keyed.body).toMatchObject({ refresh_error: null, tools: { total: 2 } });
    expect(Number(await version())).toBeGreaterThan(before);
    const lists = mock.log.filter((e) => e.method === "tools/list");
    // The last one is the comparison without the key, which lists less: the key makes a difference.
    expect(lists.map((e) => e.headers.get("Authorization"))).toEqual([
      null,
      "Bearer rl-0123456789",
      null,
    ]);
    expect(keyed.body.key_same).toBe(false);
  });
});

describe("a key that makes no difference", () => {
  const firecrawl = catalog.find((m) => m.id === "firecrawl");
  const host = new URL(String(firecrawl?.mcp_url)).host;

  it("is noticed for a provider that also works without a key, listed on a connection of its own", async () => {
    const { call } = await signIn();
    servers[host] = { era: "session", tools: [readOnly("firecrawl_search")] };
    const enabled = await call("PATCH", "/api/providers/firecrawl", { enabled: true });
    expect(enabled.body).toMatchObject({ refresh_error: null, key_same: false });
    const key = "fc-wrong-0123456789";
    const keyed = await call("PATCH", "/api/providers/firecrawl", { key });
    expect(keyed.body).toMatchObject({ refresh_error: null, key_same: true });
    const lists = mock.log.filter((e) => e.method === "tools/list").slice(1);
    expect(lists.map((e) => e.headers.get("Authorization"))).toEqual([`Bearer ${key}`, null]);
    const [keyedSession, keylessSession] = lists.map((e) => e.headers.get("Mcp-Session-Id"));
    expect(keylessSession).not.toBe(keyedSession);

    // The keyed session is untouched: the next call uses it, with no new handshake.
    mock.log.length = 0;
    await tool("call_tool", { id: "firecrawl.firecrawl_search", arguments: {} });
    expect(
      mock.log.map((e) => [
        e.method,
        e.headers.get("Authorization"),
        e.headers.get("Mcp-Session-Id"),
      ]),
    ).toEqual([["tools/call", `Bearer ${key}`, keyedSession]]);

    // Removing the key clears the finding; a refresh with no key has nothing to compare.
    const removed = await call("PATCH", "/api/providers/firecrawl", { key: null });
    expect(removed.body.key_same).toBe(false);
    expect(
      await env.DB.prepare("SELECT key_same FROM providers WHERE id = 'firecrawl'").first(
        "key_same",
      ),
    ).toBeNull();
  });

  it("is never looked for on a provider that needs its key", async () => {
    const { id, host: keyedHost } = unique("k");
    servers[keyedHost] = { era: "stateless", tools: [readOnly("look")], key: ["X-Key", "k-0123"] };
    await addProvider(id, keyedHost, { key: "k-0123", auth: { header: "X-Key", format: "{key}" } });
    expect(await refresh(env, id)).toBeNull();
    const lists = mock.log.filter((e) => e.method === "tools/list");
    expect(lists.map((e) => e.headers.get("X-Key"))).toEqual(["k-0123"]);
    expect((await listProviders(env)).find((p) => p.id === id)?.key_same).toBe(false);
  });
});

describe("cron", () => {
  it("refreshes only the stalest provider that is due, and drops usage and changes older than 90 days", async () => {
    const stale = await custom({ tools: [readOnly("a")] });
    const recent = await custom({ tools: [readOnly("a")] });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE providers SET refreshed_at = ?").bind(now - 1000),
      env.DB.prepare("UPDATE providers SET refreshed_at = ? WHERE id = ?").bind(
        now - 24 * 3_600_000,
        stale.id,
      ),
      env.DB.prepare(
        "INSERT INTO usage_daily VALUES ('2000-01-01', 'g', 'p', 't', 1, 0, 5), (?, 'g', 'p', 't', 1, 0, 5)",
      ).bind(new Date(now).toISOString().slice(0, 10)),
      env.DB.prepare("DELETE FROM tool_changes"),
      env.DB.prepare(
        "INSERT INTO tool_changes VALUES ('p', ?, 'old', 'added'), ('p', ?, 'kept', 'added')",
      ).bind(now - 91 * 86_400_000, now - 89 * 86_400_000),
    ]);
    await worker.scheduled(createScheduledController(), env);
    expect(await rows(stale.id)).toHaveLength(1);
    expect(await rows(recent.id)).toHaveLength(0);
    const days = await env.DB.prepare("SELECT DISTINCT day FROM usage_daily").all();
    expect(days.results).toEqual([{ day: new Date(now).toISOString().slice(0, 10) }]);
    const changes = await env.DB.prepare("SELECT name FROM tool_changes").all();
    expect(changes.results).toEqual([{ name: "kept" }]);
    await cron(env);
    expect(await rows(recent.id)).toHaveLength(0);
  });
});
