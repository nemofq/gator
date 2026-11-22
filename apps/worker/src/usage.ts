import type { Status } from "./text";
import { SHORT_TEXT } from "./upstream";

/** The OAuth grant a request was made under. */
export type Agent = { id: string; clientName: string; connectedAt: number };

type Call = {
  id: string;
  provider: string;
  tool: string;
  status: Status;
  latency: number;
  size: number;
  /** The backup key produced the answer. */
  backup: boolean;
  /** What the provider said about a failure: its result text or error message. Never arguments. */
  detail: string | null;
};

/** Recent calls kept for the dashboard. */
const CALL_LOG_ROWS = 500;
/** As much of a failure's text as the recent calls show. */
const DETAIL_CHARS = 300;
/** A cut moves back to a word boundary by at most this much; a long URL is cut where it crosses. */
const DETAIL_WORD_SLACK = 40;

/** The failure text to keep and whether it was cut. A long text is data, not a message: not kept. */
function keptDetail(detail: string | null): [string | null, boolean] {
  if (!detail || detail.length > SHORT_TEXT) return [null, false];
  if (detail.length <= DETAIL_CHARS) return [detail, false];
  const cut = detail.slice(0, DETAIL_CHARS + 1).search(/\s\S*$/);
  return [detail.slice(0, cut >= DETAIL_CHARS - DETAIL_WORD_SLACK ? cut : DETAIL_CHARS), true];
}

/** One batch: the agent's last use, and for a `call_tool` the log and the daily rollup. */
export function recordUse(env: Env, agent: Agent, call?: Call): Promise<unknown> {
  const db = env.DB;
  const now = Date.now();
  const statements = [
    db
      .prepare(
        `INSERT INTO agents (id, client_name, connected_at, last_used_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      )
      .bind(agent.id, agent.clientName, agent.connectedAt, now),
  ];
  if (call) {
    const [detail, capped] = keptDetail(call.detail);
    statements.push(
      db
        .prepare(
          "INSERT INTO calls (ts, agent_id, tool_id, status, latency_ms, result_size, backup, detail, detail_capped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          now,
          agent.id,
          call.id,
          call.status,
          call.latency,
          call.size,
          call.backup ? 1 : 0,
          detail,
          capped ? 1 : 0,
        ),
      db
        .prepare("DELETE FROM calls WHERE id <= (SELECT MAX(id) FROM calls) - ?")
        .bind(CALL_LOG_ROWS),
    );
    // Invented tool IDs go to the log only, so they cannot grow the rollup.
    if (call.status !== "unknown_tool") {
      statements.push(
        db
          .prepare(
            `INSERT INTO usage_daily (day, agent_id, provider_id, tool, calls, errors, latency_ms)
             VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO UPDATE SET calls = calls + 1,
             errors = errors + excluded.errors, latency_ms = latency_ms + excluded.latency_ms`,
          )
          .bind(
            new Date(now).toISOString().slice(0, 10),
            agent.id,
            call.provider,
            call.tool,
            call.status === "ok" ? 0 : 1,
            call.latency,
          ),
      );
    }
  }
  return db.batch(statements);
}
