import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { FOUNDRY_SDK_ERROR_CODES, FoundrySdkError } from "@arcanedesk/foundry-sdk/contracts";
import { createLobbyTools } from "../src/main/lobby-tools.js";
import { MtLobbyClient } from "../src/main/mt-lobby-client.js";
import { LOBBY_URL, createLobbyFixture } from "./fixtures/lobby-harness.mjs";

const PLAY_URL = "https://arcanemap.com/user-files/compat/play.html?campaign=campaign-1";
const AUTH_URL = "https://arcanemap.com/auth/realms/arcane/protocol/openid-connect/auth?client_id=compat";

function harness(t, { approved = true } = {}) {
  const page = createLobbyFixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-tools-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "world.zip");
  writeFileSync(source, "PK tool fixture world");
  const client = new MtLobbyClient({ getWebContents: () => page.webContents });
  const approvals = [];
  const host = {
    profile: { mode: "prep" },
    log: () => {},
    cwd: () => directory,
    lobbyFileRoots: () => [directory],
    lobbyClient: () => client,
    maybeRequestApproval: async (payload) => {
      approvals.push(payload);
      return approved;
    },
  };
  const tools = new Map(createLobbyTools(host).map(tool => [tool.name, tool]));
  return { page, directory, source, client, approvals, host, tools };
}

function returnHarness(t, {
  url = PLAY_URL,
  panelProfile = "mtcompat",
  behavior = null,
  withRuntime = true,
  readyTimeoutMs = 500,
  readyPollMs = 10,
} = {}) {
  const page = createLobbyFixture({ url });
  const client = new MtLobbyClient({
    getWebContents: () => page.webContents,
    readyTimeoutMs,
    readyPollMs,
  });
  const calls = [];
  const foundryRuntime = withRuntime ? {
    lastWorldInfo: null,
    callForSession: async (_telemetry, _mode, action, args, options) => {
      calls.push({ action, args, options });
      const receipt = behavior
        ? await behavior({ page, client, calls })
        : (page.webContents.navigate(LOBBY_URL), {
          status: "completed",
          from: { path: "/user-files/compat/play.html", campaignId: "campaign-1" },
          to: { path: "/user-files/compat/lobby.html" },
          returnPlayUrl: PLAY_URL,
        });
      return receipt;
    },
  } : null;
  const host = {
    profile: { mode: "prep" },
    telemetry: { marker: "lobby-return" },
    log: () => {},
    lobbyClient: () => client,
    panelProfileId: () => panelProfile,
    ...(foundryRuntime ? { foundryRuntime } : {}),
  };
  const tools = new Map(createLobbyTools(host).map(tool => [tool.name, tool]));
  return { page, client, calls, host, tools, tool: tools.get("foundry_lobby_return") };
}

test("the tool pool registers exactly the nine lobby tools with exact schemas", () => {
  const tools = new Map(createLobbyTools({ profile: { mode: "prep" } }).map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], [
    "foundry_lobby_return",
    "foundry_lobby_rulesets_list",
    "foundry_lobby_import_start",
    "foundry_lobby_import_job",
    "foundry_lobby_campaigns_list",
    "foundry_lobby_campaign_packs_get",
    "foundry_lobby_campaign_packs_update",
    "foundry_lobby_packs_read",
    "foundry_lobby_packs_delete",
  ]);
  const lobbyReturn = tools.get("foundry_lobby_return");
  assert.equal(Value.Check(lobbyReturn.parameters, {}), true);
  assert.equal(Value.Check(lobbyReturn.parameters, { unexpected: true }), false);
  const start = tools.get("foundry_lobby_import_start");
  assert.equal(Value.Check(start.parameters, { sourcePath: "a.zip", ruleset: "2024" }), true);
  assert.equal(Value.Check(start.parameters, { sourcePath: "a.zip", expectedKind: "world", ruleset: "2014" }), true);
  assert.equal(Value.Check(start.parameters, { sourcePath: "a.zip", ruleset: "2024", base64: "x" }), false);
  assert.equal(Value.Check(start.parameters, { sourcePath: "a.zip", expectedKind: "collection" }), true, "collection imports do not require ruleset");
  assert.equal(Value.Check(start.parameters, { sourcePath: "a.zip", expectedKind: "module", ruleset: "2024" }), false);
  assert.equal(Value.Check(tools.get("foundry_lobby_import_job").parameters, { jobId: "j", action: "status", waitMs: 30000 }), false);
  const update = tools.get("foundry_lobby_campaign_packs_update");
  assert.equal(Value.Check(update.parameters, { campaignId: "c", expectedRevision: 1, add: ["a"], remove: ["b"] }), true);
  assert.equal(Value.Check(update.parameters, { campaignId: "c", expectedRevision: 1, enabledSourcesPatch: { srd2014: true, srd2024: false } }), true);
  assert.equal(Value.Check(update.parameters, { campaignId: "c", expectedRevision: 1, enabledSourcesPatch: { srd: true } }), false);
  assert.equal(Value.Check(update.parameters, { campaignId: "c", expectedRevision: 1, enabledSourcesPatch: { srd2014: ["srd"] } }), false);
  assert.equal(Value.Check(update.parameters, { campaignId: "c", expectedRevision: 1, enabledSourcesPatch: {} }), true, "empty patch is rejected at execution, not by the structural schema");
});

