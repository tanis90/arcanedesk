import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import { createMapApiTools } from "../src/main/map-api-tools.js";

const OPERATIONS = [
  {
    id: "lobbyCampaignCreate", kind: "action", effect: "write", summary: "创建空白战役",
    page: "lobby", access: "authenticated", inputSchema: { type: "object" }, idempotent: false,
  },
  {
    id: "lobbyCampaignsList", kind: "action", effect: "read", summary: "列出战役",
    page: "lobby", access: "authenticated", inputSchema: { type: "object" }, idempotent: true,
  },
  {
    id: "lobbyPacksDelete", kind: "action", effect: "write", summary: "删除内容包",
    page: "lobby", access: "owner", inputSchema: { type: "object" }, idempotent: false,
    requiresPreview: true,
  },
  {
    id: "lobbyImportRun", kind: "job", effect: "write", summary: "异步导入世界",
    page: "lobby", access: "authenticated", inputSchema: { type: "object" }, idempotent: false,
  },
];

function harness({ page = "lobby", result = null, previewResult = null, approve = true } = {}) {
  const calls = [];
  const approvals = [];
  const handle = async (action, args) => {
    calls.push({ action, args });
    if (action === "apiOperationSearch") {
      const prefix = args.prefix ?? "";
      return {
        page,
        operations: OPERATIONS.filter(operation => operation.id.startsWith(prefix)),
        ...(args.prefix === "game.journal" ? { surface: { entries: [{ path: "game.journal", status: "partial" }] } } : {}),
      };
    }
    if (action === "apiCall") {
      if (args.preview === true) return previewResult ?? { status: "preview", operationId: args.id, value: null };
      if (result instanceof Error) throw result;
      if (result) return result;
      return { status: "completed", operationId: args.id, value: { campaign: { id: "c1", name: args.args.name } } };
    }
    throw new Error(`unexpected ${action}`);
  };
  const client = { classifyPanelUrl: () => ({ kind: page }), call: handle };
  const host = {
    profile: { mode: "prep" },
    lobbyClient: () => client,
    callFoundryRuntime: handle,
    maybeRequestApproval: async request => { approvals.push(request); return approve; },
  };
  const tools = new Map(createMapApiTools(host).map(tool => [tool.name, tool]));
  return { tools, calls, approvals };
}

test("the Map API pool has exactly search and lightweight call", () => {
  const { tools } = harness();
  assert.deepEqual([...tools.keys()], ["map_api_search", "map_api_call"]);
  assert.equal(Value.Check(tools.get("map_api_search").parameters, { prefix: "game.journal", limit: 5 }), true);
  assert.equal(Value.Check(tools.get("map_api_call").parameters, { id: "lobbyCampaignCreate", args: { name: "x", ruleset: "2024" } }), true);
  assert.equal(Value.Check(tools.get("map_api_call").parameters, { id: "x", args: {}, code: "eval" }), false);
});

test("play search uses the Map runtime and can return apiSurface declarations", async () => {
  const h = harness({ page: "play" });
  const result = await h.tools.get("map_api_search").execute("s1", { prefix: "game.journal" });
  assert.equal(result.details.surface.entries[0].path, "game.journal");
  assert.deepEqual(h.calls.map(call => call.action), ["apiOperationSearch"]);
});

test("a lightweight write searches metadata, requests approval, then invokes once", async () => {
  const h = harness();
  const result = await h.tools.get("map_api_call").execute("c1", {
    id: "lobbyCampaignCreate", args: { name: "渡鸦岭", ruleset: "2024" },
  });
  assert.equal(result.details.status, "completed");
  assert.equal(result.details.value.campaign.id, "c1");
  assert.deepEqual(h.calls.map(call => call.action), ["apiOperationSearch", "apiCall"]);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].args.operationId, "lobbyCampaignCreate");
  assert.equal("args" in h.approvals[0].args && "name" in h.approvals[0].args, false);
});

test("job is rejected before approval or any write dispatch", async () => {
  const h = harness();
  const result = await h.tools.get("map_api_call").execute("j1", {
    id: "lobbyImportRun", args: { preparationId: "hidden" },
  });
  assert.equal(result.details.code, "OPERATION_KIND_UNSUPPORTED");
  assert.equal(result.isError, true);
  assert.deepEqual(h.calls.map(call => call.action), ["apiOperationSearch"]);
  assert.equal(h.approvals.length, 0);
  assert.equal(result.content[0].text.includes("map_lobby_import_start"), false);
});

test("a read action does not require write approval", async () => {
  const h = harness();
  await h.tools.get("map_api_call").execute("r1", { id: "lobbyCampaignsList", args: {} });
  assert.equal(h.approvals.length, 0);
});

test("partial receipts are returned once without replay", async () => {
  const h = harness({ result: { status: "partial", code: "CAMPAIGN_CREATE_PARTIAL", campaignId: "c1" } });
  const result = await h.tools.get("map_api_call").execute("p1", {
    id: "lobbyCampaignCreate", args: { name: "部分完成", ruleset: "2024" },
  });
  assert.equal(result.details.status, "partial");
  assert.equal(h.calls.filter(call => call.action === "apiCall").length, 1);
});

test("destructive writes preview impact before requesting approval", async () => {
  const h = harness({
    previewResult: { status: "preview", operationId: "lobbyPacksDelete", value: { totals: { packs: 1 } } },
  });
  const result = await h.tools.get("map_api_call").execute("d1", {
    id: "lobbyPacksDelete", args: { packIds: ["user-a.items"], expectedRevision: 4 },
  });
  assert.equal(result.details.status, "completed", JSON.stringify({ details: result.details, calls: h.calls, approvals: h.approvals }));
  assert.deepEqual(h.calls.map(call => call.action), ["apiOperationSearch", "apiCall", "apiCall"]);
  assert.equal(h.calls[1].args.preview, true);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].args.preview.totals.packs, 1);
});

test("login-required guidance forbids lobby and auth page evaluation", async () => {
  const error = Object.assign(new Error("LOGIN_REQUIRED: sign in first"), { code: "LOGIN_REQUIRED" });
  const h = harness({ result: error });
  const result = await h.tools.get("map_api_call").execute("login", { id: "lobbyCampaignsList", args: {} });
  assert.equal(result.details.code, "LOGIN_REQUIRED");
  assert.match(result.content[0].text, /never evaluate the lobby or auth page/);
  assert.match(result.content[0].text, /map_page_eval/);
});
