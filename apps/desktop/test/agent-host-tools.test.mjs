import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { activeToolNames } from "../src/main/foundry-tool-policy.js";
const scratch = mkdtempSync(path.join(os.tmpdir(), "arcane-host-tools-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
import test from "node:test";

import {
  AgentHost,
  arcaneShellTool,
  builtinToolNamesForPlatform,
  initialModelRefForAttach,
  pinArcaneNodeForShellSpawn,
} from "../src/main/agent-host.js";

function buildHarness({ call, sendToRenderer = () => {} } = {}) {
  const foundryRuntime = {
    lastWorldInfo: null,
    call: call ?? (async () => ({})),
  };
  const host = new AgentHost({
    foundryRuntime,
    operationStorageDir: mkdtempSync(path.join(scratch, "session-")),
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer,
    log: () => {},
  });
  host.describeCurrent = () => ({ id: "test" });
  host.taskCoordinator = () => ({ currentInputBinding: () => ({ taskId: "task", metadata: Promise.resolve({ world: { origin: "https://test", id: "w" }, selectedTokenUuids: [] }) }) });
  return {
    host,
    foundryRuntime,
    tools: new Map(host.buildTools().map((tool) => [tool.name, tool])),
  };
}

test("model access follows the session's actual current model instead of the stored fallback", () => {
  const checked = [];
  const host = new AgentHost({
    providerStore: {
      effectiveModel: () => ({ providerId: "arcane-spark", modelId: "arcane-spark" }),
      missingApiKeyForModel(model) {
        checked.push(model);
        return model?.providerId === "arcane-spark"
          ? { providerId: "arcane-spark", providerName: "Arcane Spark", arcaneSpark: true }
          : null;
      },
    },
    sendToRenderer: () => {},
    log: () => {},
  });

  host.session = { model: { provider: "kimi", id: "kimi-for-coding" } };
  assert.deepEqual(host.currentModelRef(), { providerId: "kimi", modelId: "kimi-for-coding" });
  assert.equal(host.missingApiKeyForCurrentModel(), null);
  assert.deepEqual(checked.at(-1), { providerId: "kimi", modelId: "kimi-for-coding" });

  host.session = null;
  assert.deepEqual(host.currentModelRef(), { providerId: "arcane-spark", modelId: "arcane-spark" });
  assert.equal(host.missingApiKeyForCurrentModel().arcaneSpark, true);
});

test("an unconfigured model can be selected before its key activates the Agent session", async () => {
  let missing = true;
  let activated = null;
  const host = new AgentHost({
    providerStore: {
      effectiveModel: () => ({ providerId: "arcane-spark", modelId: "arcane-spark" }),
      missingApiKeyForModel: (model) => missing
        ? { providerId: model.providerId, providerName: model.providerId, arcaneSpark: false }
        : null,
    },
    sendToRenderer: () => {},
    log: () => {},
  });
  const model = { provider: "custom", id: "custom-model", input: ["text"] };
  host.modelRuntime = { getModel: () => model };
  host.session = { model: { provider: "old", id: "old-model" }, setModel: async (next) => { activated = next; } };

  assert.deepEqual(await host.setCurrentModel("custom", "custom-model"), { ok: true, pendingKey: true });
  assert.deepEqual(host.currentModelRef(), { providerId: "custom", modelId: "custom-model" });
  assert.equal(activated, null);

  missing = false;
  assert.deepEqual(await host.setCurrentModel("custom", "custom-model"), { ok: true });
  assert.equal(activated, model);
});

test("attach keeps a session's own model by refusing the global default", () => {
  const providerStore = { effectiveModel: () => ({ providerId: "arcane-spark", modelId: "arcane-spark" }) };
  // 已有会话:JSONL 里可恢复出模型,不能再让全局默认进 options.model
  assert.equal(
    initialModelRefForAttach({ provider: "kimi", modelId: "kimi-for-coding" }, providerStore),
    null,
  );
  // 新会话/纯用户消息会话:没有可恢复模型,用全局默认兜底
  assert.deepEqual(
    initialModelRefForAttach(null, providerStore),
    { providerId: "arcane-spark", modelId: "arcane-spark" },
  );
  assert.equal(initialModelRefForAttach(null, null), null);
});

test("model changes during a task are deferred until the next task begins", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const models = [];
  const host = new AgentHost({ sendToRenderer() {}, log() {} });
  host.sessionManager = { getSessionId: () => "model-test", getSessionName: () => "test" };
  host.modelRuntime = { getModel: (provider, id) => ({ provider, id, input: ["text"] }) };
  host.session = { model: { provider: "p", id: "old" }, prompt: () => gate,
    setModel: async model => { models.push(model.id); host.session.model = model; }, clearQueue() {} };
  host.submitInput("first", [], "first");
  const result = await host.setCurrentModel("p", "new");
  assert.equal(result.deferred, true);
  assert.deepEqual(models, []);
  release(); await host.tasks.run;
  assert.deepEqual(models, []);
  host.submitInput("next", [], "next");
  await host.tasks.run;
  assert.deepEqual(models, ["new"]);
  assert.equal(host.tasks.pendingModel, null);
});

test("sessionHasMessages reports whether the attached session already started", () => {
  const host = new AgentHost({ sendToRenderer: () => {}, log: () => {} });
  assert.equal(host.sessionHasMessages(), false); // 未挂载 sessionManager
  host.sessionManager = { getEntries: () => [{ type: "custom", customType: "arcane.session" }] };
  assert.equal(host.sessionHasMessages(), false); // 只有模式标记,还没对话
  host.sessionManager = { getEntries: () => [{ type: "message" }, { type: "custom" }] };
  assert.equal(host.sessionHasMessages(), true);
});

test("setCurrentModel skips a redundant model_change when the session already holds the model", async () => {
  const emitted = [];
  const setCalls = [];
  const host = new AgentHost({
    providerStore: { missingApiKeyForModel: () => null },
    sendToRenderer: (payload) => emitted.push(payload),
    log: () => {},
  });
  const model = { provider: "kimi", id: "k2", input: ["text", "image"] };
  host.modelRuntime = { getModel: () => model };
  host.session = { model: { provider: "kimi", id: "k2" }, setModel: async (next) => setCalls.push(next) };

  assert.deepEqual(await host.setCurrentModel("kimi", "k2"), { ok: true, noop: true });
  assert.deepEqual(setCalls, []); // 同模型不重复写 model_change
  assert.equal(host.modelLabel, "kimi/k2");
  assert.equal(emitted.at(-1).type, "model_info");
  assert.equal(emitted.at(-1).supportsImages, true);

  assert.deepEqual(await host.setCurrentModel("kimi", "k3"), { ok: true });
  assert.equal(setCalls.length, 1); // 换模型仍然落到 session.setModel
});

test("prep sessions select the native shell tool for each desktop platform", () => {
  assert.deepEqual(builtinToolNamesForPlatform("win32"), ["read", "powershell", "edit", "write"]);
  assert.deepEqual(builtinToolNamesForPlatform("darwin"), ["read", "bash", "edit", "write"]);
  assert.deepEqual(builtinToolNamesForPlatform("linux"), ["read", "bash", "edit", "write"]);
});

test("Agent shell spawn pins Arcane Node ahead of Pi and system tool directories", () => {
  const context = {
    command: "node --version",
    cwd: "C:\\Prep",
    env: {
      Path: "C:\\Users\\dm\\.pi\\agent\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32",
    },
  };
  const nodeBinary = "C:\\Users\\dm\\AppData\\Local\\ArcaneDesk\\runtime\\node\\22.23.2\\win-x64\\node.exe";

  assert.equal(pinArcaneNodeForShellSpawn(context, nodeBinary, "win32"), context);
  assert.equal(context.env.ARCANE_FVTT_NODE, nodeBinary);
  assert.equal(
    context.env.Path,
    "C:\\Users\\dm\\AppData\\Local\\ArcaneDesk\\runtime\\node\\22.23.2\\win-x64;" +
      "C:\\Users\\dm\\.pi\\agent\\bin;C:\\Program Files\\nodejs;C:\\Windows\\System32",
  );
});

test("the Pi shell override receives the pinned Node environment at execution", async () => {
  const nodeBinary = "C:\\Users\\dm\\AppData\\Local\\ArcaneDesk\\runtime\\node\\22.23.2\\win-x64\\node.exe";
  let captured = null;
  const tool = arcaneShellTool("C:\\Prep", nodeBinary, "win32", {
    async exec(command, cwd, options) {
      captured = { command, cwd, env: options.env };
      return { exitCode: 0 };
    },
  });

  await tool.execute("shell-call", { command: "node --version" });
  assert.equal(captured.cwd, "C:\\Prep");
  assert.equal(captured.env.ARCANE_FVTT_NODE, nodeBinary);
  const pathKey = Object.keys(captured.env).find((key) => key.toLowerCase() === "path");
  assert.equal(captured.env[pathKey].split(";")[0], "C:\\Users\\dm\\AppData\\Local\\ArcaneDesk\\runtime\\node\\22.23.2\\win-x64");
});

test("Agent startup fails before Pi initialization when packaged Node bootstrap fails", async () => {
  const runtimeReady = Promise.reject(new Error("bundled Node checksum mismatch"));
  runtimeReady.catch(() => {});
  const host = new AgentHost({
    runtimeReady,
    sendToRenderer: () => {},
    log: () => {},
  });

  await assert.rejects(host.start(), /bundled Node checksum mismatch/);
  assert.equal(host.modelRuntime, null);
  assert.equal(host.session, null);
});

test("play activates six Foundry tools plus user input; definitions do not expose legacy aliases", () => {
  const { tools } = buildHarness();
  const attackRollModeDescription =
    "Optional only when the selected battle-context action advertises input.attackRollMode. " +
    "Set it only from an explicit DM instruction: advantage/disadvantage set the corresponding Midi request flags; " +
    "normal leaves the roll unforced and does not cancel effects Foundry applies automatically. " +
    "Otherwise omit it; never infer it from conditions, positioning, or tactics.";
  const executeTurnInputSchema = {
    type: "object",
    properties: {
      selections: { type: "object", properties: {}, additionalProperties: true },
      declaredRiders: {
        type: "array",
        items: { type: "object", properties: {}, additionalProperties: true },
        description: 'Rider entries, e.g. [{ id: "branding-smite", spellLevel: 2 }]',
      },
      allocation: {
        type: "array",
        items: { type: "object", properties: {}, additionalProperties: true },
        description: "Non-empty array of allocation entries",
      },
      spellLevel: { type: "number" },
      attackRollMode: {
        type: "string",
        enum: ["normal", "advantage", "disadvantage"],
        description: attackRollModeDescription,
      },
      targetSpec: { type: "object", properties: {}, additionalProperties: true },
    },
    additionalProperties: true,
  };

  assert.deepEqual(activeToolNames("combat"), ["foundry_open", "world_status", "browser_evaluate",
    "combat_battle_context", "combat_turn_context", "combat_execute_turn", "request_user_input", "open_document"]);
  for (const name of activeToolNames("combat")) assert.ok(tools.has(name), name);
  // Pool is the superset for both modes; prep-only tools stay defined but inactive in combat.
  for (const name of ["foundry_screenshot", "foundry_actor_advance", "foundry_compendium_browse", "foundry_play_context"]) {
    assert.ok(tools.has(name), name);
  }
  assert.deepEqual(tools.get("combat_battle_context").parameters, { type: "object", properties: {} });
  assert.deepEqual(tools.get("combat_turn_context").parameters, { type: "object", properties: {} });
  assert.deepEqual(tools.get("combat_execute_turn").parameters, {
    type: "object",
    properties: {
      actionId: { type: "string", description: "Single action id from battle-context" },
      actions: {
        type: "array",
        items: {
          type: "object",
          required: ["actionId"],
          properties: {
            actionId: { type: "string" },
            targetTokenIds: { type: "array", items: { type: "string" } },
            input: executeTurnInputSchema,
          },
        },
        description: "Multiple actions in one submission",
      },
      targetTokenIds: { type: "array", items: { type: "string" } },
      input: executeTurnInputSchema,
      advance: { type: "boolean", description: "Advance the combat turn after execution" },
    },
  });
});

test("prep mode exposes the Foundry panel, screenshot and page eval custom tools", () => {
  const host = new AgentHost({
    foundryRuntime: null,
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer: () => {},
    log: () => {},
    profile: {
      mode: "prep",
      builtinTools: true,
      customToolNames: ["foundry_open", "foundry_screenshot", "browser_evaluate"],
    },
  });
  const tools = new Map(host.buildTools().map((tool) => [tool.name, tool]));

  assert.ok(tools.has("foundry_screenshot"));
  assert.ok(activeToolNames("prep").includes("foundry_conditions_set"));
  assert.equal(activeToolNames("prep").includes("foundry_execute_action"), false);
  assert.match(tools.get("foundry_screenshot").description, /current visible viewport/);
  assert.match(tools.get("foundry_screenshot").description, /never captures the desktop/);
  assert.match(tools.get("browser_evaluate").description, /MAY read or change the current world/);
  assert.match(tools.get("browser_evaluate").promptGuidelines.join("\n"), /game\.ready && game\.user\.isGM/);
  assert.doesNotMatch(tools.get("browser_evaluate").description, /structured combat tools/);
});

test("open_document opens a markdown note in the right-side reader panel", async () => {
  const opened = [];
  const host = new AgentHost({
    foundryRuntime: null,
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    openMdReader: (rawPath) => { opened.push(rawPath); return { ok: true, state: "reader", error: null }; },
    sendToRenderer: () => {},
    log: () => {},
  });
  const tool = host.buildTools().find((candidate) => candidate.name === "open_document");
  const result = await tool.execute("call-1", { path: "notes/a.md" });
  assert.deepEqual(opened, ["notes/a.md"]);
  assert.match(result.content[0].text, /right-side reader panel/);
  assert.doesNotMatch(result.content[0].text, /WARNING/);
});

test("open_document surfaces a reader error page as a warning", async () => {
  const host = new AgentHost({
    foundryRuntime: null,
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    openMdReader: () => ({ ok: true, state: "reader", error: "missing" }),
    sendToRenderer: () => {},
    log: () => {},
  });
  const tool = host.buildTools().find((candidate) => candidate.name === "open_document");
  const result = await tool.execute("call-1", { path: "notes/gone.md" });
  assert.match(result.content[0].text, /WARNING: the document could not be loaded \(missing\)/);
});

test("prep screenshot returns bounded image content from the current Foundry WebContents", async () => {
  const imageBytes = Buffer.from("bounded-jpeg");
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 800, height: 450 }),
    resize: () => {
      throw new Error("an 800px image should not be resized");
    },
    toJPEG: (quality) => {
      assert.equal(quality, 82);
      return imageBytes;
    },
  };
  let captures = 0;
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "http://127.0.0.1:30000/game",
    on: () => {},
    off: () => {},
    executeJavaScript: async () => ({
      detected: true,
      url: "http://127.0.0.1:30000/game",
      path: "/game",
      ready: true,
      gm: true,
    }),
    capturePage: async () => {
      captures += 1;
      return image;
    },
  };
  const host = new AgentHost({
    getFoundryView: () => ({ webContents }),
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer: () => {},
    log: () => {},
    profile: {
      mode: "prep",
      builtinTools: true,
      customToolNames: ["foundry_screenshot"],
    },
  });
  host.supportsImages = true;
  const tool = host.buildTools().find((candidate) => candidate.name === "foundry_screenshot");

  const result = await tool.execute("shot-1", {});

  assert.equal(captures, 1);
  assert.deepEqual(result.content.map((part) => part.type), ["text", "image"]);
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.equal(result.content[1].data, imageBytes.toString("base64"));
  assert.deepEqual(
    { url: result.details.url, path: result.details.path, width: result.details.width, height: result.details.height },
    { url: "http://127.0.0.1:30000/game", path: "/game", width: 800, height: 450 }
  );
});

