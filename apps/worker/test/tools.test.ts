import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encryptKey, keys } from "../src/crypto";
import { refresh } from "../src/snapshot";
import { DEFAULT_RESULT_LIMIT, invalidate } from "../src/state";
import { shape } from "../src/tools";
import { AGENT_NAME, addProvider, GRANT, readOnly, tool } from "./helpers";
import { type Logged, mockUpstream, type Server } from "./mock-upstream";

const KEY = "sk-live-0123456789";
const BACKUP_KEY = "bk-live-9876543210";
const HOST = "data.example.com";
const schema = {
  type: "object",
  properties: { query: { type: "string" }, region: { type: "string", "x-mcp-header": "Region" } },
  required: ["query"],
};
const server: Server = {
  era: "session",
  key: ["X-Api-Key", KEY],
  tools: [
    {
      name: "find",
      description: "Find reddit posts about a topic",
      inputSchema: schema,
      annotations: { readOnlyHint: true },
    },
    readOnly("big"),
  ],
};
let log: Logged[];
let answer: unknown;

beforeAll(async () => {
  server.call = () => answer;
  ({ log } = mockUpstream({
    [HOST]: server,
    "keyless.example.com": { era: "stateless", tools: [readOnly("free")] },
  }));
  await addProvider("data", HOST, {
    key: KEY,
    auth: { header: "X-Api-Key", format: "{key}" },
    timeoutMs: 100,
  });
  await addProvider("nokey", "nokey.example.com", {
    auth: { header: "X-Api-Key", format: "{key}" },
  });
  await addProvider("keyless", "keyless.example.com");
  await env.DB.prepare(
    'INSERT INTO tools VALUES (\'nokey\', \'thing\', 1, 0, \'{"description":"","input_schema":{"type":"object"},"read_only":true}\', \'h\', NULL, \'h\', 0)',
  ).run();
  expect(await refresh(env, "data")).toBeNull();
  expect(await refresh(env, "keyless")).toBeNull();
  invalidate();
});
afterEach(() => {
  answer = undefined;
  vi.restoreAllMocks();
});

const call = (id: string, args: Record<string, unknown> = { query: "x" }) =>
  tool("call_tool", { id, arguments: args });
const error = (text: string) => ({ content: [{ type: "text", text }], isError: true });

describe("search_tools and describe_tool", () => {
  it("search returns the core's output with schemas, and lists providers for an empty query", async () => {
    const found = JSON.parse(
      (await tool("search_tools", { query: "reddit posts" })).content[0].text,
    );
    expect(found.total).toBe(3);
    expect(found.tools[0]).toMatchObject({
      id: "data.find",
      provider: "data",
      input_schema: schema,
    });
    const listed = JSON.parse((await tool("search_tools", { query: "" })).content[0].text);
    expect(listed.providers.map((p: { id: string }) => p.id).sort()).toEqual(["data", "keyless"]);
    const scoped = JSON.parse(
      (await tool("search_tools", { query: "tool", provider: "keyless", limit: 1 })).content[0]
        .text,
    );
    expect(scoped.tools.map((t: { id: string }) => t.id)).toEqual(["keyless.free"]);
  });

  it("describe returns the full approved definition, or a tool error", async () => {
    const described = JSON.parse(
      (await tool("describe_tool", { id: "data.find" })).content[0].text,
    );
    expect(described).toMatchObject({
      id: "data.find",
      read_only: true,
      provider: { name: "Name data" },
    });
    expect(await tool("describe_tool", { id: "data.nope" })).toEqual(
      error(
        'Unknown or disabled tool "data.nope". Use search_tools to find the tools that are available.',
      ),
    );
    expect(await tool("describe_tool", { id: "nokey.thing" })).toEqual(
      error("No API key is set for Name nokey. Add one in the Gator dashboard."),
    );
  });
});

