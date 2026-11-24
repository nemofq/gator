import { useState } from "preact/hooks";
import { api, type Session, type Settings, signOut, useLoad } from "../api";
import { Alert, Button, CopyLine, num, Path, ProviderLinks, REPO, Tag, useAction } from "../ui";

/** The Worker's name when the dashboard is served at <name>.<account>.workers.dev; else unknown. */
const workerName = (host: string) => /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/.exec(host)?.[1];

export function SettingsPage(props: { session: Session }) {
  const { data, error } = useLoad<Settings>("/api/settings");
  const [edited, setEdited] = useState<Settings>();
  const action = useAction();
  const out = useAction();
  const form = edited ?? data;
  const unreadable = props.session.keys_unreadable;
  const worker = workerName(location.hostname);
  const putSecret = `pnpm exec wrangler secret put OWNER_PASSWORD --name ${worker ?? "<your Worker's name>"}`;

  const field = (key: keyof Settings) => ({
    id: key,
    type: "number" as const,
    required: true,
    // Drawn before the settings arrive, so nothing below moves when they do.
    readOnly: !form,
    value: form?.[key],
    onInput: (e: Event) => {
      setEdited({
        ...(form as Settings),
        [key]: Number((e.currentTarget as HTMLInputElement).value),
      });
    },
  });
  const save = (e: Event) => {
    e.preventDefault();
    action.run(async () => setEdited(await api<Settings>("/api/settings", "PATCH", form)));
  };

  return (
    <>
      <h1 class="display">Settings</h1>
      {error && <Alert>{error}</Alert>}
      <form class="panel" onSubmit={save}>
        <h2 class="display">Global limits</h2>
        <p class="hint">Defaults for every provider. A provider's own page can set its timeout.</p>
        <label for="result_limit">Result size limit (characters)</label>
        <input
          {...field("result_limit")}
          min={1000}
          max={500000}
          step={1000}
          aria-describedby="result_limit-hint"
        />
        <p class="hint" id="result_limit-hint">
          {form &&
            form.result_limit > 0 &&
            `About ${num(Math.round(form.result_limit / 4))} tokens. `}
          Longer tool results are cut here, with a note telling the agent to ask for less. 1,000 to
          500,000.
        </p>
        <label for="timeout_ms">Provider timeout (ms)</label>
        <input {...field("timeout_ms")} min={1000} max={120000} step={1000} />
        <p class="hint">How long to wait for a provider. 1,000 to 120,000.</p>
        {action.error && <Alert>{action.error}</Alert>}
        <div class="row">
          <Button action={action} class="primary" done="Saved">
            Save
          </Button>
        </div>
      </form>
      <section class="panel">
        <h2 class="display">Encryption key</h2>
        {unreadable.length === 0 ? (
          <p class="hint">
            <Tag kind="ok">Healthy</Tag> Every saved key can be read.
          </p>
        ) : (
          <p class="hint">
            <Tag kind="error">Keys unreadable</Tag> Gator cannot read the keys for{" "}
            <ProviderLinks providers={unreadable} />. Enter them again, or put the previous
            encryption key back.
          </p>
        )}
        <p class="hint prose">
          Provider API keys are stored encrypted with this deployment's <code>MASTER_KEY</code>{" "}
          secret, so replacing it makes the keys saved before unreadable.
        </p>
      </section>
      <section class="panel">
        <h2 class="display">Owner password</h2>
        <p class="hint">It signs you in here and approves agents. At least 12 characters.</p>
        <h3 class="display">In the Cloudflare dashboard</h3>
        <p>
          <Path
            steps={[
              <a
                key="link"
                href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"
                target="_blank"
                rel="noopener noreferrer"
              >
                Workers & Pages
              </a>,
              worker ?? "your Gator Worker",
              "Settings",
              "Variables and Secrets",
              <code key="secret">OWNER_PASSWORD</code>,
              "Edit",
              "Deploy",
            ]}
          />
        </p>
        <h3 class="display">From the command line</h3>
        <CopyLine text={putSecret} label="Copy the command" />
        <p class="hint">
          A new password signs out every browser; agents you approved stay connected.
        </p>
      </section>
      <section class="panel">
        <h2 class="display">Session</h2>
        <p class="hint">Signed in on this browser for up to seven days.</p>
        <Button action={out} onRun={signOut}>
          Sign out
        </Button>
        {out.error && <Alert>{out.error}</Alert>}
      </section>
      <footer class="foot">
        <span>
          gator {props.session.version} ·{" "}
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </span>
        <span>Written in Rust. Gators eat pythons.</span>
      </footer>
    </>
  );
}
