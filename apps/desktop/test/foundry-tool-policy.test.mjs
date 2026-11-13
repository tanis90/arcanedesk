import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  createReadTool, createWriteTool, createEditTool, createBashTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { TOOL_NAMES_BY_PROFILE, MTCOMPAT_RUNTIME_ACTIONS, LOBBY_TOOL_NAMES, activeToolNames, activeToolNamesForPool, activeToolNamesForPoolInProfile, activeToolNamesForProfile, normalizePolicyProfile, verifyActiveTools, DESKTOP_FOUNDRY_ACTIONS } from "../src/main/foundry-tool-policy.js";
import { PAGE_PROFILES } from "../src/main/page-profiles.js";
import { SearchStore } from "../src/main/search/store.js";
import { testSecretStorage } from "./test-secret-storage.mjs";
import { SAFE_DIRECT_ACTIONS } from "@arcanedesk/foundry-sdk/contracts";
import { sideEffectClass } from "../src/main/telemetry/task-taxonomy.js";

for (const mode of ["combat", "prep"]) test(`real Pi ${mode} session activates exactly its explicit tool set`, async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-tool-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory();
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("test", { api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const host = new AgentHost({ profile: { mode }, log() {} });
  const customTools = host.buildTools();
  for (const tool of customTools) assert.equal(tool.parameters.type, "object", `${tool.name}: provider requires an object root even for unions`);
  if (mode === "prep") customTools.push(createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    process.platform === "win32" ? createPowerShellTool(cwd) : createBashTool(cwd));
  // 池感知激活表:无搜索配置时 web_search 不激活(与 agent-host 会话创建同判定)。
  const expected = activeToolNamesForPool(mode, customTools);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, model: runtime.getModel("test", "model"),
    customTools, tools: expected });
  t.after(() => session.dispose());
  verifyActiveTools(session, expected);
  assert.deepEqual(new Set(session.getActiveToolNames()), new Set(expected));
  if (mode === "combat") {
    assert.equal(expected.length, 6);
    assert.equal(session.getActiveToolNames().includes("foundry_execute_action"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_conditions_set"), true);
    assert.equal(session.getActiveToolNames().includes("browser_evaluate"), false);
    assert.equal(session.getActiveToolNames().includes("request_user_input"), false);
    assert.equal(session.getActiveToolNames().includes("read"), false);
  } else {
    assert.equal(expected.length, 27);
    assert.equal(session.getActiveToolNames().includes("foundry_actor_advance"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_module_prepare"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_compendium_browse"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_advancement_plan"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_scene_get"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_scene_apply"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_execute_action"), false);
    assert.equal(session.getActiveToolNames().includes("foundry_conditions_set"), true);
    for (const builtin of ["read", process.platform === "win32" ? "powershell" : "bash", "edit", "write", "grep", "find", "ls"]) {
      assert.equal(session.getActiveToolNames().includes(builtin), true, `${builtin} should be active in prep`);
    }
  }
});

test("activation check rejects extra/missing names; Desktop explicitly opts in without widening SDK defaults", () => {
  assert.throws(() => verifyActiveTools({ getActiveToolNames: () => ["read"] }, activeToolNames("combat")), /activation mismatch/);
  assert.throws(() => activeToolNames("unknown"), /Unknown tool mode/);
  assert.deepEqual(SAFE_DIRECT_ACTIONS, ["worldInfo", "battleContext", "turnContext", "executeTurn"]);
  assert.ok(DESKTOP_FOUNDRY_ACTIONS.includes("conditionsSet"));
  assert.equal(DESKTOP_FOUNDRY_ACTIONS.includes("actorImport"), false);
  assert.equal(sideEffectClass("foundry_conditions_set"), "world_write");
  assert.equal(sideEffectClass("foundry_execute_action"), "world_write");
});

test("real Pi prep session activates web_search and web_fetch when search is configured", async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-tool-policy-search-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory();
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("test", { api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const searchStore = new SearchStore(path.join(cwd, "search.json"), () => {}, testSecretStorage());
  searchStore.update({ mode: "spark" }, { apiKey: "sk-spark", baseUrl: "https://llm.example/v1" });
  const host = new AgentHost({ profile: { mode: "prep", getCwd: () => cwd }, log() {},
    search: { store: searchStore, spark: () => ({ apiKey: "sk-spark", baseUrl: "https://llm.example/v1" }) } });
  const customTools = host.buildTools();
  assert.equal(customTools.some((tool) => tool?.name === "web_search"), true);
  assert.equal(customTools.some((tool) => tool?.name === "web_fetch"), true);
  customTools.push(createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    process.platform === "win32" ? createPowerShellTool(cwd) : createBashTool(cwd));
  const expected = activeToolNamesForPool("prep", customTools);
  assert.equal(expected.length, 29); // 27 基线 + web_search + web_fetch
  const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, model: runtime.getModel("test", "model"),
    customTools, tools: expected });
  t.after(() => session.dispose());
  verifyActiveTools(session, expected);
  assert.equal(session.getActiveToolNames().includes("web_search"), true);
  assert.equal(session.getActiveToolNames().includes("web_fetch"), true);
});