test("rulesets_list returns the current deployment registry including non-DND choices", async (t) => {
  const h = harness(t);
  const result = await h.tools.get("foundry_lobby_rulesets_list").execute("rulesets-1", {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.rulesets.map(ruleset => ruleset.id), ["2014", "2024", "octopus", "coc7"]);
  assert.equal(result.details.rulesets.find(ruleset => ruleset.id === "coc7").supportLevel, "experimental");
});

test("world imports reject missing ruleset before binding, inspecting, approval, or dispatch", async (t) => {
  for (const [suffix, args] of [
    ["auto", { sourcePath: "world.zip" }],
    ["world", { sourcePath: "world.zip", expectedKind: "world" }],
  ]) {
    const h = harness(t);
    const result = await h.tools.get("foundry_lobby_import_start").execute(`start-no-ruleset-${suffix}`, args);
    assert.equal(result.details.code, "INPUT_INVALID", suffix);
    assert.equal(h.page.state.inspectCalls.length, 0, suffix);
    assert.equal(h.page.state.runCalls.length, 0, suffix);
    assert.equal(h.approvals.length, 0, suffix);
  }
});

test("world imports reject a ruleset outside the current registry before binding or dispatch", async (t) => {
  const h = harness(t);
  const result = await h.tools.get("foundry_lobby_import_start").execute("start-unknown-ruleset", {
    sourcePath: "world.zip", expectedKind: "world", ruleset: "unknown-rule",
  });
  assert.equal(result.details.code, "INPUT_INVALID");
  assert.match(result.content[0].text, /foundry_lobby_rulesets_list/);
  assert.deepEqual(result.details.supportedRulesets.map(ruleset => ruleset.id), ["2014", "2024", "octopus", "coc7"]);
  assert.equal(h.page.state.inspectCalls.length, 0);
  assert.equal(h.page.state.runCalls.length, 0);
  assert.equal(h.approvals.length, 0);
});

test("an import binds the native file, inspects, asks approval, then runs one job", async (t) => {
  const h = harness(t);
  const result = await h.tools.get("foundry_lobby_import_start").execute("start-1", {
    sourcePath: "world.zip",
    expectedKind: "world",
    campaignName: "Test",
    ruleset: "2014",
    failurePolicy: "abort",
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /job-1/);
  assert.equal(result.details.jobId, "job-1");
  assert.equal(h.page.state.inspectCalls.length, 1);
  assert.equal(h.page.state.inspectCalls[0].expectedKind, "world");
  assert.equal(h.page.state.inspectCalls[0].options.ruleset, "2014");
  assert.equal(h.page.state.runCalls.length, 1);
  assert.deepEqual(h.page.state.runCalls[0], { preparationId: "prep-secret" });
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].tool, "foundry_lobby_import_start");
  assert.equal(h.approvals[0].args.ruleset, "2014");
  assert.equal(JSON.stringify(h.approvals[0]).includes(h.directory), false);
  assert.equal(JSON.stringify(h.approvals[0]).includes("sourcePath"), false);
  const payload = JSON.stringify(result);
  assert.equal(payload.includes("prep-secret"), false, "preparationId never reaches the model");
  assert.equal(payload.includes("keepAssetIds"), false);
  assert.equal(payload.includes(h.directory), false);
  assert.equal(payload.includes("secret-token"), false);
});

