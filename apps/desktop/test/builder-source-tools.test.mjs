import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { buildVerificationExpectations, createBuilderSourceTools, normalizeVerification, rootExpectations, verificationScript } from "../src/main/builder-source.js";
import { MtLobbyClient } from "../src/main/mt-lobby-client.js";
import { LOBBY_URL, createLobbyFixture } from "./fixtures/lobby-harness.mjs";

const PLAY_URL = "https://arcanemap.com/user-files/compat/play.html?campaign=campaign-1";
const MODULE_ID = "alice-homebrew";
const ROOT_CLASS = "Item.aaaaaaaaaaaaaaaa";
const ROOT_SPELL = "Item.bbbbbbbbbbbbbbbb";
const CLASS_UUID = "Compendium.user-alice-homebrew.classes.Item.aaaaaaaaaaaaaaaa";
const SPELL_UUID = "Compendium.user-alice-homebrew.spells.Item.bbbbbbbbbbbbbbbb";

function makeDump(moduleId = MODULE_ID) {
  return {
    moduleId,
    moduleJson: { id: moduleId, title: "Alice 自建合集", version: "1.0.0" },
    title: "Alice 自建合集",
    version: "1.0.0",
    packs: [
      {
        name: "classes",
        label: "自建职业",
        type: "Item",
        system: "dnd5e",
        entries: [{
          _id: "aaaaaaaaaaaaaaaa",
          name: "Mage",
          type: "class",
          system: {
            identifier: "mage",
            advancement: [{
              type: "ItemGrant",
              configuration: { items: [`Compendium.${moduleId}.spells.Item.bbbbbbbbbbbbbbbb`] },
            }],
          },
        }],
      },
      {
        name: "spells",
        label: "自建法术",
        type: "Item",
        system: "dnd5e",
        entries: [{
          _id: "bbbbbbbbbbbbbbbb",
          name: "Ember",
          type: "spell",
          flags: { [moduleId]: { spellClasses: ["mage"] } },
        }],
      },
    ],
    assets: [{ path: "assets/ember.png", bytesBase64: "cG5n" }],
    rawAssetBytes: 3,
    entryCount: 2,
    outwardEntryCount: 2,
  };
}

function makeFeatDump(moduleId = MODULE_ID) {
  return {
    moduleId,
    moduleJson: { id: moduleId, title: "Alice 自建合集", version: "1.0.0" },
    title: "Alice 自建合集",
    version: "1.0.0",
    packs: [{
      name: "feats",
      label: "自建专长",
      type: "Item",
      system: "dnd5e",
      entries: [{
        _id: "eeeeeeeeeeeeeeee",
        name: "Ash Gift",
        type: "feat",
        system: { type: { value: "feat" }, identifier: "ash-gift", source: { rules: "2024" } },
      }],
    }],
    assets: [],
    rawAssetBytes: 0,
    entryCount: 1,
    outwardEntryCount: 1,
  };
}

function makeFeatPlan(moduleId = MODULE_ID) {
  return {
    digest: "feat-digest",
    rootCount: 1,
    dependencyCount: 0,
    exposure: { feats: 1 },
    packs: [{ packId: "feats", operation: "create", entries: 1 }],
    assets: { reuse: 0, upload: 0, bytes: 0 },
    coverage: makePlan(moduleId).coverage,
    issues: { errors: [], warnings: [] },
  };
}

function makePlan(moduleId = MODULE_ID) {
  return {
    digest: "digest-1",
    rootCount: 2,
    dependencyCount: 1,
    exposure: { identity: 1, spells: 1 },
    packs: [
      { packId: "classes", operation: "create", entries: 1 },
      { packId: "spells", operation: "create", entries: 1 },
    ],
    assets: { reuse: 0, upload: 1, bytes: 3 },
    coverage: {
      schema: "passed",
      identityAndVersions: "passed",
      dependencyClosure: "passed",
      catalogExposure: "passed",
      spellLists: "passed",
      startingEquipment: "not-applicable",
      assetPreflight: "passed",
      campaignPreflight: "passed",
      advancementApply: "not-run",
      persistenceAfterRefresh: "not-run",
      playerBuild: "not-run",
      automationExecution: "not-run",
      crossClientRefresh: "not-run",
    },
    issues: { errors: [], warnings: [] },
    ...(moduleId === MODULE_ID ? {} : {}),
  };
}

function parseExpectations(code) {
  const match = /const EXPECTED = (\{.*\});\n  const missing/s.exec(code);
  assert.ok(match, "pageEval must embed EXPECTED");
  return JSON.parse(match[1]);
}

function verificationFor(expectations, {
  omitPack = null,
  unresolvedRoot = null,
  omitIdentity = null,
  denyClassChecks = false,
  dropReadback = false,
} = {}) {
  const packs = expectations.packIds.map(packId => ({ packId, present: packId !== omitPack, count: 1 }));
  const roots = expectations.roots.map(root => {
    if (root.uuid === unresolvedRoot) return { ...root, resolved: false };
    return {
      ...root,
      resolved: true,
      actualType: root.type,
      actualIdentifier: root.identifier,
    };
  });
  const identity = expectations.identity.map(row => ({ ...row, present: row.uuid !== omitIdentity }));
  const feats = expectations.feats.map(row => ({ ...row, present: true }));
  const spells = expectations.spells.map(row => ({
    ...row,
    present: true,
    checks: expectations.classChecks
      .filter(check => check.id === row.id && check.packId === row.packId)
      .map(check => ({ classIdentifier: check.classIdentifier, allowed: !denyClassChecks })),
  }));
  const missing = [];
  if (omitPack) missing.push({ feature: "pack", path: omitPack });
  if (unresolvedRoot) missing.push({ feature: "uuid", path: unresolvedRoot });
  if (omitIdentity) {
    const row = expectations.identity.find(entry => entry.uuid === omitIdentity);
    missing.push({ feature: "identity", path: omitIdentity, bucket: row?.bucket ?? null, packId: row?.packId ?? null });
  }
  if (denyClassChecks) {
    for (const check of expectations.classChecks) {
      missing.push({ feature: "spellClass", path: check.uuid, classIdentifier: check.classIdentifier });
    }
  }
  const errors = dropReadback ? [{ feature: "readback", error: "studio data unavailable" }] : [];
  return {
    register: { called: true, ok: true },
    packs,
    roots,
    identity,
    feats,
    spells,
    readback: { ok: !dropReadback, authAvailable: true, version: expectations.rulesVersion, error: dropReadback ? "studio data unavailable" : null },
    missing,
    errors,
  };
}

