// What the README screenshots show: an invented instance about a month into use, built call by
// call from a seeded random generator and summed up the way the Worker does, so every figure
// agrees with the others and every run gives the same images. Typed with the dashboard's own types.
import catalog from "../../../../catalog/catalog.json";
import type { Agent, Overview, Provider, Session } from "../../src/api";

/** The moment the screenshots show: Tuesday 24 November 2026, 11:42 in the morning in California. */
export const NOW = Date.UTC(2026, 10, 24, 19, 42, 18);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const today = Date.UTC(2026, 10, 24);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** mulberry32: small, seeded, the same numbers on every machine. */
let seed = 20261124;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}
/** A positive number around `mean`, with the long right tail latencies and sizes have. */
const around = (mean: number) => mean * Math.exp(0.45 * (random() + random() + random() - 1.5));
/** An index, each as likely as its weight. */
function weighted(weights: number[]) {
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (const [i, w] of weights.entries()) {
    r -= w;
    if (r < 0) return i;
  }
  return 0;
}
function pick<T extends string>(weights: Partial<Record<T, number>>): T {
  const keys = Object.keys(weights) as T[];
  return keys[weighted(keys.map((k) => weights[k] ?? 0))];
}

type Failure = "rate_limited" | "timeout" | "upstream_error" | "tool_error";
type ToolSpec = { ms: number; chars: number; fails?: Partial<Record<Failure, number>> };

/** Typical latency and result length of each tool used, and how often it fails, and how. */
const TOOLS = {
  "tavily.tavily_search": { ms: 1150, chars: 9800, fails: { timeout: 0.003 } },
  "tavily.tavily_extract": { ms: 2300, chars: 21000, fails: { timeout: 0.01 } },
  "redlisten.search_reddit": { ms: 950, chars: 12500, fails: { rate_limited: 0.012 } },
  "redlisten.get_thread": { ms: 820, chars: 16000, fails: { rate_limited: 0.01 } },
  "redlisten.latest_posts": { ms: 700, chars: 9000, fails: { rate_limited: 0.01 } },
  "github.search_code": { ms: 520, chars: 7400 },
  "github.get_file_contents": { ms: 380, chars: 14000, fails: { tool_error: 0.015 } },
  "github.list_issues": { ms: 460, chars: 11000 },
  "github.search_repositories": { ms: 430, chars: 6800 },
  "github.pull_request_read": { ms: 610, chars: 18000 },
  "firecrawl.firecrawl_scrape": { ms: 3100, chars: 26000, fails: { timeout: 0.02 } },
  "firecrawl.firecrawl_search": { ms: 2100, chars: 8200, fails: { upstream_error: 0.004 } },
  "firecrawl.firecrawl_map": { ms: 1800, chars: 5400 },
  "x.search_posts_all": { ms: 720, chars: 5200, fails: { rate_limited: 0.012 } },
  "x.get_users_posts": { ms: 640, chars: 4600, fails: { rate_limited: 0.01 } },
  "x.get_posts_by_id": { ms: 410, chars: 2600 },
  "transcriptapi.get_youtube_transcript": { ms: 1700, chars: 41000 },
  "transcriptapi.search_youtube": { ms: 1200, chars: 6200 },
  "zoodata.openapi_v2_products_search": { ms: 1900, chars: 15000, fails: { upstream_error: 0.01 } },
  "zoodata.openapi_v2_reviews_search": { ms: 2200, chars: 17000 },
  "zoodata.openapi_v3_realtime_product": { ms: 2600, chars: 9000, fails: { tool_error: 0.05 } },
} satisfies Record<string, ToolSpec>;
type ToolId = keyof typeof TOOLS;

type AgentSpec = {
  id: string;
  client_name: string;
  via: string;
  connected_at: number;
  /** Calls on a full weekday. */
  perDay: number;
  /** Follows the owner's day (in California) when true; runs on a schedule around the clock if not. */
  owner: boolean;
  tools: Partial<Record<ToolId, number>>;
};

