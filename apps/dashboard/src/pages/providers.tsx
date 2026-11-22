import { type Provider, useLoad } from "../api";
import { Alert, category, ProviderName, Stat, Tag } from "../ui";

type Chip = [Parameters<typeof Tag>[0]["kind"], string];

const STATUS: Record<Provider["status"], Chip | undefined> = {
  ready: ["ok", "Ready"],
  attention: ["error", "Needs attention"],
  no_key: ["off", "No key"],
  off: undefined,
};

/** Whether agents can use it (nothing when it is off: its group says so), then what waits for the
    owner, so the chips fit on one line. */
function states(p: Provider): Chip[] {
  const issue: Chip | undefined =
    p.tools.changed > 0
      ? ["changed", `${p.tools.changed} to review`]
      : p.on_backup
        ? ["changed", "On backup key"]
        : undefined;
  return [STATUS[p.status], issue].filter((c) => c !== undefined);
}

function Cards(props: { providers: Provider[] }) {
  return (
    <ul class="cards">
      {props.providers.map((p) => (
        <li key={p.id}>
          <a class="card tipped" href={`/providers/${encodeURIComponent(p.id)}`}>
            <span class="card-body">
              <span class="card-title">
                <span class="display">
                  <ProviderName p={p} />
                </span>
                {category(p) && <span class="badge">{category(p)}</span>}
              </span>
              <span class="card-text">{p.description}</span>
            </span>
            <span class="card-foot">
              <span class="tags">
                {states(p).map(([kind, text]) => (
                  <Tag key={text} kind={kind}>
                    {text}
                  </Tag>
                ))}
              </span>
              <span class="card-count">
                {p.tools.total === 0 ? (
                  <span class="dim">No tools listed yet</span>
                ) : (
                  <Stat n={p.tools.enabled}>of {p.tools.total} tools on</Stat>
                )}
                {p.tools.new > 0 && (
                  <Stat n={p.tools.new}>{p.tools.new === 1 ? "new tool" : "new tools"}</Stat>
                )}
              </span>
              {p.status === "attention" && <span class="tip">{p.status_reason}</span>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Providers() {
  const { data, error } = useLoad<Provider[]>("/api/providers");
  const on = data?.filter((p) => p.enabled) ?? [];
  const off = data?.filter((p) => !p.enabled) ?? [];
  return (
    <>
      <div class="head">
        <h1 class="display">Providers</h1>
        <a class="button" href="/providers/new">
          Add custom MCP
        </a>
      </div>
      {error && <Alert>{error}</Alert>}
      {data && (
        <>
          <h2 class="display group">
            Enabled
            <Stat n={on.length} />
          </h2>
          {on.length === 0 ? (
            <p class="empty">None yet. Open one below and switch it on.</p>
          ) : (
            <Cards providers={on} />
          )}
          {off.length > 0 && (
            <>
              <h2 class="display group">
                Available
                <Stat n={off.length} />
              </h2>
              <Cards providers={off} />
            </>
          )}
        </>
      )}
    </>
  );
}