function harness(t, {
  approved = true,
  plan = null,
  dump = null,
  importError = null,
  jobStatus = null,
  packsUpdate = null,
  verification = null,
  navigateError = null,
  openPlay = true,
  secondPlan = undefined,
  worldReady = true,
  worldInfoBehavior = null,
  worldInfoError = null,
} = {}) {
  const page = createLobbyFixture({ url: PLAY_URL });
  const directory = mkdtempSync(path.join(os.tmpdir(), "arcane-builder-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const runtimeCalls = [];
  const approvals = [];
  const openCalls = [];
  const effectiveDump = dump ?? makeDump();
  const effectivePlan = plan ?? makePlan(effectiveDump.moduleId);

  const service = page.service;
  let importStartCalls = 0;
  let planCalls = 0;
  const selectedPacks = new Set(["pack-a"]);
  service.lobbyCampaignPacksGet = async ({ campaignId }) => {
    page.state.campaignPacksGetCalls.push({ campaignId });
    return {
      campaignId,
      revision: page.state.campaignRevision,
      selected: [...selectedPacks],
      missing: [],
      builtIn: [{ id: "srd", readOnly: true }],
      enabledSources: { srd: true },
    };
  };
  if (!packsUpdate) {
    service.lobbyCampaignPacksUpdate = async ({ campaignId, expectedRevision, add, remove }) => {
      page.state.campaignPacksUpdateCalls.push({ campaignId, expectedRevision, add, remove });
      if (String(expectedRevision) !== String(page.state.campaignRevision)) throw Object.assign(new Error("stale revision"), { code: "REVISION_MISMATCH" });
      for (const packId of add ?? []) selectedPacks.add(packId);
      page.state.campaignRevision += 1;
      return { campaignId, revision: page.state.campaignRevision, selected: [...selectedPacks] };
    };
  }
  service.builderSourceImportStart = async payload => {
    importStartCalls += 1;
    calls.push({ action: "builderSourceImportStart", args: payload });
    if (importError) throw importError;
    return { jobId: "job-1", plan: effectivePlan };
  };
  const originalStatus = service.lobbyImportStatus;
  if (jobStatus) service.lobbyImportStatus = jobStatus;
  if (packsUpdate) service.lobbyCampaignPacksUpdate = packsUpdate;

  const client = new MtLobbyClient({ getWebContents: () => page.webContents, readyTimeoutMs: 2_000, readyPollMs: 10 });
  const host = {
    profile: { mode: "prep" },
    log: () => {},
    panelProfileId: () => "mtcompat",
    lobbyClient: () => client,
    operationStorageDir: directory,
    describeCurrent: () => ({ id: "session-1" }),
    taskCoordinator: () => ({
      currentInputBinding: () => ({
        taskId: "task-1",
        metadata: Promise.resolve({ world: { origin: "https://arcanemap.com", id: "world-1" } }),
      }),
    }),
    maybeRequestApproval: async request => {
      approvals.push(request);
      return approved;
    },
    openFoundry: async url => {
      openCalls.push(url);
      if (!openPlay) return { ok: false, summary: "navigation refused" };
      page.webContents.navigate(PLAY_URL);
      return { ok: true, profile: "mtcompat", summary: "opened" };
    },
    callFoundryRuntime: async (action, args, options) => {
      runtimeCalls.push({ action, args, options });
      if (action === "builderSourcePlan") {
        planCalls += 1;
        if (planCalls === 2 && secondPlan !== undefined) {
          if (secondPlan instanceof Error) throw secondPlan;
          return secondPlan;
        }
        return { status: "completed", plan: effectivePlan, dump: effectiveDump };
      }
      if (action === "navigateToLobby") {
        if (navigateError) throw navigateError;
        page.webContents.navigate(LOBBY_URL);
        return { status: "completed" };
      }
      if (action === "worldInfo") {
        if (worldInfoError) throw worldInfoError;
        if (worldInfoBehavior) return worldInfoBehavior({ page, client });
        return { ready: worldReady, world: { id: "world-1" }, user: { isGM: true } };
      }
      if (action === "pageEval") {
        const expectations = parseExpectations(args.code);
        const value = verification ? verification(expectations) : verificationFor(expectations);
        return { status: "completed", value, touched: [], missing: [] };
      }
      throw new Error(`unexpected runtime action ${action}`);
    },
  };
  const tools = new Map(createBuilderSourceTools(host).map(tool => [tool.name, tool]));
  return {
    page, directory, client, service, host, tools, calls, runtimeCalls, approvals, openCalls,
    tool: tools.get("map_builder_source_attach"),
    importStartCalls: () => importStartCalls,
    planCalls: () => planCalls,
    selectedPacks,
    originalStatus,
  };
}

const ARGS = { sourceUuids: [ROOT_CLASS, ROOT_SPELL], moduleId: MODULE_ID, title: "灰烬秘法" };

test("the tool pool exposes only the builder source tool with a strict schema", () => {
  const tools = new Map(createBuilderSourceTools({ profile: { mode: "prep" } }).map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], ["map_builder_source_attach"]);
  const schema = tools.get("map_builder_source_attach").parameters;
  assert.equal(Value.Check(schema, ARGS), true);
  assert.equal(Value.Check(schema, { sourceUuids: [ROOT_CLASS] }), true);
  assert.equal(Value.Check(schema, { sourceUuids: [] }), false);
  assert.equal(Value.Check(schema, { sourceUuids: [ROOT_CLASS], dryRun: "yes" }), false);
  assert.equal(Value.Check(schema, { sourceUuids: [ROOT_CLASS], planRef: "plan-1" }), false);
  assert.equal(Value.Check(schema, { sourceUuids: [ROOT_CLASS], apply: true }), false);
  assert.equal(Value.Check(schema, { sourceUuids: [ROOT_CLASS], approval: true }), false);
  assert.equal(Value.Check(schema, { sourceUuids: Array.from({ length: 21 }, (_, i) => `Item.${"a".repeat(15)}${i % 10}`) }), false);
  const description = tools.get("map_builder_source_attach").description;
  assert.match(description, /dryRun:true/);
  assert.match(description, /sourceUuids/);
  assert.match(description, /\{sourceUuids:/);
  assert.match(description, /never returns the dump or Base64/);
});

test("a dry run returns preview + coverage + issues and performs zero writes", async t => {
  const h = harness(t);
  const result = await h.tool.execute("dry-1", { ...ARGS, dryRun: true });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "preview");
  assert.equal(result.details.plan.digest, "digest-1");
  assert.equal(result.details.plan.rootCount, 2);
  assert.equal(result.details.coverage.schema, "passed");
  assert.deepEqual(result.details.issues.errors, []);
  assert.deepEqual(h.runtimeCalls.map(call => call.action), ["builderSourcePlan"]);
  assert.equal(h.calls.length, 0, "no lobby import");
  assert.equal(h.importStartCalls(), 0);
  assert.deepEqual(h.openCalls, []);
  assert.deepEqual(readdirSync(h.directory), [], "no operation journal is written for a dry run");
  const payload = JSON.stringify(result);
  assert.equal(payload.includes("bytesBase64"), false);
  assert.equal(payload.includes("cG5n"), false);
  assert.equal(payload.includes('"dump"'), false);
});

test("a rejected plan is returned as rejected before any lobby navigation", async t => {
  const h = harness(t, {
    plan: { status: "rejected", code: "PLAN_REJECTED", issues: { errors: [{ code: "BROKEN_REF" }], warnings: [] }, retry: false },
  });
  // The runtime mock always returns completed; make the plan itself rejected instead.
  h.host.callFoundryRuntime = async (action, args, options) => {
    h.runtimeCalls.push({ action, args, options });
    assert.equal(action, "builderSourcePlan");
    return { status: "rejected", code: "DEPENDENCY_MISSING", issues: { errors: [{ code: "DEPENDENCY_MISSING" }], warnings: [] }, retry: false };
  };
  const result = await h.tool.execute("plan-rejected", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "DEPENDENCY_MISSING");
  assert.deepEqual(result.details.issues.errors, [{ code: "DEPENDENCY_MISSING" }]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.openCalls.length, 0);
  assert.equal(h.page.webContents.getURL(), PLAY_URL);
  assert.deepEqual(h.approvals.length, 1, "approval is the shared write gate before planning the publication");
});

test("the default call walks plan → lobby import → pack selection → return play → verification", async t => {
  const h = harness(t);
  const result = await h.tool.execute("apply-1", ARGS);
  assert.equal(result.isError, undefined, JSON.stringify(result.details));
  assert.equal(result.details.status, "completed");
  assert.equal(result.details.jobId, "job-1");
  assert.equal(typeof result.details.operationRef, "string");
  assert.deepEqual(result.details.published.uuidMap, [
    { sourceUuid: ROOT_CLASS, uuid: CLASS_UUID },
    { sourceUuid: ROOT_SPELL, uuid: SPELL_UUID },
  ]);
  assert.deepEqual(result.details.campaign.attachedPackIds, ["user-alice-homebrew.classes", "user-alice-homebrew.spells"]);
  assert.equal(result.details.verification.packRegistry, "passed");
  assert.equal(result.details.verification.identityCandidates, "passed");
  assert.equal(result.details.verification.featCandidates, "not-applicable");
  assert.equal(result.details.verification.spellLists, "passed");
  assert.equal(result.details.verification.dependencyResolution, "passed");
  assert.equal(result.details.verification.readback, "passed");
  assert.deepEqual(result.details.verification.unresolvedRefs, []);
  assert.equal(result.details.navigation.returnedToPlay, true);
  assert.equal(result.details.navigation.url, PLAY_URL);

  assert.deepEqual(h.runtimeCalls.map(call => call.action), ["builderSourcePlan", "builderSourcePlan", "navigateToLobby", "worldInfo", "pageEval"]);
  const worldInfoCall = h.runtimeCalls.find(call => call.action === "worldInfo");
  assert.equal(worldInfoCall.options.readyTimeoutMs, 30_000);
  assert.equal(worldInfoCall.options.executionTimeoutMs, 30_000);
  assert.equal(h.planCalls(), 2);
  assert.equal(h.importStartCalls(), 1);
  assert.deepEqual(h.page.state.campaignPacksUpdateCalls.map(call => call.add.join(",")), [
    "user-alice-homebrew.classes,user-alice-homebrew.spells",
  ]);
  assert.deepEqual(h.openCalls, [PLAY_URL]);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.approvals[0].tool, "map_builder_source_attach");

  const payload = JSON.stringify(result);
  assert.equal(payload.includes("bytesBase64"), false, "dump asset bytes never reach the model");
  assert.equal(payload.includes("cG5n"), false);
  assert.equal(payload.includes('"dump"'), false);
  assert.match(result.content[0].text, /not proof that a real player completed character creation/);
});

