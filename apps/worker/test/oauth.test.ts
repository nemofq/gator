import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { refresh } from "../src/snapshot";
import { addProvider, freshIp, ORIGIN, readOnly, send, signIn, unique } from "./helpers";
import { mockUpstream, type Server } from "./mock-upstream";

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const CLAUDE_CODE_DOCUMENT = {
  client_id: CLAUDE_CODE,
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const servers: Record<string, Server> = {};
const provider = unique("o");

beforeEach(() => {
  mockUpstream(servers);
  // The library fetches Client ID Metadata Documents with the global fetch, like upstream calls.
  const upstream = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) =>
    new Request(input).url === CLAUDE_CODE
      ? Promise.resolve(Response.json(CLAUDE_CODE_DOCUMENT))
      : upstream(input, init),
  );
});
afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  servers[provider.host] = { era: "stateless", tools: [readOnly("lookup", "Look up a record")] };
  mockUpstream(servers);
  await addProvider(provider.id, provider.host);
  await refresh(env, provider.id);
  vi.unstubAllGlobals();
});

async function pkce() {
  const verifier = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: new Uint8Array(digest).toBase64({ alphabet: "base64url", omitPadding: true }),
  };
}

/** The origin the Worker is reached on, and the `env` object the isolate hands to each request. */
type Site = { origin: string; env: Env };
const HOME: Site = { origin: ORIGIN, env };

async function register(name = "Claude", redirect = CLAUDE, site = HOME): Promise<string> {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  };
  const response = await send(`${site.origin}/oauth/register`, init, site.env);
  expect(response.status).toBe(201);
  return (await response.json<{ client_id: string }>()).client_id;
}

type Flow = { clientId: string; redirect: string; verifier: string; query: string; site: Site };

async function start(
  clientId: string,
  redirect: string,
  extra: Record<string, string> = {},
  site = HOME,
): Promise<Flow> {
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: "mcp",
    state: "the-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${site.origin}/mcp`,
    ...extra,
  }).toString();
  return { clientId, redirect, verifier, query, site };
}

/** GET /authorize: the page, its single-use handle and the cookie that binds it to this browser. */
async function open(flow: Flow, cookie = "") {
  const url = `${flow.site.origin}/authorize?${flow.query}`;
  const response = await send(url, { headers: cookie ? { Cookie: cookie } : {} }, flow.site.env);
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const bound = String(response.headers.get("Set-Cookie")).split(";")[0];
  return { response, html, handle, bound };
}

function post(flow: Flow, fields: Record<string, string>, cookie: string, ip = freshIp()) {
  const init = {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": ip,
    },
    body: new URLSearchParams(fields).toString(),
  };
  return send(`${flow.site.origin}/authorize?${flow.query}`, init, flow.site.env);
}

function token(fields: Record<string, string>, site = HOME) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
  return send(`${site.origin}/oauth/token`, init, site.env);
}

type Tokens = { access_token: string; refresh_token: string; resource: string };

/** The whole flow as the owner: page, password, approve, code, token exchange. */
async function connect(flow: Flow): Promise<Tokens> {
  const page = await open(flow);
  const approved = await post(
    flow,
    { handle: page.handle, password: env.OWNER_PASSWORD, decision: "approve" },
    page.bound,
  );
  expect(approved.status).toBe(302);
  const location = new URL(String(approved.headers.get("Location")));
  expect(location.href.split("?")[0]).toBe(flow.redirect);
  expect(location.searchParams.get("state")).toBe("the-state");
  const exchanged = await token(
    {
      grant_type: "authorization_code",
      code: String(location.searchParams.get("code")),
      redirect_uri: flow.redirect,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
    },
    flow.site,
  );
  expect(exchanged.status).toBe(200);
  return exchanged.json<Tokens>();
}

async function mcp(
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
  site = HOME,
) {
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  };
  const response = await send(`${site.origin}/mcp`, init, site.env);
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC results are checked field by field
  const body: any = response.status === 200 ? await response.json() : null;
  return { status: response.status, body };
}