describe("call_tool", () => {
  it("passes text through, without the structuredContent that repeats it, with the key, the session and the header params", async () => {
    answer = { content: [{ type: "text", text: "three posts" }], structuredContent: { posts: 3 } };
    expect(await call("data.find", { query: "x", region: "eu" })).toEqual({
      content: [{ type: "text", text: "three posts" }],
    });
    const sent = log.at(-1);
    expect(sent?.headers.get("X-Api-Key")).toBe(KEY);
    expect(sent?.body).toMatchObject({
      method: "tools/call",
      params: { name: "find", arguments: { query: "x", region: "eu" } },
    });
    expect(await call("keyless.free", {})).toEqual({ content: [{ type: "text", text: "ok" }] });
    answer = { content: [], structuredContent: { posts: 3 } };
    expect(await call("data.find")).toEqual({ content: [], structuredContent: { posts: 3 } });
  });

  it("answers every row of the error table", async () => {
    expect(await call("data.nope")).toEqual(
      error(
        'Unknown or disabled tool "data.nope". Use search_tools to find the tools that are available.',
      ),
    );
    expect(await call("data.find", { region: 5 })).toEqual(
      error(
        "Invalid arguments for data.find:\n- query: is required\n- region: expected string, got integer",
      ),
    );
    expect(await call("nokey.thing", {})).toEqual(
      error("No API key is set for Name nokey. Add one in the Gator dashboard."),
    );
    const upstream: [unknown, string][] = [
      [
        new Response(null, { status: 401 }),
        "Name data rejected its API key. Update the key in the Gator dashboard.",
      ],
      [
        new Response(null, { status: 403 }),
        "Name data rejected its API key. Update the key in the Gator dashboard.",
      ],
      [
        new Response(null, { status: 429 }),
        "Name data says its rate limit or quota is used up. Try again later.",
      ],
      ["hang", "Name data did not respond in time."],
      [new Response("<html>", { status: 503 }), "Name data returned an error: HTTP 503"],
      [
        Response.json({ jsonrpc: "2.0", id: 1, error: { message: "x".repeat(400) } }),
        `Name data returned an error: ${"x".repeat(300)}`,
      ],
    ];
    for (const [response, text] of upstream) {
      answer = response;
      expect(await call("data.find")).toEqual(error(text));
    }
    answer = { content: [{ type: "text", text: "No such subreddit" }], isError: true };
    expect(await call("data.find")).toEqual(error("No such subreddit"));
  });

  it("drops non-text content with a note, cuts long results and keeps structuredContent only without text and when it fits", async () => {
    answer = {
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "a".repeat(DEFAULT_RESULT_LIMIT - 10) },
        { type: "resource", resource: { uri: "x", blob: "AAAA" } },
        { type: "text", text: "b".repeat(81_244) },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      structuredContent: { big: true },
    };
    const result = await call("data.find");
    expect(result.content.map((c) => c.text.length)).toEqual([
      49_990,
      10,
      expect.any(Number),
      expect.any(Number),
    ]);
    // The structured result goes silently: the result has text.
    expect(result.content.slice(2).map((c) => c.text)).toEqual([
      "[Gator: 3 non-text items (image, resource) were left out.]",
      "[Gator: result cut at 50,000 characters; 81,234 more were left out. Ask for less at a time.]",
    ]);
    expect(result.structuredContent).toBeUndefined();

    expect(
      shape({ content: [{ type: "text", text: "abc" }], structuredContent: { k: "v" } }, 100),
    ).toEqual({ content: [{ type: "text", text: "abc" }] });
    const image = { type: "image" };
    expect(shape({ content: [image], structuredContent: { k: "vv" } }, 10)).toEqual({
      content: [{ type: "text", text: "[Gator: 1 non-text item (image) was left out.]" }],
      structuredContent: { k: "vv" },
    });
    expect(shape({ structuredContent: { k: "vvv" } }, 10)).toEqual({
      content: [
        {
          type: "text",
          text: "[Gator: the structured result was left out because of the size limit.]",
        },
      ],
    });
    expect(shape({ content: [{ type: "audio" }] }, 10).content[0].text).toBe(
      "[Gator: 1 non-text item (audio) was left out.]",
    );
    // An embedded text resource is the file itself, as GitHub's get_file_contents returns it.
    const file = { type: "resource", resource: { uri: "repo://README", text: "Hello World!" } };
    expect(shape({ content: [{ type: "text", text: "downloaded" }, file] }, 100).content).toEqual([
      { type: "text", text: "downloaded" },
      { type: "text", text: "Hello World!" },
    ]);
  });

  it("respects the result_limit setting", async () => {
    await env.DB.prepare(
      "INSERT INTO settings VALUES ('result_limit', '5') ON CONFLICT DO UPDATE SET value = '5'",
    ).run();
    invalidate();
    answer = { content: [{ type: "text", text: "123456789" }] };
    expect((await call("data.find")).content.map((c) => c.text)).toEqual([
      "12345",
      "[Gator: result cut at 5 characters; 4 more were left out. Ask for less at a time.]",
    ]);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'result_limit'").run();
    invalidate();
  });
});