test("real Pi mtcompat prep session activates foundry_page_eval（foundry 档不可见）", async t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-tool-policy-page-eval-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory();
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("test", { api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const host = new AgentHost({ profile: { mode: "prep", getCwd: () => cwd }, log() {}, getPanelProfileId: () => "mtcompat" });
  const customTools = host.buildTools();
  customTools.push(createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    process.platform === "win32" ? createPowerShellTool(cwd) : createBashTool(cwd));
  const expected = activeToolNamesForPoolInProfile("prep", customTools, "mtcompat");
  assert.equal(expected.length, 37, "mtcompat 备团 39 静态成员 - 未配置的 web_search/web_fetch");
  assert.equal(activeToolNamesForPoolInProfile("prep", customTools, "foundry").includes("foundry_page_eval"), false);
  const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, model: runtime.getModel("test", "model"),
    customTools, tools: expected });
  t.after(() => session.dispose());
  verifyActiveTools(session, expected);
  assert.equal(session.getActiveToolNames().includes("foundry_page_eval"), true);
  assert.equal(session.getActiveToolNames().includes("browser_evaluate"), true, "A3 不动 A2 的 eval 面");
  for (const name of ["foundry_lobby_rulesets_list", "foundry_lobby_import_start", "foundry_lobby_import_job", "foundry_lobby_campaigns_list",
    "foundry_lobby_campaign_packs_get", "foundry_lobby_campaign_packs_update", "foundry_lobby_packs_read", "foundry_lobby_packs_delete",
    "foundry_lobby_return"]) {
    assert.equal(session.getActiveToolNames().includes(name), true, name);
  }
});

// ---- A2/A3：写策略的档位维度（mtcompat 档策略面独立，A3 在其上放 pageEval）----

