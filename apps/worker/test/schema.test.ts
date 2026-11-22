import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/schema";
import { getState, invalidate } from "../src/state";

const DROP_ALL = [
  "settings",
  "providers",
  "tools",
  "agents",
  "usage_daily",
  "calls",
  "login_attempts",
  "tool_changes",
].map((table) => `DROP TABLE IF EXISTS ${table}`);

const tables = async () =>
  (
    await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  ).results.map((row) => row.name);

it("migrates an empty database, from several isolates at once, and again without effect", async () => {
  expect(await tables()).not.toContain("settings");
  await Promise.all([migrate(env.DB), migrate(env.DB)]);
  expect(await tables()).toEqual(
    expect.arrayContaining(["agents", "calls", "providers", "settings", "tools", "usage_daily"]),
  );
  await env.DB.prepare("UPDATE settings SET value = '7' WHERE key = 'version'").run();
  await migrate(env.DB);
  const settings = await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all();
  expect(settings.results).toEqual([
    { key: "schema", value: String(MIGRATIONS.length) },
    { key: "version", value: "7" },
  ]);
});

it("adds the backup key, the key warning and the sign-in counter to a database with two migrations, keeping every row, once", async () => {
  const db = env.DB;
  const deployed = [
    ...DROP_ALL,
    ...MIGRATIONS[0],
    ...MIGRATIONS[1],
    "INSERT INTO settings (key, value) VALUES ('schema', '2')",
    `INSERT INTO providers (id, enabled, key, key_check, key_last4, refreshed_at, list_hash)
     VALUES ('tavily', 1, 'sealed', 'check', 'abcd', 5, 'digest')`,
    `INSERT INTO calls (ts, agent_id, tool_id, status, latency_ms, result_size)
     VALUES (7, 'g', 'tavily.tavily_search', 'ok', 12, 34)`,
  ];
  await db.batch(deployed.map((sql) => db.prepare(sql)));

  invalidate();
  await Promise.all([1, 2].map(() => getState(env, createExecutionContext())));
  const expected = async () => {
    expect((await db.prepare("SELECT * FROM providers").all()).results).toEqual([
      {
        id: "tavily",
        manifest: null,
        enabled: 1,
        key: "sealed",
        key_check: "check",
        key_last4: "abcd",
        timeout_ms: null,
        refreshed_at: 5,
        refresh_error: null,
        list_hash: "digest",
        backup_key: null,
        backup_key_check: null,
        backup_key_last4: null,
        on_backup: 0,
        switched_at: null,
        key_same: null,
        review: 0,
      },
    ]);
    expect((await db.prepare("SELECT * FROM calls").all()).results).toEqual([
      {
        id: 1,
        ts: 7,
        agent_id: "g",
        tool_id: "tavily.tavily_search",
        status: "ok",
        latency_ms: 12,
        result_size: 34,
        backup: 0,
        detail: null,
        detail_capped: 0,
      },
    ]);
    expect(await tables()).toContain("login_attempts");
    expect(await db.prepare("SELECT value FROM settings WHERE key = 'schema'").first("value")).toBe(
      String(MIGRATIONS.length),
    );
  };
  await expected();
  await migrate(db);
  await expected();
});

it("adds list_hash to a database deployed with only the first migration, once", async () => {
  const db = env.DB;
  const columns = async () =>
    (await db.prepare("PRAGMA table_info(providers)").all()).results.map((c) => c.name);
  const deployed = [
    ...DROP_ALL,
    ...MIGRATIONS[0],
    "INSERT INTO settings (key, value) VALUES ('schema', '1')",
    "INSERT INTO providers (id, enabled, refreshed_at) VALUES ('redlisten', 1, 5)",
  ];
  await db.batch(deployed.map((sql) => db.prepare(sql)));
  expect(await columns()).not.toContain("list_hash");

  // Two isolates loading the state at once both find the schema behind.
  invalidate();
  await Promise.all([1, 2].map(() => getState(env, createExecutionContext())));
  expect(await columns()).toContain("list_hash");
  expect(await db.prepare("SELECT * FROM providers").all()).toMatchObject({
    results: [{ id: "redlisten", enabled: 1, refreshed_at: 5, list_hash: null }],
  });
  await migrate(db);
  expect(await db.prepare("SELECT value FROM settings WHERE key = 'schema'").first("value")).toBe(
    String(MIGRATIONS.length),
  );
});

