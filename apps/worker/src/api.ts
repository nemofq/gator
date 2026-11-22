import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { validate_provider } from "@gator/core";
import { OWNER } from "./authorize";
import { encryptKey, keys } from "./crypto";
import {
  CLEAR_SESSION,
  checkPassword,
  csrfToken,
  issueSession,
  sameOrigin,
  session,
  trusted,
} from "./session";
import { approvePending, refresh, testProvider } from "./snapshot";
import {
  bumpVersion,
  catalog,
  DEFAULT_RESULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  getState,
  invalidate,
  listProviders,
  type Provider,
  saveSwitch,
} from "./state";
import { GATOR } from "./upstream";

type Body = Record<string, unknown>;

/** INTERFACES §6 bounds, shared by the setting and a provider's own timeout. */
const RESULT_LIMIT = [1_000, 500_000] as const;
const TIMEOUT = [1_000, 120_000] as const;
/** catalog/schema.json `id.maxLength`. */
const ID_MAX = 32;
/** About two lines of the provider page's tool list at 1280 pixels. */
const DESCRIPTION_CLIP = 400;
const CHANGES_SHOWN = 20;
const MIN_KEY_FOR_LAST4 = 12;
const TOP_TOOLS = 10;
const RECENT_CALLS = 50;

const fail = (status: number, error: string, extra: Body = {}) =>
  Response.json({ error, ...extra }, { status });
const done = (headers: HeadersInit = {}) => new Response(null, { status: 204, headers });
const notFound = () => fail(404, "Not found.");

/** The dashboard API (INTERFACES §6). Same origin only: no CORS headers, nothing cached. */
export async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = await route(request, env, ctx);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let parts: string[];
  try {
    parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
  } catch {
    return notFound();
  }
  const [resource, id, sub, name, ...rest] = parts;
  if (rest.length > 0) return notFound();
  const method = request.method;
  if (resource === "login" && method === "POST" && parts.length === 1) return login(request, env);

  const cookie = await session(request, env);
  if (!cookie) return fail(401, "Sign in to the dashboard first.");
  if (method !== "GET" && !(await trusted(request, env, cookie))) {
    return fail(403, "This request must come from the dashboard page.");
  }
  const body = await readBody(request);
  if (!body) return fail(400, "The request body must be a JSON object.");
  // Applies pending migrations, which every query below relies on.
  await getState(env, ctx);

  const pattern = [resource, id && ":id", sub, name && ":name"].filter(Boolean).join("/");
  switch (`${method} ${pattern}`) {
    case "POST logout":
      return done({ "Set-Cookie": CLEAR_SESSION });
    case "GET session": {
      const unreadable = (await listProviders(env)).filter((p) => !p.key_ok || !p.backup_ok);
      return Response.json({
        csrf: await csrfToken(env, cookie),
        mcp_url: `${url.origin}/mcp`,
        version: GATOR.version,
        keys_unreadable: unreadable.map((p) => ({ id: p.id, name: p.name })),
      });
    }
    case "GET overview":
      return Response.json(await overview(env));
    case "GET agents":
      return Response.json(await agents(env));
    case "DELETE agents/:id":
      await env.OAUTH_PROVIDER.revokeGrant(id, OWNER);
      return done();
    case "GET providers":
      return Response.json(await listProviders(env));
    case "POST providers":
      return addCustom(env, body);
    case "GET settings":
      return Response.json(await settings(env));
    case "PATCH settings":
      return patchSettings(env, body);
  }
  if (resource !== "providers" || !id) return notFound();
  const provider = await find(env, id);
  if (!provider) return notFound();
  switch (`${method} ${pattern}`) {
    case "GET providers/:id":
      return Response.json(await detail(env, provider));
    case "PATCH providers/:id":
      return patchProvider(env, provider, body);
    case "DELETE providers/:id":
      if (!provider.custom) return fail(400, "Only custom providers can be deleted.");
      await write(env, [
        env.DB.prepare("DELETE FROM tools WHERE provider_id = ?").bind(id),
        env.DB.prepare("DELETE FROM providers WHERE id = ?").bind(id),
      ]);
      return done();
    case "POST providers/:id/refresh":
      await refresh(env, id);
      return Response.json(await detail(env, (await find(env, id)) as Provider));
    case "POST providers/:id/seen":
      // Not `write()`: what the owner has seen changes nothing an agent sees, so no version bump.
      await env.DB.prepare("UPDATE tools SET fresh = 0 WHERE provider_id = ? AND fresh = 1")
        .bind(id)
        .run();
      return done();
    case "POST providers/:id/test":
      return Response.json(await testProvider(env, id));
    case "GET providers/:id/tools/:name": {
      const tool = await toolDetail(env, id, name);
      return tool ? Response.json(tool) : notFound();
    }
    case "PATCH providers/:id/tools/:name":
      return patchTool(env, id, name, body);
  }
  return notFound();
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return fail(403, "This request must come from the dashboard page.");
  const body = await readBody(request);
  const result = await checkPassword(request, env, body?.password);
  if (result === "limited") return fail(429, "Too many attempts. Wait a minute and try again.");
  if (result === "wrong") return fail(401, "Wrong password.");
  return done({ "Set-Cookie": await issueSession(env) });
}