test("moduleId defaults to homebrew-<campaignId> and the planner receives it", async t => {
  const h = harness(t, { dump: makeDump("homebrew-campaign-1"), plan: makePlan("homebrew-campaign-1") });
  const result = await h.tool.execute("default-module", { sourceUuids: [ROOT_CLASS, ROOT_SPELL] });
  assert.equal(result.details.module.id, "homebrew-campaign-1");
  const planCall = h.runtimeCalls.find(call => call.action === "builderSourcePlan");
  assert.equal(planCall.args.moduleId, "homebrew-campaign-1");
});

test("user-* and dotted module ids are rejected before the planner is called", async t => {
  const h = harness(t);
  const userPrefixed = await h.tool.execute("bad-module", { ...ARGS, moduleId: "user-alice-homebrew" });
  assert.equal(userPrefixed.details.status, "rejected");
  assert.equal(userPrefixed.details.code, "INPUT_INVALID");
  const dotted = await h.tool.execute("dotted-module", { ...ARGS, moduleId: "alice.homebrew" });
  assert.equal(dotted.details.status, "rejected");
  assert.equal(dotted.details.code, "INPUT_INVALID");
  assert.match(dotted.content[0].text, /without dots/);
  assert.equal(h.runtimeCalls.length, 0);
  assert.equal(h.approvals.length, 0);
});