it("approves the pending version of a switched-off tool (6), then every one, as review starts off (7)", async () => {
  const db = env.DB;
  const deployed = [
    ...DROP_ALL,
    ...MIGRATIONS.slice(0, 5).flat(),
    "INSERT INTO settings (key, value) VALUES ('schema', '5')",
    `INSERT INTO tools (provider_id, name, enabled, approved, approved_hash, latest, latest_hash)
     VALUES ('p', 'off', 0, 'old', 'h1', 'new', 'h2'), ('p', 'on', 1, 'old', 'h1', 'new', 'h2')`,
  ];
  await db.batch(deployed.map((sql) => db.prepare(sql)));
  await migrate(db);
  const rows = await db
    .prepare("SELECT name, approved, approved_hash, latest, latest_hash FROM tools ORDER BY name")
    .all();
  expect(rows.results).toEqual([
    { name: "off", approved: "new", approved_hash: "h2", latest: null, latest_hash: "h2" },
    { name: "on", approved: "new", approved_hash: "h2", latest: null, latest_hash: "h2" },
  ]);
});

it("adds the new-tool mark, unset, to a database with seven migrations", async () => {
  const db = env.DB;
  const deployed = [
    ...DROP_ALL,
    ...MIGRATIONS.slice(0, 7).flat(),
    "INSERT INTO settings (key, value) VALUES ('schema', '7')",
    `INSERT INTO tools (provider_id, name, enabled, approved, approved_hash, latest_hash)
     VALUES ('p', 'look', 1, 'one', 'h', 'h')`,
  ];
  await db.batch(deployed.map((sql) => db.prepare(sql)));
  await migrate(db);
  expect((await db.prepare("SELECT name, enabled, fresh FROM tools").all()).results).toEqual([
    { name: "look", enabled: 1, fresh: 0 },
  ]);
});

it("turns review off for every provider and approves what waited, on a database with six migrations", async () => {
  const db = env.DB;
  const deployed = [
    ...DROP_ALL,
    ...MIGRATIONS.slice(0, 6).flat(),
    "INSERT INTO settings (key, value) VALUES ('schema', '6')",
    "INSERT INTO providers (id, enabled) VALUES ('p', 1)",
    `INSERT INTO tools (provider_id, name, enabled, approved, approved_hash, latest, latest_hash)
     VALUES ('p', 'on', 1, 'old', 'h1', 'new', 'h2'), ('p', 'same', 1, 'one', 'h3', NULL, 'h3')`,
  ];
  await db.batch(deployed.map((sql) => db.prepare(sql)));
  await migrate(db);
  const rows = await db
    .prepare("SELECT name, approved, approved_hash, latest, latest_hash FROM tools ORDER BY name")
    .all();
  expect(rows.results).toEqual([
    { name: "on", approved: "new", approved_hash: "h2", latest: null, latest_hash: "h2" },
    { name: "same", approved: "one", approved_hash: "h3", latest: null, latest_hash: "h3" },
  ]);
  expect(await db.prepare("SELECT review FROM providers").all()).toMatchObject({
    results: [{ review: 0 }],
  });
  expect(await tables()).toContain("tool_changes");
});

it("forgets a stored time zone, on a database with eight migrations", async () => {
  const db = env.DB;
  const deployed = [
    ...DROP_ALL,
    ...MIGRATIONS.slice(0, 8).flat(),
    "INSERT INTO settings (key, value) VALUES ('schema', '8'), ('time_zone', 'Asia/Kolkata')",
  ];
  await db.batch(deployed.map((sql) => db.prepare(sql)));
  await migrate(db);
  expect(await db.prepare("SELECT value FROM settings WHERE key = 'time_zone'").first()).toBeNull();
});