describe("discovery", () => {
  it("challenges an unauthenticated /mcp and publishes both metadata documents", async () => {
    const challenge = await send("/mcp", { method: "POST", body: "{}" });
    expect(challenge.status).toBe(401);
    const challenged = challenge.headers.get("WWW-Authenticate") ?? "";
    expect(challenged.startsWith("Bearer ")).toBe(true);
    expect(challenged).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resource = await (await send("/.well-known/oauth-protected-resource/mcp")).json<
      Record<string, unknown>
    >();
    expect(resource.resource).toBe(`${ORIGIN}/mcp`);
    expect(resource.authorization_servers).toEqual([ORIGIN]);
    const server = await (await send("/.well-known/oauth-authorization-server")).json<
      Record<string, unknown>
    >();
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
    expect(server.token_endpoint_auth_methods_supported).toContain("none");
  });
});

describe("authorization code flow", () => {
  it("registers a public client, shows the consent page and ends in working MCP calls", async () => {
    const clientId = await register(`Claude <script>alert("x")</script>`);
    const flow = await start(clientId, CLAUDE);
    const page = await open(flow);
    expect(page.response.status).toBe(200);
    expect(page.html).toContain("Claude &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;");
    expect(page.html).not.toContain("<script>alert");
    expect(page.html).toContain('<code class="host">claude.ai</code>');
    expect(page.html).not.toContain("an app on this computer");
    expect(page.html).toContain('type="password"');
    expect(page.html).toMatch(
      /href="\/theme.css"[\s\S]*href="\/authorize.css"[\s\S]*src="\/theme.js"/,
    );
    expect(page.response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.response.headers.get("Content-Security-Policy")).not.toContain("form-action");
    expect(page.response.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");

    const { access_token } = await connect(flow);
    const init = await mcp(access_token, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
    });
    expect(init.body.result.serverInfo.name).toBe("gator");
    const list = await mcp(access_token, "tools/list");
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "search_tools",
      "describe_tool",
      "call_tool",
    ]);
    const search = await mcp(access_token, "tools/call", {
      name: "search_tools",
      arguments: { query: "look up record" },
    });
    const found = JSON.parse(search.body.result.content[0].text);
    expect(found.tools.map((t: { id: string }) => t.id)).toEqual([`${provider.id}.lookup`]);
  });

  it("accepts Claude Code's metadata document with any loopback port", async () => {
    for (const redirect of ["http://localhost:54321/callback", "http://127.0.0.1:61000/callback"]) {
      const flow = await start(CLAUDE_CODE, redirect);
      const page = await open(flow);
      expect(page.html).toContain('<strong class="client">Claude Code</strong>');
      expect(page.html).toContain('<code class="host">claude.ai</code>'); // the published domain
      expect(page.html).toContain("This is an app on this computer.");
      const { access_token } = await connect(flow);
      expect((await mcp(access_token, "tools/list")).status).toBe(200);
    }
    // Told apart from Claude Code on another computer only by when it connected.
    const { call } = await signIn();
    const listed = (await call("GET", "/api/agents")).body.filter(
      (a: { client_name: string }) => a.client_name === "Claude Code",
    );
    expect(listed.map((a: { via: string }) => a.via)).toEqual(["computer", "computer"]);
  });

  it("rotates refresh tokens, refuses dead ones and form-less token requests", async () => {
    const clientId = await register();
    const first = await connect(await start(clientId, CLAUDE));
    const refreshWith = (refresh_token: string) =>
      token({ grant_type: "refresh_token", refresh_token, client_id: clientId });
    const second = await (await refreshWith(first.refresh_token)).json<Tokens>();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(second.access_token, "tools/list")).status).toBe(200);
    const third = await refreshWith(second.refresh_token);
    expect(third.status).toBe(200);
    // Once its replacement has been used, the first token is dead.
    const dead = await refreshWith(first.refresh_token);
    expect([dead.status, (await dead.json<{ error: string }>()).error]).toEqual([
      400,
      "invalid_grant",
    ]);
    const garbage = await refreshWith("owner:nope:nothing");
    expect([garbage.status, (await garbage.json<{ error: string }>()).error]).toEqual([
      400,
      "invalid_grant",
    ]);
    const asJson = await send("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: second.refresh_token,
        client_id: clientId,
      }),
    });
    expect(asJson.status).toBe(400);
  });
});