test("prep screenshot refuses capture when the selected model has no vision input", async () => {
  let captures = 0;
  const host = new AgentHost({
    getFoundryView: () => ({
      webContents: {
        isDestroyed: () => false,
        capturePage: async () => {
          captures += 1;
        },
      },
    }),
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer: () => {},
    log: () => {},
    profile: {
      mode: "prep",
      builtinTools: true,
      customToolNames: ["foundry_screenshot"],
    },
  });
  host.supportsImages = false;
  const tool = host.buildTools().find((candidate) => candidate.name === "foundry_screenshot");

  const result = await tool.execute("shot-no-vision", {});

  assert.equal(captures, 0);
  assert.match(result.content[0].text, /does not support image input/);
});

test("tool images stay in the model transcript instead of crossing renderer IPC", () => {
  const events = [];
  const host = new AgentHost({
    sendToRenderer: (event) => events.push(event),
    log: () => {},
  });

  host.forwardEvent({
    type: "tool_execution_end",
    toolCallId: "shot-ipc",
    toolName: "foundry_screenshot",
    isError: false,
    result: {
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "large-base64-payload", mimeType: "image/jpeg" },
      ],
      details: { width: 800, height: 450 },
    },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0].result.content, [{ type: "text", text: "captured" }]);
  assert.deepEqual(events[0].result.details, { width: 800, height: 450 });
});