/** An empty body is `{}`; anything but a JSON object is null. */
async function readBody(request: Request): Promise<Body | null> {
  const text = await request.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Every write to providers, tools or settings: one transaction that bumps the state version. */
async function write(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  await env.DB.batch([...statements, bumpVersion(env.DB)]);
  invalidate();
}

const inRange = (value: unknown, [min, max]: readonly [number, number]) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** INTERFACES §3: the status of a tool row. */
const STATUS = `CASE WHEN removed THEN 'removed' WHEN latest_hash <> approved_hash THEN 'changed' ELSE 'ok' END AS status`;

async function find(env: Env, id: string): Promise<Provider | undefined> {
  return (await listProviders(env)).find((p) => p.id === id);
}

async function detail(env: Env, provider: Provider) {
  const db = env.DB;
  const [tools, changes] = await db.batch([
    // One character more than is shown tells whether there is more.
    db
      .prepare(
        `SELECT name, substr(json_extract(approved, '$.description'), 1, ?) AS description,
         json_extract(approved, '$.read_only') AS read_only, enabled, fresh,
         ${STATUS} FROM tools WHERE provider_id = ? ORDER BY name`,
      )
      .bind(DESCRIPTION_CLIP + 1, provider.id),
    db
      .prepare(
        "SELECT ts, name, kind FROM tool_changes WHERE provider_id = ? ORDER BY ts DESC, name LIMIT ?",
      )
      .bind(provider.id, CHANGES_SHOWN),
  ]);
  type Row = {
    name: string;
    description: string | null;
    read_only: number;
    enabled: number;
    fresh: number;
    status: string;
  };
  const tool_list = (tools.results as Row[]).map((t) => {
    const description = t.description ?? "";
    const clipped = description.length > DESCRIPTION_CLIP;
    // Cut before the last word that does not fit whole; no ellipsis, the dashboard shows "more".
    const cut = description.search(/\s\S*$/);
    return {
      name: t.name,
      description: clipped ? description.slice(0, cut > 0 ? cut : DESCRIPTION_CLIP) : description,
      clipped,
      read_only: Boolean(t.read_only),
      enabled: Boolean(t.enabled),
      new: Boolean(t.fresh),
      status: t.status,
    };
  });
  return { ...provider, tool_list, changes: changes.results };
}

const KEY_PROBLEM = "key must be printable characters with no spaces or line breaks.";

/** A pasted key without the whitespace around it, or null if it could not go in a request header. */
function cleanKey(key: unknown): string | null {
  const trimmed = typeof key === "string" ? key.trim() : "";
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Sets or removes a stored key. Only the ciphertext, the key check value and the last four
 * characters are kept. What the provider lists with and without its key is compared afresh.
 */
async function keyUpdate(
  env: Env,
  id: string,
  key: string | null,
  column: "key" | "backup_key",
): Promise<D1PreparedStatement> {
  const sql = `UPDATE providers SET ${column} = ?, ${column}_check = ?, ${column}_last4 = ?,
    list_hash = NULL, key_same = NULL WHERE id = ?`;
  if (key === null) return env.DB.prepare(sql).bind(null, null, null, id);
  const k = await keys(env);
  // The last four characters would give away too much of a short key.
  const last4 = key.length >= MIN_KEY_FOR_LAST4 ? key.slice(-4) : "";
  // Bound to its role too, so the two ciphertexts cannot be swapped.
  const sealed = await encryptKey(k, column === "key" ? id : `${id}:backup`, key);
  return env.DB.prepare(sql).bind(sealed, k.check, last4, id);
}

/** A key field of a PATCH: unchanged, null to remove it, the cleaned key, or false if unusable. */
function keyField(value: unknown): string | null | undefined | false {
  return value === undefined || value === null ? value : (cleanKey(value) ?? false);
}

async function patchProvider(env: Env, provider: Provider, body: Body): Promise<Response> {
  const { enabled, timeout_ms, on_backup, review } = body;
  const key = keyField(body.key);
  const backup = keyField(body.backup_key);
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return fail(400, "enabled must be true or false.");
  }
  if (review !== undefined && typeof review !== "boolean") {
    return fail(400, "review must be true or false.");
  }
  if (key === false) return fail(400, KEY_PROBLEM);
  if (backup === false) return fail(400, `backup_${KEY_PROBLEM}`);
  if (on_backup !== undefined && on_backup !== false) {
    return fail(400, "on_backup can only be false: Gator switches to the backup key itself.");
  }
  const hasKey = key === undefined ? provider.key_last4 !== null : key !== null;
  const hasBackup = backup === undefined ? provider.backup_last4 !== null : backup !== null;
  if (hasBackup && !hasKey) {
    return fail(400, key === null ? "Remove the backup key first." : "Set the primary key first.");
  }
  if (timeout_ms !== undefined && timeout_ms !== null && !inRange(timeout_ms, TIMEOUT)) {
    return fail(
      400,
      `timeout_ms must be a whole number from ${TIMEOUT[0]} to ${TIMEOUT[1]}, or null.`,
    );
  }
  const db = env.DB;
  const id = provider.id;
  // A catalog provider has no row until the owner first changes it.
  const statements = [
    db.prepare("INSERT INTO providers (id) VALUES (?) ON CONFLICT DO NOTHING").bind(id),
  ];
  if (enabled !== undefined) {
    statements.push(
      db.prepare("UPDATE providers SET enabled = ? WHERE id = ?").bind(enabled ? 1 : 0, id),
    );
  }
  if (key !== undefined) statements.push(await keyUpdate(env, id, key, "key"));
  if (backup !== undefined) statements.push(await keyUpdate(env, id, backup, "backup_key"));
  // Removing the backup key while it is in use returns the provider to the primary.
  if (on_backup === false || backup === null) statements.push(saveSwitch(db, id, false));
  if (timeout_ms !== undefined) {
    statements.push(
      db.prepare("UPDATE providers SET timeout_ms = ? WHERE id = ?").bind(timeout_ms, id),
    );
  }
  if (review !== undefined) {
    statements.push(
      db.prepare("UPDATE providers SET review = ? WHERE id = ?").bind(review ? 1 : 0, id),
    );
    // Turning review off lets through what was waiting for it.
    if (!review) statements.push(approvePending(db, id));
  }
  await write(env, statements);
  // A failed refresh is not an API error: the change is saved and `refresh_error` says why.
  if (enabled === true || (key !== undefined && (enabled ?? provider.enabled)))
    await refresh(env, id);
  return Response.json(await find(env, id));
}

async function addCustom(env: Env, body: Body): Promise<Response> {
  const { name, description, mcp_url, auth } = body;
  const key = body.key === undefined ? undefined : cleanKey(body.key);
  if (key === null) return fail(400, KEY_PROBLEM);
  const { results } = await env.DB.prepare("SELECT id FROM providers").all<{ id: string }>();
  const taken = new Set([...catalog.map((m) => m.id), ...results.map((r) => r.id)]);
  const id = uniqueId(typeof name === "string" ? name : "", taken);
  // The one rule for a custom provider: it needs a key exactly when it has an auth header.
  const manifest = { id, name, description, mcp_url, auth, key_required: auth !== undefined };
  const text = JSON.stringify(manifest);
  const problems = JSON.parse(validate_provider(text));
  if (problems.length > 0) return fail(400, "Fix the fields marked below.", { problems });
  const statements = [
    env.DB.prepare("INSERT INTO providers (id, manifest) VALUES (?, ?)").bind(id, text),
  ];
  if (key) statements.push(await keyUpdate(env, id, key, "key"));
  await write(env, statements);
  return Response.json(await find(env, id));
}

/** Lowercase, runs of other characters as `-`, trimmed, then `-2`, `-3`… until it is free. */
function uniqueId(name: string, taken: Set<string>): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, ID_MAX)
    .replace(/^-|-$/g, "");
  let id = base;
  for (let n = 2; id && taken.has(id); n++)
    id = `${base.slice(0, ID_MAX - String(n).length - 1)}-${n}`;
  return id;
}