test("a digest drift on the pre-lobby recheck is TARGET_CHANGED with zero lobby writes", async t => {
  const changedPlan = { ...makePlan(), digest: "digest-2" };
  const h = harness(t, {
    secondPlan: { status: "completed", plan: changedPlan, dump: makeDump() },
  });
  const result = await h.tool.execute("digest-drift", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "TARGET_CHANGED");
  assert.deepEqual(result.details.planDigest, { initial: "digest-1", recheck: "digest-2" });
  assert.match(result.content[0].text, /Run dryRun again/);
  assert.equal(h.planCalls(), 2);
  assert.equal(h.runtimeCalls.some(call => call.action === "navigateToLobby"), false);
  assert.equal(h.importStartCalls(), 0);
  assert.deepEqual(h.openCalls, []);
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 0);
  assert.equal(h.page.webContents.getURL(), PLAY_URL);
});

test("a rejected pre-lobby recheck rejects with zero writes and never enters the lobby", async t => {
  const h = harness(t, {
    secondPlan: {
      status: "rejected",
      code: "DEPENDENCY_MISSING",
      issues: { errors: [{ code: "DEPENDENCY_MISSING" }], warnings: [] },
      retry: false,
    },
  });
  const result = await h.tool.execute("recheck-rejected", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "PLAN_RECHECK_FAILED");
  assert.equal(result.details.plannerCode, "DEPENDENCY_MISSING");
  assert.equal(h.planCalls(), 2);
  assert.equal(h.runtimeCalls.some(call => call.action === "navigateToLobby"), false);
  assert.equal(h.importStartCalls(), 0);
  assert.deepEqual(h.openCalls, []);
  assert.equal(h.page.webContents.getURL(), PLAY_URL);
});

test("a thrown or digest-less pre-lobby recheck rejects with zero writes", async t => {
  for (const [label, secondPlan, code] of [
    ["thrown", Object.assign(new Error("planner exploded"), { code: "EVALUATION_FAILED" }), "PLAN_RECHECK_FAILED"],
    ["missing-digest", { status: "completed", plan: { ...makePlan(), digest: null }, dump: makeDump() }, "PLAN_DIGEST_MISSING"],
    ["protocol", { status: "completed", plan: makePlan() }, "PLAN_RECHECK_FAILED"],
  ]) {
    const h = harness(t, { secondPlan });
    const result = await h.tool.execute(`recheck-${label}`, ARGS);
    assert.equal(result.details.status, "rejected", label);
    assert.equal(result.details.code, code, label);
    assert.equal(h.planCalls(), 2, label);
    assert.equal(h.runtimeCalls.some(call => call.action === "navigateToLobby"), false, label);
    assert.equal(h.importStartCalls(), 0, label);
    assert.deepEqual(h.openCalls, [], label);
  }
});

test("an initial plan without a digest is rejected before the pre-lobby recheck", async t => {
  const h = harness(t, { plan: { ...makePlan(), digest: null } });
  const result = await h.tool.execute("initial-no-digest", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "PLAN_DIGEST_MISSING");
  assert.equal(h.planCalls(), 1);
  assert.equal(h.runtimeCalls.some(call => call.action === "navigateToLobby"), false);
  assert.equal(h.importStartCalls(), 0);
});

test("non-world or duplicate UUIDs are rejected and roots are deduplicated in order", async t => {
  const h = harness(t);
  const bad = await h.tool.execute("bad-uuid", { ...ARGS, sourceUuids: ["Compendium.x.classes.Item.aaaaaaaaaaaaaaaa"] });
  assert.equal(bad.details.code, "INPUT_INVALID");
  assert.equal(h.runtimeCalls.length, 0);

  const dedup = await h.tool.execute("dedup", { ...ARGS, sourceUuids: [ROOT_CLASS, ROOT_CLASS, ROOT_SPELL], dryRun: true });
  const planCall = h.runtimeCalls.find(call => call.action === "builderSourcePlan");
  assert.deepEqual(planCall.args.sourceUuids, [ROOT_CLASS, ROOT_SPELL]);
  assert.equal(dedup.details.status, "preview");
});

test("a campaign pack preflight failure rejects before any import is started", async t => {
  const h = harness(t);
  h.client.call = async action => {
    if (action === "lobbyCampaignPacksGet") throw Object.assign(new Error("denied"), { code: "LOGIN_REQUIRED" });
    return {};
  };
  const result = await h.tool.execute("preflight", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "LOGIN_REQUIRED");
  assert.equal(result.details.stages.at(-1).step, "campaign_preflight");
  assert.equal(h.importStartCalls(), 0);
});

test("entryFailures or assetFailures make the result partial, never completed", async t => {
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({
      jobId,
      phase: "succeeded",
      terminal: true,
      report: {
        batchId: "batch-1",
        entryFailures: [{ entryId: "aaaaaaaaaaaaaaaa", error: "bad schema" }],
        assetFailures: [],
        failures: [],
      },
    }),
  });
  const result = await h.tool.execute("entry-failure", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "IMPORT_ENTRY_FAILURES");
  assert.equal(result.details.jobId, "job-1");
  assert.equal(result.details.retry, false);
  assert.equal(result.details.published.entryFailures.length, 1);
  assert.match(result.content[0].text, /map_lobby_import_job/);
  assert.equal(h.importStartCalls(), 1);
  assert.deepEqual(h.openCalls, [], "no return to play is claimed after a partial import");
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 0, "packs are not changed for an incomplete import");
});

test("real runModule numeric failure counts are preserved as explicit diagnostics", async t => {
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({
      jobId,
      phase: "succeeded",
      terminal: true,
      report: {
        kind: "module",
        totals: { entries: 120, packs: 4, failed: 3, reused: 0 },
        assets: { uploads: 2, uploadBytes: 10, failures: 2, reused: 0, assetCount: 4 },
        warnings: [],
      },
    }),
  });
  const result = await h.tool.execute("numeric-failures", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "IMPORT_ENTRY_FAILURES");
  assert.deepEqual(result.details.published.entryFailures, [{ code: "ENTRY_FAILURES", count: 3 }]);
  assert.deepEqual(result.details.published.assetFailures, [{ code: "ASSET_FAILURES", count: 2 }]);
  assert.match(result.content[0].text, /3 entry/);
  assert.match(result.content[0].text, /2 asset/);
});

