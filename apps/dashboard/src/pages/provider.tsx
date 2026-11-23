import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  api,
  type Provider,
  type ProviderDetail,
  type Settings,
  type Tool,
  type ToolDetail,
  useLoad,
} from "../api";
import {
  Alert,
  ago,
  Button,
  breakable,
  category,
  Disclose,
  Icon,
  KeyInput,
  navigate,
  num,
  Pending,
  ProviderName,
  Stat,
  Switch,
  Tag,
  time,
  useAction,
} from "../ui";

type Op = ["=" | "-" | "+" | "…", string];

/** Longest-common-subsequence diff of two token lists. */
function diff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push(["=", a[i++]]);
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push(["+", b[j++]]);
    else ops.push(["-", a[i++]]);
  }
  return ops;
}

const words = (s: string) => s.split(/(\s+)/);

/** Keeps two unchanged lines around each change and folds the rest into one marker line. */
function context(ops: Op[]): Op[] {
  const near = (i: number) => ops.slice(Math.max(0, i - 2), i + 3).some(([op]) => op !== "=");
  return ops.flatMap((op, i): Op[] => {
    if (near(i)) return [op];
    return i === 0 || near(i - 1) ? [["…", "unchanged lines"]] : [];
  });
}
const lines = (o: object) => JSON.stringify(o, null, 2).split("\n");

function Review(props: { providerId: string; tool: Tool; onApproved: () => void }) {
  const path = `/api/providers/${encodeURIComponent(props.providerId)}/tools/${encodeURIComponent(props.tool.name)}`;
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ToolDetail>();
  const action = useAction();
  const toggle = () => {
    setOpen(!open);
    if (!detail) action.run(async () => setDetail(await api<ToolDetail>(path)));
  };
  const approve = async () => {
    await api(path, "PATCH", { approve: true });
    props.onApproved();
  };
  const { approved, latest } = detail ?? {};

  return (
    <li class="review">
      <div class="row">
        <span class="mono">{props.tool.name}</span>
        <Disclose open={open} controls={`diff-${props.tool.name}`} onClick={toggle}>
          Changes
        </Disclose>
        <Button action={action} class="primary" onRun={approve}>
          Approve
        </Button>
      </div>
      {action.error && <Alert>{action.error}</Alert>}
      {open && approved && latest && (
        <div class="diff" id={`diff-${props.tool.name}`}>
          {approved.read_only !== latest.read_only && (
            <p>
              <Tag kind={latest.read_only ? "ok" : "write"}>
                {latest.read_only ? "Now read-only" : "No longer read-only: it can make changes"}
              </Tag>
            </p>
          )}
          <h3 class="display">Description</h3>
          <p class="words">
            {diff(words(approved.description), words(latest.description)).map(([op, w], i, ops) => {
              if (op === "=") return w;
              // A removed word next to an added one would otherwise run together: "datareturn".
              const gap = i > 0 && ops[i - 1][0] !== "=" && ops[i - 1][0] !== op ? " " : "";
              return [gap, op === "-" ? <del key={i}>{w}</del> : <ins key={i}>{w}</ins>];
            })}
          </p>
          <h3 class="display">Input schema</h3>
          <pre class="lines">
            {context(diff(lines(approved.input_schema), lines(latest.input_schema))).map(
              ([op, l], i) => (
                <span key={i} class={op === "-" ? "del" : op === "+" ? "ins" : undefined}>
                  {op === "=" ? " " : op === "…" ? "⋯" : op} {l}
                  {"\n"}
                </span>
              ),
            )}
          </pre>
          <p class="hint">
            <del>Struck out</del>: in the approved version only. <ins>Underlined</ins>: in the new
            version only.
          </p>
        </div>
      )}
    </li>
  );
}

const STORED = "Stored encrypted. Only its last four characters are shown again.";

