import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, listTools, type UpstreamError } from "../src/upstream";
import { readOnly, unique } from "./helpers";
import { mockUpstream, type Server } from "./mock-upstream";

afterEach(() => vi.unstubAllGlobals());

function setup(server: Partial<Server> = {}) {
  const { id, host } = unique();
  const mock = mockUpstream({ [host]: { era: "session", tools: [readOnly("a")], ...server } });
  const upstream = {
    id,
    url: `https://${host}/mcp`,
    auth: { header: "X-Key", value: "k1" },
    timeoutMs: 200,
  };
  const methods = () => mock.log.map((entry) => entry.method);
  return { ...mock, upstream, host, methods };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: UpstreamError) => ({ status: error.status, message: error.message }),
  );

describe("legacy servers with sessions", () => {
  it("initializes once, sends the session and the negotiated version, and reuses the session", async () => {
    const { upstream, log, methods } = setup({ key: ["X-Key", "k1"] });
    expect((await listTools(upstream)).tools).toHaveLength(1);
    expect(await callTool(upstream, "a", {}, {})).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(methods()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(log[0].body).toMatchObject({ params: { protocolVersion: "2025-11-25" } });
    for (const entry of log.slice(1)) {
      expect(entry.headers.get("Mcp-Session-Id")).toBe("session-1");
      expect(entry.headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
    }
    for (const entry of log) {
      expect(entry.headers.get("Accept")).toBe("application/json, text/event-stream");
      expect(entry.redirect).toBe("manual");
    }
  });

  it("re-initializes after the session expired and sends the request once more", async () => {
    const { upstream, methods, expireSessions, log } = setup();
    await listTools(upstream);
    expireSessions();
    await callTool(upstream, "a", {}, {});
    expect(methods()).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(log.at(-1)?.headers.get("Mcp-Session-Id")).toBe("session-2");
  });

  it("does not resend a second time when the new session fails too", async () => {
    const { upstream } = setup();
    await listTools(upstream);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body.method);
      if (body.method === "initialize") {
        const headers = { "Mcp-Session-Id": "new" };
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers });
      }
      return new Response(null, { status: body.method === "tools/call" ? 404 : 202 });
    });
    expect(await failure(callTool(upstream, "a", {}, {}))).toEqual({
      status: "upstream_error",
      message: "HTTP 404",
    });
    expect(sent).toEqual(["tools/call", "initialize", "notifications/initialized", "tools/call"]);
  });

  it("reads event streams, skipping the priming event and notifications", async () => {
    const { upstream } = setup({ sse: true });
    expect(await callTool(upstream, "a", {}, {})).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("follows nextCursor", async () => {
    const tools = ["a", "b", "c", "d", "e"].map((name) => readOnly(name));
    const { upstream, methods } = setup({ tools, pageSize: 2 });
    expect((await listTools(upstream)).tools.map((t) => (t as { name: string }).name)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(methods().filter((m) => m === "tools/list")).toHaveLength(3);
  });
});

describe("the tool list digest", () => {
  it("is the same for the same list whatever the request id and the server's layout", async () => {
    const { upstream } = setup();
    let tools = [readOnly("a")];
    vi.stubGlobal("fetch", async (_: RequestInfo, init?: RequestInit) => {
      const { id, method } = JSON.parse(String(init?.body));
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      // Result first and pretty-printed, as some servers write it; the id is last.
      const text = JSON.stringify({ result: { tools }, jsonrpc: "2.0", id }, null, 1);
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    });
    const first = await listTools(upstream);
    const second = await listTools(upstream);
    expect(second.digest).toBe(first.digest);
    tools = [readOnly("a", "Changed")];
    expect((await listTools(upstream)).digest).not.toBe(first.digest);
  });
});

describe("other generations", () => {
  it("talks to a stateless legacy server without a session ID", async () => {
    const { upstream, log } = setup({ era: "stateless" });
    await callTool(upstream, "a", {}, {});
    expect(log.map((entry) => entry.headers.get("Mcp-Session-Id"))).toEqual([null, null, null]);
  });

  it("detects a current-spec server and sends _meta and the Mcp-* headers, with no handshake after", async () => {
    const { upstream, log, methods } = setup({ era: "current" });
    await listTools(upstream);
    await callTool(
      upstream,
      "a",
      { region: "eu", page: 2, query: "café" },
      { Region: "eu", Page: 2, Query: "café" },
    );
    expect(methods()).toEqual(["initialize", "tools/list", "tools/call"]);
    const call = log[2];
    expect(call.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(call.headers.get("Mcp-Method")).toBe("tools/call");
    expect(call.headers.get("Mcp-Name")).toBe("a");
    expect(call.headers.get("Mcp-Param-Region")).toBe("eu");
    expect(call.headers.get("Mcp-Param-Page")).toBe("2");
    expect(call.headers.get("Mcp-Param-Query")).toBe(`=?base64?${btoa("caf\xc3\xa9")}?=`);
    expect(call.body).toMatchObject({
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
  });
});

describe("failures", () => {
  it("classifies 401, 429, other statuses and JSON-RPC errors, and never retries", async () => {
    const cases: [Response | unknown, object][] = [
      [new Response(null, { status: 401 }), { status: "auth" }],
      [new Response(null, { status: 403 }), { status: "auth" }],
      [new Response(null, { status: 429 }), { status: "rate_limited" }],
      [
        new Response("<html>oops</html>", { status: 502 }),
        { status: "upstream_error", message: "HTTP 502" },
      ],
      [
        Response.json(
          { jsonrpc: "2.0", id: 0, error: { code: -32000, message: "Quota for this tool" } },
          { status: 500 },
        ),
        { status: "upstream_error", message: "Quota for this tool" },
      ],
      [
        Response.json({ jsonrpc: "2.0", id: 9, error: { code: -32602, message: "Bad input" } }),
        { status: "upstream_error", message: "Bad input" },
      ],
      [
        new Response("not json", { headers: { "Content-Type": "application/json" } }),
        { status: "upstream_error", message: "an unreadable response" },
      ],
    ];
    for (const [answer, expected] of cases) {
      const { upstream, methods } = setup({ call: () => answer });
      expect(await failure(callTool(upstream, "a", {}, {}))).toMatchObject(expected);
      expect(methods().filter((m) => m === "tools/call")).toHaveLength(1);
    }
  });

  it("times out a hanging call once, without retrying", async () => {
    const { upstream, methods } = setup({ call: () => "hang" });
    expect(await failure(callTool(upstream, "a", {}, {}))).toMatchObject({ status: "timeout" });
    expect(methods().filter((m) => m === "tools/call")).toHaveLength(1);
  });

  it("treats a network failure as a timeout", async () => {
    const { upstream } = setup();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Network connection lost.")));
    expect(await failure(listTools(upstream))).toMatchObject({ status: "timeout" });
  });

  it("does not follow a redirect", async () => {
    const { upstream, log } = setup({ redirect: "https://elsewhere.example.com/mcp" });
    expect(await failure(listTools(upstream))).toEqual({
      status: "upstream_error",
      message: "HTTP 302",
    });
    expect(log.map((entry) => entry.host)).toEqual([new URL(upstream.url).host]);
  });
});