test("array failure details win over numeric totals and keep the real entries", async t => {
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({
      jobId,
      phase: "succeeded",
      terminal: true,
      report: {
        totals: { failed: 1 },
        assets: { failures: 1 },
        entryFailures: [{ entryId: "aaaaaaaaaaaaaaaa", error: "bad schema" }],
        assetFailures: [{ filename: "ember.png", error: "upload failed" }],
        failures: [],
      },
    }),
  });
  const result = await h.tool.execute("array-failures", ARGS);
  assert.equal(result.details.status, "partial");
  assert.deepEqual(result.details.published.entryFailures, [{ entryId: "aaaaaaaaaaaaaaaa", error: "bad schema" }]);
  assert.deepEqual(result.details.published.assetFailures, [{ filename: "ember.png", error: "upload failed" }]);
});

test("legacy report.failures alone still prevents completed and is exposed", async t => {
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({
      jobId,
      phase: "succeeded",
      terminal: true,
      report: { totals: { failed: 0 }, assets: { failures: 0 }, failures: [{ filename: "x.png", error: "upload failed" }] },
    }),
  });
  const result = await h.tool.execute("legacy-failures", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "IMPORT_ENTRY_FAILURES");
  assert.deepEqual(result.details.published.failures, [{ filename: "x.png", error: "upload failed" }]);
  assert.match(result.content[0].text, /1 unclassified/);
});

test("a failed import job is partial with the job id and is not replayed", async t => {
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({ jobId, phase: "failed", terminal: true, report: { failures: [{ reason: "disk" }] } }),
  });
  const result = await h.tool.execute("job-failed", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "IMPORT_FAILED");
  assert.equal(result.details.jobId, "job-1");
  assert.equal(result.details.retry, false);
  assert.equal(h.importStartCalls(), 1);
  assert.match(result.content[0].text, /never replay|do not replay/i);
});

test("an indeterminate job keeps the job id and never re-dispatches the import", async t => {
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({ jobId, phase: "indeterminate", terminal: true, indeterminate: true }),
  });
  const result = await h.tool.execute("job-indeterminate", ARGS);
  assert.equal(result.details.status, "indeterminate");
  assert.equal(result.details.code, "JOB_INDETERMINATE");
  assert.equal(result.details.jobId, "job-1");
  assert.equal(result.details.retry, false);
  assert.equal(h.importStartCalls(), 1);
  assert.deepEqual(h.openCalls, []);
});

test("an import call with an unknown outcome is indeterminate and not replayed", async t => {
  const h = harness(t, {
    importError: Object.assign(new Error("timeout after dispatch"), { code: "JOB_INDETERMINATE" }),
  });
  const result = await h.tool.execute("import-unknown", ARGS);
  assert.equal(result.details.status, "indeterminate");
  assert.equal(result.details.code, "JOB_INDETERMINATE");
  assert.equal(result.details.jobId, null);
  assert.equal(h.importStartCalls(), 1);
  assert.match(result.content[0].text, /never replay/i);
});

test("a pre-dispatch lobby capability failure rejects without claiming a job", async t => {
  const h = harness(t, {
    importError: Object.assign(new Error("builderSourceImportStart is not implemented"), { code: "CAPABILITY_UNAVAILABLE" }),
  });
  const result = await h.tool.execute("import-unavailable", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(result.details.jobId, null);
  assert.equal(h.importStartCalls(), 1);
});

test("revision drift re-reads the campaign selection without re-running the import", async t => {
  const h = harness(t, {
    packsUpdate: async function update({ campaignId, expectedRevision, add }) {
      h.page.state.campaignPacksUpdateCalls.push({ campaignId, expectedRevision, add });
      if (h.page.state.campaignPacksUpdateCalls.length === 1) {
        throw Object.assign(new Error("stale revision"), { code: "REVISION_MISMATCH" });
      }
      for (const packId of add ?? []) h.selectedPacks.add(packId);
      h.page.state.campaignRevision += 1;
      return { campaignId, revision: h.page.state.campaignRevision, selected: ["pack-a", ...(add ?? [])] };
    },
  });
  const result = await h.tool.execute("revision-drift", ARGS);
  assert.equal(result.details.status, "completed", JSON.stringify(result.details));
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 2);
  assert.equal(h.importStartCalls(), 1);
  assert.ok(h.page.state.campaignPacksGetCalls.length >= 3, "selection is re-read after drift");
});

test("persistent revision drift is partial with the job id and no import replay", async t => {
  const h = harness(t, {
    packsUpdate: async function update({ campaignId, expectedRevision, add }) {
      h.page.state.campaignPacksUpdateCalls.push({ campaignId, expectedRevision, add });
      throw Object.assign(new Error("stale revision"), { code: "REVISION_MISMATCH" });
    },
  });
  const result = await h.tool.execute("revision-stuck", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "REVISION_MISMATCH");
  assert.equal(result.details.jobId, "job-1");
  assert.equal(h.importStartCalls(), 1);
  assert.equal(h.page.state.campaignPacksUpdateCalls.length, 3);
  assert.match(result.content[0].text, /retry only the selection|re-read the campaign packs/i);
});

test("a failed post-import read-back is partial, not completed", async t => {
  const h = harness(t, {
    verification: expectations => verificationFor(expectations, { omitPack: "user-alice-homebrew.spells", unresolvedRoot: SPELL_UUID }),
  });
  const result = await h.tool.execute("verify-pack-missing", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "VERIFICATION_FAILED");
  assert.equal(result.details.verification.packRegistry, "failed");
  assert.equal(result.details.verification.dependencyResolution, "failed");
  assert.ok(result.details.verification.unresolvedRefs.includes(SPELL_UUID));
  assert.equal(result.details.navigation.returnedToPlay, true);
});

test("a studio data read failure is partial, never silently passed", async t => {
  const h = harness(t, {
    verification: expectations => verificationFor(expectations, { dropReadback: true }),
  });
  const result = await h.tool.execute("verify-readback-failed", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.verification.readback, "failed");
  assert.equal(result.details.verification.identityCandidates, "passed", "the raw candidate rows can still be present while the readback reports failure");
  assert.equal(result.details.verification.verificationErrors[0].feature, "readback");
});