const AGENTS: AgentSpec[] = [
  {
    id: "c3f2a9d41b7e6085",
    client_name: "Claude Code",
    via: "computer",
    connected_at: Date.UTC(2026, 9, 26, 17, 12, 40),
    perDay: 78,
    owner: true,
    tools: {
      "tavily.tavily_search": 20,
      "github.search_code": 18,
      "github.get_file_contents": 14,
      "firecrawl.firecrawl_scrape": 10,
      "tavily.tavily_extract": 8,
      "github.list_issues": 5,
      "firecrawl.firecrawl_search": 5,
      "github.search_repositories": 4,
      "redlisten.search_reddit": 4,
      "github.pull_request_read": 3,
      "transcriptapi.get_youtube_transcript": 2,
      "firecrawl.firecrawl_map": 2,
    },
  },
  {
    id: "8e14d07a5c2b93f6",
    client_name: "Claude",
    via: "claude.ai",
    connected_at: Date.UTC(2026, 9, 27, 20, 31, 5),
    perDay: 40,
    owner: true,
    tools: {
      "tavily.tavily_search": 24,
      "redlisten.search_reddit": 16,
      "x.search_posts_all": 9,
      "zoodata.openapi_v2_products_search": 8,
      "transcriptapi.get_youtube_transcript": 7,
      "redlisten.get_thread": 6,
      "tavily.tavily_extract": 6,
      "zoodata.openapi_v2_reviews_search": 5,
      "transcriptapi.search_youtube": 4,
      "firecrawl.firecrawl_scrape": 3,
      "zoodata.openapi_v3_realtime_product": 2,
    },
  },
  {
    id: "5a9b61e2f04c7d38",
    client_name: "Codex",
    via: "computer",
    connected_at: Date.UTC(2026, 10, 3, 18, 4, 52),
    perDay: 30,
    owner: true,
    tools: {
      "github.search_code": 22,
      "tavily.tavily_search": 18,
      "github.get_file_contents": 16,
      "firecrawl.firecrawl_scrape": 8,
      "firecrawl.firecrawl_search": 6,
      "tavily.tavily_extract": 5,
      "github.list_issues": 4,
      "github.pull_request_read": 4,
    },
  },
  {
    id: "f7d3c8b20e9a4165",
    client_name: "Hermes Agent",
    via: "computer",
    connected_at: Date.UTC(2026, 10, 12, 22, 47, 19),
    perDay: 15,
    owner: false,
    tools: {
      "x.search_posts_all": 26,
      "redlisten.latest_posts": 14,
      "tavily.tavily_search": 14,
      "redlisten.search_reddit": 12,
      "x.get_users_posts": 8,
      "x.get_posts_by_id": 4,
      "redlisten.get_thread": 4,
      "transcriptapi.get_youtube_transcript": 4,
    },
  },
];

/** How busy each hour of the owner's day is, in Pacific time (UTC−8 after 1 November). */
const OWNER_HOURS = [
  0.08, 0.04, 0.02, 0.02, 0.02, 0.03, 0.08, 0.3, 0.8, 1, 1, 1, 0.7, 0.9, 1, 1, 0.9, 0.7, 0.6, 0.6,
  0.6, 0.4, 0.3, 0.15,
];

type Call = {
  ts: number;
  agent: AgentSpec;
  tool: ToolId;
  status: "ok" | Failure;
  latency_ms: number;
  result_size: number;
  detail: string | null;
};

const PROVIDER_NAMES: Record<string, string> = Object.fromEntries(
  catalog.map((m) => [m.id, m.name]),
);

/** What Gator says back for a failure (apps/worker/src/text.ts), and what it keeps of the cause. */
function failure(tool: ToolId, status: Failure): Pick<Call, "result_size" | "detail"> {
  const provider = PROVIDER_NAMES[tool.split(".")[0]];
  const detail = {
    rate_limited: null,
    timeout: null,
    upstream_error: "HTTP 503",
    tool_error: tool.startsWith("github.")
      ? "failed to get file contents: Not Found"
      : "NOT_FOUND: no product with this ASIN in the marketplace right now",
  }[status];
  const text = {
    rate_limited: `${provider} says its rate limit or quota is used up. Try again later.`,
    timeout: `${provider} did not respond in time.`,
    upstream_error: `${provider} returned an error: ${detail}`,
    tool_error: detail ?? "",
  }[status];
  return { result_size: text.length, detail };
}

