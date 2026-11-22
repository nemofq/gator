import { type State, saveSwitch } from "./state";
import {
  CALL_DESCRIPTION,
  cutNote,
  DESCRIBE_DESCRIPTION,
  errorText,
  nonTextNote,
  PARAM,
  problemList,
  STRUCTURED_NOTE,
  type Status,
} from "./text";
import { callTool, shortText, type ToolResult, UpstreamError, withKeys } from "./upstream";
import { type Agent, recordUse } from "./usage";

type Result = {
  content: { type: "text"; text: string }[];
  isError?: true;
  structuredContent?: unknown;
};

type CoreError = { error: Status; provider_name?: string; problems?: string[] };

const DEFAULT_LIMIT = 5;
const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };
/** Room for Gator's notes on top of the result limit. */
const NOTES_ROOM = 1_000;
/** The most Claude Code accepts for `anthropic/maxResultSizeChars`. */
const MAX_INLINE_RESULT = 500_000;

export function toolDefinitions(searchDescription: string, resultLimit: number) {
  return [
    {
      name: "search_tools",
      description: searchDescription,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: PARAM.query },
          provider: { type: "string", description: PARAM.provider },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: DEFAULT_LIMIT,
            description: PARAM.limit,
          },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      _meta: ALWAYS_LOAD,
    },
    {
      name: "describe_tool",
      description: DESCRIBE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: PARAM.describeId } },
        required: ["id"],
      },
      annotations: { readOnlyHint: true },
      _meta: ALWAYS_LOAD,
    },
    {
      name: "call_tool",
      description: CALL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: PARAM.callId },
          arguments: { type: "object", description: PARAM.arguments },
        },
        required: ["id"],
      },
      annotations: { openWorldHint: true },
      // Claude Code moves a result over 50,000 characters into a file unless told the tool may
      // return more, which would hide a result of exactly the default limit.
      _meta: {
        ...ALWAYS_LOAD,
        "anthropic/maxResultSizeChars": Math.min(resultLimit + NOTES_ROOM, MAX_INLINE_RESULT),
      },
    },
  ];
}

/** Runs one of the three tools, or returns null for any other name. */
export async function runTool(
  name: unknown,
  args: Record<string, unknown>,
  state: State,
  env: Env,
  ctx: ExecutionContext,
  agent: Agent,
): Promise<Result | null> {
  const id = typeof args.id === "string" ? args.id : "";
  if (name === "search_tools") {
    ctx.waitUntil(recordUse(env, agent));
    const provider = typeof args.provider === "string" ? args.provider : undefined;
    const limit = Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_LIMIT;
    const index = await state.indexed();
    return text(index.search(String(args.query ?? ""), provider, limit));
  }
  if (name === "describe_tool") {
    ctx.waitUntil(recordUse(env, agent));
    const described = (await state.indexed()).describe(id);
    // Only an error is parsed: a description can be long.
    return described.startsWith('{"error"')
      ? coreError(id, JSON.parse(described))
      : text(described);
  }
  if (name === "call_tool") return call(id, args.arguments ?? {}, state, env, ctx, agent);
  return null;
}

async function call(
  id: string,
  args: unknown,
  state: State,
  env: Env,
  ctx: ExecutionContext,
  agent: Agent,
) {
  const started = Date.now();
  const index = await state.indexed();
  const route = JSON.parse(index.prepare_call(id, JSON.stringify(args)));
  let status: Status;
  let result: Result;
  let backup = false;
  let detail: string | null = null;
  if (route.error) {
    status = route.error;
    result = coreError(id, route);
  } else {
    const keys = state.keys.get(route.provider);
    backup = Boolean(keys?.onBackup);
    const timeoutMs = state.timeouts.get(route.provider) as number;
    const upstream = withKeys(
      { id: route.provider, url: route.url, timeoutMs, signals: state.signals.get(route.provider) },
      route.auth,
      keys,
      (now) => {
        backup = now;
        ctx.waitUntil(saveSwitch(env.DB, route.provider, now).run());
      },
    );
    try {
      const upstreamResult = await callTool(upstream, route.tool, args, route.params);
      status = upstreamResult.isError ? "tool_error" : "ok";
      if (upstreamResult.isError) detail = shortText(upstreamResult);
      result = shape(upstreamResult, state.resultLimit);
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      status = error.status;
      detail = error.message;
      result = failed(errorText(error.status, id, route.provider_name, error.message));
    }
  }
  const latency = Date.now() - started;
  const size = result.content.reduce((sum, item) => sum + item.text.length, 0);
  // Tool IDs are `<provider>.<tool>` and provider IDs have no dot.
  const dot = id.indexOf(".");
  const [provider, tool] = [id.slice(0, Math.max(dot, 0)), id.slice(dot + 1)];
  console.log("call_tool", provider, tool, status, `${latency}ms`);
  ctx.waitUntil(
    recordUse(env, agent, { id, provider, tool, status, latency, size, backup, detail }),
  );
  return result;
}

/** Text items only, cut to the limit, with a note for everything left out. */
export function shape(upstream: ToolResult, limit: number): Result {
  const content: Result["content"] = [];
  const skipped = new Map<string, number>();
  let left = limit;
  let cut = 0;
  for (const item of upstream.content ?? []) {
    // A file sent as an embedded resource is text too: GitHub returns file contents this way.
    const full = item.type === "resource" ? item.resource?.text : item.text;
    if (typeof full !== "string" || (item.type !== "text" && item.type !== "resource")) {
      skipped.set(item.type, (skipped.get(item.type) ?? 0) + 1);
      continue;
    }
    const kept = full.slice(0, left);
    if (kept) content.push({ type: "text", text: kept });
    cut += full.length - kept.length;
    left -= kept.length;
  }
  const notes: string[] = [];
  if (skipped.size > 0) notes.push(nonTextNote(skipped));
  if (cut > 0) notes.push(cutNote(limit, cut));
  const result: Result = { content };
  // Servers repeat the structured result as text; the agent needs it once.
  if (upstream.structuredContent !== undefined && content.length === 0) {
    if (JSON.stringify(upstream.structuredContent).length <= left) {
      result.structuredContent = upstream.structuredContent;
    } else notes.push(STRUCTURED_NOTE);
  }
  for (const note of notes) content.push({ type: "text", text: note });
  if (upstream.isError) result.isError = true;
  return result;
}

function coreError(id: string, error: CoreError): Result {
  return failed(
    errorText(error.error, id, error.provider_name ?? "", problemList(error.problems ?? [])),
  );
}

const text = (value: string): Result => ({ content: [{ type: "text", text: value }] });
const failed = (value: string): Result => ({
  content: [{ type: "text", text: value }],
  isError: true,
});