test("pageEval is not dispatched until the returned play page reports game.ready", async t => {
  const h = harness(t, { worldReady: false });
  const result = await h.tool.execute("not-ready", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "VERIFICATION_UNAVAILABLE");
  assert.match(result.content[0].text, /not confirmed ready|did not report game\.ready/);
  assert.equal(h.runtimeCalls.some(call => call.action === "worldInfo"), true);
  assert.equal(h.runtimeCalls.some(call => call.action === "pageEval"), false, "read-back must not run before game.ready");
  assert.equal(result.details.stages.at(-1).step, "play_ready");
  assert.equal(result.details.stages.at(-1).state, "failed");
  assert.equal(result.details.verification, null);
  assert.equal(h.importStartCalls(), 1, "the import is not replayed");
  assert.deepEqual(h.openCalls, [PLAY_URL]);
});

test("a failed or timed-out ready read is partial and never falls through to pageEval", async t => {
  const h = harness(t, { worldInfoError: Object.assign(new Error("worldInfo timed out"), { code: "TIMEOUT" }) });
  const result = await h.tool.execute("ready-read-failed", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "VERIFICATION_UNAVAILABLE");
  assert.equal(h.runtimeCalls.some(call => call.action === "pageEval"), false);
  assert.equal(h.importStartCalls(), 1);
  assert.match(result.content[0].text, /worldInfo timed out/);
});

test("a lobby URL during the ready read is not accepted as a ready play page", async t => {
  const h = harness(t, {
    worldInfoBehavior: ({ page }) => {
      page.webContents.navigate(LOBBY_URL);
      return { ready: true, world: { id: "world-1" } };
    },
  });
  const result = await h.tool.execute("ready-on-lobby", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.code, "VERIFICATION_UNAVAILABLE");
  assert.match(result.content[0].text, /original campaign play page/);
  assert.equal(h.runtimeCalls.some(call => call.action === "pageEval"), false);
  assert.equal(h.importStartCalls(), 1);
});

test("an unresolved root UUID fails verification and identity/spell checks", async t => {
  const h = harness(t, {
    verification: expectations => verificationFor(expectations, { unresolvedRoot: CLASS_UUID, omitIdentity: CLASS_UUID }),
  });
  const result = await h.tool.execute("verify-root-missing", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.verification.identityCandidates, "failed");
  assert.equal(result.details.verification.dependencyResolution, "failed");
  assert.ok(result.details.verification.unresolvedRefs.includes(CLASS_UUID));
  assert.equal(result.details.verification.candidateFailures[0].feature, "identity");
});

test("a spell-list mismatch fails the spell-list check", async t => {
  const h = harness(t, {
    verification: expectations => verificationFor(expectations, { denyClassChecks: true }),
  });
  const result = await h.tool.execute("verify-spells", ARGS);
  assert.equal(result.details.status, "partial");
  assert.equal(result.details.verification.spellLists, "failed");
  assert.equal(result.details.verification.candidateFailures[0].feature, "spellClass");
});

test("a selectable feat root is checked through loadFeatOptions, not only fromUuid", async t => {
  const featRoot = "Item.eeeeeeeeeeeeeeee";
  const h = harness(t, {
    dump: makeFeatDump(),
    plan: makeFeatPlan(),
  });
  const result = await h.tool.execute("feat-root", { sourceUuids: [featRoot], moduleId: MODULE_ID });
  assert.equal(result.details.status, "completed", JSON.stringify(result.details));
  assert.equal(result.details.verification.featCandidates, "passed");
  assert.equal(result.details.verification.identityCandidates, "not-applicable");
  assert.equal(result.details.verification.spellLists, "not-applicable");
  const pageEval = h.runtimeCalls.find(call => call.action === "pageEval");
  assert.match(pageEval.args.code, /loadFeatOptions/);
  assert.equal(parseExpectations(pageEval.args.code).feats.length, 1);
});

