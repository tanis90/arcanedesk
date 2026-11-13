import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createPowerShellTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import {
  LOBBY_TOOL_NAMES,
  activeToolNamesForPoolInProfile,
  TOOL_NAMES_BY_PROFILE,
} from "../src/main/foundry-tool-policy.js";

const LOBBY = new Set(LOBBY_TOOL_NAMES);

function fakeSession(pool) {
  return {
    active: [],
    calls: [],
    getActiveToolNames() { return [...this.active]; },
    setActiveToolsByName(names) { this.calls.push([...names]); this.active = [...names]; },
    getAllTools() { return pool.map(tool => ({ name: tool.name })); },
  };
}

function harness(profileId = "foundry") {
  let panelProfile = profileId;
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-loadout-"));
  const host = new AgentHost({
    profile: { mode: "prep", getCwd: () => cwd },
    getPanelProfileId: () => panelProfile,
    lobbyClient: { dispose() {} },
    sendToRenderer: () => {},
    log: () => {},
  });
  const pool = host.buildTools();
  for (const tool of [
    createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    process.platform === "win32" ? createPowerShellTool(cwd) : createBashTool(cwd),
  ]) pool.push(tool);
  const session = fakeSession(pool);
  const foundryNames = activeToolNamesForPoolInProfile("prep", pool, "foundry");
  session.active = [...foundryNames];
  host.session = session;
  host._toolPool = pool;
  host._activeToolNames = [...foundryNames];
  host._activeToolProfileId = "foundry";
  return {
    host,
    session,
    pool,
    cwd,
    setPanelProfile(next) { panelProfile = next; },
    cleanup() { rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("the static pool always registers lobby tools but the foundry loadout never declares them", () => {
  const h = harness();
  assert.equal(h.pool.some(tool => LOBBY.has(tool.name)), true);
  assert.equal(h.host.getActiveToolNames().some(name => LOBBY.has(name)), false);
  for (const name of LOBBY) assert.equal(h.host.getActiveToolNames().includes(name), false, name);
  h.cleanup();
});

test("foundry_open loads the mtcompat lobby tools for the next request and reports activatedTools", async () => {
  const h = harness();
  const beforeCalls = h.session.calls.length;
  h.host.openFoundry = async () => ({ ok: true, profile: "mtcompat", summary: "panel at lobby" });
  h.setPanelProfile("mtcompat");
  const result = await h.host.buildTools().find(tool => tool.name === "foundry_open").execute("open-1", {});
  assert.equal(result.details.profile, "mtcompat");
  assert.deepEqual(new Set(result.details.activatedTools), new Set([...LOBBY, "foundry_page_eval"]));
  assert.equal(h.session.calls.length, beforeCalls + 1);
  for (const name of LOBBY) assert.equal(h.session.active.includes(name), true, name);
  assert.match(result.content[0].text, /Activated for the next model request \(10\)/);
});

test("opening plain Foundry first activates no lobby tools", async () => {
  const h = harness("foundry");
  const before = h.session.active.length;
  h.host.openFoundry = async () => ({ ok: true, profile: "foundry", summary: "panel at foundry" });
  const result = await h.host.buildTools().find(tool => tool.name === "foundry_open").execute("open-foundry-first", {});
  assert.deepEqual(result.details.activatedTools, []);
  assert.equal(h.session.active.length, before);
  assert.equal(h.session.active.some(name => LOBBY.has(name)), false);
  h.cleanup();
});

test("lobby and play stay in the same loadout: reopening does not reload tools", async () => {
  const h = harness("mtcompat");
  h.session.active = [...activeToolNamesForPoolInProfile("prep", h.pool, "mtcompat")];
  h.host._activeToolNames = [...h.session.active];
  h.host._activeToolProfileId = "mtcompat";
  const calls = h.session.calls.length;
  h.host.openFoundry = async () => ({ ok: true, profile: "mtcompat", summary: "panel at play" });
  const result = await h.host.buildTools().find(tool => tool.name === "foundry_open").execute("open-play", {});
  assert.deepEqual(result.details.activatedTools, []);
  assert.equal(h.session.calls.length, calls, "same profile + same set must not call setActiveToolsByName");
  h.cleanup();
});

test("mtcompat -> foundry removes the lobby tools; closing the panel also falls back to foundry", async () => {
  const h = harness("mtcompat");
  h.session.active = [...activeToolNamesForPoolInProfile("prep", h.pool, "mtcompat")];
  h.host._activeToolNames = [...h.session.active];
  h.host._activeToolProfileId = "mtcompat";
  h.host.openFoundry = async () => ({ ok: true, profile: "foundry", summary: "panel at foundry" });
  h.setPanelProfile("foundry");
  const result = await h.host.buildTools().find(tool => tool.name === "foundry_open").execute("open-foundry", {});
  assert.deepEqual(new Set(result.details.activatedTools), new Set());
  for (const name of LOBBY) assert.equal(h.session.active.includes(name), false, name);

  h.setPanelProfile("mtcompat");
  await h.host.refreshToolLoadout("mtcompat");
  assert.equal(h.session.active.some(name => LOBBY.has(name)), true);
  h.setPanelProfile(null);
  const closed = await h.host.refreshToolLoadout(null);
  assert.equal(closed.profileId, "foundry");
  for (const name of LOBBY) assert.equal(h.session.active.includes(name), false, name);
  h.cleanup();
});

test("restoring a session computes the loadout from the current real profile, not history", () => {
  const h = harness("mtcompat");
  const restored = activeToolNamesForPoolInProfile("prep", h.pool, "mtcompat");
  assert.equal(restored.some(name => LOBBY.has(name)), true);
  const foundry = harness("foundry");
  assert.equal(foundry.host.toolLoadout().some(name => LOBBY.has(name)), false);
  foundry.cleanup();
  h.cleanup();
});

test("combat and plain Foundry policy tables never contain lobby tools", () => {
  assert.equal(LOBBY_TOOL_NAMES.length, 9);
  assert.equal(TOOL_NAMES_BY_PROFILE.foundry.combat.includes("foundry_lobby_import_start"), false);
  assert.equal(TOOL_NAMES_BY_PROFILE.mtcompat.combat.includes("foundry_lobby_import_start"), false);
  assert.equal(TOOL_NAMES_BY_PROFILE.foundry.prep.some(name => LOBBY.has(name)), false);
  for (const name of LOBBY) assert.equal(TOOL_NAMES_BY_PROFILE.mtcompat.prep.includes(name), true, name);
});

test("a real attached session recomputes the mtcompat preamble on refresh and removes it on foundry", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-prompt-"));
  const surface = path.join(cwd, "mtcompat-surface.json");
  const SENTINEL = "MTCOMPAT_SURFACE_SENTINEL_FOR_DYNAMIC_REFRESH";
  writeFileSync(surface, JSON.stringify({ revision: 1, segment: SENTINEL }));
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("test", {
    api: "openai-completions", apiKey: "fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
  });
  let profile = "foundry";
  const host = new AgentHost({
    profile: { mode: "prep", getCwd: () => cwd, builtinTools: true, systemPrompt: "append", fence: true },
    getPanelProfileId: () => profile,
    mtcompatSurfaceFile: surface,
    lobbyClient: { dispose() {} },
    sendToRenderer: () => {},
    log: () => {},
  });
  host.modelRuntime = runtime;
  host.fvttOpsNode = process.execPath;
  try {
    await host.attach(SessionManager.inMemory(cwd));
    assert.equal(host.session.systemPrompt.includes(SENTINEL), false, "foundry attach must not bake the mtcompat segment");

    profile = "mtcompat";
    const calls = [];
    const original = host.session.setActiveToolsByName.bind(host.session);
    host.session.setActiveToolsByName = (names) => { calls.push(names); return original(names); };
    await host.refreshToolLoadout("mtcompat");
    assert.equal(host.session.systemPrompt.includes(SENTINEL), true, "refresh must recompute the loader override");
    assert.equal(host.session.systemPrompt.split(SENTINEL).length - 1, 1, "the segment must not accumulate");
    assert.equal(host.session.getActiveToolNames().some(name => LOBBY.has(name)), true);

    const afterFirst = calls.length;
    await host.refreshToolLoadout("mtcompat");
    assert.equal(calls.length, afterFirst, "the same profile must not reload/redeclare");

    profile = "foundry";
    await host.refreshToolLoadout("foundry");
    assert.equal(host.session.systemPrompt.includes(SENTINEL), false, "switching back must remove the mtcompat segment");
    assert.equal(host.session.getActiveToolNames().some(name => LOBBY.has(name)), false);
  } finally {
    host.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- 真实 Pi session：下一次模型请求的 tools 声明真的带上新工具 ----

function sseServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push({ parseError: body.slice(0, 200) }); }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta, finish = null) => JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.write(`data: ${chunk({ role: "assistant", content: "ok" })}\n\n`);
      response.write(`data: ${chunk({}, "stop")}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

test("a real Pi session declares lobby tools only on the request after foundry_open activation", async (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-realpi-"));
  const { server, requests, port } = await sseServer();
  t.after(() => { server.close(); rmSync(cwd, { recursive: true, force: true }); });

  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("test", {
    api: "openai-completions",
    apiKey: "fixture",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{
      id: "model", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000, maxTokens: 1000,
    }],
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();

  const host = new AgentHost({
    profile: { mode: "prep", getCwd: () => cwd },
    getPanelProfileId: () => "foundry",
    lobbyClient: { dispose() {} },
    sendToRenderer: () => {},
    log: () => {},
  });
  const pool = host.buildTools();
  for (const tool of [
    createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd),
    process.platform === "win32" ? createPowerShellTool(cwd) : createBashTool(cwd),
  ]) pool.push(tool);
  const foundryNames = activeToolNamesForPoolInProfile("prep", pool, "foundry");
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), modelRuntime,
    model: modelRuntime.getModel("test", "model"), customTools: pool,
  });
  session.setActiveToolsByName(foundryNames);
  t.after(() => session.dispose());
  host.session = session;
  host._toolPool = pool;
  host._activeToolNames = session.getActiveToolNames();
  host._activeToolProfileId = "foundry";

  await session.prompt("before");
  const firstTools = (requests.at(-1)?.tools ?? []).map(tool => tool.function?.name ?? tool.name);
  assert.equal(firstTools.some(name => LOBBY.has(name)), false, "no lobby tools in the first request");

  host.getPanelProfileId = () => "mtcompat";
  const refreshed = await host.refreshToolLoadout("mtcompat");
  assert.equal(refreshed.changed, true);
  assert.deepEqual(new Set(refreshed.activatedTools), new Set([...LOBBY, "foundry_page_eval"]));
  assert.equal(session.getActiveToolNames().some(name => LOBBY.has(name)), true);

  await session.prompt("after");
  const secondTools = (requests.at(-1)?.tools ?? []).map(tool => tool.function?.name ?? tool.name);
  for (const name of LOBBY) assert.equal(secondTools.includes(name), true, `${name} must be declared in the next request`);
});