test("external expectedKind=collection is normalized to module before the runtime call", async (t) => {
  const h = harness(t);
  const result = await h.tools.get("foundry_lobby_import_start").execute("start-collection", {
    sourcePath: "world.zip",
    expectedKind: "collection",
  });
  assert.equal(result.isError, undefined);
  assert.equal(h.page.state.inspectCalls.length, 1);
  assert.equal(h.page.state.inspectCalls[0].expectedKind, "module");
  assert.equal(h.page.state.runCalls.length, 1);
});

test("approval denial after inspect starts no job", async (t) => {
  const h = harness(t, { approved: false });
  const result = await h.tools.get("foundry_lobby_import_start").execute("start-denied", { sourcePath: "world.zip", ruleset: "2024" });
  assert.equal(result.details.code, "DECLINED");
  assert.equal(h.page.state.inspectCalls.length, 1);
  assert.equal(h.page.state.runCalls.length, 0);
});

test("path fence failures never bind or dispatch", async (t) => {
  const h = harness(t);
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-tools-outside-"));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, "outside.zip");
  writeFileSync(outside, "outside");
  const result = await h.tools.get("foundry_lobby_import_start").execute("start-outside", { sourcePath: outside, ruleset: "2024" });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "FILE_OUTSIDE_FENCE");
  assert.equal(h.page.state.inspectCalls.length, 0);
  assert.equal(h.approvals.length, 0);
  assert.equal(JSON.stringify(result).includes(outsideDir), false);
});

test("import_job status waits for the terminal report and cancel calls the contract", async (t) => {
  const h = harness(t);
  await h.tools.get("foundry_lobby_import_start").execute("start-2", { sourcePath: "world.zip", ruleset: "2024" });
  const status = await h.tools.get("foundry_lobby_import_job").execute("status-1", { jobId: "job-1", action: "status", waitMs: 2_000 });
  assert.equal(status.isError, undefined);
  assert.match(status.content[0].text, /Terminal/);
  assert.equal(status.details.status, "succeeded");
  assert.equal(status.details.report.actors, 12);
  assert.ok(h.page.state.statusCalls >= 2);

  const cancel = await h.tools.get("foundry_lobby_import_job").execute("cancel-1", { jobId: "job-1", action: "cancel" });
  assert.equal(cancel.isError, undefined);
  assert.match(cancel.content[0].text, /accepted is not proof of stop\/cleanup/);
  assert.equal(cancel.details.status, "cancelling");
  assert.equal(cancel.details.terminal, false);
  assert.deepEqual(h.page.state.cancelCalls, [{ jobId: "job-1" }]);
});

test("job status compacts status/state/phase consistently and never emits unknown when a field exists", async (t) => {
  for (const [field, value] of [["status", "completed"], ["state", "failed"], ["phase", "succeeded"]]) {
    const h = harness(t);
    await h.tools.get("foundry_lobby_import_start").execute(`start-${field}`, { sourcePath: "world.zip", ruleset: "2024" });
    h.page.service.lobbyImportStatus = async ({ jobId }) => ({
      jobId, [field]: value, terminal: true, report: { marker: field }, failures: [],
    });
    const result = await h.tools.get("foundry_lobby_import_job").execute(`status-${field}`, { jobId: "job-1", action: "status" });
    assert.equal(result.details.status, value, field);
    assert.equal(result.details.terminal, true, field);
    assert.doesNotMatch(result.content[0].text, /unknown/, field);
  }
});

test("union arguments reject invalid combinations before any page call", async (t) => {
  const h = harness(t);
  const status = await h.tools.get("foundry_lobby_import_job").execute("bad-status", { jobId: "job-1", action: "status", waitMs: 30_000 });
  assert.equal(status.details.code, "INPUT_INVALID");
  const cancel = await h.tools.get("foundry_lobby_import_job").execute("bad-cancel", { jobId: "job-1", action: "cancel", waitMs: 10 });
  assert.equal(cancel.details.code, "INPUT_INVALID");
  const read = await h.tools.get("foundry_lobby_packs_read").execute("bad-read", { packId: "p", moduleId: "m" });
  assert.equal(read.details.code, "INPUT_INVALID");
  assert.equal(h.page.state.statusCalls, 0);
  assert.equal(h.page.state.cancelCalls.length, 0);
  assert.equal(h.page.state.packReadCalls.length, 0);
});

