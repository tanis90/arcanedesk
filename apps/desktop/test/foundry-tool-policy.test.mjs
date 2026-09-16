import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  createReadTool, createWriteTool, createEditTool, createBashTool, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { activeToolNames, verifyActiveTools, DESKTOP_FOUNDRY_ACTIONS } from "../src/main/foundry-tool-policy.js";
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
  const expected = activeToolNames(mode);
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
    assert.equal(expected.length, 23);
    assert.equal(session.getActiveToolNames().includes("foundry_actor_advance"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_compendium_browse"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_advancement_plan"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_scene_get"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_scene_apply"), true);
    assert.equal(session.getActiveToolNames().includes("foundry_execute_action"), false);
    assert.equal(session.getActiveToolNames().includes("foundry_conditions_set"), true);
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
