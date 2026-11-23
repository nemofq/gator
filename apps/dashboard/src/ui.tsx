import type { ComponentChildren, InputHTMLAttributes } from "preact";
import { useId, useState } from "preact/hooks";
import type { Provider } from "./api";

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** A number in the browser's locale, like every date on the dashboard. */
export const num = (n: number, fractionDigits = 0) =>
  n.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });

export function ago(ms: number | null) {
  if (ms === null) return "never";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return date(ms);
}

// Dates and times are written the browser's way: its locale's order and month names ("Nov 20",
// "20 Nov", "20. Nov."), its clock, its time zone. The year shows only outside this one, judged in
// the zone the date is written in.
const stamp = (ms: number, options: Intl.DateTimeFormatOptions) => {
  const year = (t: number) =>
    new Date(t).toLocaleString("en", { year: "numeric", timeZone: options.timeZone });
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: year(ms) === year(Date.now()) ? undefined : "numeric",
    ...options,
  }).format(ms);
};

export const date = (ms: number) => stamp(ms, {});

/** A day the server counts by ("2026-11-20"): a calendar date with no zone. Read as UTC midnight
    and named in UTC, it is the same date in every browser. */
export const day = (iso: string) => stamp(Date.parse(iso), { timeZone: "UTC" });

/** The date with the time, to the second or to the minute. */
export const time = (ms: number, seconds = true) =>
  stamp(ms, { hour: "numeric", minute: "2-digit", second: seconds ? "2-digit" : undefined });

/** Everything, weekday, year and time zone included, for a tooltip. */
export const fullTime = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" }).format(ms);

/** An identifier or URL that may break after a separator ("." "_" "/" "?" "&" "="), never inside a
    word, nor inside "://". */
export const breakable = (s: string) =>
  s.split(/(?<=[^/:]\/|[._?&=])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));

/** A provider's one category tag: its first, capitalised, or "Custom". */
export function category(p: Provider) {
  const c = p.custom ? "custom" : p.category[0];
  return c && c[0].toUpperCase() + c.slice(1);
}

/** How to tell agents with the same name apart: the host they connected through, if not this
    computer, and when. */
export function agentLabel(a: { via: string | null; connected_at: number }) {
  // It wraps only between its parts.
  return [a.via !== "computer" && a.via, `since ${date(a.connected_at)}`]
    .filter((p) => typeof p === "string")
    .map((p) => p.replaceAll(" ", "\u00a0"))
    .join(" · ");
}

/** A provider's icon and name. The icon is the catalog's, or the name's first letter when there is
    none (a custom provider, or no file); it keeps its size either way, so nothing moves. The name
    stays on one line and is cut with an ellipsis when it does not fit; its title holds all of it. */
export function ProviderName(props: { p: Provider }) {
  const [letter, setLetter] = useState(props.p.custom);
  return (
    <>
      <span class="logo" aria-hidden="true">
        {letter ? (
          props.p.name[0]
        ) : (
          <img
            src={`/icons/${props.p.id}.png`}
            alt=""
            width={64}
            height={64}
            decoding="async"
            onError={() => setLetter(true)}
          />
        )}
      </span>
      <span class="name" title={props.p.name}>
        {props.p.name}
      </span>
    </>
  );
}

// Every icon is drawn in a 10-unit square, one cap height tall, standing on the baseline: so it
// centres on the capitals beside it in any font.
const ICONS = {
  ok: <circle cx="5" cy="5" r="3" />,
  off: <circle class="line" cx="5" cy="5" r="2.6" />,
  error: <path class="line" d="M2.6 2.6l4.8 4.8m0-4.8L2.6 7.4" />,
  changed: <path d="M5 1.4 8.6 5 5 8.6 1.4 5z" />,
  write: <path d="M5 1.2 9.2 8.6H.8z" />,
  chevron: <path class="line" d="M3.6 1.6 7 5 3.6 8.4" />,
  check: <path class="line" d="M.9 5.3 3.8 8.3 9.3 1.9" />,
  // A little past the square, so a thin ring looks as large as the capitals.
  ring: <circle class="line spin" cx="5" cy="5" r="5" pathLength="4" stroke-dasharray="3 1" />,
};

const TURN = { left: "180deg", down: "90deg", up: "-90deg" };

/** `turn` points the chevron left, down or up. */
export function Icon(props: { name: keyof typeof ICONS; turn?: keyof typeof TURN }) {
  return (
    <svg
      class="icon"
      style={props.turn && { rotate: TURN[props.turn] }}
      viewBox="0 0 10 10"
      aria-hidden="true"
    >
      {ICONS[props.name]}
    </svg>
  );
}

/** A state label: always an icon and a word, never colour alone. */
export function Tag(props: {
  kind: "ok" | "off" | "error" | "changed" | "write";
  children: ComponentChildren;
}) {
  return (
    <span class={`tag ${props.kind}`}>
      <Icon name={props.kind} />
      {props.children}
    </span>
  );
}

/** A figure and what it counts. The container decides the scale: inline in a heading or a line,
    or stacked in a row of stats. */
export function Stat(props: { n: string | number; children?: ComponentChildren }) {
  return (
    <span class="stat">
      <strong>{typeof props.n === "number" ? num(props.n) : props.n}</strong>
      {props.children && <span> {props.children}</span>}
    </span>
  );
}

