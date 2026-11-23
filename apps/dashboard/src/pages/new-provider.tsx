import { useEffect, useState } from "preact/hooks";
import { api, type Problem, type Provider } from "../api";
import { loadCore } from "../core";
import { Alert, Button, Icon, KeyInput, navigate, useAction } from "../ui";

type Form = {
  name: string;
  description: string;
  mcp_url: string;
  header: string;
  format: string;
  key: string;
};

// The server derives the id the same way (`uniqueId` in the Worker's api.ts), then makes it unique.
const idFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 32)
    .replace(/^-|-$/g, "");

/** The manifest exactly as the server will build and validate it. */
function manifest(f: Form) {
  return {
    name: f.name.trim(),
    description: f.description.trim(),
    mcp_url: f.mcp_url.trim(),
    ...(f.header.trim() || f.key ? { auth: { header: f.header.trim(), format: f.format } } : {}),
  };
}

const FIELDS: [keyof Form, string, string, string[]][] = [
  ["name", "Name", "Shown in the dashboard and to agents.", ["name", "id"]],
  [
    "description",
    "What it covers",
    "The sites and kinds of data, in the words you would use to ask for them. Agents read this.",
    ["description"],
  ],
  [
    "mcp_url",
    "MCP URL",
    "The server's Streamable HTTP endpoint. https and a public host name only.",
    ["mcp_url"],
  ],
  [
    "header",
    "Header name",
    "The request header that carries the key, e.g. Authorization. Leave empty if it needs no key.",
    ["auth.header", "auth"],
  ],
  ["format", "Value format", "The header value, with {key} where the key goes.", ["auth.format"]],
  ["key", "API key", "Stored encrypted. Only its last four characters are shown again.", []],
];

export function NewProvider() {
  const [form, setForm] = useState<Form>({
    name: "",
    description: "",
    mcp_url: "",
    header: "",
    format: "Bearer {key}",
    key: "",
  });
  const [touched, setTouched] = useState(new Set<string>());
  const [problems, setProblems] = useState<Problem[]>([]);
  const [validate, setValidate] = useState<(manifest: string) => string>();
  const action = useAction();

  useEffect(() => {
    loadCore().then((core) => setValidate(() => core.validate_provider));
  }, []);
  useEffect(() => {
    if (!validate) return;
    const m = manifest(form);
    // The server sets key_required the same way: a key exactly when there is an auth header.
    const checked = { id: idFrom(m.name), ...m, key_required: "auth" in m };
    setProblems(JSON.parse(validate(JSON.stringify(checked))));
  }, [form, validate]);

  const submit = (e: Event) => {
    e.preventDefault();
    setTouched(new Set(FIELDS.map((f) => f[0])));
    action.run(async () => {
      try {
        const p = await api<Provider>("/api/providers", "POST", {
          ...manifest(form),
          ...(form.key ? { key: form.key } : {}),
        });
        navigate(`/providers/${encodeURIComponent(p.id)}`);
      } catch (e) {
        const server = ((e as Error).cause as { problems?: Problem[] })?.problems;
        if (server) setProblems(server);
        throw e;
      }
    });
  };
  const known = FIELDS.flatMap((f) => f[3]);
  const other = problems.filter((p) => !known.includes(p.path));

  return (
    <>
      <a class="back" href="/providers">
        <Icon name="chevron" turn="left" />
        Providers
      </a>
      <h1 class="display">Add custom MCP</h1>
      <p class="lead">
        A remote MCP server that takes a static API key in a request header, or no key at all.
      </p>
      <form class="panel" onSubmit={submit} noValidate>
        {FIELDS.map(([field, label, hint, paths]) => {
          const all = touched.has(field) ? problems.filter((p) => paths.includes(p.path)) : [];
          // An empty name is also an empty id: say it once.
          const mine = all.filter((p, i) => all.findIndex((q) => q.message === p.message) === i);
          const input = {
            id: field,
            autocomplete: "off",
            spellcheck: false,
            value: form[field],
            "aria-invalid": mine.length > 0,
            "aria-describedby": `${field}-hint`,
            onInput: (e: Event) =>
              setForm({ ...form, [field]: (e.currentTarget as HTMLInputElement).value }),
            onBlur: () => setTouched(new Set(touched).add(field)),
          };
          return (
            <div key={field} class="field">
              <label for={field}>{label}</label>
              {field === "key" ? (
                <KeyInput {...input} />
              ) : (
                <input type="text" inputMode={field === "mcp_url" ? "url" : undefined} {...input} />
              )}
              <p class="hint" id={`${field}-hint`}>
                {hint}
              </p>
              {mine.map((p) => (
                <p key={p.path + p.message} class="problem">
                  <Icon name="error" />
                  {p.message}
                </p>
              ))}
            </div>
          );
        })}
        {touched.size === FIELDS.length &&
          other.map((p) => (
            <p key={p.path + p.message} class="problem">
              <Icon name="error" />
              <span class="mono">{p.path}</span>: {p.message}
            </p>
          ))}
        {action.error && <Alert>{action.error}</Alert>}
        <div class="row">
          <Button action={action} class="primary">
            Add provider
          </Button>
        </div>
      </form>
    </>
  );
}
