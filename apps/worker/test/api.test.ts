import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../catalog/catalog.json";
import { decryptKey, keys } from "../src/crypto";
import { getState, invalidate } from "../src/state";
import {
  addProvider,
  apiBodies,
  freshIp,
  login,
  ORIGIN,
  readOnly,
  send,
  signIn,
  tool,
  unique,
} from "./helpers";
import { mockUpstream, type Server } from "./mock-upstream";

/** Never appear in any API response; checked after the last test. */
const KEY = "sk-live-0123456789-plaintext-WXYZ";
const BACKUP = "bk-live-9876543210-plaintext-QRST";

let servers: Record<string, Server>;
let mock: ReturnType<typeof mockUpstream>;
beforeEach(() => {
  servers = {};
  mock = mockUpstream(servers);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  expect(apiBodies.length).toBeGreaterThan(30);
  for (const body of apiBodies) {
    expect(body).not.toContain(KEY);
    expect(body).not.toContain(BACKUP);
  }
});

const cookieOf = (response: Response) => String(response.headers.get("Set-Cookie"));

/** A custom provider created through the API, served by a mock upstream. */
async function createCustom(
  call: Awaited<ReturnType<typeof signIn>>["call"],
  server: Partial<Server> = {},
) {
  const { id, host } = unique("api");
  servers[host] = { era: "stateless", tools: [readOnly("look")], ...server };
  const created = await call("POST", "/api/providers", {
    name: `Custom ${id}`,
    description: "Things",
    mcp_url: `https://${host}/mcp`,
  });
  expect(created.status).toBe(200);
  return { id: created.body.id as string, host };
}

describe("sessions", () => {
  it("issue a strict __Host- cookie on the right password and nothing on a wrong one", async () => {
    const ok = await login(env.OWNER_PASSWORD);
    expect(ok.status).toBe(204);
    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/^__Host-gator=\d+\.[\w-]+; /);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=604800"]) {
      expect(cookie).toContain(attribute);
    }
    const wrong = await login("guess");
    expect([wrong.status, wrong.headers.get("Set-Cookie")]).toEqual([401, null]);
    const foreign = await send("/api/login", {
      method: "POST",
      headers: { Origin: "https://evil.example.com", "CF-Connecting-IP": freshIp() },
      body: JSON.stringify({ password: env.OWNER_PASSWORD }),
    });
    expect(foreign.status).toBe(403);
  });

  it("rate limit logins per address, counting each attempt in D1 before the password is checked", async () => {
    const ip = freshIp();
    const compared = vi.spyOn(crypto.subtle, "timingSafeEqual");
    for (let i = 0; i < 5; i++) expect((await login("guess", ip)).status).toBe(401);
    expect(compared).toHaveBeenCalledTimes(5);
    const limited = await login(env.OWNER_PASSWORD, ip);
    expect([limited.status, limited.headers.get("Set-Cookie")]).toEqual([429, null]);
    expect(compared).toHaveBeenCalledTimes(5);
    const counted = env.DB.prepare("SELECT SUM(count) AS n FROM login_attempts WHERE ip = ?");
    expect(await counted.bind(ip).first("n")).toBe(6);
    expect((await login(env.OWNER_PASSWORD)).status).toBe(204);
  });

  it("hold the limit exactly under parallel attempts, per address, until the next minute", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const ip = freshIp();
    let answered = 0;
    let fifthAnswered = () => {};
    const five = new Promise<void>((resolve) => {
      fifthAnswered = resolve;
    });
    const wrong = Array.from({ length: 20 }, () =>
      login("guess", ip).then((response) => {
        if (++answered === 5) fifthAnswered();
        return response.status;
      }),
    );
    // Sent once five attempts are counted, while the rest of the burst is still in flight.
    const right = five.then(() => login(env.OWNER_PASSWORD, ip));
    const statuses = await Promise.all(wrong);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    const late = await right;
    expect([late.status, late.headers.get("Set-Cookie")]).toEqual([429, null]);
    expect((await login(env.OWNER_PASSWORD, freshIp())).status).toBe(204);

    clock.mockReturnValue(start + 60_000);
    expect((await login(env.OWNER_PASSWORD, ip)).status).toBe(204);
    clock.mockReturnValue(start + 120_000);
    await login("guess", ip);
    const minutes = await env.DB.prepare("SELECT minute FROM login_attempts WHERE ip = ?")
      .bind(ip)
      .all<{ minute: number }>();
    // Rows older than the previous minute are deleted by the next attempt.
    expect(minutes.results.map((r) => r.minute).sort()).toEqual(
      [60_000, 120_000].map((ms) => Math.floor((start + ms) / 60_000)),
    );
  });

  it("refuse missing, expired, tampered and outdated cookies", async () => {
    const session = (cookie: string, testEnv = env) =>
      send("/api/session", { headers: { Cookie: cookie } }, testEnv);
    const cookie = cookieOf(await login(env.OWNER_PASSWORD)).split(";")[0];
    expect((await session(cookie)).status).toBe(200);
    expect((await send("/api/session")).status).toBe(401);
    const [, signature] = cookie.split(".");
    const later = String(Date.now() + 1e9);
    expect((await session(`__Host-gator=${later}.${signature}`)).status).toBe(401);
    expect((await session(`${cookie.slice(0, -2)}xx`)).status).toBe(401);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86_400_000);
    expect((await session(cookie)).status).toBe(401);
    clock.mockRestore();
    // Signed with a key derived from the old password.
    expect((await session(cookie, { ...env, OWNER_PASSWORD: "a new password" })).status).toBe(401);
  });

  it("sign out by clearing the cookie", async () => {
    const { call } = await signIn();
    const out = await call("POST", "/api/logout");
    expect(out.status).toBe(204);
    expect(out.headers.get("Set-Cookie")).toMatch(/^__Host-gator=; .*Max-Age=0/);
  });
});