async function toolDetail(env: Env, id: string, name: string) {
  const row = await env.DB.prepare(
    `SELECT name, enabled, approved, latest,
     ${STATUS} FROM tools WHERE provider_id = ? AND name = ?`,
  )
    .bind(id, name)
    .first<{
      name: string;
      enabled: number;
      approved: string;
      latest: string | null;
      status: string;
    }>();
  if (!row) return null;
  return {
    name: row.name,
    enabled: Boolean(row.enabled),
    status: row.status,
    approved: JSON.parse(row.approved),
    latest: row.latest ? JSON.parse(row.latest) : null,
  };
}

async function patchTool(env: Env, id: string, name: string, body: Body): Promise<Response> {
  const { enabled, approve } = body;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return fail(400, "enabled must be true or false.");
  }
  if (approve !== undefined && approve !== true) return fail(400, "approve must be true.");
  if (!(await toolDetail(env, id, name))) return notFound();
  const statements: D1PreparedStatement[] = [];
  if (enabled !== undefined) {
    statements.push(
      // Switching off accepts a pending version: a switched-off tool is never under review.
      env.DB.prepare(
        enabled
          ? "UPDATE tools SET enabled = 1 WHERE provider_id = ? AND name = ?"
          : `UPDATE tools SET enabled = 0, approved = COALESCE(latest, approved),
             approved_hash = latest_hash, latest = NULL WHERE provider_id = ? AND name = ?`,
      ).bind(id, name),
    );
  }
  if (approve) {
    statements.push(
      env.DB.prepare(
        `UPDATE tools SET approved = latest, approved_hash = latest_hash, latest = NULL
         WHERE provider_id = ? AND name = ? AND latest IS NOT NULL`,
      ).bind(id, name),
    );
  }
  if (statements.length > 0) await write(env, statements);
  return Response.json(await toolDetail(env, id, name));
}