function KeyForm(props: {
  id: string;
  noun: "key" | "backup key";
  last4: string | null;
  ok: boolean;
  save: (key: string | null) => Promise<void>;
  children: ComponentChildren;
}) {
  const { noun, last4 } = props;
  const [key, setKey] = useState("");
  const action = useAction();
  const submit = (e: Event) => {
    e.preventDefault();
    action.run(() => props.save(key.trim()).then(() => setKey("")));
  };
  return (
    <form onSubmit={submit}>
      <div class="row">
        <label for={props.id}>{noun === "key" ? "Main key" : "Backup key"}</label>
        {last4 === null ? (
          <Tag kind="off">None saved</Tag>
        ) : props.ok ? (
          <Tag kind="ok">
            Saved <span class="mono">…{last4}</span>
          </Tag>
        ) : (
          <Tag kind="error">
            Unreadable <span class="mono">…{last4}</span>
          </Tag>
        )}
      </div>
      {last4 !== null && !props.ok && (
        <p class="hint">Gator cannot read it: the encryption key has changed. Enter it again.</p>
      )}
      <div class="row">
        <KeyInput
          id={props.id}
          required
          placeholder={last4 === null ? "" : `A new ${noun} replaces the saved one`}
          value={key}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <Button action={action} class="primary" done="Saved">
          Save {noun}
        </Button>
        {last4 !== null && (
          <Button action={action} onRun={() => props.save(null)}>
            Remove {noun}
          </Button>
        )}
      </div>
      <p class="hint">{props.children}</p>
      {action.error && <Alert>{action.error}</Alert>}
    </form>
  );
}

function Keys(props: { p: ProviderDetail; patch: (body: object) => Promise<void> }) {
  const { p, patch } = props;
  const action = useAction();
  const since = p.switched_at === null ? "" : `, switched ${ago(p.switched_at)}`;
  return (
    <section class="panel">
      <h2 class="display">{p.key_required ? "API key" : "API key (optional)"}</h2>
      {p.backup_last4 !== null && (
        <div class="row">
          <Tag kind={p.on_backup ? "changed" : "ok"}>
            {`In use: ${p.on_backup ? "backup" : "primary"} key${since}`}
          </Tag>
          {p.on_backup && (
            <Button action={action} onRun={() => patch({ on_backup: false })}>
              Switch back to primary
            </Button>
          )}
        </div>
      )}
      {action.error && <Alert>{action.error}</Alert>}
      {p.key_same && (
        <p class="note">
          <Icon name="changed" />
          With this key the provider lists the same tools as without one. If you expected more,
          check the key.
        </p>
      )}
      <KeyForm id="key" noun="key" last4={p.key_last4} ok={p.key_ok} save={(key) => patch({ key })}>
        {p.signup_url && (
          <>
            <a href={p.signup_url} target="_blank" rel="noopener noreferrer">
              Get API key
            </a>
            {". "}
          </>
        )}
        {p.key_hint ?? STORED}
      </KeyForm>
      {(p.key_last4 !== null || p.backup_last4 !== null) && (
        <KeyForm
          id="backup-key"
          noun="backup key"
          last4={p.backup_last4}
          ok={p.backup_ok}
          save={(backup_key) => patch({ backup_key })}
        >
          Optional. It takes over when the main key reaches its limit.
        </KeyForm>
      )}
    </section>
  );
}

/** The page of a provider that is off and has no key: how to connect it, and nothing else. Once
    connected, "Connected" shows for a second before the full page `opened` brings. */
