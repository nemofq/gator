import { Index } from "@gator/core";
import catalogJson from "../../../catalog/catalog.json";
import { keys as cryptoKeys, decryptKey, type Keys } from "./crypto";
import { MIGRATIONS, migrate } from "./schema";
import { instructions, searchDescription, summary } from "./text";
import { toolDefinitions } from "./tools";
import type { KeyPair } from "./upstream";

export const DEFAULT_RESULT_LIMIT = 50_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** A warm isolate re-reads the version in the background after this long… */
const RECHECK_MS = 15_000;
/** …and waits for that read after this long, so a change reaches every isolate within a minute. */
const STALE_MS = 60_000;

type Manifest = {
  id: string;
  name: string;
  description: string;
  category?: string[];
  mcp_url: string;
  signup_url?: string;
  docs_url?: string;
  key_hint?: string;
  read_only?: boolean;
  key_required?: boolean;
  auth?: { header: string; format: string };
  default_enabled_tools?: string[];
  default_disabled_tools?: string[];
  quota_signals?: string[];
};

export type ProviderRow = {
  id: string;
  manifest: string | null;
  enabled: number;
  key: string | null;
  key_check: string | null;
  key_last4: string | null;
  timeout_ms: number | null;
  refreshed_at: number | null;
  refresh_error: string | null;
  list_hash: string | null;
  backup_key: string | null;
  backup_key_check: string | null;
  backup_key_last4: string | null;
  on_backup: number;
  switched_at: number | null;
  key_same: number | null;
  review: number;
};

/** INTERFACES §6 `Provider`. */
export type Provider = Omit<Manifest, "default_enabled_tools" | "default_disabled_tools"> & {
  category: string[];
  read_only: boolean;
  key_required: boolean;
  custom: boolean;
  enabled: boolean;
  key_last4: string | null;
  key_ok: boolean;
  timeout_ms: number | null;
  refreshed_at: number | null;
  refresh_error: string | null;
  /** `new`: added after the first listing and not yet seen by the owner. */
  tools: { total: number; enabled: number; changed: number; new: number };
  backup_last4: string | null;
  backup_ok: boolean;
  on_backup: boolean;
  switched_at: number | null;
  key_same: boolean;
  review: boolean;
} & Health;

/** INTERFACES §12: whether the provider can be used, and if not why, in a sentence for the owner. */
type Health = { status: "ready" | "attention" | "no_key" | "off"; status_reason: string | null };

export type State = {
  version: number;
  /**
   * The search index, read and built on first use, once per state: only search_tools,
   * describe_tool and call_tool need it.
   */
  indexed: () => Promise<Index>;
  /**
   * Provider ID → its decrypted keys, for providers with a key that could be read. Which key is in
   * use changes here on a switch, without a reload.
   */
  keys: Map<string, KeyPair>;
  /** Provider ID → upstream timeout, for enabled providers. */
  timeouts: Map<string, number>;
  /** Provider ID → its quota signals, for enabled catalog providers that declare some. */
  signals: Map<string, string[]>;
  resultLimit: number;
  /** The JSON of the `tools` array that `tools/list` returns. */
  toolList: string;
  instructions: string;
};

export const catalog = catalogJson as Manifest[];
let current: State | undefined;
let checkedAt = 0;
let reloadNext = false;

/** Catalog providers in catalog order, then custom ones, each with its row if it has one. */
export function configured(rows: ProviderRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const custom = rows.flatMap((row) => {
    if (!row.manifest) return [];
    const manifest: Manifest = JSON.parse(row.manifest);
    return [{ manifest: { ...manifest, id: row.id }, custom: true, row }];
  });
  return [
    ...catalog.map((manifest) => ({ manifest, custom: false, row: byId.get(manifest.id) })),
    ...custom,
  ];
}

/**
 * The provider's keys in the clear, each null if none is stored or it was stored under another
 * MASTER_KEY, and which is in use: the stored choice, or the other key when that one cannot be read.
 */
export async function storedKeys(keys: Keys, row: ProviderRow | undefined): Promise<KeyPair> {
  const read = (stored: string | null | undefined, check: unknown, aad: string) =>
    stored && check === keys.check ? decryptKey(keys, aad, stored) : null;
  const [primary, backup] = await Promise.all([
    read(row?.key, row?.key_check, String(row?.id)),
    read(row?.backup_key, row?.backup_key_check, `${row?.id}:backup`),
  ]);
  return {
    primary,
    backup,
    onBackup: backup !== null && (row?.on_backup === 1 || primary === null),
  };
}

/**
 * Records which key is in use, only if that changed. A switch is not a state version change, so no
 * isolate rebuilds for it; one that has not seen it makes the same switch itself.
 */
export function saveSwitch(db: D1Database, id: string, onBackup: boolean): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE providers SET on_backup = ?1, switched_at = ?2 WHERE id = ?3 AND on_backup <> ?1",
    )
    .bind(onBackup ? 1 : 0, Date.now(), id);
}