test("attack-roll guidance preserves explicit DM and per-action scope", () => {
  const { tools } = buildHarness();
  const tool = tools.get("foundry_execute_action");
  const prompt = readFileSync(new URL("../system-prompts/combat.md", import.meta.url), "utf8");
  assert.match(tool.promptGuidelines.join("\n"), /scope it per action/);
  assert.match(prompt, /input\.optional/);
  assert.match(prompt, /"normal"[^\n]*与省略等价/);
  assert.match(prompt, /actions\[i\]\.input\.attackRollMode/);
  assert.match(prompt, /作用域不清楚时先问 DM/);
});

test("structured tools resolve snapshot references and use the fixed runtime with bounded timeouts", async () => {
  const calls = [], events = [];
  const snapshot = { scope: { combatId: "c", world: { origin: "https://test", id: "w" } }, contextRef: "snapshot",
    combatants: [{ tokenUuid: "Scene.s.Token.t", actorUuid: "Actor.a", actions: [{ actionRef: "ref", id: "native-id", itemId: "item", activityId: "activity" }] }] };
  const live = { contextRef: "snapshot", turn: { tokenId: "t", actorId: "a", round: 1, index: 0 }, combatants: [] };
  const responses = { worldInfo: { world: { id: "w" } }, staticContext: snapshot, playContext: live, executeAction: { status: "completed" } };
  const { host, tools } = buildHarness({ call: async (action, args, options) => { calls.push({ action, args, options }); return responses[action]; }, sendToRenderer: e => events.push(e) });
  host.maybeRequestApproval = async () => true;
  const signal = new AbortController().signal;
  await tools.get("world_status").execute("world", {}, signal);
  await tools.get("foundry_static_context").execute("static", {}, signal);
  await tools.get("foundry_play_context").execute("turn", { view: "turn" }, signal);
  const result = await tools.get("foundry_execute_action").execute("execute", { actionRef: "ref", advance: true }, signal);
  assert.deepEqual(calls.map(value => value.action), ["worldInfo", "staticContext", "playContext", "executeAction"]);
  assert.deepEqual(calls.map(value => value.options.executionTimeoutMs), [30000, 30000, 30000, 120000]);
  assert.ok(calls.every(value => value.options.signal === signal));
  assert.equal(calls[3].args.resolvedActions[0].sourceTokenUuid, "Scene.s.Token.t");
  assert.equal(calls[3].args.resolvedActions[0].actionId, "native-id");
  assert.deepEqual(calls[3].args.turn, live.turn);
  assert.equal(result.details.status, "completed");
  assert.equal(events[0].type, "world_info");
});