/** Steps through a menu: "Settings > Connectors > …" with chevrons; a line breaks after one. */
export function Path(props: { steps: ComponentChildren[] }) {
  return props.steps.map((s, i) => (
    <span key={i} class="step">
      {s}
      {i < props.steps.length - 1 && <Icon name="chevron" />}
    </span>
  ));
}

/** One choice of a few, as a row of pressed and unpressed buttons. */
export function Segmented<T extends string>(props: {
  legend: string;
  options: { value: T; text: string; label?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset class="segmented">
      <legend class="sr-only">{props.legend}</legend>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          aria-label={o.label}
          onClick={() => props.onChange(o.value)}
        >
          {o.text}
        </button>
      ))}
    </fieldset>
  );
}

/** A quiet show/hide control for the content with id `controls`. */
export function Disclose(props: {
  open: boolean;
  controls: string;
  onClick: (e: MouseEvent) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      class="disclose"
      aria-expanded={props.open}
      aria-controls={props.controls}
      onClick={props.onClick}
    >
      {props.children}
      <Icon name="chevron" turn={props.open ? "up" : "down"} />
    </button>
  );
}

export function Switch(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={props.checked}
      class="switch"
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
    />
  );
}

/** Text to copy, and a Copy button as wide as "Copied", so it does not jump. */
export function CopyLine(props: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(props.text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    });
  return (
    <div class="copyline">
      <code>{breakable(props.text)}</code>
      <button type="button" class="copy" onClick={copy} aria-label={props.label}>
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** "A", "A and B", "A, B and C", each a link to its provider page. */
export function ProviderLinks(props: { providers: { id: string; name: string }[] }) {
  const last = props.providers.length - 1;
  return props.providers.map((p, i) => (
    <span key={p.id}>
      {i > 0 && (i === last ? " and " : ", ")}
      <a href={`/providers/${encodeURIComponent(p.id)}`}>{p.name}</a>
    </span>
  ));
}

/** An API key field: text masked by CSS, not type="password". Browsers fill a saved password into
    any password field, whatever its autocomplete says, and offer to save what is typed there. */
export function KeyInput(props: Omit<InputHTMLAttributes, "type" | "class" | "role">) {
  return (
    <input
      {...props}
      type="text"
      class="key"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck={false}
    />
  );
}

export function Alert(props: { children: ComponentChildren }) {
  return (
    <p class="alert" role="alert">
      <Icon name="error" />
      {props.children}
    </p>
  );
}

/** Runs the actions of a group of controls, one at a time. It exposes whether one is running, the
    message it failed with, and what the control that started it (`by`; a form's submit button when
    left out) shows: nothing for 300 ms, so a quick action never flashes, then a ring; after a slow
    success, a check for 1.5 s. An action that resolves `false` ran but did not succeed, and the
    page says why: no check. */
export function useAction() {
  const [error, setError] = useState("");
  const [shown, setShown] = useState<{ by: string; icon?: "ring" | "check" }>();
  const run = async (action: () => Promise<unknown>, by = "submit") => {
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      setShown({ by, icon: "ring" });
    }, 300);
    setShown({ by });
    setError("");
    try {
      if ((await action()) === false) slow = false;
    } catch (e) {
      slow = false;
      setError((e as Error).message);
    }
    clearTimeout(timer);
    const done = slow ? ({ by, icon: "check" } as const) : undefined;
    setShown(done);
    if (done) setTimeout(() => setShown((s) => (s === done ? undefined : s)), 1500);
  };
  return { busy: shown !== undefined && shown.icon !== "check", error, run, shown };
}

type Action = ReturnType<typeof useAction>;

/** A button that runs `onRun` with `action`, or without it submits its form, whose submit runs
    `action`. While the action runs, every button of it is disabled; this one is busy, not faded,
    and shows what `useAction` says before its label, announcing a success it marked. The label
    alone and the label after the icon share one grid cell, the one not shown hidden: the button is
    always as wide as the wider, so neither it nor anything beside it moves. */
export function Button(props: {
  action: Action;
  onRun?: () => Promise<unknown>;
  class?: string;
  children: ComponentChildren;
}) {
  const { action, onRun } = props;
  const id = useId();
  const by = onRun ? id : "submit";
  const mine = action.shown?.by === by ? action.shown : undefined;
  return (
    <>
      <button
        type={onRun ? "button" : "submit"}
        class={props.class ? `act ${props.class}` : "act"}
        disabled={action.busy}
        aria-busy={action.busy && mine ? true : undefined}
        onClick={onRun && (() => action.run(onRun, by))}
      >
        <span class={mine?.icon && "hide"}>{props.children}</span>
        <span class={mine?.icon ? undefined : "hide"}>
          <Icon name={mine?.icon ?? "check"} />
          {props.children}
        </span>
      </button>
      <span class="sr-only" role="status">
        {mine?.icon === "check" && "Done"}
      </span>
    </>
  );
}

/** The ring after a switch's label while the action it started (`by`) takes long; a switch cannot
    hold it. After the label, so nothing moves. */
export function Pending(props: { action: Action; by: string }) {
  const { shown } = props.action;
  return shown?.by === props.by && shown.icon === "ring" ? (
    <span class="pending">
      <Icon name="ring" />
    </span>
  ) : null;
}
