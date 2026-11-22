import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { type Overview as Data, type Provider, type Range, type Ranges, useLoad } from "../api";
import { Alert, breakable, Disclose, day, fullTime, num, Segmented, Stat, Tag, time } from "../ui";

const DAYS = 30;
const DAY = 86_400_000;
const RECENT = 10;
const TOP_TOOLS = 10;
/** Days of the chart that carry a date under them; the last one reads "Today". */
const TICKS = [0, 7, 14, 21, DAYS - 1];
const RANGES: { value: Range; text: string; label: string }[] = [7, 30, 90].map((d) => ({
  value: `d${d}` as Range,
  text: `${d}d`,
  label: `Last ${d} days`,
}));

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const percent = (part: number, whole: number) => Math.round((100 * part) / whole);
// Rounded down, so 99.96% never reads as 100%.
const succeeded = (calls: number, errors: number) =>
  calls ? `${num(Math.floor((1000 * (calls - errors)) / calls) / 10, 1)}%` : "–";
/** A result's length in tokens, at about four characters a token, to two significant figures:
    "7", "140", "3.1k", "13k". */
function tokens(chars: number) {
  const t = chars / 4;
  const n = t < 10 ? Math.round(t) : Number(t.toPrecision(2));
  return n < 1000 ? num(n) : `${num(n / 1000, n < 10_000 ? 1 : 0)}k`;
}

