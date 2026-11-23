import { useEffect, useState } from "preact/hooks";

export type Provider = {
  id: string;
  name: string;
  description: string;
  category: string[];
  mcp_url: string;
  signup_url?: string;
  docs_url?: string;
  key_hint?: string;
  read_only: boolean;
  key_required: boolean;
  auth?: { header: string; format: string };
  custom: boolean;
  enabled: boolean;
  key_last4: string | null;
  key_ok: boolean;
  backup_last4: string | null;
  backup_ok: boolean;
  on_backup: boolean;
  switched_at: number | null;
  key_same: boolean;
  review: boolean;
  timeout_ms: number | null;
  refreshed_at: number | null;
  refresh_error: string | null;
  /** Whether agents can use it: `off` when it is not enabled; `attention` comes with a reason. */
  status: "ready" | "attention" | "no_key" | "off";
  status_reason: string | null;
  /** `new`: tools listed since the owner last opened the provider; they start switched off. */
  tools: { total: number; enabled: number; changed: number; new: number };
};
export type Tool = {
  name: string;
  /** Cut at a word when `clipped`; the tool's own route has it whole. */
  description: string;
  clipped: boolean;
  read_only: boolean;
  enabled: boolean;
  status: "ok" | "changed" | "removed";
  new: boolean;
};
export type ProviderDetail = Provider & {
  tool_list: Tool[];
  changes: { ts: number; name: string; kind: "added" | "removed" | "modified" }[];
};
type ToolVersion = { description: string; input_schema: object; read_only: boolean };
export type ToolDetail = { approved: ToolVersion; latest: ToolVersion | null };
export type Session = {
  csrf: string;
  mcp_url: string;
  version: string;
  keys_unreadable: { id: string; name: string }[];
};
export type Agent = {
  id: string;
  client_name: string;
  connected_at: number;
  /** "computer" for an app on the owner's computer, else the host its sign-in returned to. */
  via: string | null;
  last_used_at: number | null;
  calls: { d1: number; d7: number; d30: number; d90: number };
};
export type Count = { calls: number; errors: number; latency_ms: number };
export type Range = "d7" | "d30" | "d90";
export type Ranges = Record<Range, { calls: number; errors: number }>;
export type Overview = {
  /** Today's UTC date (YYYY-MM-DD). */
  day: string;
  today: Count;
  days: ({ day: string } & Count)[];
  agents: ({
    id: string;
    client_name: string;
    connected_at: number;
    via: string | null;
    revoked: boolean;
  } & Ranges)[];
  providers: ({ id: string } & Ranges)[];
  tools: ({ id: string } & Ranges)[];
  recent: {
    ts: number;
    agent: string;
    /** The grant: an `agents[]` id, unless that agent has had no call in 90 days. */
    agent_id: string;
    tool_id: string;
    status: string;
    latency_ms: number;
    result_size: number;
    backup: boolean;
    /** The start of what the provider said about a failed call: untrusted text. */
    detail: string | null;
    /** The provider said more than `detail` holds. */
    detail_capped: boolean;
  }[];
};
export type Settings = { result_limit: number; timeout_ms: number };
export type Problem = { path: string; message: string };

let csrf = "";

export function startSession(session: Session) {
  csrf = session.csrf;
}

/** Throws an Error whose `cause` is the server's JSON error body. */
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== "/api/login") dispatchEvent(new Event("gator-signed-out"));
  if (method !== "GET") seen.clear();
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `The server answered ${res.status}.` }));
    throw new Error(error.error, { cause: error });
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** The app listens for "gator-signed-out" and shows the sign-in page. */
export const signOut = () =>
  api("/api/logout", "POST").then(() => dispatchEvent(new Event("gator-signed-out")));

/** What each path last answered, so a page opened again shows at once. Any write empties it: what
    it changed may show on every page. */
const seen = new Map<string, unknown>();

/** Loads `path` on mount, showing what it last answered meanwhile unless `keep` is false; `set`
    replaces the data after a write that returns it. */
export function useLoad<T>(path: string, keep = true) {
  const last = () => (keep ? (seen.get(path) as T | undefined) : undefined);
  const [data, setData] = useState(last);
  const [error, setError] = useState("");
  const set = (d: T | undefined) => {
    if (keep) seen.set(path, d);
    setData(d);
  };
  const reload = () =>
    api<T>(path).then(
      (d) => {
        set(d);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    setData(last());
    reload();
  }, [path]);
  return { data, error, set, reload };
}