describe("the consent page", () => {
  it("re-renders on a wrong password with a fresh handle and issues no code", async () => {
    const flow = await start(await register(), CLAUDE);
    const page = await open(flow);
    const wrong = await post(
      flow,
      { handle: page.handle, password: "guess", decision: "approve" },
      page.bound,
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("Location")).toBeNull();
    const html = await wrong.text();
    expect(html).toContain("Wrong password.");
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();
    expect(handle).not.toBe(page.handle);
    const bound = String(wrong.headers.get("Set-Cookie")).split(";")[0];
    const right = await post(
      flow,
      { handle: String(handle), password: env.OWNER_PASSWORD, decision: "approve" },
      bound,
    );
    expect(new URL(String(right.headers.get("Location"))).searchParams.get("code")).toBeTruthy();
  });

  it("rate limits password attempts before checking them", async () => {
    const flow = await start(await register(), CLAUDE);
    const page = await open(flow);
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await post(
            flow,
            { handle: page.handle, password: "guess", decision: "approve" },
            page.bound,
            ip,
          )
        ).status,
      ).toBe(401);
    }
    const limited = await post(
      flow,
      { handle: page.handle, password: env.OWNER_PASSWORD, decision: "approve" },
      page.bound,
      ip,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Location")).toBeNull();
  });

  it("redirects a denial back to the client with access_denied", async () => {
    const flow = await start(await register(), CLAUDE);
    const page = await open(flow);
    const denied = await post(flow, { handle: page.handle, decision: "deny" }, page.bound);
    expect(denied.status).toBe(302);
    const location = new URL(String(denied.headers.get("Location")));
    expect(location.origin + location.pathname).toBe(CLAUDE);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("the-state");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("refuses a reused handle, a handle from another browser and a made-up one", async () => {
    const flow = await start(await register(), CLAUDE);
    const a = await open(flow);
    const b = await open(flow);
    const approve = (handle: string, cookie: string) =>
      post(flow, { handle, password: env.OWNER_PASSWORD, decision: "approve" }, cookie);
    for (const response of [await approve(a.handle, b.bound), await approve("forged", a.bound)]) {
      expect([response.status, response.headers.get("Location")]).toEqual([400, null]);
    }
    expect((await approve(a.handle, a.bound)).status).toBe(302);
    const replay = await approve(a.handle, a.bound);
    expect([replay.status, replay.headers.get("Location")]).toEqual([400, null]);
    expect(await replay.text()).toContain("expired or was already used");
  });

  it("lets a dashboard session skip the password but not the consent", async () => {
    const { cookie } = await signIn();
    const flow = await start(await register(), CLAUDE);
    const page = await open(flow, cookie);
    expect(page.html).not.toContain('type="password"');
    expect(page.html).toContain('value="approve"');
    expect(page.response.headers.get("Location")).toBeNull();
    const approved = await post(
      flow,
      { handle: page.handle, decision: "approve" },
      `${page.bound}; ${cookie}`,
    );
    expect(new URL(String(approved.headers.get("Location"))).searchParams.get("code")).toBeTruthy();
  });

  it("redirects request errors only when the redirect URI is trusted", async () => {
    const clientId = await register();
    const plain = await open(await start(clientId, CLAUDE, { code_challenge_method: "plain" }));
    expect(plain.response.status).toBe(302);
    expect(new URL(String(plain.response.headers.get("Location"))).searchParams.get("error")).toBe(
      "invalid_request",
    );
    for (const flow of [
      await start("unknown-client", CLAUDE),
      await start(clientId, "https://evil.example.com/cb"),
    ]) {
      const page = await open(flow);
      expect([page.response.status, page.response.headers.get("Location")]).toEqual([400, null]);
      expect(page.html).toContain("<h1>Cannot connect</h1>");
    }
  });
});