async function settings(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('result_limit', 'timeout_ms')",
  ).all<{ key: string; value: string }>();
  const stored = new Map(results.map((r) => [r.key, Number(r.value)]));
  return {
    result_limit: stored.get("result_limit") ?? DEFAULT_RESULT_LIMIT,
    timeout_ms: stored.get("timeout_ms") ?? DEFAULT_TIMEOUT_MS,
  };
}

async function patchSettings(env: Env, body: Body): Promise<Response> {
  const { result_limit, timeout_ms } = body;
  if (result_limit !== undefined && !inRange(result_limit, RESULT_LIMIT)) {
    return fail(
      400,
      `result_limit must be a whole number from ${RESULT_LIMIT[0]} to ${RESULT_LIMIT[1]}.`,
    );
  }
  if (timeout_ms !== undefined && !inRange(timeout_ms, TIMEOUT)) {
    return fail(400, `timeout_ms must be a whole number from ${TIMEOUT[0]} to ${TIMEOUT[1]}.`);
  }
  const upsert = env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const statements = Object.entries({ result_limit, timeout_ms })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => upsert.bind(key, String(value)));
  if (statements.length > 0) await write(env, statements);
  return Response.json(await settings(env));
}

/** Loopback hosts as RFC 8252 §7.3 and the OAuth library's consent description define them. */
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/** What tells agents with the same name apart. */
type Label = { client_name: string; connected_at: number; via: string | null };

/**
 * Grant ID → label, for every current grant. Grants that were never exchanged for tokens expire on
 * their own within ten minutes.
 */
