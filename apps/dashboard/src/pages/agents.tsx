import { useState } from "preact/hooks";
import { type Agent, api, useLoad } from "../api";
import { Alert, agentLabel, ago, Button, CopyLine, Icon, num, Path, useAction } from "../ui";

export function Agents(props: { mcpUrl: string }) {
  const { data, error, set } = useLoad<Agent[]>("/api/agents");
  const [connect, setConnect] = useState<boolean>();
  const [confirming, setConfirming] = useState<string>();
  const [gone, setGone] = useState("");
  const action = useAction();
  // Open by default until an agent is connected.
  const open = connect ?? data?.length === 0;

  const revoke = async (agent: Agent) => {
    await api(`/api/agents/${encodeURIComponent(agent.id)}`, "DELETE");
    set(data?.filter((a) => a.id !== agent.id));
    setConfirming(undefined);
    setGone(agent.client_name);
  };

  return (
    <>
      <div class="head">
        <h1 class="display">Agents</h1>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="connect"
          onClick={() => setConnect(!open)}
        >
          Connect an agent
          <Icon name="chevron" turn={open ? "up" : "down"} />
        </button>
      </div>
      {open && (
        <section class="panel connect" id="connect" aria-label="Connect an agent">
          <p>Every agent connects to this one endpoint and signs in with your owner password.</p>
          <CopyLine text={props.mcpUrl} label="Copy the MCP endpoint" />
          <h2 class="display">Claude (web, desktop, mobile)</h2>
          <p>
            <Path
              steps={["Settings", "Connectors", "Add custom connector", "paste the endpoint"]}
            />
          </p>
          <h2 class="display">Claude Code</h2>
          <CopyLine
            text={`claude mcp add --transport http gator ${props.mcpUrl}`}
            label="Copy the Claude Code command"
          />
          <h2 class="display">Anything else</h2>
          <CopyLine
            text={`Add this MCP server: ${props.mcpUrl} (Streamable HTTP, OAuth)`}
            label="Copy the prompt for another agent"
          />
        </section>
      )}
      {error && <Alert>{error}</Alert>}
      {action.error && <Alert>{action.error}</Alert>}
      <p role="status" class="done">
        {gone && `See you later, alligator. ${gone} is disconnected.`}
      </p>
      {data?.length === 0 && <p class="empty">No agents connected yet.</p>}
      {!!data?.length && (
        <section class="panel">
          <table class="stack agents">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Last used</th>
                <th class="n">Today (UTC)</th>
                <th class="n">7 days</th>
                <th class="n">30 days</th>
                <th class="n">90 days</th>
                <th>
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td data-label="Agent">
                    <div class="name">{a.client_name}</div>
                    <div class="qual">{agentLabel(a)}</div>
                  </td>
                  <td data-label="Last used">{ago(a.last_used_at)}</td>
                  <td data-label="Today" class="n">
                    {num(a.calls.d1)}
                  </td>
                  <td data-label="7 days" class="n">
                    {num(a.calls.d7)}
                  </td>
                  <td data-label="30 days" class="n">
                    {num(a.calls.d30)}
                  </td>
                  <td data-label="90 days" class="n">
                    {num(a.calls.d90)}
                  </td>
                  <td class="end">
                    {confirming === a.id ? (
                      <span class="confirm">
                        Revoke {a.client_name}? Its tokens stop working at once.
                        <Button action={action} class="danger" onRun={() => revoke(a)}>
                          Revoke
                        </Button>
                        <button type="button" onClick={() => setConfirming(undefined)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setConfirming(a.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
