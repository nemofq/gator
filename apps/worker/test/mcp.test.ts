import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { mcp, send } from "./helpers";

const CURRENT = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": CURRENT,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const current = (
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  mcp(
    { jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: meta } },
    { "MCP-Protocol-Version": CURRENT, "Mcp-Method": method, ...headers },
  );
const legacy = (method: string, params: Record<string, unknown> = {}) =>
  mcp({ jsonrpc: "2.0", id: 1, method, params });

describe("legacy clients", () => {
  it("initialize echoes a known version and otherwise answers the latest", async () => {
    for (const [asked, answered] of [
      ["2025-06-18", "2025-06-18"],
      ["2025-03-26", "2025-03-26"],
      ["2024-11-05", "2025-11-25"],
    ]) {
      const { status, body } = await legacy("initialize", {
        protocolVersion: asked,
        capabilities: {},
      });
      expect(status).toBe(200);
      expect(body.result).toMatchObject({
        protocolVersion: answered,
        capabilities: { tools: {} },
        serverInfo: { name: "gator" },
      });
      expect(body.result.instructions).toMatch(/^Gator reads live data from: /);
    }
  });

  it("answers ping, notifications and tools/list, and refuses unknown methods and tools", async () => {
    expect((await legacy("ping")).body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      status: 202,
      body: null,
    });
    const { body } = await legacy("tools/list");
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "search_tools",
      "describe_tool",
      "call_tool",
    ]);
    for (const definition of body.result.tools) {
      expect(definition._meta["anthropic/alwaysLoad"]).toBe(true);
      expect(definition.inputSchema.type).toBe("object");
    }
    // A result of the full default limit, with Gator's notes, must stay inline in Claude Code.
    expect(body.result.tools.map((t: { _meta: object }) => t._meta)).toEqual([
      { "anthropic/alwaysLoad": true },
      { "anthropic/alwaysLoad": true },
      { "anthropic/alwaysLoad": true, "anthropic/maxResultSizeChars": 51_000 },
    ]);
    expect(body.result.tools.map((t: { annotations: object }) => t.annotations)).toEqual([
      { readOnlyHint: true },
      { readOnlyHint: true },
      { openWorldHint: true },
    ]);
    expect((await legacy("resources/list")).body.error.code).toBe(-32601);
    const unknown = await legacy("tools/call", { name: "do_anything", arguments: {} });
    expect(unknown.body.error.code).toBe(-32602);
  });

  it("calls a gateway tool", async () => {
    const { body } = await legacy("tools/call", { name: "search_tools", arguments: { query: "" } });
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ total: 0, tools: [] });
    expect(body.result.resultType).toBeUndefined();
  });
});

describe("current-spec clients", () => {
  it("serves server/discover, tools/list and tools/call statelessly", async () => {
    const discover = await current("server/discover");
    expect(discover.status).toBe(200);
    expect(discover.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [CURRENT],
      capabilities: { tools: {} },
      ttlMs: 300000,
      cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "gator" } },
    });
    expect(discover.body.result.instructions).toMatch(/^Gator reads live data from: /);
    const list = await current("tools/list");
    expect(list.body.result).toMatchObject({
      resultType: "complete",
      ttlMs: 300000,
      cacheScope: "private",
    });
    expect(list.body.result.tools).toHaveLength(3);
    const call = await current(
      "tools/call",
      { name: "describe_tool", arguments: { id: "x.y" } },
      { "Mcp-Name": "describe_tool" },
    );
    expect(call.body.result).toMatchObject({ resultType: "complete", isError: true });
    const encoded = await current(
      "tools/call",
      { name: "search_tools", arguments: { query: "" } },
      { "Mcp-Name": `=?base64?${btoa("search_tools")}?=` },
    );
    expect(encoded.body.result.resultType).toBe("complete");
  });

  it("answers the spec's errors with their HTTP statuses", async () => {
    const mismatch = await current("tools/list", {}, { "Mcp-Method": "tools/call" });
    expect([mismatch.status, mismatch.body.error.code]).toEqual([400, -32020]);
    const missingName = await current("tools/call", { name: "search_tools", arguments: {} });
    expect([missingName.status, missingName.body.error.code]).toEqual([400, -32020]);
    const noHeader = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: meta },
    });
    expect([noHeader.status, noHeader.body.error.code]).toEqual([400, -32020]);
    const version = await mcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
      },
      { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" },
    );
    expect([version.status, version.body.error.code, version.body.error.data]).toEqual([
      400,
      -32022,
      { supported: [CURRENT], requested: "2099-01-01" },
    ]);
    const noCapabilities = await mcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": CURRENT } },
      },
      { "MCP-Protocol-Version": CURRENT, "Mcp-Method": "tools/list" },
    );
    expect([noCapabilities.status, noCapabilities.body.error.code]).toEqual([400, -32602]);
    const unknown = await current("prompts/list");
    expect([unknown.status, unknown.body.error.code]).toEqual([404, -32601]);
  });
});

describe("transport", () => {
  it("refuses GET, DELETE, batches and bodies that are not a request", async () => {
    expect((await mcp(null, {}, "GET")).status).toBe(405);
    expect((await mcp(null, {}, "DELETE")).status).toBe(405);
    const batch = await mcp([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect([batch.status, batch.body.error.code]).toEqual([400, -32600]);
    const garbage = await mcp({ hello: "world" });
    expect([garbage.status, garbage.body.error.code]).toEqual([400, -32600]);
  });

  it("answers 500 with a plain sentence on every Worker route when a secret is missing", async () => {
    const broken = {
      MASTER_KEY: { ...env, MASTER_KEY: "short" },
      OWNER_PASSWORD: { ...env, OWNER_PASSWORD: "" },
    };
    for (const [secret, brokenEnv] of Object.entries(broken)) {
      for (const path of [
        "/mcp",
        "/api/session",
        "/authorize",
        "/.well-known/oauth-protected-resource/mcp",
      ]) {
        const response = await send(path, {}, brokenEnv);
        expect([path, response.status]).toEqual([path, 500]);
        expect(await response.text()).toMatch(new RegExp(`^Gator is not set up: .*${secret}`));
      }
    }
  });

  it("refuses an owner password under 12 characters and names the Worker in the fix", async () => {
    const url = "https://gator-dev.example.workers.dev/.well-known/oauth-protected-resource/mcp";
    const short = await send(url, {}, { ...env, OWNER_PASSWORD: "a".repeat(11) });
    expect(short.status).toBe(500);
    expect(await short.text()).toMatch(
      /^Gator is not set up: .*`pnpm exec wrangler secret put OWNER_PASSWORD --name gator-dev`/,
    );
    const enough = await send(url, {}, { ...env, OWNER_PASSWORD: "a".repeat(12) });
    expect(enough.status).toBe(200);
  });
});