function Hero(props: { data: Data }) {
  const byDay = new Map(props.data.days.map((d) => [d.day, d]));
  // The server's today (a UTC date, read as its midnight), then whole days back.
  const last = Date.parse(props.data.day);
  const days = Array.from({ length: DAYS }, (_, i) => {
    const day = isoDay(last - (DAYS - 1 - i) * DAY);
    return { day, calls: byDay.get(day)?.calls ?? 0, errors: byDay.get(day)?.errors ?? 0 };
  });
  const month = props.data.days.reduce(
    (t, d) => ({ calls: t.calls + d.calls, errors: t.errors + d.errors, ms: t.ms + d.latency_ms }),
    { calls: 0, errors: 0, ms: 0 },
  );
  const today = DAYS - 1;
  // The day under the pointer or the keyboard; null hides the tooltip.
  const [picked, pick] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.calls));
  const name = (i: number) => (i === today ? "Today" : day(days[i].day));
  const reading = (i: number) =>
    `${name(i)}: ${num(days[i].calls)} calls, ${num(days[i].errors)} failed`;
  const key = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -DAYS, End: DAYS }[e.key];
    if (!step) return;
    e.preventDefault();
    pick(Math.min(today, Math.max(0, (picked ?? today) + step)));
  };
  const point = (e: PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    pick(Math.min(today, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * DAYS))));
  };
  const h = 100;

  return (
    <section class="panel hero">
      <div class="today">
        <h2 class="display">Calls today</h2>
        <p class="big">{num(props.data.today.calls)}</p>
        <p class="dim">{num(days[today - 1].calls)} yesterday</p>
        <p class="stats">
          <Stat n={month.calls}>calls in {DAYS} days</Stat>
          <Stat n={succeeded(month.calls, month.errors)}>succeeded</Stat>
          <Stat n={month.calls ? `${num(Math.round(month.ms / month.calls))} ms` : "–"}>
            average latency
          </Stat>
        </p>
      </div>
      <figure class="chart">
        {/* A slider over the days: the pointer, a tap or the arrow keys pick the day the tooltip reads. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label={`Calls per day, last ${DAYS} days`}
          aria-valuemin={1}
          aria-valuemax={DAYS}
          aria-valuenow={(picked ?? today) + 1}
          aria-valuetext={reading(picked ?? today)}
          onKeyDown={key}
          onFocus={() => pick(picked ?? today)}
          onBlur={() => pick(null)}
          onPointerDown={point}
          onPointerMove={point}
          onPointerLeave={(e) =>
            e.pointerType === "mouse" && document.activeElement !== e.currentTarget && pick(null)
          }
        >
          <svg viewBox={`0 0 ${DAYS * 10} ${h}`} preserveAspectRatio="none" aria-hidden="true">
            {days.map((d, i) => (
              <g key={d.day} class={i === picked ? "picked" : undefined}>
                {(["calls", "errors"] as const).map((series) => (
                  <rect
                    key={series}
                    class={series}
                    x={i * 10 + 1.5}
                    width={7}
                    y={h - (h * d[series]) / max}
                    height={(h * d[series]) / max}
                  />
                ))}
              </g>
            ))}
          </svg>
          {picked !== null && (
            <span
              class={`tip shown${picked < 4 ? " start" : picked > DAYS - 5 ? " end" : ""}`}
              style={{ left: `${(100 * (picked + 0.5)) / DAYS}%` }}
              aria-hidden="true"
            >
              <strong>{name(picked)}</strong> {num(days[picked].calls)} calls ·{" "}
              {num(days[picked].errors)} failed
            </span>
          )}
        </div>
        <div class="axis" aria-hidden="true">
          {TICKS.map((i) => (
            <span key={i} style={{ gridColumn: i + 1 }}>
              {name(i)}
            </span>
          ))}
        </div>
      </figure>
    </section>
  );
}

type Row = { key: string; name: ComponentChildren } & Ranges;

/** Rows for one range: the name; at the end the total, after a failure rate when it is over 10%;
    beneath, a bar in proportion whose pink end is the failed share. Hover, focus or a tap shows the
    exact numbers. */
function Bars(props: {
  title: string;
  rows: Row[];
  count?: boolean;
  top?: number;
  wide?: boolean;
}) {
  const [range, setRange] = useState<Range>("d30");
  const rows = props.rows
    .filter((r) => r[range].calls > 0)
    .sort((a, b) => b[range].calls - a[range].calls)
    .slice(0, props.top);
  const max = Math.max(1, ...rows.map((r) => r[range].calls));
  return (
    <section class={props.wide ? "panel wide" : "panel"}>
      <div class="card-head">
        <h2 class="display">
          {props.title}
          {props.count && <Stat n={rows.length} />}
        </h2>
        <Segmented
          legend={`${props.title}: range`}
          options={RANGES}
          value={range}
          onChange={setRange}
        />
      </div>
      {rows.length === 0 ? (
        <p class="empty">No calls in the last {range.slice(1)} days.</p>
      ) : (
        // Two columns fill top to bottom: the first holds the first half of the rows.
        <ul class="bars" style={{ "--rows": Math.ceil(rows.length / 2) }}>
          {rows.map((r) => {
            const { calls, errors } = r[range];
            const rate = percent(errors, calls);
            return (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: focus (or a tap) shows the row's exact numbers, as hover does
              <li key={r.key} tabIndex={0} class="tipped">
                <span class="item">{r.name}</span>
                <span class="figures">
                  {errors * 10 > calls && <Tag kind="error">{`${rate}%`}</Tag>}
                  <span class="n">{num(calls)}</span>
                </span>
                <span class="bar" aria-hidden="true">
                  <span class="calls" style={{ width: `${(100 * calls) / max}%` }}>
                    {errors > 0 && (
                      <span class="errors" style={{ width: `${(100 * errors) / calls}%` }} />
                    )}
                  </span>
                </span>
                <span class="tip">
                  {num(calls)} calls · {num(calls - errors)} succeeded · {num(errors)} failed (
                  {rate}%)
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const LINK = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;

/** Provider text as text, with its http(s) URLs as links. A URL the cap cut off leads nowhere, so
    it stays text. */
function linkify(text: string, capped: boolean) {
  const out: ComponentChildren[] = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    const end = m.index + m[0].length;
    out.push(
      text.slice(at, m.index),
      capped && end === text.length ? (
        breakable(m[0])
      ) : (
        <a href={m[0]} target="_blank" rel="noopener noreferrer">
          {breakable(m[0])}
        </a>
      ),
    );
    at = end;
  }
  out.push(text.slice(at));
  return out;
}

function Recent(props: {
  rows: Data["recent"];
  who: (name: string, id: string) => ComponentChildren;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(new Set<number>());
  const toggle = (i: number) => {
    const next = new Set(open);
    if (!next.delete(i)) next.add(i);
    setOpen(next);
  };
  return (
    <section class="panel">
      <h2 class="display">Recent calls</h2>
      <table class="stack recent">
        <thead>
          <tr>
            <th>Time</th>
            <th>Agent</th>
            <th>Tool</th>
            <th>Status</th>
            <th>
              <span class="sr-only">Details</span>
            </th>
            <th class="n">Latency</th>
            <th class="n">≈ Tokens</th>
          </tr>
        </thead>
        <tbody>
          {(all ? props.rows : props.rows.slice(0, RECENT)).map((c, i) => {
            const size = tokens(c.result_size);
            return [
              <tr key={i} class={open.has(i) ? "opened" : undefined}>
                <td data-label="Time" class="nowrap">
                  <time dateTime={new Date(c.ts).toISOString()} title={fullTime(c.ts)}>
                    {time(c.ts)}
                  </time>
                </td>
                <td data-label="Agent">{props.who(c.agent, c.agent_id)}</td>
                <td data-label="Tool" class="mono tool">
                  {breakable(c.tool_id)}
                </td>
                <td data-label="Status">
                  <span class="tags">
                    <Tag kind={c.status === "ok" ? "ok" : "error"}>{c.status}</Tag>
                    {c.backup && <Tag kind="off">backup key</Tag>}
                  </span>
                </td>
                <td>
                  {c.detail && (
                    <Disclose open={open.has(i)} controls={`call-${i}`} onClick={() => toggle(i)}>
                      Details
                    </Disclose>
                  )}
                </td>
                <td data-label="Latency" class="n">
                  {num(c.latency_ms)} ms
                </td>
                {/* Without the column header (on a phone) the label is the unit after the figure. */}
                <td data-label={size === "1" ? "token" : "tokens"} class="n size">
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus (or a tap) shows the exact length, as hover does */}
                  <span class="tipped" tabIndex={0}>
                    {size}
                    <span class="tip">{num(c.result_size)} characters</span>
                  </span>
                </td>
              </tr>,
              c.detail && open.has(i) && (
                <tr key={`${i}d`} id={`call-${i}`} class="said">
                  <td colSpan={7}>
                    <div class="detail">
                      <p>{linkify(c.detail, c.detail_capped)}</p>
                      {c.detail_capped && (
                        <p class="capped">Gator keeps the first 300 characters of a message.</p>
                      )}
                    </div>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      {props.rows.length > RECENT && (
        <button type="button" class="more" onClick={() => setAll(!all)}>
          {all ? `Show the last ${RECENT}` : `Show all ${props.rows.length}`}
        </button>
      )}
    </section>
  );
}

export function Overview() {
  const { data, error } = useLoad<Data>("/api/overview");
  const { data: providers } = useLoad<Provider[]>("/api/providers");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return null;
  const names = new Map(providers?.map((p) => [p.id, p.name]));
  const revoked = new Set(data.agents.filter((a) => a.revoked).map((a) => a.id));
  /** An agent's name, and "revoked" after it once its access is gone. */
  const who = (name: string, id: string) => (
    <>
      <span class="name">{name || "Unknown agent"}</span>
      {revoked.has(id) && (
        <>
          {" "}
          <span class="qual">revoked</span>
        </>
      )}
    </>
  );

  if (data.days.length === 0 && data.recent.length === 0)
    return (
      <>
        <h1 class="display">Overview</h1>
        <section class="panel start">
          <h2 class="display">No calls yet</h2>
          <ol>
            <li>
              <a href="/providers">Enable a provider</a> and add its API key.
            </li>
            <li>
              <a href="/agents">Connect an agent</a>: Claude, Claude Code or any MCP client.
            </li>
            <li>Ask it something that needs live data. Its calls show up here.</li>
          </ol>
        </section>
      </>
    );

  return (
    <>
      {/* Counts are kept per UTC day; the times below are the browser's own. */}
      <div class="titled">
        <h1 class="display">Overview</h1>
        <span class="hint">Days in UTC</span>
      </div>
      <Hero data={data} />
      <div class="breakdowns">
        <Bars
          title="By provider"
          count
          rows={data.providers.map((p) => ({
            ...p,
            key: p.id,
            name: <span class="name">{names.get(p.id) ?? p.id}</span>,
          }))}
        />
        <Bars
          title="By agent"
          count
          rows={data.agents.map((a) => ({
            ...a,
            key: a.id,
            name: who(a.client_name, a.id),
          }))}
        />
        <Bars
          title="Top tools"
          top={TOP_TOOLS}
          wide
          rows={data.tools.map((t) => {
            const [provider, tool] = t.id.split(/\.(.*)/);
            return {
              ...t,
              key: t.id,
              name: (
                <>
                  <span class="name">{breakable(tool)}</span>{" "}
                  <span class="badge">{names.get(provider) ?? provider}</span>
                </>
              ),
            };
          })}
        />
      </div>
      <Recent rows={data.recent} who={who} />
    </>
  );
}
