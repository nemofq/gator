import { diff_tools } from "@gator/core";
import { keys as cryptoKeys } from "./crypto";
import { migrate } from "./schema";
import {
  bumpVersion,
  configured,
  DEFAULT_TIMEOUT_MS,
  invalidate,
  type ProviderRow,
  saveSwitch,
  storedKeys,
} from "./state";
import { errorText } from "./text";
import { listTools, UpstreamError, withKeys } from "./upstream";

/** The cron refreshes a provider once its snapshot is older than this. */
const REFRESH_AFTER_MS = 23 * 3_600_000;
/** Usage and the tool-change log are kept this long. */
const KEEP_DAYS = 90;

type Version = { description: string; input_schema: unknown; read_only: boolean; hash: string };
type Diff = {
  added: (Version & { name: string; enabled: boolean })[];
  changed: (Version & { name: string })[];
};

/**
 * The provider's config and how to reach it, read from D1 (not the isolate state, which may lag a
 * write), or why it is not contacted: a provider that needs a key would only refuse without one.
 */
async function target(env: Env, id: string) {
  const [rows, timeout] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM providers WHERE id = ?").bind(id),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'timeout_ms'"),
  ]);
  const provider = configured(rows.results as ProviderRow[]).find((p) => p.manifest.id === id);
  if (!provider) return null;
  const { row, manifest } = provider;
  const keys = await storedKeys(await cryptoKeys(env), row);
  const missingKey =
    keys.primary === null && keys.backup === null && manifest.key_required !== false
      ? errorText("missing_key", "", manifest.name)
      : null;
  const setting = (timeout.results[0] as { value?: string } | undefined)?.value;
  const timeoutMs = row?.timeout_ms ?? Number(setting ?? DEFAULT_TIMEOUT_MS);
  // No request context here (the cron has none), so a switch is written before going on.
  const upstream = withKeys({ id, url: manifest.mcp_url, timeoutMs }, manifest.auth, keys, (now) =>
    saveSwitch(env.DB, id, now).run(),
  );
  return { provider, upstream, missingKey, primary: keys.primary };
}

/** Lists the tools without storing anything: `{ ok, tools }` or `{ ok: false, error }`. */
export async function testProvider(
  env: Env,
  id: string,
): Promise<{ ok: true; tools: number } | { ok: false; error: string }> {
  const found = await target(env, id);
  if (!found) return { ok: false, error: "There is no such provider." };
  if (found.missingKey) return { ok: false, error: found.missingKey };
  try {
    return { ok: true, tools: (await listTools(found.upstream)).tools.length };
  } catch (error) {
    return { ok: false, error: refreshError(error, found.provider.manifest.name) };
  }
}

/**
 * Fetches `tools/list` and, unless it is the same as last time, applies the diff (INTERFACES §3
 * "Snapshot rules"). Returns why it failed as a sentence for the owner, or null. Agents keep seeing
 * approved versions only.
 */
