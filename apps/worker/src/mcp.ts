import { getState, type State } from "./state";
import { RPC } from "./text";
import { runTool } from "./tools";
import { CURRENT_VERSION, GATOR } from "./upstream";
import type { Agent } from "./usage";

const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** How long clients may cache the tool list: the only change signal a stateless server has. */
const LIST_TTL_MS = 300_000;

/** What the OAuth provider adds to the context: the grant's props and the access token. */
type Grant = { props: { clientName: string; connectedAt: number }; auth: { token: string } };
type Params = Record<string, unknown>;

/** `POST /mcp`, behind the OAuth provider: both protocol generations, JSON responses, no sessions. */
export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const message = await request.json().catch(() => undefined);
    if (Array.isArray(message)) return error(null, -32600, RPC.batch, 400);
    if (!isObject(message) || typeof message.method !== "string") {
      return error(null, -32600, RPC.invalid, 400);
    }
    // Notifications need no answer; the current revision defines none for clients to send.
    if (message.id === undefined) return new Response(null, { status: 202 });
    const id = message.id;
    const method = message.method;
    const params = isObject(message.params) ? message.params : {};
    const { props, auth } = ctx as unknown as Grant;
    // The token is `userId:grantId:secret`; the grant is the agent.
    const agent: Agent = { id: auth.token.split(":")[1], ...props };
    const meta = isObject(params._meta) ? params._meta : {};
    const version = meta["io.modelcontextprotocol/protocolVersion"];
    if (version === undefined) return legacy(id, method, params, env, ctx, agent);

    if (version !== CURRENT_VERSION) {
      return error(id, -32022, RPC.version, 400, {
        supported: [CURRENT_VERSION],
        requested: version,
      });
    }
    if (!isObject(meta["io.modelcontextprotocol/clientCapabilities"])) {
      return error(id, -32602, RPC.capabilities, 400);
    }
    const headers = request.headers;
    const nameMatches =
      method !== "tools/call" || decodeHeader(headers.get("Mcp-Name")) === params.name;
    if (
      headers.get("MCP-Protocol-Version") !== version ||
      headers.get("Mcp-Method") !== method ||
      !nameMatches
    ) {
      return error(id, -32020, RPC.headers, 400);
    }
    const state = await getState(env, ctx);
    if (method === "server/discover") {
      const discover = {
        resultType: "complete",
        supportedVersions: [CURRENT_VERSION],
        capabilities: { tools: {} },
        instructions: state.instructions,
        ttlMs: LIST_TTL_MS,
        cacheScope: "private",
        _meta: { "io.modelcontextprotocol/serverInfo": GATOR },
      };
      return reply(id, JSON.stringify(discover));
    }
    if (method === "tools/list") {
      const list = `{"resultType":"complete","tools":${state.toolList},"ttlMs":${LIST_TTL_MS},"cacheScope":"private"}`;
      return reply(id, list);
    }
    if (method === "tools/call") return call(id, params, state, env, ctx, agent, true);
    return error(id, -32601, RPC.unknownMethod(method), 404);
  },
};

async function legacy(
  id: unknown,
  method: string,
  params: Params,
  env: Env,
  ctx: ExecutionContext,
  agent: Agent,
) {
  if (method === "ping") return reply(id, "{}");
  const state = await getState(env, ctx);
  if (method === "initialize") {
    const requested = params.protocolVersion;
    const result = {
      protocolVersion: LEGACY_VERSIONS.find((v) => v === requested) ?? LEGACY_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: GATOR,
      instructions: state.instructions,
    };
    return reply(id, JSON.stringify(result));
  }
  if (method === "tools/list") return reply(id, `{"tools":${state.toolList}}`);
  if (method === "tools/call") return call(id, params, state, env, ctx, agent, false);
  return error(id, -32601, RPC.unknownMethod(method), 200);
}

async function call(
  id: unknown,
  params: Params,
  state: State,
  env: Env,
  ctx: ExecutionContext,
  agent: Agent,
  current: boolean,
) {
  const args = isObject(params.arguments) ? params.arguments : {};
  const result = await runTool(params.name, args, state, env, ctx, agent);
  if (!result) return error(id, -32602, RPC.unknownTool(params.name), 200);
  return reply(id, JSON.stringify(current ? { resultType: "complete", ...result } : result));
}

function reply(id: unknown, result: string): Response {
  return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${result}}`, {
    headers: { "Content-Type": "application/json" },
  });
}

function error(
  id: unknown,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message, data } }, { status });
}

function isObject(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Undoes the spec's `=?base64?…?=` form for header values that are not plain ASCII. */
function decodeHeader(value: string | null): string | null {
  const encoded = value?.match(/^=\?base64\?(.*)\?=$/)?.[1];
  if (encoded === undefined) return value;
  try {
    return new TextDecoder().decode(Uint8Array.fromBase64(encoded));
  } catch {
    return null;
  }
}