test("campaigns, campaign pack reads and stale updates are bounded and remain zero-write", async (t) => {
  const h = harness(t);
  const campaigns = await h.tools.get("foundry_lobby_campaigns_list").execute("campaigns", {});
  assert.equal(campaigns.details.campaigns[0].id, "campaign-1");

  const current = await h.tools.get("foundry_lobby_campaign_packs_get").execute("get", { campaignId: "campaign-1" });
  assert.equal(current.details.revision, 4);
  assert.equal(current.details.selected.includes("pack-a"), true);

  const stale = await h.tools.get("foundry_lobby_campaign_packs_update").execute("update-stale", {
    campaignId: "campaign-1",
    expectedRevision: 3,
    add: ["pack-b"],
  });
  assert.equal(stale.details.code, "REVISION_MISMATCH");
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 0);
  assert.equal(h.approvals.length, 0);

  const update = await h.tools.get("foundry_lobby_campaign_packs_update").execute("update", {
    campaignId: "campaign-1",
    expectedRevision: 4,
    add: ["pack-b"],
    remove: ["pack-c"],
    enabledSourcesPatch: { srd2014: false },
  });
  assert.equal(update.isError, undefined);
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.page.state.campaignPacksUpdateCalls[0])), {
    campaignId: "campaign-1",
    expectedRevision: 4,
    add: ["pack-b"],
    remove: ["pack-c"],
    enabledSourcesPatch: { srd2014: false },
  });
  assert.equal(update.details.current.revision, 5);
  assert.equal(h.approvals.length, 1);
});

test("campaign pack update denial and empty patches never write", async (t) => {
  const h = harness(t, { approved: false });
  const empty = await h.tools.get("foundry_lobby_campaign_packs_update").execute("empty", { campaignId: "campaign-1", expectedRevision: 4 });
  assert.equal(empty.details.code, "INPUT_INVALID");
  const emptyPatch = await h.tools.get("foundry_lobby_campaign_packs_update").execute("empty-patch", {
    campaignId: "campaign-1", expectedRevision: 4, add: ["pack-b"], enabledSourcesPatch: {},
  });
  assert.equal(emptyPatch.details.code, "INPUT_INVALID");
  const unknownPatch = await h.tools.get("foundry_lobby_campaign_packs_update").execute("unknown-patch", {
    campaignId: "campaign-1", expectedRevision: 4, add: ["pack-b"], enabledSourcesPatch: { srd: true },
  });
  assert.equal(unknownPatch.details.code, "INPUT_INVALID");
  const denied = await h.tools.get("foundry_lobby_campaign_packs_update").execute("denied", { campaignId: "campaign-1", expectedRevision: 4, add: ["pack-b"] });
  assert.equal(denied.details.code, "DECLINED");
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 0);
});

test("pack library reads are paginated and bounded", async (t) => {
  const h = harness(t);
  const list = await h.tools.get("foundry_lobby_packs_read").execute("list", {});
  assert.equal(list.details.revision, 7);
  assert.equal(list.details.modules.length, 1);
  const read = await h.tools.get("foundry_lobby_packs_read").execute("read", { packId: "pack-a", limit: 10 });
  assert.equal(read.details.entries.length, 10);
  assert.equal(read.details.nextCursor, "10");
  assert.equal(JSON.stringify(read).includes("Entry 0"), true);

  h.page.service.lobbyPackRead = async ({ packId }) => ({
    pack: { packId, name: "Pack A" },
    entries: Array.from({ length: 500 }, (_, index) => ({ entryId: `e-${index}`, name: `Entry ${index}` })),
    nextCursor: "500",
  });
  const oversized = await h.tools.get("foundry_lobby_packs_read").execute("read-big", { packId: "pack-a", limit: 50 });
  assert.equal(oversized.details.entries.length, 50);
});