/** A successful call's figures. */
function ok(tool: ToolId) {
  const spec: ToolSpec = TOOLS[tool];
  return {
    status: "ok" as const,
    latency_ms: Math.round(around(spec.ms)),
    result_size: Math.round(around(spec.chars)),
    detail: null,
  };
}

function makeCall(ts: number, agent: AgentSpec): Call {
  const tool = pick(agent.tools);
  const spec: ToolSpec = TOOLS[tool];
  let status: Call["status"] = "ok";
  let r = random();
  for (const [kind, rate] of Object.entries(spec.fails ?? {}) as [Failure, number][]) {
    if (r < rate) {
      status = kind;
      break;
    }
    r -= rate;
  }
  if (status === "ok") return { ts, agent, tool, ...ok(tool) };
  const latency = status === "timeout" ? 30_000 + Math.round(random() * 40) : around(spec.ms / 2);
  return { ts, agent, tool, status, latency_ms: Math.round(latency), ...failure(tool, status) };
}

/** Every call, oldest first: each agent's day, quieter at weekends, from the day it connected. */
const calls: Call[] = [];
for (let day = Date.UTC(2026, 9, 26); day <= today; day += DAY) {
  const weekday = new Date(day).getUTCDay() % 6 !== 0;
  for (const agent of AGENTS) {
    if (day + DAY <= agent.connected_at) continue;
    // A new agent is tried out slowly for its first days.
    const settling = Math.min(1, 0.45 + (day - agent.connected_at) / (5 * DAY));
    const busy = (weekday ? 1 : agent.owner ? 0.4 : 0.85) * settling * (0.75 + 0.5 * random());
    const n = Math.round(agent.perDay * busy);
    for (let i = 0; i < n; i++) {
      const hour = agent.owner ? weighted(OWNER_HOURS) : Math.floor(random() * 24);
      // Pacific hour h is UTC hour h + 8: from 4 PM on, the early hours of the next UTC day.
      const ts = day + ((hour + 8) % 24) * HOUR + Math.floor(random() * HOUR);
      if (ts > agent.connected_at && ts < NOW - 40_000) calls.push(makeCall(ts, agent));
    }
  }
}
calls.sort((a, b) => a.ts - b.ts);

// The ten recent calls in view: all fine but one of Claude's, whose provider says why it failed.
const shown = calls.slice(-10);
for (const c of shown) if (c.status !== "ok") Object.assign(c, ok(c.tool));
Object.assign(shown.findLast((c) => c.agent.client_name === "Claude") ?? shown[0], {
  tool: "zoodata.openapi_v3_realtime_product",
  status: "tool_error",
  latency_ms: 2140,
  ...failure("zoodata.openapi_v3_realtime_product", "tool_error"),
});

/** Calls and failures since a first day, as the Worker sums usage_daily. */
function sum(rows: Call[], from: number) {
  const inRange = rows.filter((c) => c.ts >= from);
  return { calls: inRange.length, errors: inRange.filter((c) => c.status !== "ok").length };
}
const ranges = (rows: Call[]) => ({
  d7: sum(rows, today - 6 * DAY),
  d30: sum(rows, today - 29 * DAY),
  d90: sum(rows, today - 89 * DAY),
});
function byKey(key: (c: Call) => string) {
  const groups = new Map<string, Call[]>();
  for (const c of calls) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  return groups;
}
const byC90 = <T extends { d90: { calls: number } }>(a: T, b: T) => b.d90.calls - a.d90.calls;

const days = [...byKey((c) => isoDay(c.ts))].map(([day, rows]) => ({
  day,
  ...sum(rows, 0),
  latency_ms: rows.reduce((t, c) => t + c.latency_ms, 0),
}));
const tools = [...byKey((c) => c.tool)].map(([id, rows]) => ({ id, ...ranges(rows) })).sort(byC90);
// The Worker sends each range's top ten, together.
const top = new Set(
  (["d7", "d30", "d90"] as const).flatMap((r) =>
    [...tools].sort((a, b) => b[r].calls - a[r].calls).slice(0, 10),
  ),
);
const agentCalls = (agent: AgentSpec) => calls.filter((c) => c.agent === agent);