test("档位维度：mtcompat 档自带策略面，foundry 档名单逐字节不变", () => {
  // 档位词汇表与页面档位同一份事实源：两边键集必须一致（新增档位不许漏配策略表）。
  assert.deepEqual(Object.keys(TOOL_NAMES_BY_PROFILE).sort(), Object.keys(PAGE_PROFILES).sort());
  // 战斗模式仍同集：两档都不给 eval（任意代码执行在战斗中的爆炸半径不可控）。
  const combatFoundry = activeToolNamesForProfile("combat", "foundry");
  const combatMtcompat = activeToolNamesForProfile("combat", "mtcompat");
  assert.deepEqual(combatMtcompat, combatFoundry);
  assert.deepEqual(combatMtcompat, activeToolNames("combat"));
  assert.equal(combatMtcompat.includes("foundry_page_eval"), false);
  // mtcompat 备团 = foundry 备团 + foundry_page_eval + 9 个 lobby tools。
  const prepFoundry = activeToolNamesForProfile("prep", "foundry");
  const prepMtcompat = activeToolNamesForProfile("prep", "mtcompat");
  assert.deepEqual([...prepMtcompat].sort(), [...prepFoundry, "foundry_page_eval", ...LOBBY_TOOL_NAMES].sort());
  assert.equal(prepMtcompat.includes("foundry_page_eval"), true);
  assert.equal(prepFoundry.includes("foundry_page_eval"), false);
  for (const name of LOBBY_TOOL_NAMES) assert.equal(prepFoundry.includes(name), false, name);
  // 旧调用方语义：无档位 = 开放默认档；模式校验照旧。
  assert.equal(activeToolNames("combat").length, 6);
  assert.equal(activeToolNames("prep").length, 29, "静态 allowlist 29 = 27 有效 + web_search/web_fetch 静态成员");
  assert.equal(prepMtcompat.length, 39, "mtcompat 备团 39 = foundry 备团 29 + foundry_page_eval + 9 lobby tools");
  assert.throws(() => activeToolNamesForProfile("unknown-mode", "mtcompat"), /Unknown tool mode/);
});

test("A3 runtime 白名单：pageEval 与 navigateToLobby 只随 mtcompat client 装配，foundry 档白名单逐字不变", () => {
  assert.deepEqual([...MTCOMPAT_RUNTIME_ACTIONS], [...DESKTOP_FOUNDRY_ACTIONS, "pageEval", "navigateToLobby"]);
  assert.equal(DESKTOP_FOUNDRY_ACTIONS.includes("pageEval"), false);
  assert.equal(DESKTOP_FOUNDRY_ACTIONS.includes("navigateToLobby"), false);
  // 既有消费方断言（SDK 出厂默认档不受影响）照旧成立。
  assert.ok(DESKTOP_FOUNDRY_ACTIONS.includes("conditionsSet"));
  assert.equal(DESKTOP_FOUNDRY_ACTIONS.includes("actorImport"), false);
});

test("档位归一：词汇表外的 id（含笔误/undefined/null）一律落开放默认档", () => {
  assert.equal(normalizePolicyProfile("mtcompat"), "mtcompat");
  assert.equal(normalizePolicyProfile("foundry"), "foundry");
  assert.equal(normalizePolicyProfile("mtcompat-dev"), "foundry");
  assert.equal(normalizePolicyProfile(undefined), "foundry");
  assert.equal(normalizePolicyProfile(null), "foundry");
  assert.equal(normalizePolicyProfile(42), "foundry");
});

test("档位维度的池感知激活：web_search/web_fetch 只在池里真的构造出它们时才激活", () => {
  const searchOnly = [{ name: "foundry_open" }, { name: "web_search" }];
  const searchAndFetch = [...searchOnly, { name: "web_fetch" }];
  assert.deepEqual(activeToolNamesForPoolInProfile("prep", searchOnly, "mtcompat"),
    activeToolNamesForProfile("prep", "mtcompat").filter((name) => name !== "web_fetch"));
  assert.deepEqual(activeToolNamesForPoolInProfile("prep", searchAndFetch, "mtcompat"), activeToolNamesForProfile("prep", "mtcompat"));
  for (const profile of ["mtcompat", "foundry"]) {
    assert.equal(activeToolNamesForPoolInProfile("prep", [], profile).includes("web_search"), false);
    assert.equal(activeToolNamesForPoolInProfile("prep", [], profile).includes("web_fetch"), false);
  }
  assert.equal(activeToolNamesForPool("prep", searchOnly).includes("web_search"), true);
  assert.equal(activeToolNamesForPool("prep", searchOnly).includes("web_fetch"), false);
  assert.equal(activeToolNamesForPool("prep", searchAndFetch).includes("web_fetch"), true);
});