function Setup(props: {
  p: ProviderDetail;
  connect: (key: string) => Promise<void>;
  opened: () => void;
}) {
  const { p } = props;
  const [key, setKey] = useState("");
  const action = useAction();
  const submit = async (e: Event) => {
    e.preventDefault();
    // Not again while "Connected" shows.
    if (action.shown) return;
    if (await action.run(() => props.connect(key.trim()))) setTimeout(props.opened, 1000);
  };
  const button = (
    <Button action={action} class="primary" done="Connected">
      Connect
    </Button>
  );
  const paste = p.signup_url ? "Paste it here" : `Paste your ${p.name} API key here`;
  const field = (
    <>
      <span id="setup-key-label">
        {p.key_required ? `${paste}.` : `${paste}, or leave it empty.`}
      </span>
      <div class="row">
        <KeyInput
          id="setup-key"
          aria-labelledby="setup-key-label"
          aria-describedby="setup-key-hint"
          required={p.key_required}
          value={key}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        {button}
      </div>
      <p class="hint" id="setup-key-hint">
        {p.key_hint ?? STORED}
      </p>
    </>
  );
  return (
    <form class="panel start" onSubmit={submit}>
      <h2 class="display">Set up {p.name}</h2>
      {!p.key_required && !p.auth ? (
        <>
          <p>It needs no API key. Connect lists its tools for your agents.</p>
          <div class="row">{button}</div>
        </>
      ) : p.signup_url ? (
        <ol>
          <li>
            <a href={p.signup_url} target="_blank" rel="noopener noreferrer">
              Get an API key
            </a>{" "}
            from {p.name}.
          </li>
          <li>{field}</li>
        </ol>
      ) : (
        field
      )}
      {action.error && <Alert>{action.error}</Alert>}
    </form>
  );
}

/** Text as paragraphs, a run of lines that start with "- " as a list, and `end` after the last
    words. Text only, never HTML. */
function Blocks(props: { text: string; end: ComponentChildren }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of props.text.split("\n")) {
    const line = raw.trim();
    const list = line.startsWith("- ");
    const last = blocks.at(-1);
    if (!line) continue;
    if (list && last?.list) last.lines.push(line.slice(2));
    else blocks.push({ list, lines: [list ? line.slice(2) : line] });
  }
  return blocks.map((b, i) => {
    const end = i === blocks.length - 1 && props.end;
    return b.list ? (
      <ul key={i}>
        {b.lines.map((l, j) => (
          <li key={j}>
            {l}
            {j === b.lines.length - 1 && end}
          </li>
        ))}
      </ul>
    ) : (
      <p key={i}>
        {b.lines[0]}
        {end}
      </p>
    );
  });
}

/** A tool's description on one line; when it is longer, the whole line is a control that opens
    it, with "More" at its end. The list holds the text cut at a word when `clipped`; the whole text
    is fetched on the first open. */