export const overview: Overview = {
  day: isoDay(today),
  today: { ...sum(calls, today), latency_ms: days.at(-1)?.latency_ms ?? 0 },
  days,
  agents: AGENTS.map((a) => ({
    id: a.id,
    client_name: a.client_name,
    connected_at: a.connected_at,
    via: a.via,
    revoked: false,
    ...ranges(agentCalls(a)),
  })).sort(byC90),
  providers: [...byKey((c) => c.tool.split(".")[0])]
    .map(([id, rows]) => ({ id, ...ranges(rows) }))
    .sort(byC90),
  tools: tools.filter((t) => top.has(t)),
  recent: calls
    .slice(-50)
    .reverse()
    .map((c) => ({
      ts: c.ts,
      agent: c.agent.client_name,
      agent_id: c.agent.id,
      tool_id: c.tool,
      status: c.status,
      latency_ms: c.latency_ms,
      result_size: c.result_size,
      backup: false,
      detail: c.detail,
      detail_capped: false,
    })),
};

export const agents: Agent[] = AGENTS.map((a) => {
  const mine = agentCalls(a);
  const { d7, d30, d90 } = ranges(mine);
  return {
    id: a.id,
    client_name: a.client_name,
    connected_at: a.connected_at,
    via: a.via,
    last_used_at: mine.at(-1)?.ts ?? null,
    calls: { d1: sum(mine, today).calls, d7: d7.calls, d30: d30.calls, d90: d90.calls },
  };
}).sort((a, b) => b.connected_at - a.connected_at);

/** Set up and in use, with their tool counts from the providers' live lists (November 2026). */
const SETUP: Record<string, Pick<Provider, "key_last4" | "tools">> = {
  firecrawl: { key_last4: "q7Lm", tools: { total: 38, enabled: 3, changed: 0, new: 0 } },
  github: { key_last4: "x2Pd", tools: { total: 28, enabled: 26, changed: 0, new: 0 } },
  redlisten: { key_last4: "9fKe", tools: { total: 13, enabled: 9, changed: 0, new: 0 } },
  tavily: { key_last4: "3bWn", tools: { total: 5, enabled: 2, changed: 0, new: 0 } },
  transcriptapi: { key_last4: "Rt5c", tools: { total: 12, enabled: 12, changed: 0, new: 0 } },
  x: { key_last4: "uV8s", tools: { total: 59, enabled: 4, changed: 0, new: 0 } },
  zoodata: { key_last4: "m4Ha", tools: { total: 71, enabled: 12, changed: 0, new: 0 } },
};

export const providers: Provider[] = catalog.map((m) => {
  const setup = SETUP[m.id];
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    category: m.category,
    mcp_url: m.mcp_url,
    signup_url: m.signup_url,
    docs_url: m.docs_url,
    key_hint: "key_hint" in m ? m.key_hint : undefined,
    read_only: m.read_only,
    key_required: "key_required" in m ? Boolean(m.key_required) : true,
    auth: m.auth,
    custom: false,
    enabled: Boolean(setup),
    key_last4: setup?.key_last4 ?? null,
    key_ok: true,
    backup_last4: null,
    backup_ok: true,
    on_backup: false,
    switched_at: null,
    key_same: false,
    review: false,
    timeout_ms: null,
    refreshed_at: setup ? NOW - 5 * HOUR : null,
    refresh_error: null,
    status: setup ? "ready" : "off",
    status_reason: null,
    tools: setup?.tools ?? { total: 0, enabled: 0, changed: 0, new: 0 },
  };
});

export const session: Session = {
  csrf: "screenshots",
  mcp_url: "https://gator.example.com/mcp",
  version: "0.1.0",
  keys_unreadable: [],
};

/** The dashboard's GET routes, answered as the Worker would. */
export const routes: Record<string, unknown> = {
  "/api/session": session,
  "/api/overview": overview,
  "/api/providers": providers,
  "/api/agents": agents,
};
