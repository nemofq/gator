/** Where and how to reach one provider. `url` is always the provider's own `mcp_url`. */
type Upstream = {
  id: string;
  url: string;
  auth: { header: string; value: string } | null;
  timeoutMs: number;
  /** The provider's other key, used once if this one is refused for quota. */
  other?: { auth: Upstream["auth"]; switched: () => unknown };
  /** Text that marks a short `tools/call` result as a refusal for quota, from the catalog. */
  signals?: string[];
};

/** A provider's keys in the clear (null: none, or unreadable) and which one is in use. */
export type KeyPair = { primary: string | null; backup: string | null; onBackup: boolean };

export type ToolResult = {
  content?: { type: string; text?: string; resource?: { text?: string } }[];
  structuredContent?: unknown;
  isError?: boolean;
};

type FailureStatus = "auth" | "rate_limited" | "timeout" | "upstream_error";

export class UpstreamError extends Error {
  constructor(
    readonly status: FailureStatus,
    message = "",
  ) {
    super(message);
  }
}

type Message = { id?: unknown; result?: unknown; error?: { message?: unknown } };
/** A JSON-RPC result, the raw text of the message that carried it, and the request id it answers. */
type Answer = { result: unknown; text: string; id: number | undefined };
type Connection = { era: "legacy" | "current"; version: string; sessionId: string | null };

export const CURRENT_VERSION = "2026-07-28";
/** The `clientInfo` Gator sends upstream and the `serverInfo` it answers with. */
export const GATOR = { name: "gator", version: "0.1.2" };
const LEGACY_VERSION = "2025-11-25";
/** Stops a server that keeps answering with another cursor. */
const MAX_PAGES = 50;
/** A result longer than this is data, not a message about the key, and is never read for one. */
export const SHORT_TEXT = 2_000;

/** Per isolate: what each provider speaks and its session, learned on first contact. */
const connections = new Map<string, Connection>();
let lastId = 0;

/**
 * The provider reached with the key in use. When it has the other key too, a refusal for quota
 * switches to it: `keys.onBackup` changes in place and `switched` is told the new value.
 */
export function withKeys(
  upstream: Omit<Upstream, "auth" | "other">,
  auth: { header: string; format: string } | null | undefined,
  keys: KeyPair | undefined,
  switched: (onBackup: boolean) => unknown,
): Upstream {
  const onBackup = keys?.onBackup ?? false;
  const [inUse, other] = onBackup ? [keys?.backup, keys?.primary] : [keys?.primary, keys?.backup];
  const reached: Upstream = { ...upstream, auth: authHeader(auth, inUse) };
  if (keys && other && auth) {
    // Set, not flipped: concurrent requests refused with the same key all switch to the other.
    const use = () => {
      keys.onBackup = !onBackup;
      return switched(!onBackup);
    };
    reached.other = { auth: authHeader(auth, other), switched: use };
  }
  return reached;
}

/** The auth header with the key filled in, or null when there is no key to send. */
function authHeader(
  auth: { header: string; format: string } | null | undefined,
  key: string | null | undefined,
): Upstream["auth"] {
  if (!auth || !key) return null;
  return { header: auth.header, value: auth.format.replaceAll("{key}", () => key) };
}

/**
 * Every tool the provider lists, following `nextCursor`, and a SHA-256 digest of the raw pages,
 * which is the same whenever the server sends the same list.
 */
export async function listTools(upstream: Upstream): Promise<{ tools: unknown[]; digest: string }> {
  const tools: unknown[] = [];
  let pages = "";
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { result, text, id } = await request(upstream, "tools/list", cursor ? { cursor } : {});
    const { tools: listed, nextCursor } = result as { tools?: unknown[]; nextCursor?: string };
    tools.push(...(listed ?? []));
    // The echoed id counts Gator's requests, so it is left out of the digest.
    pages += text.replace(new RegExp(`"id"\\s*:\\s*${id}\\b`), "");
    cursor = nextCursor;
    if (!cursor) break;
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pages));
  return { tools, digest: new Uint8Array(hash).toBase64() };
}

/** One `tools/call`. `headerParams` are the arguments a current-spec server expects as headers. */
export async function callTool(
  upstream: Upstream,
  name: string,
  args: unknown,
  headerParams: Record<string, unknown>,
): Promise<ToolResult> {
  const answer = await request(upstream, "tools/call", { name, arguments: args }, headerParams);
  return answer.result as ToolResult;
}

async function request(
  upstream: Upstream,
  method: string,
  params: Record<string, unknown>,
  headerParams: Record<string, unknown> = {},
): Promise<Answer> {
  try {
    let connection = connections.get(upstream.id) ?? (await connect(upstream));
    let sent: Awaited<ReturnType<typeof post>>;
    if (connection.era === "current") {
      const headers: Record<string, string> = {
        "MCP-Protocol-Version": CURRENT_VERSION,
        "Mcp-Method": method,
      };
      if (typeof params.name === "string") headers["Mcp-Name"] = headerValue(params.name);
      for (const [name, value] of Object.entries(headerParams)) {
        headers[`Mcp-Param-${name}`] = headerValue(String(value));
      }
      const _meta = {
        "io.modelcontextprotocol/protocolVersion": CURRENT_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": GATOR,
      };
      sent = await post(upstream, method, { ...params, _meta }, headers);
    } else {
      sent = await post(upstream, method, params, sessionHeaders(connection));
      if (sent.response.status === 404 && connection.sessionId) {
        // The session expired, so the server did not process the request: the one allowed repeat.
        await sent.response.body?.cancel();
        connection = await connect(upstream);
        sent = await post(upstream, method, params, sessionHeaders(connection));
      }
    }
    const answer = await result(sent);
    // A provider that answers an exhausted key with a result is refused here like a 429.
    if (upstream.signals && method === "tools/call") {
      const text = shortText(answer.result as ToolResult);
      if (text !== null && upstream.signals.some((signal) => text.includes(signal)))
        throw new UpstreamError("rate_limited", text);
    }
    return answer;
  } catch (error) {
    // Learn the provider afresh next time: its key, session or protocol may have changed.
    connections.delete(upstream.id);
    const other = upstream.other;
    if (!other || !(error instanceof UpstreamError && error.status === "rate_limited")) throw error;
    // The one switch, and the one repeat of a call: a refusal for quota means it was not run.
    // The later pages of a tool list keep the new key, and nothing switches back.
    upstream.auth = other.auth;
    upstream.other = undefined;
    await other.switched();
    return request(upstream, method, params, headerParams);
  }
}