function Description(props: { path: string; tool: Tool }) {
  const { tool } = props;
  const line = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const [long, setLong] = useState(tool.clipped);
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState<string>();
  const { error, run } = useAction();
  useLayoutEffect(() => {
    const e = line.current;
    if (e && e.scrollWidth > e.clientWidth) setLong(true);
  }, [tool.description]);
  // Opening or closing swaps the control for another button: focus follows it.
  useLayoutEffect(() => {
    if (refocus.current) box.current?.querySelector("button")?.focus();
    refocus.current = false;
  }, [open]);
  const toggle = (e: Event) => {
    refocus.current = e.currentTarget === document.activeElement;
    setOpen(!open);
    if (tool.clipped && whole === undefined)
      run(async () => setWhole((await api<ToolDetail>(props.path)).approved.description));
  };
  const id = `about-${tool.name}`;
  const text = (
    <span ref={line} class="line">
      {tool.description}
    </span>
  );
  return (
    <div id={id} ref={box} class="about">
      {open ? (
        <Blocks
          text={whole ?? tool.description}
          end={
            <>
              {" "}
              <Disclose open controls={id} onClick={toggle}>
                Less
              </Disclose>
            </>
          }
        />
      ) : long ? (
        <button
          type="button"
          class="disclose opener"
          aria-expanded={false}
          aria-controls={id}
          onClick={toggle}
        >
          {text}
          <span>
            More
            <Icon name="chevron" turn="down" />
          </span>
        </button>
      ) : (
        text
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

const KIND = { added: "Added", removed: "Removed", modified: "Modified" };

/** Whether changes wait for approval, what waits, and what changed lately. */
function ToolChanges(props: {
  p: ProviderDetail;
  pending: Tool[];
  patch: (body: object) => Promise<void>;
  reload: () => void;
}) {
  const { p } = props;
  const action = useAction();
  return (
    <section class="panel">
      <h2 class="display">Tool changes</h2>
      <div class="row">
        <Switch
          checked={p.review}
          label="Review tool changes"
          disabled={action.busy}
          onChange={(review) => action.run(() => props.patch({ review }), "review")}
        />
        <span>
          <strong>Review {p.review ? "on" : "off"}</strong>
          <span class="dim">
            {p.review
              ? ": a change to a switched-on tool waits for your approval."
              : ": changes apply at each refresh. Switch on to approve them first."}
          </span>
          <Pending action={action} by="review" />
        </span>
      </div>
      {action.error && <Alert>{action.error}</Alert>}
      {props.pending.length > 0 && (
        <>
          <h3 class="display">
            To review
            <Stat n={props.pending.length} />
          </h3>
          <p class="hint">Agents keep seeing the approved version until you approve the new one.</p>
          <ul class="plain-list">
            {props.pending.map((t) => (
              <Review key={t.name} providerId={p.id} tool={t} onApproved={props.reload} />
            ))}
          </ul>
        </>
      )}
      {p.changes.length > 0 && (
        <>
          <h3 class="display">Recent changes</h3>
          <ul class="changes">
            {p.changes.map((c) => (
              <li key={`${c.ts}${c.name}`}>
                <span class="dim">{KIND[c.kind]}</span>
                <span class="mono">{breakable(c.name)}</span>
                <time class="dim" dateTime={new Date(c.ts).toISOString()}>
                  {time(c.ts, false)}
                </time>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type Test = { ok: boolean; tools?: number; error?: string };

/** Review first, then switched-on tools, then new ones (off until switched on), then the other
    switched-off ones, then removed ones; by name within. */
const rank = (t: Tool, isNew: boolean) =>
  t.status === "changed" ? 0 : t.status === "removed" ? 4 : t.enabled ? 1 : isNew ? 2 : 3;

export function ProviderPage(props: { id: string; refreshSession: () => void }) {
  const base = `/api/providers/${encodeURIComponent(props.id)}`;
  // Never from memory: what the page shows first (setup or not, which tools are new) is decided
  // once, from the first answer.
  const { data: p, error, set, reload } = useLoad<ProviderDetail>(base, false);
  // Only for the timeout field's default; the page does not wait for it.
  const { data: settings, error: settingsError } = useLoad<Settings>("/api/settings");
  const [test, setTest] = useState<Test>();
  const [timeout, setTimeoutMs] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [turnedOn, setTurnedOn] = useState<string>();
  // Switches flipped on this page. The list is sorted by what the server last said, so a tool
  // does not jump away while it is being switched; the next load sorts it into place.
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const action = useAction();
  // While switching on or off (switching on lists its tools), the switch shows what was asked.
  const [wanted, setWanted] = useState<boolean>();
  const toolAction = useAction();
  // Whether it opened not set up: off, with no key. Decided once, so switching it off or removing
  // its key here does not swap the page under the pointer.
  const setup = useRef<boolean>(undefined);
  const [, setOpened] = useState(false);
  // The tools that were new when the page opened keep their tag until the owner leaves it. Opening
  // the page marks them seen once it is visible; a failure is not the owner's doing, so it is silent.
  const [fresh, setFresh] = useState<string[]>();
  useEffect(() => {
    if (!p || fresh) return;
    const names = p.tool_list.filter((t) => t.new).map((t) => t.name);
    setFresh(names);
    if (names.length === 0) return;
    const seen = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", seen);
      api(`${base}/seen`, "POST").catch(() => {});
    };
    document.addEventListener("visibilitychange", seen);
    seen();
  }, [p]);

  if (error) return <Alert>{error}</Alert>;
  if (!p) return null;

  const patch = async (body: object) => {
    await api(base, "PATCH", body);
    await reload();
  };
  const patchKeys = async (body: object) => {
    await patch(body);
    props.refreshSession();
  };
  // Switching it on lists its tools in the same request; a failed listing is saved, not an HTTP
  // error, so it is undone here and its reason thrown.
  const connect = async (key: string) => {
    const on = await api<Provider>(base, "PATCH", key ? { key, enabled: true } : { enabled: true });
    if (on.refresh_error) {
      await api(base, "PATCH", key ? { enabled: false, key: null } : { enabled: false });
      throw new Error(on.refresh_error);
    }
    // Loaded now, so the full page is ready when "Connected" has been seen.
    await reload();
    props.refreshSession();
  };
  const opened = () => {
    setup.current = false;
    setOpened(true);
  };
  setup.current ??= !p.enabled && p.key_last4 === null;
  const on = action.busy && action.shown?.by === "enabled" ? Boolean(wanted) : p.enabled;
  const toolPath = (t: Tool) => `${base}/tools/${encodeURIComponent(t.name)}`;
  const isOn = (t: Tool) => flipped[t.name] ?? t.enabled;
  const setTool = (tool: Tool, enabled: boolean) =>
    toolAction.run(async () => {
      await api(toolPath(tool), "PATCH", { enabled });
      setFlipped({ ...flipped, [tool.name]: enabled });
      setTurnedOn(enabled && p.custom && !tool.read_only ? tool.name : undefined);
    }, tool.name);
  const isNew = (t: Tool) => fresh?.includes(t.name) ?? t.new;
  const tools = [...p.tool_list].sort(
    (a, b) => rank(a, isNew(a)) - rank(b, isNew(b)) || (a.name < b.name ? -1 : 1),
  );
  const live = tools.filter((t) => t.status !== "removed");

  const head = (
    <>
      <a class="back" href="/providers">
        <Icon name="chevron" turn="left" />
        Providers
      </a>
      <div class="title">
        <h1 class="display">
          <ProviderName p={p} />
        </h1>
        {category(p) && <span class="badge">{category(p)}</span>}
        {p.docs_url && (
          <a class="docs" href={p.docs_url} target="_blank" rel="noopener noreferrer">
            Docs
          </a>
        )}
      </div>
      <p class="lead">{p.description}</p>
    </>
  );
  if (setup.current)
    return (
      <>
        {head}
        <Setup p={p} connect={connect} opened={opened} />
      </>
    );

  return (
    <>
      {head}

      <section class="panel">
        <h2 class="display">Connection</h2>
        <div class="row">
          <Switch
            checked={on}
            label="Enabled"
            disabled={action.busy}
            onChange={(enabled) => {
              setWanted(enabled);
              action.run(() => patch({ enabled }), "enabled");
            }}
          />
          <span>
            <strong>{on ? "On" : "Off"}</strong>
            <span class="dim">
              {on ? ": agents can find its tools." : ": agents do not see its tools."}
            </span>
            <Pending action={action} by="enabled" />
          </span>
        </div>
        {p.status === "attention" && (
          <p class="hint">
            <Tag kind="error">Needs attention</Tag> {p.status_reason}
          </p>
        )}
        <div class="row">
          <Button
            action={action}
            done="Refreshed"
            onRun={async () => {
              const listed = await api<ProviderDetail>(`${base}/refresh`, "POST");
              set(listed);
              setFlipped({});
              return !listed.refresh_error;
            }}
          >
            Refresh tools
          </Button>
          <Button
            action={action}
            done="Tested"
            onRun={async () => {
              const result = await api<Test>(`${base}/test`, "POST");
              setTest(result);
              return result.ok;
            }}
          >
            Test connection
          </Button>
          <span role="status">
            {test &&
              (test.ok ? (
                <Tag kind="ok">{`Connected: ${test.tools} tools`}</Tag>
              ) : (
                <Tag kind="error">{test.error ?? "Failed"}</Tag>
              ))}
          </span>
        </div>
        <p class="hint">
          Tools checked {ago(p.refreshed_at)} from{" "}
          <span class="mono wrap">{breakable(p.mcp_url)}</span>.
        </p>
        {/* With "attention", the line above says it (or names the unreadable key behind it). */}
        {p.refresh_error && p.status !== "attention" && (
          <Alert>{`Last refresh failed: ${p.refresh_error}`}</Alert>
        )}
        <form
          class="inline"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(() => patch({ timeout_ms: timeout ? Number(timeout) : null }));
          }}
        >
          <label for="timeout">Timeout (ms)</label>
          <div class="row">
            <input
              id="timeout"
              type="number"
              min={1000}
              max={120000}
              step={1000}
              placeholder={
                settings ? `${num(settings.timeout_ms)} ms` : settingsError ? "Default" : ""
              }
              value={timeout ?? p.timeout_ms ?? ""}
              onInput={(e) => setTimeoutMs(e.currentTarget.value)}
            />
            <Button action={action} done="Saved">
              Save
            </Button>
          </div>
          <p class="hint">Leave empty to use the default from Settings.</p>
        </form>
        {action.error && <Alert>{action.error}</Alert>}
      </section>

      {(p.key_required || p.auth) && <Keys p={p} patch={patchKeys} />}

      <ToolChanges
        p={p}
        pending={tools.filter((t) => t.status === "changed")}
        patch={patch}
        reload={reload}
      />

      <section class="panel">
        <h2 class="display">
          Tools<Stat n={live.filter(isOn).length}>of {live.length} on</Stat>
        </h2>
        {!p.custom && (
          <p class="hint">
            {p.read_only
              ? "Every tool of this provider only reads data."
              : "Some of this provider's tools are not read-only; the ones on by default only read data."}
          </p>
        )}
        {toolAction.error && <Alert>{toolAction.error}</Alert>}
        {tools.length === 0 && (
          <p class="empty">No tools listed yet. Enable the provider or refresh.</p>
        )}
        <ul class="tools">
          {tools.map((t) => (
            <li key={t.name} class={t.status === "removed" ? "gone" : undefined}>
              <Switch
                checked={isOn(t)}
                label={t.name}
                disabled={t.status === "removed" || toolAction.busy}
                onChange={(enabled) => setTool(t, enabled)}
              />
              <div>
                <span class="mono wrap">{breakable(t.name)}</span>
                {isNew(t) && <span class="badge">New</span>}
                {t.status === "changed" && <Tag kind="changed">changed</Tag>}
                {t.status === "removed" && <Tag kind="error">removed by the provider</Tag>}
                {p.custom && !t.read_only && <Tag kind="write">can make changes</Tag>}
                <Pending action={toolAction} by={t.name} />
                <Description path={toolPath(t)} tool={t} />
                {turnedOn === t.name && (
                  <p class="note" role="status">
                    <Icon name="write" />
                    Agents can now use {t.name} to change data at {p.name}, not only read it.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {p.custom && (
        <section class="panel">
          <h2 class="display">Delete</h2>
          {confirmDelete ? (
            <p class="row">
              Delete {p.name} and its tools?
              <Button
                action={action}
                class="danger"
                onRun={async () => {
                  await api(base, "DELETE");
                  navigate("/providers");
                }}
              >
                Delete
              </Button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </p>
          ) : (
            <button type="button" class="danger" onClick={() => setConfirmDelete(true)}>
              Delete provider
            </button>
          )}
        </section>
      )}
    </>
  );
}