describe("agents", () => {
  it("are grants: one client authorised twice is two agents, usage is theirs, and revoking cuts one off", async () => {
    const { call } = await signIn();
    const before = new Set(
      (await call("GET", "/api/agents")).body.map((a: { id: string }) => a.id),
    );
    const clientId = await register("Twice");
    const one = await connect(await start(clientId, CLAUDE));
    const two = await connect(await start(clientId, CLAUDE));
    const grant = one.access_token.split(":")[1];
    const listed = (await call("GET", "/api/agents")).body.filter(
      (a: { id: string }) => !before.has(a.id),
    );
    expect(listed.map((a: { id: string }) => a.id).sort()).toEqual(
      [grant, two.access_token.split(":")[1]].sort(),
    );
    expect(listed.map((a: { client_name: string }) => a.client_name)).toEqual(["Twice", "Twice"]);
    expect(listed.find((a: { id: string }) => a.id === grant)).toMatchObject({
      last_used_at: null,
      via: "claude.ai",
      calls: { d1: 0, d7: 0, d30: 0, d90: 0 },
    });
    expect((await mcp(one.access_token, "tools/list")).status).toBe(200);
    expect((await mcp(two.access_token, "tools/list")).status).toBe(200);
    // Yesterday counts in the ranges, not in today's calls.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO usage_daily VALUES (?, ?, ?, 'lookup', 1, 0, 0)")
      .bind(yesterday, grant, provider.id)
      .run();

    const called = await mcp(one.access_token, "tools/call", {
      name: "call_tool",
      arguments: { id: `${provider.id}.lookup` },
    });
    expect(called.body.result.content[0].text).toBe("ok");
    const agent = (await call("GET", "/api/agents")).body.find(
      (a: { id: string }) => a.id === grant,
    );
    expect(agent.last_used_at).toBeGreaterThan(0);
    expect(agent.calls).toEqual({ d1: 1, d7: 2, d30: 2, d90: 2 });
    const overview = (await call("GET", "/api/overview")).body;
    const row = (body: { agents: { id: string }[] }) => body.agents.find((a) => a.id === grant);
    expect(row(overview)).toMatchObject({
      client_name: "Twice",
      connected_at: agent.connected_at,
      via: "claude.ai",
      revoked: false,
      d30: { calls: 2, errors: 0 },
    });
    expect(overview.recent[0]).toMatchObject({
      agent: "Twice",
      tool_id: `${provider.id}.lookup`,
      status: "ok",
    });

    expect((await call("DELETE", `/api/agents/${grant}`)).status).toBe(204);
    expect((await mcp(one.access_token, "tools/list")).status).toBe(401);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: one.refresh_token,
      client_id: clientId,
    });
    expect((await refreshed.json<{ error: string }>()).error).toBe("invalid_grant");
    expect((await mcp(two.access_token, "tools/list")).status).toBe(200);
    expect((await call("GET", "/api/agents")).body.map((a: { id: string }) => a.id)).not.toContain(
      grant,
    );
    // Its usage stays, under the name it was saved with.
    expect(row((await call("GET", "/api/overview")).body)).toMatchObject({
      client_name: "Twice",
      via: null,
      revoked: true,
      d30: { calls: 2 },
    });
  });
});

describe("two origins", () => {
  it("are two resources, in either order: each has its own metadata and tokens, valid only there", async () => {
    const OTHER = "https://gator.other-example.com";
    for (const order of [
      [ORIGIN, OTHER],
      [OTHER, ORIGIN],
    ]) {
      // One `env` object for both origins, as an isolate shares it; fresh per order, as a new isolate.
      const shared = { ...env };
      const [first, second] = order.map((origin) => ({ origin, env: shared }));
      const tokens: string[] = [];
      for (const site of [first, second]) {
        const metadata = await send(
          `${site.origin}/.well-known/oauth-protected-resource/mcp`,
          {},
          shared,
        );
        expect(await metadata.json()).toMatchObject({
          resource: `${site.origin}/mcp`,
          authorization_servers: [site.origin],
        });
        const flow = await start(await register("Claude", CLAUDE, site), CLAUDE, {}, site);
        const issued = await connect(flow);
        expect(issued.resource).toBe(`${site.origin}/mcp`);
        expect((await mcp(issued.access_token, "tools/list", {}, site)).status).toBe(200);
        tokens.push(issued.access_token);
      }
      expect((await mcp(tokens[0], "tools/list", {}, second)).status).toBe(401);
      expect((await mcp(tokens[1], "tools/list", {}, first)).status).toBe(401);
    }
  });
});