describe("usage", () => {
  it("records the agent, the call log and the rollup after the response", async () => {
    await env.DB.batch(
      ["agents", "calls", "usage_daily"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await tool("search_tools", { query: "x" });
    answer = new Response(null, { status: 429 });
    await call("data.find");
    answer = undefined;
    await call("data.find");
    await call("invented.tool");
    const agents = await env.DB.prepare("SELECT * FROM agents").all();
    expect(agents.results).toEqual([
      { id: GRANT, client_name: AGENT_NAME, connected_at: 1000, last_used_at: expect.any(Number) },
    ]);
    const rateLimited = "Name data says its rate limit or quota is used up. Try again later.";
    const unknown =
      'Unknown or disabled tool "invented.tool". Use search_tools to find the tools that are available.';
    const calls = await env.DB.prepare(
      "SELECT agent_id, tool_id, status, result_size FROM calls ORDER BY id",
    ).all();
    expect(calls.results).toEqual([
      {
        agent_id: GRANT,
        tool_id: "data.find",
        status: "rate_limited",
        result_size: rateLimited.length,
      },
      { agent_id: GRANT, tool_id: "data.find", status: "ok", result_size: 2 },
      {
        agent_id: GRANT,
        tool_id: "invented.tool",
        status: "unknown_tool",
        result_size: unknown.length,
      },
    ]);
    const usage = await env.DB.prepare(
      "SELECT agent_id, provider_id, tool, calls, errors FROM usage_daily",
    ).all();
    expect(usage.results).toEqual([
      { agent_id: GRANT, provider_id: "data", tool: "find", calls: 2, errors: 1 },
    ]);
  });

  it("records a result marked isError as a failed call, in the log and in the rollup", async () => {
    await env.DB.batch(["calls", "usage_daily"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    answer = { content: [{ type: "text", text: "No such subreddit" }], isError: true };
    await call("data.find");
    const calls = await env.DB.prepare("SELECT tool_id, status, backup FROM calls").all();
    expect(calls.results).toEqual([{ tool_id: "data.find", status: "tool_error", backup: 0 }]);
    const usage = await env.DB.prepare(
      "SELECT provider_id, tool, calls, errors FROM usage_daily",
    ).all();
    expect(usage.results).toEqual([{ provider_id: "data", tool: "find", calls: 1, errors: 1 }]);
  });

  it("keeps only the newest 500 calls", async () => {
    await env.DB.prepare(
      "INSERT INTO calls (ts, agent_id, tool_id, status, latency_ms, result_size) SELECT 0, 'g', 't', 'ok', 0, 0 FROM json_each(?)",
    )
      .bind(JSON.stringify(Array(600).fill(0)))
      .run();
    await call("data.find");
    const { n, newest } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(ts) AS newest FROM calls",
    ).first()) as {
      n: number;
      newest: number;
    };
    expect(n).toBe(500);
    expect(newest).toBeGreaterThan(0);
  });
});

describe("safety", () => {
  it("never logs either key, the arguments or the result", async () => {
    const k = await keys(env);
    const sealed = await encryptKey(k, "data:backup", BACKUP_KEY);
    const setBackup = env.DB.prepare(
      "UPDATE providers SET backup_key = ?, backup_key_check = ?, on_backup = 0 WHERE id = 'data'",
    );
    await setBackup.bind(sealed, k.check).run();
    invalidate();
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => {
        lines.push(args.map(String).join(" "));
      });
    }
    answer = { content: [{ type: "text", text: "RESULT-MARKER" }] };
    await call("data.find", { query: "ARGUMENT-MARKER" });
    answer = new Response(null, { status: 401 });
    await call("data.find", { query: "ARGUMENT-MARKER" });
    answer = "hang";
    await call("data.find", { query: "ARGUMENT-MARKER" });
    // A switch: the server refuses the primary for quota and does not know the backup.
    answer = new Response(null, { status: 429 });
    await call("data.find", { query: "ARGUMENT-MARKER" });
    expect(log.at(-1)?.headers.get("X-Api-Key")).toBe(BACKUP_KEY);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(BACKUP_KEY);
      expect(line).not.toContain("ARGUMENT-MARKER");
      expect(line).not.toContain("RESULT-MARKER");
    }
    await setBackup.bind(null, null).run();
    invalidate();
  });

  it("only ever connects to the mcp_url host of an enabled provider", async () => {
    await addProvider("off", "off.example.com", { enabled: false });
    await env.DB.prepare(
      'INSERT INTO tools VALUES (\'off\', \'thing\', 1, 0, \'{"description":"","input_schema":{"type":"object"},"read_only":true}\', \'h\', NULL, \'h\', 0)',
    ).run();
    invalidate();
    expect((await call("off.thing", {})).isError).toBe(true);
    expect(
      (await call("data.find", { query: "x", url: "https://evil.example.com/" })).isError,
    ).toBeUndefined();
    const hosts = new Set(log.map((entry) => entry.host));
    expect([...hosts].sort()).toEqual([HOST, "keyless.example.com"]);
  });
});
