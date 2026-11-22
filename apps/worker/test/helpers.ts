import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { encryptKey, keys } from "../src/crypto";
import worker from "../src/index";
import { mcpHandler } from "../src/mcp";
import { migrate } from "../src/schema";
import { invalidate } from "../src/state";

export const GRANT = "grant123";
export const AGENT_NAME = "Test Agent";

let count = 0;
/** A provider ID and host no other test in the file uses, so cached sessions never carry over. */
export function unique(prefix = "p"): { id: string; host: string } {
  count += 1;
  return { id: `${prefix}${count}`, host: `${prefix}${count}.example.com` };
}

/**
 * Stores an enabled custom provider for `https://<host>/mcp`, as the dashboard API will, or with
 * `catalog` only the row of a catalog provider whose manifest the test put in the catalog.
 */
export async function addProvider(
  id: string,
  host: string,
  options: {
    key?: string;
    backup?: string;
    auth?: { header: string; format: string };
    timeoutMs?: number;
    enabled?: boolean;
    catalog?: boolean;
    review?: boolean;
  } = {},
) {
  const manifest = {
    name: `Name ${id}`,
    description: `Data from ${id}`,
    mcp_url: `https://${host}/mcp`,
    auth: options.auth,
    key_required: options.auth !== undefined,
  };
  await migrate(env.DB);
  const k = await keys(env);
  const key = options.key ? await encryptKey(k, id, options.key) : null;
  const backup = options.backup ? await encryptKey(k, `${id}:backup`, options.backup) : null;
  await env.DB.prepare(
    `INSERT INTO providers (id, manifest, enabled, key, key_check, key_last4, timeout_ms, backup_key, backup_key_check, backup_key_last4, review)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      options.catalog ? null : JSON.stringify(manifest),
      options.enabled === false ? 0 : 1,
      key,
      key ? k.check : null,
      options.key?.slice(-4) ?? null,
      options.timeoutMs ?? null,
      backup,
      backup ? k.check : null,
      options.backup?.slice(-4) ?? null,
      options.review ? 1 : 0,
    )
    .run();
  invalidate();
}

/** Sends one JSON-RPC message to the MCP handler as an authenticated agent. */
export async function mcp(message: unknown, headers: Record<string, string> = {}, method = "POST") {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: { clientName: AGENT_NAME, connectedAt: 1000 } });
  Object.assign(ctx, { auth: { token: `owner:${GRANT}:secret` } });
  const request = new Request("https://gator.example.com/mcp", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(message) : undefined,
  });
  const response = await mcpHandler.fetch(
    request,
    env,
    ctx as Parameters<typeof mcpHandler.fetch>[2],
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** `tools/call` of one gateway tool over the legacy protocol; returns the result. */
export async function tool(name: string, args: Record<string, unknown>) {
  const { body } = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return body.result as {
    content: { type: string; text: string }[];
    isError?: boolean;
    structuredContent?: unknown;
  };
}

export const readOnly = (name: string, description = `Tool ${name}`) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
});

export const ORIGIN = "https://gator.example.com";
/** Every dashboard API response body in this test file, to check that no key ever appears. */
export const apiBodies: string[] = [];

let clients = 0;
/** A `CF-Connecting-IP` no other request used, so the login rate limit is per test. */
export const freshIp = () => `198.51.100.${++clients}`;

/** One request through the Worker's entry point, so the OAuth provider is in the path. A path is on `ORIGIN`. */
export async function send(url: string, init: RequestInit = {}, testEnv: Env = env) {
  const ctx = createExecutionContext();
  const request = new Request(new URL(url, ORIGIN), init) as Parameters<typeof worker.fetch>[0];
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function login(password: string, ip = freshIp(), testEnv: Env = env) {
  return send(
    "/api/login",
    {
      method: "POST",
      headers: { Origin: ORIGIN, "CF-Connecting-IP": ip, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    },
    testEnv,
  );
}

/** Signs in and returns the cookie, the CSRF token and a client for the dashboard API. */
export async function signIn(testEnv: Env = env) {
  const response = await login(testEnv.OWNER_PASSWORD, freshIp(), testEnv);
  const cookie = String(response.headers.get("Set-Cookie")).split(";")[0];
  const { csrf } = await (
    await send("/api/session", { headers: { Cookie: cookie } }, testEnv)
  ).json<{
    csrf: string;
  }>();
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {
      Cookie: cookie,
      Origin: ORIGIN,
      "X-CSRF-Token": csrf,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    const response = await send(path, init, testEnv);
    const text = await response.text();
    apiBodies.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
    const parsed: any = text ? JSON.parse(text) : null;
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { cookie, csrf, call };
}