test("pack library projection keeps packCount=0 and omits batches/legacy presentation fields", async (t) => {
  const h = harness(t);
  h.page.service.lobbyPacksList = async () => ({
    revision: "empty-revision",
    packCount: 0,
    modules: [],
    batches: [{ batchId: "large-presentation-row" }],
    legacy: [{ rowId: "large-legacy-row" }],
  });
  const list = await h.tools.get("foundry_lobby_packs_read").execute("empty-list", {});
  assert.equal(list.details.packCount, 0);
  assert.equal(list.details.revision, "empty-revision");
  assert.deepEqual(list.details.modules, []);
  assert.equal("batches" in list.details, false);
  assert.equal("legacy" in list.details, false);
  assert.equal(JSON.stringify(list).includes("large-presentation-row"), false);
  assert.equal(JSON.stringify(list).includes("large-legacy-row"), false);
});

test("tool redaction preserves remote URLs while masking real local paths", async (t) => {
  const h = harness(t);
  const assetUrl = "http://127.0.0.1:18615/var/lib/assets/monster.png?signature=abc";
  const playUrl = "https://arcanemap.example.test/private/compat/play.html?campaign=c1";
  h.page.service.lobbyImportStatus = async () => ({
    jobId: "job-1",
    phase: "succeeded",
    status: "succeeded",
    terminal: true,
    report: {
      assetUrl,
      playUrl,
      localFile: "D:\\prep\\world.zip",
      posixFile: "/var/lib/arcane/world.zip",
    },
  });
  await h.tools.get("foundry_lobby_import_start").execute("start-url-redaction", { sourcePath: "world.zip", ruleset: "2024" });
  const result = await h.tools.get("foundry_lobby_import_job").execute("status-url-redaction", { jobId: "job-1", action: "status" });
  assert.equal(result.details.report.assetUrl, assetUrl);
  assert.equal(result.details.report.playUrl, playUrl);
  assert.equal(result.details.report.localFile, "[path]");
  assert.equal(result.details.report.posixFile, "[path]");
  assert.equal(JSON.stringify(result).includes("D:\\prep\\world.zip"), false);
});

test("pack delete previews, asks approval, then deletes; stale revisions never preview", async (t) => {
  const staleHarness = harness(t);
  const stale = await staleHarness.tools.get("foundry_lobby_packs_delete").execute("delete-stale", { packIds: ["pack-a"], expectedRevision: 6 });
  assert.equal(stale.details.code, "REVISION_MISMATCH");
  assert.equal(staleHarness.page.state.deletePreviewCalls.length, 0);
  assert.equal(staleHarness.page.state.deleteCalls.length, 0);

  const deniedHarness = harness(t, { approved: false });
  const denied = await deniedHarness.tools.get("foundry_lobby_packs_delete").execute("delete-denied", { packIds: ["pack-a"], expectedRevision: 7 });
  assert.equal(denied.details.code, "DECLINED");
  assert.equal(deniedHarness.page.state.deletePreviewCalls.length, 1);
  assert.equal(deniedHarness.page.state.deleteCalls.length, 0);

  const h = harness(t);
  const deleted = await h.tools.get("foundry_lobby_packs_delete").execute("delete", { packIds: ["pack-a", "pack-b"], expectedRevision: 7 });
  assert.equal(deleted.isError, undefined);
  assert.equal(h.page.state.deletePreviewCalls.length, 1);
  assert.equal(h.page.state.deleteCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.page.state.deleteCalls[0])), { packIds: ["pack-a", "pack-b"], expectedRevision: 7 });
  assert.equal(deleted.details.revision, 8);
  assert.equal(h.approvals[0].tool, "foundry_lobby_packs_delete");
});

test("lobby tools fail closed outside prep mode even if invoked from history", async (t) => {
  const h = harness(t);
  h.host.profile.mode = "combat";
  const result = await h.tools.get("foundry_lobby_campaigns_list").execute("combat", {});
  assert.equal(result.details.code, "PROFILE_MISMATCH");
  assert.equal(h.page.state.listCalls, 0);
});

test("import_start reports jobStarted=false before dispatch and unknown after a run was sent", async (t) => {
  const inspectFailure = harness(t);
  inspectFailure.page.state.failLogin = true;
  const beforeRun = await inspectFailure.tools.get("foundry_lobby_import_start").execute("start-before", { sourcePath: "world.zip", ruleset: "2024" });
  assert.equal(beforeRun.details.jobStarted, false);

  const runFailure = harness(t);
  runFailure.page.service.lobbyImportRun = async () => {
    throw Object.assign(new Error("the page navigated after run"), { code: "JOB_INDETERMINATE" });
  };
  const afterRun = await runFailure.tools.get("foundry_lobby_import_start").execute("start-after", { sourcePath: "world.zip", ruleset: "2024" });
  assert.equal(afterRun.details.code, "JOB_INDETERMINATE");
  assert.equal(afterRun.details.jobStarted, "unknown");
  assert.equal(runFailure.page.state.inspectCalls.length, 1);
});