export async function refresh(env: Env, id: string): Promise<string | null> {
  const found = await target(env, id);
  if (!found) return "There is no such provider.";
  const { provider, upstream, missingKey, primary } = found;
  const { manifest, custom } = provider;
  const db = env.DB;
  const now = Date.now();
  const refreshed = (error: string | null) =>
    db
      .prepare("UPDATE providers SET refresh_error = ?, refreshed_at = ? WHERE id = ?")
      .bind(error, now, id);
  const failed = async (message: string) => {
    await refreshed(message).run();
    return message;
  };
  if (missingKey) return failed(missingKey);
  let list: Awaited<ReturnType<typeof listTools>>;
  try {
    list = await listTools(upstream);
  } catch (error) {
    return failed(refreshError(error, manifest.name));
  }
  if (list.digest === provider.row?.list_hash) {
    // Nothing changed, so neither the tools nor the state version are touched.
    await refreshed(null).run();
    return null;
  }
  const { results: stored } = await db
    .prepare("SELECT name, latest_hash AS hash, enabled, removed FROM tools WHERE provider_id = ?")
    .bind(id)
    .all<{ name: string; hash: string; enabled: number; removed: number }>();
  let diff: Diff;
  try {
    const input = {
      stored,
      fresh: list.tools,
      default_enabled_tools: manifest.default_enabled_tools ?? [],
      default_disabled_tools: manifest.default_disabled_tools ?? [],
      custom,
    };
    diff = JSON.parse(diff_tools(JSON.stringify(input)));
  } catch (error) {
    return failed(refreshError(error, manifest.name));
  }
  // A key that changes nothing (some servers treat a wrong key as none): a provider that also works
  // without a key is listed once more without it, on a connection of its own.
  let keySame: number | null = null;
  if (manifest.key_required === false && primary !== null) {
    const keyless = {
      id: `${id} without a key`,
      url: upstream.url,
      auth: null,
      timeoutMs: upstream.timeoutMs,
    };
    keySame = (await listTools(keyless).catch(() => null))?.digest === list.digest ? 1 : 0;
  }
  const names = (list.tools as { name: string }[]).map((tool) => tool.name);
  // New text for switched-off tools only is nothing an agent or the review can see.
  const on = new Set(stored.filter((tool) => tool.enabled).map((tool) => tool.name));
  const flipped = stored.filter((tool) => Boolean(tool.removed) === names.includes(tool.name));
  const bump =
    diff.added.length > 0 || diff.changed.some((tool) => on.has(tool.name)) || flipped.length > 0;
  // A provider's first listing is not a change. A tool that comes back is `added`, not `modified`.
  const first = stored.length === 0;
  const changes = new Map<string, string>(
    first ? [] : diff.added.map((tool) => [tool.name, "added"]),
  );
  for (const tool of diff.changed) if (on.has(tool.name)) changes.set(tool.name, "modified");
  for (const tool of flipped) changes.set(tool.name, tool.removed ? "added" : "removed");
  const version = ({ description, input_schema, read_only }: Version) =>
    JSON.stringify({ description, input_schema, read_only });
  await db.batch([
    ...diff.added.map((tool) =>
      db
        .prepare(
          `INSERT INTO tools (provider_id, name, enabled, approved, approved_hash, latest_hash, fresh)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          tool.name,
          tool.enabled ? 1 : 0,
          version(tool),
          tool.hash,
          tool.hash,
          first ? 0 : 1,
        ),
    ),
    ...diff.changed.map((tool) =>
      db
        .prepare(
          // A switched-off tool needs no review: its new text is approved as it comes.
          `UPDATE tools SET approved = CASE WHEN enabled THEN approved ELSE ?2 END,
           approved_hash = CASE WHEN enabled THEN approved_hash ELSE ?1 END,
           latest = CASE WHEN enabled AND approved_hash <> ?1 THEN ?2 END, latest_hash = ?1
           WHERE provider_id = ?3 AND name = ?4`,
        )
        .bind(tool.hash, version(tool), id, tool.name),
    ),
    // With review off, what the CASE left waiting is approved in the same transaction.
    ...(diff.changed.length > 0 ? [approvePending(db, id)] : []),
    db
      .prepare(
        "UPDATE tools SET removed = (name NOT IN (SELECT value FROM json_each(?))) WHERE provider_id = ?",
      )
      .bind(JSON.stringify(names), id),
    ...(changes.size > 0
      ? [
          db
            .prepare(
              `INSERT INTO tool_changes (provider_id, ts, name, kind)
               SELECT ?, ?, value ->> 0, value ->> 1 FROM json_each(?)`,
            )
            .bind(id, now, JSON.stringify([...changes])),
        ]
      : []),
    db
      .prepare(
        "UPDATE providers SET refresh_error = NULL, refreshed_at = ?, list_hash = ?, key_same = ? WHERE id = ?",
      )
      .bind(now, list.digest, keySame, id),
    ...(bump ? [bumpVersion(db)] : []),
  ]);
  if (bump) invalidate();
  return null;
}

/**
 * Approves every pending version of the provider's tools unless its review is on. Read inside the
 * write's own batch, so a review switch made meanwhile is never overtaken.
 */
export function approvePending(db: D1Database, id: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tools SET approved = latest, approved_hash = latest_hash, latest = NULL
       WHERE provider_id = ?1 AND latest IS NOT NULL
       AND ?1 NOT IN (SELECT id FROM providers WHERE review = 1)`,
    )
    .bind(id);
}

/** Anything but an upstream failure means the core could not read the tool list. */
function refreshError(error: unknown, provider: string): string {
  if (error instanceof UpstreamError) return errorText(error.status, "", provider, error.message);
  return errorText("upstream_error", "", provider, "a tool list Gator cannot read");
}

/** Hourly: refresh the stalest enabled provider if it is due, and drop old usage and changes. */
export async function cron(env: Env): Promise<void> {
  await migrate(env.DB);
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT id FROM providers WHERE enabled = 1 AND (refreshed_at IS NULL OR refreshed_at < ?)
     ORDER BY refreshed_at LIMIT 1`,
  )
    .bind(now - REFRESH_AFTER_MS)
    .first<string>("id");
  if (due) await refresh(env, due);
  const cutoff = now - KEEP_DAYS * 86_400_000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage_daily WHERE day < ?").bind(
      new Date(cutoff).toISOString().slice(0, 10),
    ),
    env.DB.prepare("DELETE FROM tool_changes WHERE ts < ?").bind(cutoff),
  ]);
}