test("execute-action approval denial does not dispatch the page runtime", async () => {
  const calls = [];
  const { host, tools } = buildHarness({ call: async (...args) => { calls.push(args); } });
  host.maybeRequestApproval = async () => false;
  const result = await tools.get("foundry_execute_action").execute("execute", { actionRef: "ref" });
  assert.equal(result.details.code, "DECLINED"); assert.deepEqual(calls, []);
});

test("structured tools fail closed when the page runtime is unavailable", async () => {
  const { host, tools } = buildHarness();
  host.foundryRuntime = null;
  await assert.rejects(tools.get("foundry_play_context").execute("turn", {}), /Foundry runtime unavailable/);
});

test("prep preamble forces reading the matching skill before install actions", () => {
  const preamble = readFileSync(
    new URL("../system-prompts/prep.md", import.meta.url),
    "utf8"
  );
  assert.ok(preamble.includes("必须先 read 对应 skill 的 SKILL.md 全文"));
  assert.ok(preamble.includes("arcane-fvtt-setup"));
  assert.ok(preamble.includes("出错后再回头读 skill"));
});

test("prep preamble prefers mermaid diagrams rendered in chat", () => {
  const preamble = readFileSync(
    new URL("../system-prompts/prep.md", import.meta.url),
    "utf8"
  );
  assert.ok(preamble.includes("```mermaid"));
  assert.ok(preamble.includes("不要生成图片文件"));
});