async function grants(env: Env): Promise<Map<string, Label>> {
  const items: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(OWNER, { cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return new Map(
    items.map((grant) => {
      // Where the grant's redirect went: an app on the owner's computer, or a site such as claude.ai.
      const host = URL.parse(grant.redirectUri ?? "")?.hostname || null;
      const label = {
        client_name: String(grant.metadata?.clientName ?? grant.clientId),
        connected_at: grant.createdAt * 1000,
        via: host && LOOPBACK.test(host) ? "computer" : host,
      };
      return [grant.id, label];
    }),
  );
}

/**
 * Calls and failures of the last 7, 30 and 90 days, from bound first days ?1, ?2 and ?3, and calls
 * today (?4), which only the agents page shows.
 */
const RANGES = `SUM(IIF(day = ?4, calls, 0)) AS c1,
  SUM(IIF(day >= ?1, calls, 0)) AS c7, SUM(IIF(day >= ?1, errors, 0)) AS e7,
  SUM(IIF(day >= ?2, calls, 0)) AS c30, SUM(IIF(day >= ?2, errors, 0)) AS e30,
  SUM(calls) AS c90, SUM(errors) AS e90 FROM usage_daily WHERE day >= ?3`;
type Ranged = {
  id: string;
  c1: number;
  c7: number;
  e7: number;
  c30: number;
  e30: number;
  c90: number;
  e90: number;
};
const BY_AGENT = `SELECT agent_id AS id, ${RANGES} GROUP BY agent_id ORDER BY c90 DESC`;
/** Every agent that has made a call, revoked ones included. */
const KNOWN_AGENTS = "SELECT id, client_name, connected_at, last_used_at FROM agents";
type Known = { id: string; client_name: string; connected_at: number; last_used_at: number };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The first days of the ranges, in RANGES' order: today is the overview's "calls today". */
const starts = (now: number) => [7, 30, 90, 1].map((days) => day(now - (days - 1) * 86_400_000));

function ranged({ id, c7, e7, c30, e30, c90, e90 }: Ranged) {
  return {
    id,
    d7: { calls: c7, errors: e7 },
    d30: { calls: c30, errors: e30 },
    d90: { calls: c90, errors: e90 },
  };
}

async function agents(env: Env) {
  const db = env.DB;
  const [labels, [known, usage]] = await Promise.all([
    grants(env),
    db.batch([db.prepare(KNOWN_AGENTS), db.prepare(BY_AGENT).bind(...starts(Date.now()))]),
  ]);
  const used = new Map((known.results as Known[]).map((a) => [a.id, a.last_used_at]));
  const calls = new Map(
    (usage.results as Ranged[]).map((u) => [u.id, { d1: u.c1, d7: u.c7, d30: u.c30, d90: u.c90 }]),
  );
  return [...labels]
    .map(([id, label]) => ({
      id,
      ...label,
      last_used_at: used.get(id) ?? null,
      calls: calls.get(id) ?? { d1: 0, d7: 0, d30: 0, d90: 0 },
    }))
    .sort((a, b) => b.connected_at - a.connected_at);
}

const COUNT = "SUM(calls) AS calls, SUM(errors) AS errors, SUM(latency_ms) AS latency_ms";

async function overview(env: Env) {
  const now = Date.now();
  const range = starts(now);
  const db = env.DB;
  const [labels, [days, byProvider, byTool, byAgent, known, recent]] = await Promise.all([
    grants(env),
    db.batch([
      db
        .prepare(`SELECT day, ${COUNT} FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day`)
        .bind(range[1]),
      db
        .prepare(`SELECT provider_id AS id, ${RANGES} GROUP BY provider_id ORDER BY c90 DESC`)
        .bind(...range),
      db
        .prepare(
          `SELECT provider_id || '.' || tool AS id, ${RANGES} GROUP BY provider_id, tool ORDER BY c90 DESC`,
        )
        .bind(...range),
      db.prepare(BY_AGENT).bind(...range),
      db.prepare(KNOWN_AGENTS),
      db
        .prepare(
          `SELECT c.ts, c.agent_id, COALESCE(a.client_name, '') AS agent, c.tool_id, c.status, c.latency_ms, c.result_size,
           c.backup, c.detail, c.detail_capped FROM calls c LEFT JOIN agents a ON a.id = c.agent_id ORDER BY c.id DESC LIMIT ?`,
        )
        .bind(RECENT_CALLS),
    ]),
  ]);
  type Day = { day: string; calls: number; errors: number; latency_ms: number };
  const today = (days.results as Day[]).find((d) => d.day === day(now));
  // Each range's top ten, so the dashboard can show any of them: together at most 30 tools.
  const tools = (byTool.results as Ranged[]).map(ranged);
  const top = new Set(
    (["d7", "d30", "d90"] as const).flatMap((r) =>
      tools
        .filter((t) => t[r].calls > 0)
        .sort((a, b) => b[r].calls - a[r].calls)
        .slice(0, TOP_TOOLS),
    ),
  );
  const saved = new Map((known.results as Known[]).map((a) => [a.id, a]));
  return {
    // Today's UTC date, which the dashboard counts the chart's days back from.
    day: range[3],
    today: {
      calls: today?.calls ?? 0,
      errors: today?.errors ?? 0,
      latency_ms: today?.latency_ms ?? 0,
    },
    days: days.results,
    // A revoked agent keeps the name it was saved with; nothing else about it is known.
    agents: (byAgent.results as Ranged[]).map((row) => {
      const label = labels.get(row.id);
      const { client_name = "", connected_at = 0 } = label ?? saved.get(row.id) ?? {};
      return {
        ...ranged(row),
        client_name,
        connected_at,
        via: label?.via ?? null,
        revoked: !label,
      };
    }),
    providers: (byProvider.results as Ranged[]).map(ranged),
    tools: tools.filter((t) => top.has(t)),
    recent: (recent.results as { backup: number; detail_capped: number }[]).map((c) => ({
      ...c,
      backup: Boolean(c.backup),
      detail_capped: Boolean(c.detail_capped),
    })),
  };
}