describe("CSRF and Origin", () => {
  const writes: [string, string][] = [
    ["POST", "/api/logout"],
    ["DELETE", "/api/agents/x"],
    ["POST", "/api/providers"],
    ["PATCH", "/api/providers/tavily"],
    ["DELETE", "/api/providers/tavily"],
    ["POST", "/api/providers/tavily/refresh"],
    ["POST", "/api/providers/tavily/test"],
    ["POST", "/api/providers/tavily/seen"],
    ["PATCH", "/api/providers/tavily/tools/x"],
    ["PATCH", "/api/settings"],
  ];
  const reads = ["session", "overview", "agents", "providers", "providers/tavily", "settings"];

  it("every write needs the token and this origin; reads need only the session", async () => {
    const { cookie, csrf } = await signIn();
    for (const [method, path] of writes) {
      const variants: Record<string, string>[] = [
        { Cookie: cookie, Origin: ORIGIN },
        { Cookie: cookie, Origin: ORIGIN, "X-CSRF-Token": "forged" },
        { Cookie: cookie, "X-CSRF-Token": csrf },
        { Cookie: cookie, Origin: "https://evil.example.com", "X-CSRF-Token": csrf },
      ];
      for (const headers of variants) {
        const response = await send(path, { method, headers, body: "{}" });
        expect([method, path, response.status]).toEqual([method, path, 403]);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
      expect(
        (await send(path, { method, headers: { Origin: ORIGIN, "X-CSRF-Token": csrf } })).status,
      ).toBe(401);
    }
    for (const path of reads) {
      const response = await send(`/api/${path}`, { headers: { Cookie: cookie } });
      expect([path, response.status]).toEqual([path, 200]);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect((await send(`/api/${path}`)).status).toBe(401);
    }
  });

  it("a token belongs to its session", async () => {
    const one = await signIn();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    const two = await signIn();
    clock.mockRestore();
    const response = await send("/api/settings", {
      method: "PATCH",
      headers: { Cookie: one.cookie, Origin: ORIGIN, "X-CSRF-Token": two.csrf },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});

describe("providers", () => {
  it("lists the catalog in order, then custom providers", async () => {
    const { call } = await signIn();
    const { id } = await createCustom(call);
    const list = (await call("GET", "/api/providers")).body as { id: string; custom: boolean }[];
    expect(list.slice(0, catalog.length).map((p) => p.id)).toEqual(catalog.map((m) => m.id));
    expect(list.slice(catalog.length).every((p) => p.custom)).toBe(true);
    expect(list.at(-1)?.id).toBe(id);
    expect((await call("GET", "/api/providers/nope")).status).toBe(404);
  });

  it("store a key encrypted and only ever show its last four characters", async () => {
    const { call } = await signIn();
    const { id, host } = unique("key");
    servers[host] = { era: "stateless", tools: [readOnly("look")], key: ["X-Api-Key", KEY] };
    const created = await call("POST", "/api/providers", {
      name: `Keyed ${id}`,
      description: "Things",
      mcp_url: `https://${host}/mcp`,
      auth: { header: "X-Api-Key", format: "{key}" },
      key: KEY,
    });
    expect(created.body).toMatchObject({
      key_required: true,
      key_last4: "WXYZ",
      key_ok: true,
      enabled: false,
    });
    const keyed = created.body.id;
    const row = await env.DB.prepare("SELECT key, manifest FROM providers WHERE id = ?")
      .bind(keyed)
      .first<{ key: string; manifest: string }>();
    expect(row?.key).toBeTruthy();
    expect(row?.key).not.toContain(KEY.slice(0, 8));
    expect(atob(String(row?.key))).not.toContain(KEY.slice(0, 8));
    expect(JSON.parse(String(row?.manifest))).toMatchObject({ id: keyed, key_required: true });

    const enabled = await call("PATCH", `/api/providers/${keyed}`, { enabled: true });
    expect(enabled.body).toMatchObject({
      enabled: true,
      refresh_error: null,
      tools: { total: 1, enabled: 1 },
    });
    expect((await tool("call_tool", { id: `${keyed}.look` })).content[0].text).toBe("ok");
    const removed = await call("PATCH", `/api/providers/${keyed}`, { key: null });
    expect(removed.body).toMatchObject({ key_last4: null, key_ok: true });
    expect((await tool("call_tool", { id: `${keyed}.look` })).content[0].text).toMatch(
      /^No API key is set/,
    );
    expect((await call("PATCH", `/api/providers/${keyed}`, { key: KEY })).body.key_last4).toBe(
      "WXYZ",
    );
    expect((await tool("call_tool", { id: `${keyed}.look` })).content[0].text).toBe("ok");
  });

  it("trim a pasted key, refuse one that cannot be a header, and show the last four only of long keys", async () => {
    const { call } = await signIn();
    const { id } = await createCustom(call);
    const set = (key: unknown) => call("PATCH", `/api/providers/${id}`, { key });
    const stored = async () => {
      const row = await env.DB.prepare("SELECT key, key_last4 FROM providers WHERE id = ?")
        .bind(id)
        .first<{ key: string | null; key_last4: string | null }>();
      const key = row?.key ? await decryptKey(await keys(env), id, row.key) : null;
      return { key, key_last4: row?.key_last4 };
    };
    const twelve = "abcdefgh1234";
    expect((await set(` \t${twelve}\r\n `)).body.key_last4).toBe("1234");
    expect(await stored()).toEqual({ key: twelve, key_last4: "1234" });
    const eleven = twelve.slice(1);
    expect((await set(eleven)).body.key_last4).toBe("");
    expect(await stored()).toEqual({ key: eleven, key_last4: "" });

    const problem = "key must be printable characters with no spaces or line breaks.";
    for (const key of [
      "",
      "   ",
      "abc def",
      "abc\ndef",
      "abc\u0007def",
      "abc\u007fdef",
      "kéy-0123456",
    ]) {
      const response = await set(key);
      expect([JSON.stringify(key), response.status, response.body.error]).toEqual([
        JSON.stringify(key),
        400,
        problem,
      ]);
    }
    expect(await stored()).toEqual({ key: eleven, key_last4: "" });
    const created = await call("POST", "/api/providers", {
      name: "Spaced",
      description: "Things",
      mcp_url: "https://spaced.example.com/mcp",
      key: "abc def",
    });
    expect([created.status, created.body.error]).toEqual([400, problem]);

    expect((await set(null)).body.key_last4).toBeNull();
    expect(await stored()).toEqual({ key: null, key_last4: null });
  });

  it("enable a catalog provider on first touch, snapshot it and apply its defaults", async () => {
    const { call } = await signIn();
    const firecrawl = catalog.find((m) => m.id === "firecrawl");
    const names = ["firecrawl_search", "firecrawl_scrape", "firecrawl_crawl", "firecrawl_agent"];
    servers[new URL(String(firecrawl?.mcp_url)).host] = {
      era: "session",
      tools: names.map((n) => readOnly(n)),
      key: ["Authorization", `Bearer ${KEY}`],
    };
    expect(
      await env.DB.prepare("SELECT id FROM providers WHERE id = 'firecrawl'").first(),
    ).toBeNull();
    const keyed = await call("PATCH", "/api/providers/firecrawl", { key: KEY, timeout_ms: 5000 });
    expect(keyed.body).toMatchObject({
      enabled: false,
      key_last4: "WXYZ",
      timeout_ms: 5000,
      tools: { total: 0 },
    });
    const enabled = await call("PATCH", "/api/providers/firecrawl", { enabled: true });
    expect(enabled.body).toMatchObject({
      enabled: true,
      refresh_error: null,
      tools: { total: 4, enabled: 2 },
    });
    const detail = (await call("GET", "/api/providers/firecrawl")).body;
    expect(
      detail.tool_list
        .filter((t: { enabled: boolean }) => t.enabled)
        .map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(["firecrawl_scrape", "firecrawl_search"]);
    expect(
      (await call("PATCH", "/api/providers/firecrawl", { timeout_ms: null })).body.timeout_ms,
    ).toBeNull();
    expect((await call("DELETE", "/api/providers/firecrawl")).status).toBe(400);
  });

  it("save the change and show the error when the refresh fails", async () => {
    const { call } = await signIn();
    const { id, host } = await createCustom(call);
    delete servers[host];
    const enabled = await call("PATCH", `/api/providers/${id}`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.refresh_error).toMatch(/returned an error/);
  });

  it("refuse bad PATCH bodies", async () => {
    const { call } = await signIn();
    for (const body of [
      { enabled: "yes" },
      { key: 5 },
      { timeout_ms: 999 },
      { timeout_ms: 120_001 },
      { timeout_ms: 1.5 },
    ]) {
      const response = await call("PATCH", "/api/providers/tavily", body);
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), 400]);
      expect(typeof response.body.error).toBe("string");
    }
    expect((await call("PATCH", "/api/providers/tavily", [1])).status).toBe(400);
  });

  it("switch and approve tools, which changes what search_tools returns next", async () => {
    const { call } = await signIn();
    const { id, host } = await createCustom(call, { tools: [readOnly("look", "Old words")] });
    await call("PATCH", `/api/providers/${id}`, { enabled: true, review: true });
    // Without the provider filter, which lists a provider's tools whether or not the words match.
    const search = async (query: string) =>
      JSON.parse((await tool("search_tools", { query })).content[0].text)
        .tools.map((t: { id: string }) => t.id)
        .filter((found: string) => found.startsWith(`${id}.`));
    expect(await search("old words")).toEqual([`${id}.look`]);

    expect(
      (await call("PATCH", `/api/providers/${id}/tools/look`, { enabled: false })).body.enabled,
    ).toBe(false);
    expect(await search("old words")).toEqual([]);
    expect((await tool("call_tool", { id: `${id}.look` })).content[0].text).toMatch(
      /^Unknown or disabled tool/,
    );
    await call("PATCH", `/api/providers/${id}/tools/look`, { enabled: true });

    servers[host].tools = [readOnly("look", "Fresh vocabulary")];
    const refreshed = await call("POST", `/api/providers/${id}/refresh`);
    expect(refreshed.body.tool_list).toEqual([
      {
        name: "look",
        description: "Old words",
        clipped: false,
        read_only: true,
        enabled: true,
        new: false,
        status: "changed",
      },
    ]);
    const pending = (await call("GET", `/api/providers/${id}/tools/look`)).body;
    expect(pending).toMatchObject({
      status: "changed",
      approved: { description: "Old words" },
      latest: { description: "Fresh vocabulary" },
    });
    expect(await search("fresh vocabulary")).toEqual([]);
    const approved = await call("PATCH", `/api/providers/${id}/tools/look`, { approve: true });
    expect(approved.body).toMatchObject({
      status: "ok",
      approved: { description: "Fresh vocabulary" },
      latest: null,
    });
    expect(await search("fresh vocabulary")).toEqual([`${id}.look`]);
    expect((await call("GET", `/api/providers/${id}/tools/nope`)).status).toBe(404);
    expect(
      (await call("PATCH", `/api/providers/${id}/tools/look`, { approve: false })).status,
    ).toBe(400);

    // Switching off a tool with a pending version accepts it; switching it on serves it.
    servers[host].tools = [readOnly("look", "Third phrasing")];
    await call("POST", `/api/providers/${id}/refresh`);
    const off = await call("PATCH", `/api/providers/${id}/tools/look`, { enabled: false });
    expect(off.body).toMatchObject({ status: "ok", latest: null });
    await call("PATCH", `/api/providers/${id}/tools/look`, { enabled: true });
    expect(await search("third phrasing")).toEqual([`${id}.look`]);

    expect(await call("POST", `/api/providers/${id}/test`)).toMatchObject({
      body: { ok: true, tools: 1 },
    });
    delete servers[host];
    expect((await call("POST", `/api/providers/${id}/test`)).body.ok).toBe(false);
  });

  it("clip a long description in the tool list at a word, and give it whole in the tool's detail", async () => {
    const { call } = await signIn();
    // 400 characters end inside "wordier", so the cut comes before it; "wordy" ends at 400 exactly.
    const words = "abcd ".repeat(79);
    const long = `${words}wordier tail`;
    const tools = [readOnly("look", long), readOnly("one"), readOnly("two", `${words}wordy tail`)];
    const { id } = await createCustom(call, { tools });
    await call("PATCH", `/api/providers/${id}`, { enabled: true });
    const { tool_list } = (await call("GET", `/api/providers/${id}`)).body;
    expect(tool_list.map((t: { clipped: boolean }) => t.clipped)).toEqual([true, false, true]);
    expect(tool_list.map((t: { description: string }) => t.description)).toEqual([
      words.trimEnd(),
      "Tool one",
      `${words}wordy`,
    ]);
    const whole = (await call("GET", `/api/providers/${id}/tools/look`)).body;
    expect(whole.approved.description).toBe(long);
  });

  it("validate custom providers with the core and derive a unique id", async () => {
    const { call } = await signIn();
    const add = (fields: Record<string, unknown>) =>
      call("POST", "/api/providers", {
        name: "Acme Search!",
        description: "Acme things",
        mcp_url: "https://mcp.acme-search.com/mcp",
        ...fields,
      });
    for (const mcp_url of [
      "http://mcp.acme.com/mcp",
      "https://203.0.113.7/mcp",
      "https://[::1]/mcp",
      "https://localhost/mcp",
      "https://mcp.internal/mcp",
      "https://router.lan/mcp",
      "https://user:pass@mcp.acme.com/mcp",
    ]) {
      const response = await add({ mcp_url });
      expect([mcp_url, response.status]).toEqual([mcp_url, 400]);
      expect(response.body.problems.map((p: { path: string }) => p.path)).toContain("mcp_url");
    }
    const badAuth = await add({ auth: { header: "Bad Header", format: "no placeholder" } });
    expect(badAuth.body.problems.map((p: { path: string }) => p.path).sort()).toEqual([
      "auth.format",
      "auth.header",
    ]);
    expect((await add({ name: "" })).body.problems.map((p: { path: string }) => p.path)).toContain(
      "name",
    );

    const first = await add({});
    expect(first.body).toMatchObject({
      id: "acme-search",
      custom: true,
      key_required: false,
      enabled: false,
      key_last4: null,
    });
    expect((await add({})).body.id).toBe("acme-search-2");
    expect(
      (
        await call("POST", "/api/providers", {
          name: "Tavily",
          description: "Mine",
          mcp_url: "https://mcp.tavily.com/mcp",
        })
      ).body.id,
    ).toBe("tavily-2");
    expect((await add({ name: "--A  b--" })).body.id).toBe("a-b");
    expect((await add({ name: "x".repeat(40) })).body.id).toBe("x".repeat(32));
    expect((await add({ name: "x".repeat(40) })).body.id).toBe(`${"x".repeat(30)}-2`);

    expect((await call("DELETE", "/api/providers/acme-search")).status).toBe(204);
    expect((await call("GET", "/api/providers/acme-search")).status).toBe(404);
    expect(
      (await call("GET", "/api/providers")).body.map((p: { id: string }) => p.id),
    ).not.toContain("acme-search");
  });
});

describe("the backup key", () => {
  async function backed(call: Awaited<ReturnType<typeof signIn>>["call"]) {
    const { id, host } = unique("bk");
    const refused = new Set<string>();
    servers[host] = {
      era: "stateless",
      tools: [readOnly("look")],
      refuse: (headers, method) =>
        method === "tools/call" && refused.has(String(headers.get("X-Api-Key"))) ? 429 : undefined,
    };
    const created = await call("POST", "/api/providers", {
      name: `Backed ${id}`,
      description: "Things",
      mcp_url: `https://${host}/mcp`,
      auth: { header: "X-Api-Key", format: "{key}" },
    });
    const pid = created.body.id as string;
    const patch = (body: unknown) => call("PATCH", `/api/providers/${pid}`, body);
    return { id: pid, host, refused, patch };
  }

  it("is stored like the key, needs a primary, and shows only its last four characters", async () => {
    const { call } = await signIn();
    const { id, patch } = await backed(call);
    expect(await patch({ backup_key: BACKUP })).toMatchObject({
      status: 400,
      body: { error: "Set the primary key first." },
    });
    expect((await patch({ key: KEY, backup_key: "a b" })).body.error).toBe(
      "backup_key must be printable characters with no spaces or line breaks.",
    );
    expect((await patch({ key: KEY, backup_key: ` ${BACKUP}\n` })).body).toMatchObject({
      key_last4: "WXYZ",
      key_ok: true,
      backup_last4: "QRST",
      backup_ok: true,
      on_backup: false,
      switched_at: null,
    });
    const row = await env.DB.prepare("SELECT backup_key FROM providers WHERE id = ?")
      .bind(id)
      .first<{ backup_key: string }>();
    const k = await keys(env);
    expect(atob(String(row?.backup_key))).not.toContain(BACKUP.slice(0, 8));
    expect(await decryptKey(k, `${id}:backup`, String(row?.backup_key))).toBe(BACKUP);
    // Bound to its role: it does not open as the primary.
    expect(await decryptKey(k, id, String(row?.backup_key))).toBeNull();
    expect((await patch({ backup_key: "short-key" })).body.backup_last4).toBe("");

    expect(await patch({ key: null })).toMatchObject({
      status: 400,
      body: { error: "Remove the backup key first." },
    });
    expect((await patch({ on_backup: true })).status).toBe(400);
    expect((await patch({ on_backup: "no" })).status).toBe(400);
    expect((await patch({ key: null, backup_key: null })).body).toMatchObject({
      key_last4: null,
      backup_last4: null,
    });
  });

  it("is switched back by hand, and removing it while in use returns the provider to the primary", async () => {
    const { call } = await signIn();
    const { id, host, refused, patch } = await backed(call);
    await patch({ key: KEY, backup_key: BACKUP, enabled: true });
    const used = () =>
      mock.log
        .filter((e) => e.host === host && e.method === "tools/call")
        .map((e) => e.headers.get("X-Api-Key"));

    refused.add(KEY);
    expect((await tool("call_tool", { id: `${id}.look` })).content[0].text).toBe("ok");
    expect(used()).toEqual([KEY, BACKUP]);
    const switched = (await call("GET", `/api/providers/${id}`)).body;
    expect(switched).toMatchObject({ on_backup: true, switched_at: expect.any(Number) });
    const recent = (await call("GET", "/api/overview")).body.recent;
    expect(recent[0]).toMatchObject({
      tool_id: `${id}.look`,
      status: "ok",
      backup: true,
      detail: null,
    });

    refused.clear();
    expect((await patch({ on_backup: false })).body.on_backup).toBe(false);
    await tool("call_tool", { id: `${id}.look` });
    expect(used().at(-1)).toBe(KEY);
    expect((await call("GET", "/api/overview")).body.recent[0].backup).toBe(false);

    refused.add(KEY);
    await tool("call_tool", { id: `${id}.look` });
    expect((await call("GET", `/api/providers/${id}`)).body.on_backup).toBe(true);
    const removed = (await patch({ backup_key: null })).body;
    expect(removed).toMatchObject({ backup_last4: null, on_backup: false, key_last4: "WXYZ" });
    refused.clear();
    await tool("call_tool", { id: `${id}.look` });
    expect(used().at(-1)).toBe(KEY);
  });

  it("is listed as unreadable when it was stored under another MASTER_KEY", async () => {
    const { call } = await signIn();
    const { id, patch } = await backed(call);
    await patch({ key: KEY, backup_key: BACKUP });
    const check = env.DB.prepare("UPDATE providers SET backup_key_check = ? WHERE id = ?");
    await check.bind("other", id).run();
    expect((await call("GET", `/api/providers/${id}`)).body).toMatchObject({
      key_ok: true,
      backup_ok: false,
    });
    const name = (await call("GET", `/api/providers/${id}`)).body.name;
    expect((await call("GET", "/api/session")).body.keys_unreadable).toContainEqual({ id, name });
    await check.bind((await keys(env)).check, id).run();
  });
});

describe("provider status", () => {
  const auth = { header: "X-Key", format: "{key}" };
  async function status(id: string) {
    const { body } = await (await signIn()).call("GET", `/api/providers/${id}`);
    return [body.status, body.status_reason];
  }
  const update = (id: string, set: string, ...values: unknown[]) =>
    env.DB.prepare(`UPDATE providers SET ${set} WHERE id = ?`)
      .bind(...values, id)
      .run();
  /** Logs calls to the provider, oldest first. */
  const calls = (id: string, ...statuses: string[]) =>
    env.DB.batch(
      statuses.map((s) =>
        env.DB.prepare(
          "INSERT INTO calls (ts, agent_id, tool_id, status, latency_ms, result_size) VALUES (0, 'g', ?, ?, 0, 0)",
        ).bind(`${id}.t`, s),
      ),
    );

  it("is off when not enabled, no_key without a needed key, else ready, keyless included", async () => {
    const [off, noKey, keyless, keyed] = [unique("st"), unique("st"), unique("st"), unique("st")];
    await addProvider(off.id, off.host, { auth, key: KEY, enabled: false });
    await update(off.id, "refresh_error = 'Down.'");
    await addProvider(noKey.id, noKey.host, { auth });
    await addProvider(keyless.id, keyless.host);
    await addProvider(keyed.id, keyed.host, { auth, key: KEY });
    const listed = (await (await signIn()).call("GET", "/api/providers")).body;
    const of = (id: string) => listed.find((p: { id: string }) => p.id === id);
    expect([of(off.id).status, of(off.id).status_reason]).toEqual(["off", null]);
    expect([of(noKey.id).status, of(noKey.id).status_reason]).toEqual(["no_key", null]);
    expect(of(keyless.id).status).toBe("ready");
    expect([of(keyed.id).status, of(keyed.id).status_reason]).toEqual(["ready", null]);
  });

  it("needs attention when no saved key can be read; one readable key of two is enough", async () => {
    const unreadable = [
      "attention",
      "Gator cannot read the saved key: the encryption key has changed.",
    ];
    const { id, host } = unique("st");
    await addProvider(id, host, { auth, key: KEY, backup: BACKUP });
    await update(id, "key_check = 'other'");
    expect(await status(id)).toEqual(["ready", null]);
    await update(id, "key_check = ?, backup_key_check = 'other'", (await keys(env)).check);
    expect(await status(id)).toEqual(["ready", null]);
    await update(id, "key_check = 'other'");
    expect(await status(id)).toEqual(unreadable);
    // A provider that works without a key still has a saved key it cannot use.
    const keyless = unique("st");
    await addProvider(keyless.id, keyless.host, { key: KEY });
    await update(keyless.id, "key_check = 'other'");
    expect(await status(keyless.id)).toEqual(unreadable);
    // Gone, so later tests see no unreadable keys.
    await env.DB.prepare("DELETE FROM providers WHERE id IN (?, ?)").bind(id, keyless.id).run();
  });

  it("gives the first cause that applies, in order", async () => {
    const { id, host } = unique("st");
    await addProvider(id, host, { key: KEY });
    await update(
      id,
      "key_check = 'other', refresh_error = 'X did not respond in time.', key_same = 1",
    );
    await calls(id, "auth", "auth", "auth");
    expect((await status(id))[1]).toBe(
      "Gator cannot read the saved key: the encryption key has changed.",
    );
    await update(id, "key_check = ?", (await keys(env)).check);
    expect(await status(id)).toEqual([
      "attention",
      "The last tool refresh failed: X did not respond in time.",
    ]);
    await update(id, "refresh_error = NULL");
    expect(await status(id)).toEqual([
      "attention",
      "The key makes no difference: the provider lists the same tools without it.",
    ]);
    await update(id, "key_same = 0");
    expect(await status(id)).toEqual([
      "attention",
      "The last 3 calls failed, the latest because the provider rejected the key.",
    ]);
  });

  it("counts the last five calls, at least three, that all failed for the provider's reasons", async () => {
    const { id, host } = unique("st");
    await addProvider(id, host, { auth, key: KEY });
    await calls(id, "auth", "rate_limited");
    expect(await status(id)).toEqual(["ready", null]);
    await calls(id, "timeout");
    expect(await status(id)).toEqual([
      "attention",
      "The last 3 calls failed, the latest because the provider did not answer in time.",
    ]);
    await calls(id, "upstream_error", "rate_limited", "auth");
    expect((await status(id))[1]).toBe(
      "The last 5 calls failed, the latest because the provider rejected the key.",
    );
    // Calls Gator refused without contacting the provider neither end nor extend a run.
    await calls(id, "invalid_arguments", "unknown_tool", "missing_key");
    expect((await status(id))[1]).toBe(
      "The last 5 calls failed, the latest because the provider rejected the key.",
    );
    for (const other of ["ok", "tool_error"]) {
      await calls(id, other);
      expect(await status(id)).toEqual(["ready", null]);
      await calls(id, "upstream_error", "upstream_error", "upstream_error", "upstream_error");
      expect(await status(id)).toEqual(["ready", null]);
      await calls(id, "upstream_error");
      expect((await status(id))[1]).toBe(
        "The last 5 calls failed, the latest because the provider returned an error.",
      );
    }
    // Calls to another provider whose ID starts the same are not this one's.
    const tool = unique("st");
    await addProvider(tool.id, tool.host, { auth, key: KEY });
    await calls(tool.id, "tool_error", "tool_error", "tool_error", "tool_error", "tool_error");
    await calls(`${tool.id}x`, "auth", "auth", "auth");
    expect(await status(tool.id)).toEqual(["ready", null]);
  });
});

describe("settings, session and overview", () => {
  it("settings keep to their bounds", async () => {
    const { call } = await signIn();
    expect((await call("GET", "/api/settings")).body).toEqual({
      result_limit: 50_000,
      timeout_ms: 30_000,
    });
    for (const body of [
      { result_limit: 999 },
      { result_limit: 500_001 },
      { timeout_ms: 999 },
      { timeout_ms: 120_001 },
      { timeout_ms: "5000" },
    ]) {
      expect((await call("PATCH", "/api/settings", body)).status).toBe(400);
    }
    const bounds = { result_limit: 1_000, timeout_ms: 120_000 };
    expect((await call("PATCH", "/api/settings", bounds)).body).toEqual(bounds);
    expect((await getState(env, createExecutionContext())).resultLimit).toBe(1_000);
    expect(
      (await call("PATCH", "/api/settings", { result_limit: 500_000, timeout_ms: 30_000 })).body,
    ).toEqual({ result_limit: 500_000, timeout_ms: 30_000 });
  });

  it("the session names the endpoint, and the tool index is no longer served", async () => {
    const { call } = await signIn();
    expect((await call("GET", "/api/index")).status).toBe(404);
    expect((await call("GET", "/api/session")).body).toMatchObject({
      mcp_url: `${ORIGIN}/mcp`,
      version: "0.1.2",
      keys_unreadable: [],
    });
  });

  it("the overview adds up recorded calls", async () => {
    const { call } = await signIn();
    const { id, host } = unique("ov");
    servers[host] = {
      era: "stateless",
      tools: [readOnly("look"), readOnly("fail")],
      call: (name) => (name === "fail" ? new Response(null, { status: 500 }) : undefined),
    };
    await addProvider(id, host);
    await call("POST", `/api/providers/${id}/refresh`);
    await tool("call_tool", { id: `${id}.look` });
    await tool("call_tool", { id: `${id}.look` });
    await tool("call_tool", { id: `${id}.fail` });
    servers[host].call = () =>
      Response.json({ error: { message: "m ".repeat(600) } }, { status: 500 });
    await tool("call_tool", { id: `${id}.look` });
    const overview = (await call("GET", "/api/overview")).body;
    const all = (calls: number, errors: number) => ({
      d7: { calls, errors },
      d30: { calls, errors },
      d90: { calls, errors },
    });
    expect(overview.providers.find((p: { id: string }) => p.id === id)).toEqual({
      id,
      ...all(4, 2),
    });
    expect(overview.tools.find((t: { id: string }) => t.id === `${id}.look`)).toEqual({
      id: `${id}.look`,
      ...all(3, 1),
    });
    expect(overview.today.calls).toBeGreaterThanOrEqual(3);
    expect(overview.days.at(-1)).toMatchObject({
      day: new Date().toISOString().slice(0, 10),
      calls: overview.today.calls,
    });
    // The test agent has no grant in KV, so it shows as revoked, under its saved name.
    expect(overview.agents.find((a: { id: string }) => a.id === "grant123")).toMatchObject({
      client_name: "Test Agent",
      connected_at: 1000,
      via: null,
      revoked: true,
    });
    expect(overview.recent[0]).toMatchObject({
      detail: "m ".repeat(150).trimEnd(),
      detail_capped: true,
    });
    expect(overview.recent[1].detail_capped).toBe(false);
    expect(
      overview.recent
        .slice(1, 4)
        .map((r: { tool_id: string; status: string }) => [r.tool_id, r.status]),
    ).toEqual([
      [`${id}.fail`, "upstream_error"],
      [`${id}.look`, "ok"],
      [`${id}.look`, "ok"],
    ]);
    expect(overview.recent[0]).toMatchObject({ agent: "Test Agent", agent_id: "grant123" });
    expect(overview.recent[0].result_size).toBeGreaterThan(0);
  });

  it("counts a call on its UTC day, which the overview names as today", async () => {
    // A second before midnight UTC (already the next day east of it), years after the other rows.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-03-07T23:59:59Z"));
    const { call } = await signIn();
    const { id, host } = unique("utc");
    servers[host] = { era: "stateless", tools: [readOnly("look")] };
    await addProvider(id, host);
    await call("POST", `/api/providers/${id}/refresh`);
    await tool("call_tool", { id: `${id}.look` });
    const overview = (await call("GET", "/api/overview")).body;
    expect(overview.day).toBe("2030-03-07");
    expect(overview.days).toEqual([
      { day: "2030-03-07", calls: 1, errors: 0, latency_ms: expect.any(Number) },
    ]);
    expect(overview.today.calls).toBe(1);
  });

  it("the overview sums 7, 30 and 90 days in one row each, and lists each range's top ten tools", async () => {
    const { call } = await signIn();
    const ago = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const usage = env.DB.prepare("INSERT INTO usage_daily VALUES (?, 'g-ranges', ?, ?, ?, ?, 0)");
    const { id: ranged } = unique("rg");
    const { id: busy } = unique("rg");
    await env.DB.batch([
      usage.bind(ago(0), ranged, "t", 1, 1),
      usage.bind(ago(6), ranged, "t", 2, 0),
      usage.bind(ago(20), ranged, "t", 4, 0),
      usage.bind(ago(60), ranged, "t", 8, 2),
      usage.bind(ago(100), ranged, "t", 16, 0),
      // Ten tools far ahead over 90 days, one with a single call today, one that is never top.
      ...Array.from({ length: 10 }, (_, n) => usage.bind(ago(60), busy, `old${n}`, 1000, 0)),
      usage.bind(ago(0), busy, "new", 1, 0),
      usage.bind(ago(60), busy, "rare", 1, 0),
    ]);
    const overview = (await call("GET", "/api/overview")).body;
    expect(overview.providers.find((p: { id: string }) => p.id === ranged)).toEqual({
      id: ranged,
      d7: { calls: 3, errors: 1 },
      d30: { calls: 7, errors: 1 },
      d90: { calls: 15, errors: 3 },
    });
    const tools = overview.tools.map((t: { id: string }) => t.id);
    expect(tools).toContain(`${busy}.new`);
    expect(tools).not.toContain(`${busy}.rare`);
    for (let n = 0; n < 10; n++) expect(tools).toContain(`${busy}.old${n}`);
    expect(overview.agents.find((a: { id: string }) => a.id === "g-ranges")).toMatchObject({
      client_name: "",
      revoked: true,
      d90: { calls: 10_017 },
    });
  });
});

describe("a changed MASTER_KEY", () => {
  it("marks the key unreadable until it is entered again", async () => {
    const { call } = await signIn();
    const { id } = unique("mk");
    await addProvider(id, `${id}.example.com`, {
      key: KEY,
      auth: { header: "X-Key", format: "{key}" },
      enabled: false,
    });
    const other = { ...env, MASTER_KEY: "e".repeat(64) };
    const rotated = await signIn(other);
    const provider = (await rotated.call("GET", `/api/providers/${id}`)).body;
    expect(provider).toMatchObject({ key_ok: false, key_last4: "WXYZ" });
    const session = (await rotated.call("GET", "/api/session")).body;
    expect(session.keys_unreadable).toContainEqual({ id, name: `Name ${id}` });
    await rotated.call("PATCH", `/api/providers/${id}`, { key: KEY });
    expect((await rotated.call("GET", "/api/session")).body.keys_unreadable).not.toContainEqual({
      id,
      name: `Name ${id}`,
    });
    // Back under the original key, the newly stored one is the unreadable one.
    expect((await call("GET", `/api/providers/${id}`)).body.key_ok).toBe(false);
    invalidate();
  });
});
