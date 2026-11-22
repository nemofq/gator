/** Applied in order, each once. Append new ones; never edit one that has shipped. */
export const MIGRATIONS: string[][] = [
  [
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
    `CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, manifest TEXT, enabled INTEGER NOT NULL DEFAULT 0,
      key TEXT, key_check TEXT, key_last4 TEXT, timeout_ms INTEGER,
      refreshed_at INTEGER, refresh_error TEXT
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS tools (
      provider_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
      removed INTEGER NOT NULL DEFAULT 0, approved TEXT NOT NULL, approved_hash TEXT NOT NULL,
      latest TEXT, latest_hash TEXT NOT NULL, PRIMARY KEY (provider_id, name)
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, client_name TEXT NOT NULL, connected_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL, agent_id TEXT NOT NULL, provider_id TEXT NOT NULL, tool TEXT NOT NULL,
      calls INTEGER NOT NULL, errors INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
      PRIMARY KEY (day, agent_id, provider_id, tool)
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent_id TEXT NOT NULL,
      tool_id TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER NOT NULL,
      result_size INTEGER NOT NULL
    )`,
    "INSERT INTO settings (key, value) VALUES ('version', '0') ON CONFLICT DO NOTHING",
  ],
  ["ALTER TABLE providers ADD COLUMN list_hash TEXT"],
  [
    "ALTER TABLE providers ADD COLUMN backup_key TEXT",
    "ALTER TABLE providers ADD COLUMN backup_key_check TEXT",
    "ALTER TABLE providers ADD COLUMN backup_key_last4 TEXT",
    "ALTER TABLE providers ADD COLUMN on_backup INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE providers ADD COLUMN switched_at INTEGER",
    "ALTER TABLE providers ADD COLUMN key_same INTEGER",
    "ALTER TABLE calls ADD COLUMN backup INTEGER NOT NULL DEFAULT 0",
    `CREATE TABLE login_attempts (
      ip TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip, minute)
    ) WITHOUT ROWID`,
  ],
  ["ALTER TABLE calls ADD COLUMN detail TEXT"],
  // Lets the request path read a provider's switched-on tools without visiting the others.
  ["CREATE INDEX tools_on ON tools (provider_id, enabled, removed)"],
  // A switched-off tool is never under review: its pending version becomes the approved one.
  [
    "UPDATE tools SET approved = latest, approved_hash = latest_hash, latest = NULL WHERE enabled = 0 AND latest IS NOT NULL",
  ],
  // Review becomes a per-provider switch, off for every provider: what waited is approved. A cut
  // failure detail says so.
  [
    "ALTER TABLE providers ADD COLUMN review INTEGER NOT NULL DEFAULT 0",
    "CREATE TABLE tool_changes (provider_id TEXT NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL)",
    "CREATE INDEX tool_changes_newest ON tool_changes (provider_id, ts)",
    "ALTER TABLE calls ADD COLUMN detail_capped INTEGER NOT NULL DEFAULT 0",
    "UPDATE tools SET approved = latest, approved_hash = latest_hash, latest = NULL WHERE latest IS NOT NULL",
  ],
  // A tool added after a provider's first listing is marked until the owner opens that provider.
  ["ALTER TABLE tools ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0"],
  // Days are UTC again: the owner's time zone setting is gone, so no stored zone lingers.
  ["DELETE FROM settings WHERE key = 'time_zone'"],
];

const SCHEMA_QUERY = "SELECT value FROM settings WHERE key = 'schema'";

/** Brings the database up to date. Safe to run from several isolates at once. */
export async function migrate(db: D1Database): Promise<void> {
  const applied = await db
    .prepare(SCHEMA_QUERY)
    .first<string>("value")
    .catch(() => null);
  const pending = MIGRATIONS.slice(Number(applied ?? 0)).flat();
  if (pending.length === 0) return;
  const statements = pending.map((sql) => db.prepare(sql));
  statements.push(
    db
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(String(MIGRATIONS.length)),
  );
  const error = await db.batch(statements).then(
    () => null,
    (e: unknown) => e,
  );
  // A batch is one transaction, so a failure changed nothing. It is fine if another isolate
  // applied the same migrations first.
  if (error && Number(await db.prepare(SCHEMA_QUERY).first<string>("value")) < MIGRATIONS.length)
    throw error;
}