/**
 * The state for this request. A warm isolate reads nothing from D1 unless the last version check
 * is 15 s old (then it checks in the background) or 60 s old (then it waits for the check).
 */
export function getState(env: Env, ctx: ExecutionContext): Promise<State> {
  const age = Date.now() - checkedAt;
  if (!current || reloadNext || age > STALE_MS) return check(env);
  if (age > RECHECK_MS) ctx.waitUntil(check(env));
  return Promise.resolve(current);
}

/** Add to the batch of every write to providers, tools or settings. */
export function bumpVersion(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
}

/** After a write from this isolate: its next request loads the new state without waiting. */
export function invalidate(): void {
  reloadNext = true;
}

async function check(env: Env): Promise<State> {
  checkedAt = Date.now();
  if (current && !reloadNext) {
    const version = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'version'",
    ).first<string>("value");
    if (Number(version) === current.version) return current;
  }
  reloadNext = false;
  return load(env);
}

const READS = ["SELECT key, value FROM settings", "SELECT * FROM providers ORDER BY id"];
/**
 * The approved versions of the callable tools, already in the shape the index takes. The index is
 * named because SQLite would otherwise walk every tool of the provider, switched on or not.
 */
const TOOLS = `SELECT provider_id, json_group_array(json_set(approved, '$.name', name)) AS tools
  FROM tools INDEXED BY tools_on WHERE enabled = 1 AND removed = 0
  AND provider_id IN (SELECT id FROM providers WHERE enabled = 1) GROUP BY provider_id`;

/** Migrates first when the schema is missing or behind. */
async function read(db: D1Database) {
  const run = async () => {
    const results = await db.batch(READS.map((sql) => db.prepare(sql)));
    const [settings, providers] = results.map((r) => r.results);
    return {
      settings: new Map(
        (settings as { key: string; value: string }[]).map((s) => [s.key, s.value]),
      ),
      providers: providers as ProviderRow[],
    };
  };
  const rows = await run().catch(() => null);
  if (rows && Number(rows.settings.get("schema")) >= MIGRATIONS.length) return rows;
  await migrate(db);
  return run();
}

async function load(env: Env): Promise<State> {
  const [keys, rows] = await Promise.all([cryptoKeys(env), read(env.DB)]);
  const decrypted = new Map<string, KeyPair>();
  await Promise.all(
    rows.providers.map(async (row) => {
      const pair = await storedKeys(keys, row);
      if (pair.primary !== null || pair.backup !== null) decrypted.set(row.id, pair);
    }),
  );
  const enabled = configured(rows.providers).filter((p) => p.row?.enabled);
  // The providers `index.search("")` lists, in its order. Mirrors the core's `Provider::callable`
  // (crates/core/src/index.rs) so the summary needs no index; a test checks that they agree.
  const callable = enabled.filter(
    ({ manifest }) => decrypted.has(manifest.id) || manifest.key_required === false,
  );
  const text = summary(callable.map(({ manifest }) => manifest));
  const build = async () => {
    const { results } = await env.DB.prepare(TOOLS).all<{ provider_id: string; tools: string }>();
    const tools = new Map(results.map((t) => [t.provider_id, t.tools]));
    // Assembled as text so that large tool lists are not parsed and serialised again.
    const providers = enabled.map(({ manifest }) => {
      const head = JSON.stringify({ ...manifest, has_key: decrypted.has(manifest.id) });
      return `${head.slice(0, -1)},"tools":${tools.get(manifest.id) ?? "[]"}}`;
    });
    return new Index(`{"providers":[${providers.join(",")}]}`);
  };
  let built: ReturnType<typeof build> | undefined;
  const timeout = Number(rows.settings.get("timeout_ms") ?? DEFAULT_TIMEOUT_MS);
  const resultLimit = Number(rows.settings.get("result_limit") ?? DEFAULT_RESULT_LIMIT);
  const state: State = {
    version: Number(rows.settings.get("version")),
    // A failed build is not kept, so the next use tries again.
    indexed: () =>
      (built ??= build().catch((error) => {
        built = undefined;
        throw error;
      })),
    keys: decrypted,
    timeouts: new Map(
      enabled.map(({ manifest, row }) => [manifest.id, row?.timeout_ms ?? timeout]),
    ),
    // Only from the catalog: a custom provider's stored manifest never adds one.
    signals: new Map(
      enabled.flatMap(({ manifest, custom }) =>
        !custom && manifest.quota_signals ? [[manifest.id, manifest.quota_signals]] : [],
      ),
    ),
    resultLimit,
    toolList: JSON.stringify(toolDefinitions(searchDescription(text), resultLimit)),
    instructions: instructions(text),
  };
  // The previous index is not freed here: a request that began before this reload may still be
  // using it. It is released when the garbage collector drops it.
  current = state;
  return state;
}