/** The text items of a result, joined, or null once they pass `SHORT_TEXT` characters. */
export function shortText(result: ToolResult): string | null {
  let text = "";
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    if (text.length > SHORT_TEXT) return null;
  }
  return text;
}

/** Legacy first: `initialize`, which a current-spec server refuses with 400, 404 or 405. */
async function connect(upstream: Upstream): Promise<Connection> {
  const params = { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: GATOR };
  const sent = await post(upstream, "initialize", params);
  let connection: Connection;
  if ([400, 404, 405].includes(sent.response.status)) {
    await sent.response.body?.cancel();
    connection = { era: "current", version: CURRENT_VERSION, sessionId: null };
  } else {
    const sessionId = sent.response.headers.get("Mcp-Session-Id");
    const { protocolVersion } = (await result(sent)).result as { protocolVersion?: unknown };
    const version = typeof protocolVersion === "string" ? protocolVersion : LEGACY_VERSION;
    connection = { era: "legacy", version, sessionId };
    const { response } = await post(
      upstream,
      "notifications/initialized",
      undefined,
      sessionHeaders(connection),
    );
    await response.body?.cancel();
    if (!response.ok) throw failure(response.status, "");
  }
  connections.set(upstream.id, connection);
  return connection;
}

function sessionHeaders(connection: Connection): Record<string, string> {
  const headers: Record<string, string> = { "MCP-Protocol-Version": connection.version };
  if (connection.sessionId) headers["Mcp-Session-Id"] = connection.sessionId;
  return headers;
}

/** One POST, with a fresh id unless it is a notification. A network failure or the timeout is `timeout`. */
async function post(
  upstream: Upstream,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ response: Response; id: number | undefined }> {
  const id = method.startsWith("notifications/") ? undefined : ++lastId;
  const all: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...headers,
  };
  if (upstream.auth) all[upstream.auth.header] = upstream.auth.value;
  try {
    const response = await fetch(upstream.url, {
      method: "POST",
      headers: all,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual",
      signal: AbortSignal.timeout(upstream.timeoutMs),
    });
    return { response, id };
  } catch {
    throw new UpstreamError("timeout");
  }
}

/** The JSON-RPC result, read from a JSON body or from an event stream. Redirects are errors. */
async function result({
  response,
  id,
}: {
  response: Response;
  id: number | undefined;
}): Promise<Answer> {
  if (!response.ok || response.status === 202) {
    throw failure(response.status, await response.text().catch(() => ""));
  }
  let text: string;
  let message: Message;
  try {
    const stream = response.headers.get("Content-Type")?.startsWith("text/event-stream");
    if (stream) ({ text, message } = await fromEventStream(response, id));
    else {
      text = await response.text();
      message = JSON.parse(text);
    }
  } catch (error) {
    // A body that stops arriving is the timeout or a dropped connection; anything else is garbled.
    if (error instanceof SyntaxError)
      throw new UpstreamError("upstream_error", "an unreadable response");
    throw new UpstreamError("timeout");
  }
  if (message?.error) {
    throw new UpstreamError(
      "upstream_error",
      String(message.error.message || "an error without a message"),
    );
  }
  if (typeof message?.result !== "object" || message.result === null) {
    throw new UpstreamError("upstream_error", "an unreadable response");
  }
  return { result: message.result, text, id };
}

function failure(status: number, body: string): UpstreamError {
  if (status === 401 || status === 403) return new UpstreamError("auth");
  if (status === 429 || status === 402) return new UpstreamError("rate_limited");
  let message = `HTTP ${status}`;
  try {
    const error = JSON.parse(body)?.error?.message;
    if (typeof error === "string" && error) message = error;
  } catch {}
  return new UpstreamError("upstream_error", message);
}

/** Reads server-sent events until the message that answers `id`, then closes the stream. */
async function fromEventStream(
  response: Response,
  id: number | undefined,
): Promise<{ text: string; message: Message }> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let data: string[] = [];
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (buffer + value).split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      else if (line === "") {
        const text = data.join("\n");
        data = [];
        // A priming event has an empty data field.
        if (!text) continue;
        const message = JSON.parse(text) as Message;
        if (message.id === id && ("result" in message || "error" in message)) {
          await reader.cancel();
          return { text, message };
        }
      }
    }
  }
  throw new SyntaxError("The event stream ended before the response.");
}

/** Header-safe values go as they are, anything else in the spec's base64 form. */
function headerValue(value: string): string {
  const safe = /^(?:[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?)?$/.test(value);
  if (safe && !(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  return `=?base64?${new TextEncoder().encode(value).toBase64()}?=`;
}
