import { vi } from "vitest";

/** A fake remote MCP server, reached by the Worker's own `fetch` to `https://<host>/mcp`. */
export type Server = {
  /** `session`: legacy with `initialize` and a session ID; `stateless`: legacy without one; `current`: 2026-07-28. */
  era: "session" | "stateless" | "current";
  tools: { name: string; description?: string; inputSchema: object; annotations?: object }[];
  /** A header the server requires, e.g. `["Authorization", "Bearer k"]`. */
  key?: [string, string];
  pageSize?: number;
  sse?: boolean;
  /** Answer for `tools/call`: a result object, a raw `Response`, or "hang" to never answer. */
  call?: (name: string, args: Record<string, unknown>, headers: Headers) => unknown;
  /** Answer every request with a redirect to this URL. */
  redirect?: string;
  /** An HTTP status to answer a request with instead (e.g. 429 for one key). */
  refuse?: (headers: Headers, method: string) => number | undefined;
  /** More tools for a request that carries this header: `[header, tools]`. */
  keyedTools?: [string, Server["tools"]];
};

export type Logged = {
  host: string;
  method: string | undefined;
  headers: Headers;
  redirect: string;
  body: unknown;
};

/** Replaces the global `fetch`. Every request is logged, including any to a host it does not know. */
export function mockUpstream(servers: Record<string, Server>) {
  const log: Logged[] = [];
  const sessions = new Set<string>();
  let issued = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    const host = new URL(request.url).host;
    const body = (await request.json().catch(() => null)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown> & {
        name?: string;
        arguments?: Record<string, unknown>;
        cursor?: string;
      };
    } | null;
    log.push({
      host,
      method: body?.method,
      headers: request.headers,
      redirect: request.redirect,
      body,
    });
    const server = servers[host];
    if (!server) return new Response("unexpected host", { status: 599 });
    if (server.redirect)
      return new Response(null, { status: 302, headers: { Location: server.redirect } });
    if (server.key && request.headers.get(server.key[0]) !== server.key[1])
      return new Response(null, { status: 401 });
    const refused = server.refuse?.(request.headers, body?.method ?? "");
    if (refused) return new Response(null, { status: refused });
    const method = body?.method ?? "";
    const params = body?.params ?? {};
    const answer = (result: unknown, headers: Record<string, string> = {}) =>
      respond({ jsonrpc: "2.0", id: body?.id, result }, server.sse, headers);

    if (server.era === "current") {
      if (method === "initialize") return rpcError(body?.id, -32022, "Use 2026-07-28", 400);
      const meta = params._meta as Record<string, unknown> | undefined;
      const headersMatch =
        meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28" &&
        request.headers.get("MCP-Protocol-Version") === "2026-07-28" &&
        request.headers.get("Mcp-Method") === method &&
        (method !== "tools/call" || request.headers.get("Mcp-Name") === params.name);
      if (!headersMatch) return rpcError(body?.id, -32020, "Header mismatch", 400);
    } else if (method === "initialize") {
      const headers: Record<string, string> = {};
      if (server.era === "session") {
        headers["Mcp-Session-Id"] = `session-${++issued}`;
        sessions.add(headers["Mcp-Session-Id"]);
      }
      const result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1" },
      };
      return answer(result, headers);
    } else if (server.era === "session") {
      const session = request.headers.get("Mcp-Session-Id");
      if (!session) return rpcError(body?.id, -32600, "Missing mcp-session-id header", 400);
      if (!sessions.has(session)) return new Response(null, { status: 404 });
    }
    if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
    if (method === "tools/list") {
      const keyed = server.keyedTools && request.headers.has(server.keyedTools[0]);
      const tools = keyed ? [...server.tools, ...(server.keyedTools?.[1] ?? [])] : server.tools;
      const start = Number(params.cursor ?? 0);
      const end = start + (server.pageSize ?? tools.length);
      const page = tools.slice(start, end);
      return answer(
        end < tools.length ? { tools: page, nextCursor: String(end) } : { tools: page },
      );
    }
    if (method === "tools/call") {
      const result = server.call?.(
        String(params.name),
        params.arguments ?? {},
        request.headers,
      ) ?? {
        content: [{ type: "text", text: "ok" }],
      };
      if (result instanceof Response) return result;
      if (result === "hang") {
        return new Promise<Response>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason)),
        );
      }
      return answer(result);
    }
    return rpcError(body?.id, -32601, "Method not found", 200);
  });
  return { log, expireSessions: () => sessions.clear() };
}

function rpcError(id: unknown, code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

/** JSON, or an event stream with a priming event and a notification first, sent in uneven chunks. */
function respond(message: object, sse = false, headers: Record<string, string> = {}): Response {
  if (!sse) return Response.json(message, { headers });
  const events = `id: 1\ndata:\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\ndata: ${JSON.stringify(message)}\n\n`;
  const bytes = new TextEncoder().encode(events);
  const middle = Math.floor(bytes.length / 2);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream" } });
}