test("login-required runtime errors are surfaced as stable codes", async (t) => {
  const h = harness(t);
  h.page.state.failLogin = true;
  const result = await h.tools.get("foundry_lobby_import_start").execute("login", { sourcePath: "world.zip", ruleset: "2024" });
  assert.equal(result.details.code, "LOGIN_REQUIRED");
  assert.match(result.content[0].text, /sign in directly/);
  assert.equal(h.page.state.runCalls.length, 0);
});

// ---- 方案 B：foundry_lobby_return（play → 受信 lobby，typed action + 就绪确认）----

test("foundry_lobby_return saves the trusted play URL, dispatches navigateToLobby, then confirms the lobby", async (t) => {
  const h = returnHarness(t);
  const result = await h.tool.execute("return-1", {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, {
    status: "completed",
    from: { path: "/user-files/compat/play.html", campaignId: "campaign-1" },
    to: { path: "/user-files/compat/lobby.html" },
    returnPlayUrl: PLAY_URL,
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "navigateToLobby");
  assert.deepEqual(h.calls[0].args, {});
  assert.equal(h.calls[0].options.executionTimeoutMs, 15_000);
  assert.equal(h.page.webContents.getURL(), LOBBY_URL);
  assert.match(result.content[0].text, /foundry_open/);
  assert.match(result.content[0].text, /campaign-1/);

  const campaigns = await h.tools.get("foundry_lobby_campaigns_list").execute("campaigns", {});
  assert.equal(campaigns.details.campaigns[0].id, "campaign-1");
});

test("an expected NAVIGATED from navigateToLobby also enters the confirmation stage", async (t) => {
  const h = returnHarness(t, {
    behavior: async ({ page }) => {
      page.webContents.navigate(LOBBY_URL);
      throw new FoundrySdkError(FOUNDRY_SDK_ERROR_CODES.NAVIGATED, "Foundry navigated while the runtime read was in progress");
    },
  });
  const result = await h.tool.execute("return-navigated", {});
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "completed");
  assert.equal(result.details.from.campaignId, "campaign-1");
  assert.equal(result.details.returnPlayUrl, PLAY_URL);
  assert.equal(h.calls.length, 1);
});

test("already in the lobby returns completed/alreadyInLobby without dispatching or navigating", async (t) => {
  const h = returnHarness(t, { url: LOBBY_URL });
  const result = await h.tool.execute("return-already", {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, { status: "completed", alreadyInLobby: true });
  assert.equal(h.calls.length, 0);
  assert.equal(h.page.webContents.getURL(), LOBBY_URL);
});

test("already in the lobby still waits for auth/runtime/service, then the first campaigns_list succeeds", async (t) => {
  const h = returnHarness(t, { url: LOBBY_URL, readyTimeoutMs: 2_000 });
  const service = h.page.service;
  h.page.setService(null);
  const timer = setTimeout(() => h.page.setService(service), 100);
  t.after(() => clearTimeout(timer));

  const result = await h.tool.execute("return-already-delayed", {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details, { status: "completed", alreadyInLobby: true });
  assert.equal(h.calls.length, 0, "already-in-lobby must not dispatch navigateToLobby");
  const campaigns = await h.tools.get("foundry_lobby_campaigns_list").execute("campaigns-first", {});
  assert.equal(campaigns.isError, undefined);
  assert.equal(campaigns.details.campaigns[0].id, "campaign-1");
  assert.equal(h.page.state.listCalls, 1);
});

test("a delayed lobby service is waited for, then the first campaigns_list succeeds", async (t) => {
  const h = returnHarness(t, { readyTimeoutMs: 2_000 });
  const service = h.page.service;
  h.page.setService(null);
  const timer = setTimeout(() => h.page.setService(service), 100);
  t.after(() => clearTimeout(timer));

  const result = await h.tool.execute("return-delayed-service", {});
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "completed");
  const campaigns = await h.tools.get("foundry_lobby_campaigns_list").execute("campaigns-first", {});
  assert.equal(campaigns.isError, undefined);
  assert.equal(campaigns.details.campaigns[0].id, "campaign-1");
  assert.equal(h.page.state.listCalls, 1);
});

test("a wrong destination is TARGET_CHANGED: no fake success and no replay", async (t) => {
  const h = returnHarness(t, {
    behavior: async ({ page }) => {
      page.webContents.navigate("https://arcanemap.com/game");
      return { status: "completed" };
    },
  });
  const result = await h.tool.execute("return-wrong", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "TARGET_CHANGED");
  assert.match(result.content[0].text, /not replayed/);
  assert.match(result.content[0].text, /foundry_open/);
  assert.doesNotMatch(result.content[0].text, /world_status/);
  assert.equal(h.calls.length, 1);
});

test("an untrusted-origin lobby is TARGET_CHANGED, never success", async (t) => {
  const h = returnHarness(t, {
    behavior: async ({ page }) => {
      page.webContents.navigate("https://evil.example/user-files/compat/lobby.html");
      return { status: "completed" };
    },
  });
  const result = await h.tool.execute("return-evil", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "TARGET_CHANGED");
  assert.equal(h.calls.length, 1);
});

test("a typed timeout is JOB_INDETERMINATE and is not replayed", async (t) => {
  const h = returnHarness(t, {
    behavior: async () => {
      throw new FoundrySdkError(FOUNDRY_SDK_ERROR_CODES.TIMEOUT, "navigateToLobby timed out after dispatch");
    },
  });
  const result = await h.tool.execute("return-timeout", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "JOB_INDETERMINATE");
  assert.equal(h.calls.length, 1);
  assert.equal(h.page.webContents.getURL(), PLAY_URL, "a failed typed call must not fake a navigation");
});

test("never reaching the lobby within the bounded wait is TARGET_CHANGED", async (t) => {
  const h = returnHarness(t, {
    readyTimeoutMs: 150,
    behavior: async () => ({ status: "completed" }),
  });
  const result = await h.tool.execute("return-never-navigated", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "TARGET_CHANGED");
  assert.equal(h.calls.length, 1);
  assert.equal(h.page.webContents.getURL(), PLAY_URL);
});

test("a missing page runtime is CAPABILITY_UNAVAILABLE before any dispatch", async (t) => {
  const h = returnHarness(t, { withRuntime: false });
  const result = await h.tool.execute("return-no-runtime", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(h.calls.length, 0);
});

test("an old frontend without navigateToLobby is CAPABILITY_UNAVAILABLE", async (t) => {
  for (const failure of [
    Object.assign(new Error("Foundry runtime read failed: ACTION_UNKNOWN: navigateToLobby"), {
      code: FOUNDRY_SDK_ERROR_CODES.EVALUATION_FAILED,
    }),
    new FoundrySdkError(FOUNDRY_SDK_ERROR_CODES.ACTION_UNSUPPORTED, "Unsupported Foundry runtime action: navigateToLobby"),
    Object.assign(new Error("CAPABILITY_UNAVAILABLE: play exit surface is not installed"), {
      code: FOUNDRY_SDK_ERROR_CODES.EVALUATION_FAILED,
    }),
  ]) {
    const h = returnHarness(t, { behavior: async () => { throw failure; } });
    const result = await h.tool.execute("return-old", {});
    assert.equal(result.isError, true, failure.message);
    assert.equal(result.details.code, "CAPABILITY_UNAVAILABLE", failure.message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.page.webContents.getURL(), PLAY_URL);
  }
});

test("an expired login during the return is LOGIN_REQUIRED", async (t) => {
  const h = returnHarness(t, {
    behavior: async ({ page }) => {
      page.webContents.navigate(AUTH_URL);
      return { status: "completed" };
    },
  });
  const result = await h.tool.execute("return-login", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "LOGIN_REQUIRED");
  assert.match(result.content[0].text, /sign in directly/);
  assert.equal(h.calls.length, 1);
});

test("the campaign identity comes from the play URL, never from the typed receipt", async (t) => {
  const h = returnHarness(t, {
    behavior: async ({ page }) => {
      page.webContents.navigate(LOBBY_URL);
      return {
        status: "completed",
        from: { path: "/user-files/compat/play.html", campaignId: "campaign-other" },
        to: { path: "/user-files/compat/lobby.html" },
        returnPlayUrl: "https://arcanemap.com/user-files/compat/play.html?campaign=campaign-other",
      };
    },
  });
  const result = await h.tool.execute("return-campaign", {});
  assert.equal(result.isError, undefined);
  assert.equal(result.details.from.campaignId, "campaign-1");
  assert.equal(result.details.returnPlayUrl, PLAY_URL);
  assert.equal(JSON.stringify(result).includes("campaign-other"), false);
});

test("an unknown typed result is JOB_INDETERMINATE with zero replays and no eval fallback", async (t) => {
  const h = returnHarness(t, {
    behavior: async () => { throw new Error("renderer exploded"); },
  });
  const result = await h.tool.execute("return-unknown", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "JOB_INDETERMINATE");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "navigateToLobby", "the failure must not be retried or replaced with another action");
  assert.equal(h.page.webContents.getURL(), PLAY_URL);
});

test("an unrecognized completed receipt is JOB_INDETERMINATE, not success", async (t) => {
  const h = returnHarness(t, {
    behavior: async () => ({ status: "rejected", code: "SOMETHING_ELSE" }),
  });
  const result = await h.tool.execute("return-bad-receipt", {});
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "JOB_INDETERMINATE");
  assert.equal(h.calls.length, 1);
});

test("empty or missing typed receipts are JOB_INDETERMINATE, never success", async (t) => {
  for (const [label, receipt] of [["empty", {}], ["undefined", undefined]]) {
    const h = returnHarness(t, { behavior: async () => receipt });
    const result = await h.tool.execute(`return-${label}-receipt`, {});
    assert.equal(result.isError, true, label);
    assert.equal(result.details.code, "JOB_INDETERMINATE", label);
    assert.equal(h.calls.length, 1, label);
    assert.equal(h.page.webContents.getURL(), PLAY_URL, label);
  }
});

test("direct runtime error codes map to stable lobby codes", async (t) => {
  for (const [code, expected] of [
    ["LOGIN_REQUIRED", "LOGIN_REQUIRED"],
    ["UNAUTHORIZED", "LOGIN_REQUIRED"],
    ["AUTH_REQUIRED", "LOGIN_REQUIRED"],
    ["SESSION_EXPIRED", "LOGIN_REQUIRED"],
    ["CAPABILITY_UNAVAILABLE", "CAPABILITY_UNAVAILABLE"],
    ["ACTION_UNKNOWN", "CAPABILITY_UNAVAILABLE"],
  ]) {
    const h = returnHarness(t, {
      behavior: async () => { throw Object.assign(new Error("opaque failure"), { code }); },
    });
    const result = await h.tool.execute(`return-code-${code}`, {});
    assert.equal(result.isError, true, code);
    assert.equal(result.details.code, expected, code);
    assert.equal(h.calls.length, 1, code);
  }
});

test("a host exposing only callFoundryRuntime (no foundryRuntime) is accepted", async (t) => {
  const h = returnHarness(t, { withRuntime: false });
  const calls = [];
  h.host.callFoundryRuntime = async (action, args, options) => {
    calls.push({ action, args, options });
    h.page.webContents.navigate(LOBBY_URL);
    return { status: "completed" };
  };
  const result = await h.tool.execute("return-host-call", {});
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "navigateToLobby");
});

test("profile and campaign preconditions fail closed before the typed call", async (t) => {
  const wrongProfile = returnHarness(t, { panelProfile: "foundry" });
  const profileResult = await wrongProfile.tool.execute("return-profile", {});
  assert.equal(profileResult.details.code, "PROFILE_MISMATCH");
  assert.equal(wrongProfile.calls.length, 0);

  const noCampaign = returnHarness(t, { url: "https://arcanemap.com/user-files/compat/play.html" });
  const campaignResult = await noCampaign.tool.execute("return-no-campaign", {});
  assert.equal(campaignResult.details.code, "PROFILE_MISMATCH");
  assert.match(campaignResult.content[0].text, /campaign/);
  assert.equal(noCampaign.calls.length, 0);

  const combat = returnHarness(t);
  combat.host.profile.mode = "combat";
  const combatResult = await combat.tool.execute("return-combat", {});
  assert.equal(combatResult.details.code, "PROFILE_MISMATCH");
  assert.equal(combat.calls.length, 0);
});