/** A provider is failing when its last calls, at least the fewest, all failed for its own reasons. */
const LAST_CALLS = 5;
/** Calls Gator refused before contacting the provider. */
const NOT_SENT = "('unknown_tool', 'invalid_arguments', 'missing_key')";
const FEWEST_CALLS = 3;
/**
 * The call statuses that say the provider itself failed (an `UpstreamError`), in the owner's words.
 * `ok` and `tool_error` (it answered, with an error result) say it works. What Gator refused
 * without calling it (`NOT_SENT`) says nothing either way and is left out of the last calls.
 */
const FAILED_BECAUSE = new Map([
  ["auth", "the provider rejected the key"],
  ["rate_limited", "the provider's rate limit or quota was used up"],
  ["upstream_error", "the provider returned an error"],
  ["timeout", "the provider did not answer in time"],
]);

/** `calls`: the statuses of the provider's last calls, newest first. */
function health(p: Omit<Provider, keyof Health>, calls: string[]): Health {
  if (!p.enabled) return { status: "off", status_reason: null };
  const saved = p.key_last4 !== null;
  if (p.key_required && !saved) return { status: "no_key", status_reason: null };
  // With a backup key, either one that can be read keeps the provider usable.
  const readable = (saved && p.key_ok) || (p.backup_last4 !== null && p.backup_ok);
  const failing = calls.length >= FEWEST_CALLS && calls.every((s) => FAILED_BECAUSE.has(s));
  const reason =
    (saved && !readable && "Gator cannot read the saved key: the encryption key has changed.") ||
    (p.refresh_error && `The last tool refresh failed: ${p.refresh_error}`) ||
    (p.key_same && "The key makes no difference: the provider lists the same tools without it.") ||
    (failing &&
      `The last ${calls.length} calls failed, the latest because ${FAILED_BECAUSE.get(calls[0])}.`) ||
    null;
  return { status: reason ? "attention" : "ready", status_reason: reason };
}

/** Every provider in the shape the dashboard API returns. Load the state once first (it migrates). */
export async function listProviders(env: Env): Promise<Provider[]> {
  const [keys, [rows, counts, last]] = await Promise.all([
    cryptoKeys(env),
    env.DB.batch([
      env.DB.prepare("SELECT * FROM providers ORDER BY id"),
      env.DB.prepare(
        `SELECT provider_id, COUNT(*) AS total, SUM(enabled) AS enabled,
         SUM(latest_hash <> approved_hash) AS changed, SUM(fresh) AS new FROM tools WHERE removed = 0 GROUP BY provider_id`,
      ),
      // Tool IDs are `<provider>.<tool>` and provider IDs have no dot.
      env.DB.prepare(
        `SELECT provider, status FROM (SELECT substr(tool_id, 1, instr(tool_id, '.') - 1) AS provider,
         status, ROW_NUMBER() OVER (PARTITION BY substr(tool_id, 1, instr(tool_id, '.') - 1)
         ORDER BY id DESC) AS n FROM calls WHERE status NOT IN ${NOT_SENT}) WHERE n <= ? ORDER BY n`,
      ).bind(LAST_CALLS),
    ]),
  ]);
  type Count = {
    provider_id: string;
    total: number;
    enabled: number;
    changed: number;
    new: number;
  };
  const tools = new Map(
    (counts.results as Count[]).map(({ provider_id, ...count }) => [provider_id, count]),
  );
  const calls = Map.groupBy(
    last.results as { provider: string; status: string }[],
    (c) => c.provider,
  );
  return configured(rows.results as ProviderRow[]).map(({ manifest, custom, row }) => {
    const { default_enabled_tools: _, default_disabled_tools: __, ...rest } = manifest;
    const provider = {
      ...rest,
      category: manifest.category ?? [],
      read_only: manifest.read_only ?? false,
      key_required: manifest.key_required ?? true,
      custom,
      enabled: Boolean(row?.enabled),
      key_last4: row?.key ? row.key_last4 : null,
      key_ok: !row?.key || row.key_check === keys.check,
      timeout_ms: row?.timeout_ms ?? null,
      refreshed_at: row?.refreshed_at ?? null,
      refresh_error: row?.refresh_error ?? null,
      tools: tools.get(manifest.id) ?? { total: 0, enabled: 0, changed: 0, new: 0 },
      backup_last4: row?.backup_key ? row.backup_key_last4 : null,
      backup_ok: !row?.backup_key || row.backup_key_check === keys.check,
      on_backup: Boolean(row?.on_backup),
      switched_at: row?.switched_at ?? null,
      key_same: Boolean(row?.key_same),
      review: Boolean(row?.review),
    };
    const statuses = (calls.get(manifest.id) ?? []).map((c) => c.status);
    return { ...provider, ...health(provider, statuses) };
  });
}