test("rulesVersion comes from the root document and is passed to the studio data reads", async t => {
  const dump = makeDump();
  dump.packs[0].entries[0].system.source = { rules: "2024" };
  dump.packs[1].entries[0].system = { source: { rules: "2024" } };
  const h = harness(t, { dump });
  const result = await h.tool.execute("rules-2024", ARGS);
  assert.equal(result.details.status, "completed", JSON.stringify(result.details));
  const pageEval = h.runtimeCalls.find(call => call.action === "pageEval");
  const expectations = parseExpectations(pageEval.args.code);
  assert.equal(expectations.rulesVersion, "2024");
  assert.match(pageEval.args.code, /listChoices\(EXPECTED\.rulesVersion/);
  assert.match(pageEval.args.code, /loadSpellOptions\(9, EXPECTED\.rulesVersion/);
  assert.match(pageEval.args.code, /classSpellFilter\(check\.classIdentifier, EXPECTED\.rulesVersion/);
});

test("spell checks come from dump dependencies even when the spell is not a source root", async t => {
  const h = harness(t);
  const result = await h.tool.execute("dependency-spell", { sourceUuids: [ROOT_CLASS], moduleId: MODULE_ID, title: "灰烬秘法" });
  assert.equal(result.details.status, "completed", JSON.stringify(result.details));
  assert.equal(result.details.verification.spellLists, "passed");
  const pageEval = h.runtimeCalls.find(call => call.action === "pageEval");
  const expectations = parseExpectations(pageEval.args.code);
  assert.equal(expectations.spells.length, 1, "the spell dependency is checked even though it is not a root");
  assert.equal(expectations.classChecks.length, 1);
  assert.equal(expectations.classChecks[0].classIdentifier, "mage");
  assert.match(pageEval.args.code, /listChoices\(EXPECTED\.rulesVersion/);
  assert.match(pageEval.args.code, /loadSpellOptions\(9, EXPECTED\.rulesVersion/);
  assert.match(pageEval.args.code, /classSpellFilter\(check\.classIdentifier, EXPECTED\.rulesVersion/);
});

test("plan spellLists mappings add class checks when spell flags are absent", async t => {
  const dump = makeDump();
  dump.packs[1].entries[0].flags = {};
  const plan = makePlan();
  plan.spellLists = { mage: ["bbbbbbbbbbbbbbbb"] };
  const h = harness(t, { dump, plan });
  const result = await h.tool.execute("plan-spell-lists", ARGS);
  assert.equal(result.details.status, "completed", JSON.stringify(result.details));
  const pageEval = h.runtimeCalls.find(call => call.action === "pageEval");
  const expectations = parseExpectations(pageEval.args.code);
  assert.deepEqual(expectations.classChecks, [{
    id: "bbbbbbbbbbbbbbbb",
    packId: "user-alice-homebrew.spells",
    uuid: SPELL_UUID,
    classIdentifier: "mage",
  }]);
});

test("an unconfirmed return to play is indeterminate with completed import and pack state", async t => {
  const h = harness(t, { openPlay: false });
  const result = await h.tool.execute("return-failed", ARGS);
  assert.equal(result.details.status, "indeterminate");
  assert.equal(result.details.code, "NAVIGATION_FAILED");
  assert.equal(result.details.jobId, "job-1");
  assert.deepEqual(result.details.campaign.attachedPackIds, ["user-alice-homebrew.classes", "user-alice-homebrew.spells"]);
  assert.equal(result.details.navigation.returnedToPlay, false);
  assert.equal(h.importStartCalls(), 1);
});

test("navigating to the lobby before the play page rejects with PROFILE_MISMATCH", async t => {
  const h = harness(t);
  h.page.webContents.navigate(LOBBY_URL);
  const result = await h.tool.execute("already-lobby", ARGS);
  assert.equal(result.details.code, "PROFILE_MISMATCH");
  assert.equal(h.runtimeCalls.length, 0);
});

test("a login failure during lobby navigation rejects before importing", async t => {
  const h = harness(t, { navigateError: Object.assign(new Error("login"), { code: "LOGIN_REQUIRED" }) });
  const result = await h.tool.execute("login-nav", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "LOGIN_REQUIRED");
  assert.equal(h.importStartCalls(), 0);
});

test("an uncertain lobby navigation is indeterminate rather than rejected", async t => {
  const h = harness(t, { navigateError: Object.assign(new Error("timeout"), { code: "JOB_INDETERMINATE" }) });
  const result = await h.tool.execute("unknown-nav", ARGS);
  assert.equal(result.details.status, "indeterminate");
  assert.equal(result.details.code, "JOB_INDETERMINATE");
  assert.equal(result.details.jobId, null);
  assert.equal(h.importStartCalls(), 0);
});

test("a declined write gate performs no plan, import, or navigation", async t => {
  const h = harness(t, { approved: false });
  const result = await h.tool.execute("declined", ARGS);
  assert.equal(result.details.code, "DECLINED");
  assert.equal(h.runtimeCalls.length, 0);
  assert.equal(h.importStartCalls(), 0);
  assert.deepEqual(h.openCalls, []);
  assert.deepEqual(readdirSync(h.directory), []);
});

test("an internal canonical reference outside the dump rejects before any lobby write", async t => {
  const dump = makeDump();
  dump.packs[0].entries[0].system.advancement[0].configuration.items = [
    "Compendium.alice-homebrew.spells.Item.cccccccccccccccc",
  ];
  const h = harness(t, { dump });
  const result = await h.tool.execute("broken-closure", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "DEPENDENCY_CLOSURE_FAILED");
  assert.ok(result.details.unresolvedRefs.some(ref => ref.includes("cccccccccccccccc")));
  assert.equal(h.calls.length, 0);
  assert.equal(h.importStartCalls(), 0);
});

test("a leftover world UUID and a module-id mismatch both reject before importing", async t => {
  const leftover = makeDump();
  leftover.packs[0].entries[0].system.description = "@UUID[Item.aaaaaaaaaaaaaaaa]";
  const h = harness(t, { dump: leftover });
  const leftoverResult = await h.tool.execute("world-ref", ARGS);
  assert.equal(leftoverResult.details.code, "DEPENDENCY_CLOSURE_FAILED");
  assert.equal(h.importStartCalls(), 0);

  const mismatch = harness(t, { dump: makeDump("other-module") });
  const mismatchResult = await mismatch.tool.execute("module-mismatch", ARGS);
  assert.equal(mismatchResult.details.code, "PLAN_PROTOCOL_INVALID");
  assert.equal(mismatch.importStartCalls(), 0);
});

test("a plan that still carries blocking issues rejects without importing", async t => {
  const plan = makePlan();
  plan.issues = { errors: [{ code: "SPELL_LIST_EMPTY" }], warnings: [] };
  const h = harness(t, { plan });
  const result = await h.tool.execute("plan-issues", ARGS);
  assert.equal(result.details.status, "rejected");
  assert.equal(result.details.code, "PLAN_ISSUES");
  assert.equal(result.details.issues.errors[0].code, "SPELL_LIST_EMPTY");
  assert.equal(h.importStartCalls(), 0);
});

test("an import report uuidMap overrides same-id derivation for publication and read-back", async t => {
  const alternate = "Compendium.user-alice-homebrew.classes.Item.dddddddddddddddd";
  const h = harness(t, {
    jobStatus: async ({ jobId }) => ({
      jobId,
      phase: "succeeded",
      terminal: true,
      report: { batchId: "batch-2", uuidMap: [{ sourceUuid: ROOT_CLASS, uuid: alternate }], failures: [] },
    }),
  });
  const result = await h.tool.execute("report-uuid", ARGS);
  assert.equal(result.details.status, "completed", JSON.stringify(result.details));
  assert.equal(result.details.published.batchId, "batch-2");
  assert.equal(result.details.published.uuidMap.find(row => row.sourceUuid === ROOT_CLASS).uuid, alternate);
  const pageEval = h.runtimeCalls.find(call => call.action === "pageEval");
  assert.match(pageEval.args.code, new RegExp(alternate.replaceAll(".", "\\.")));
});

test("verificationScript returns a pageEval value under Map's async-function-body wrapper", async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "arcane-builder-page-eval-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "studio"), { recursive: true });
  writeFileSync(path.join(directory, "studio", "data.mjs"), [
    "const state = globalThis.__TEST_STUDIO__;",
    "export async function listChoices(version) { return state.choices[version] ?? { classes: [], subclasses: [], races: [], backgrounds: [] }; }",
    "export async function loadFeatOptions() { return state.feats; }",
    "export async function loadSpellOptions(maxLevel, version, packId) { return state.spells.filter(spell => spell._pack === packId); }",
    "export async function classSpellFilter(className, version, packId) {",
    "  return spell => state.allowed.has(packId + '|' + spell.id + '|' + className);",
    "}",
    "",
  ].join("\n"), "utf8");

  const dump = makeDump();
  dump.packs.push({
    name: "feats",
    label: "自建专长",
    type: "Item",
    system: "dnd5e",
    entries: [{
      _id: "eeeeeeeeeeeeeeee",
      name: "Ash Gift",
      type: "feat",
      system: { type: { value: "feat" }, identifier: "ash-gift" },
    }],
  });
  const featRoot = "Item.eeeeeeeeeeeeeeee";
  const plan = { ...makePlan(), spellLists: { mage: ["bbbbbbbbbbbbbbbb"] } };
  const { roots, index } = rootExpectations({ dump, moduleId: MODULE_ID, sourceUuids: [ROOT_CLASS, ROOT_SPELL, featRoot], plan });
  const packIds = ["user-alice-homebrew.classes", "user-alice-homebrew.spells", "user-alice-homebrew.feats"];
  const expectations = buildVerificationExpectations({ index, moduleId: MODULE_ID, plan, roots, packIds });
  const code = verificationScript(expectations);
  assert.match(code, /^return \(async \(\) => \{/, "pageEval code must be an async function body with a top-level return");
  assert.doesNotMatch(code, /^\(async/, "a bare IIFE would make pageEval return undefined");

  const saved = {
    location: Object.hasOwn(globalThis, "location") ? globalThis.location : undefined,
    hadLocation: Object.hasOwn(globalThis, "location"),
    game: globalThis.game,
    fromUuid: globalThis.fromUuid,
    register: globalThis.__MT_REGISTER_USER_PACKS__,
    bridge: globalThis.__MT_BRIDGE__,
    studio: globalThis.__TEST_STUDIO__,
  };
  t.after(() => {
    if (saved.hadLocation) globalThis.location = saved.location;
    else delete globalThis.location;
    globalThis.game = saved.game;
    globalThis.fromUuid = saved.fromUuid;
    globalThis.__MT_REGISTER_USER_PACKS__ = saved.register;
    globalThis.__MT_BRIDGE__ = saved.bridge;
    globalThis.__TEST_STUDIO__ = saved.studio;
  });

  let registered = 0;
  const docs = new Map([
    [CLASS_UUID, { type: "class", system: { identifier: "mage" } }],
    [SPELL_UUID, { type: "spell", system: { level: 1, identifier: "ember" } }],
    ["Compendium.user-alice-homebrew.feats.Item.eeeeeeeeeeeeeeee", { type: "feat", system: { type: { value: "feat" }, identifier: "ash-gift" } }],
  ]);
  globalThis.location = { href: pathToFileURL(path.join(directory, "play.html")).href };
  globalThis.game = { packs: { get: packId => packIds.includes(packId) ? { getIndex: async () => ({ size: 1 }) } : null } };
  globalThis.fromUuid = async uuid => docs.get(uuid) ?? null;
  globalThis.__MT_REGISTER_USER_PACKS__ = async () => { registered += 1; };
  globalThis.__MT_BRIDGE__ = {
    auth: { campaign: { id: "campaign-1" }, authedFetch: async () => ({ ok: true, json: async () => [] }) },
  };
  globalThis.__TEST_STUDIO__ = {
    choices: {
      "2014": {
        classes: [{ _id: "aaaaaaaaaaaaaaaa", _pack: "user-alice-homebrew.classes" }],
        subclasses: [],
        races: [],
        backgrounds: [],
      },
    },
    feats: [{ id: "eeeeeeeeeeeeeeee", _pack: "user-alice-homebrew.feats" }],
    spells: [{ id: "bbbbbbbbbbbbbbbb", _pack: "user-alice-homebrew.spells", level: 1 }],
    allowed: new Set(["user-alice-homebrew.spells|bbbbbbbbbbbbbbbb|mage"]),
  };

  const evaluatePageEval = new Function("return (async()=>{\n" + code + "\n})()");
  const value = await evaluatePageEval();
  assert.ok(value, "Map's wrapper must receive the IIFE value; a bare IIFE yields undefined");
  assert.equal(registered, 1);
  assert.equal(value.register.ok, true);
  assert.equal(value.identity.length, 1);
  assert.equal(value.identity[0].present, true);
  assert.equal(value.feats.length, 1);
  assert.equal(value.feats[0].present, true);
  assert.equal(value.spells.length, 1);
  assert.equal(value.spells[0].present, true);
  assert.deepEqual(value.spells[0].checks, [{ classIdentifier: "mage", allowed: true }]);
  assert.equal(value.readback.ok, true);
  assert.deepEqual(value.errors, []);
  assert.deepEqual(value.missing, []);

  const verification = normalizeVerification(value, expectations, { unresolvedRefs: [], worldRefs: [] });
  assert.equal(verification.packRegistry, "passed");
  assert.equal(verification.identityCandidates, "passed");
  assert.equal(verification.featCandidates, "passed");
  assert.equal(verification.spellLists, "passed");
  assert.equal(verification.readback, "passed");
  assert.equal(verification.dependencyResolution, "passed");
  assert.deepEqual(verification.unresolvedRefs, []);
});

test("replaying the same tool call returns the recorded result instead of re-importing", async t => {
  const h = harness(t);
  const first = await h.tool.execute("same-call", ARGS);
  const second = await h.tool.execute("same-call", ARGS);
  assert.deepEqual(second.details, first.details);
  assert.equal(h.importStartCalls(), 1);
  assert.equal(h.runtimeCalls.filter(call => call.action === "builderSourcePlan").length, 2);

  const conflict = await h.tool.execute("same-call", { ...ARGS, title: "Different" });
  assert.equal(conflict.details.code, "TOOL_CALL_CONFLICT");
  assert.equal(h.importStartCalls(), 1);
});