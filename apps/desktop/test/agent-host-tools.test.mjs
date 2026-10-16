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
  assert.deepEqual(builtinToolNamesForPlatform("win32"), ["read", "powershell", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(builtinToolNamesForPlatform("darwin"), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(builtinToolNamesForPlatform("linux"), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
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

test("play activates the branch play tool set without the retired v2 names", () => {
  const { tools } = buildHarness();
  assert.deepEqual(activeToolNames("combat"), ["foundry_open", "world_status", "foundry_static_context",
    "foundry_play_context", "foundry_execute_action", "foundry_conditions_set"]);
  assert.equal([...tools.keys()].some(name => name.startsWith("combat_")), false);
  for (const name of activeToolNames("combat")) assert.ok(tools.has(name), name);
  // Pool is the superset for both modes; prep-only tools stay defined but inactive in combat.
  for (const name of ["foundry_screenshot", "foundry_actor_advance", "foundry_compendium_browse", "open_document"]) {
    assert.ok(tools.has(name), name);
  }
  assert.deepEqual(tools.get("foundry_static_context").parameters.properties, {});
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

// ---- A3：foundry_page_eval（mtcompat 档的兜底 eval，touched/missing 当场返回）----

function pageEvalHarness({ receipt, failure } = {}) {
  const calls = [];
  const { host, tools } = buildHarness({ call: async (action, args, options) => {
    calls.push({ action, args, options });
    if (failure) throw failure;
    return receipt;
  } });
  host.maybeRequestApproval = async () => true;
  return { host, tools, calls, tool: tools.get("foundry_page_eval") };
}

test("A3 注册与 schema：foundry_page_eval 在池里，参数 {code, requestId?}", () => {
  const { tool } = pageEvalHarness({ receipt: { status: "completed", touched: [], missing: [] } });
  assert.ok(tool, "工具池含 foundry_page_eval");
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["code", "requestId"]);
  assert.deepEqual(tool.parameters.required, ["code"]);
});

test("A3 审批拦截：与 browser_evaluate 同级，拒绝后绝不派发页面", async () => {
  const { host, tool, calls } = pageEvalHarness({ receipt: { status: "completed", value: 1, touched: [], missing: [] } });
  const approvals = [];
  host.maybeRequestApproval = async (payload) => { approvals.push(payload); return false; };
  const result = await tool.execute("eval-1", { code: "return game.user.isGM;" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].tool, "foundry_page_eval");
  assert.equal(approvals[0].summary, "return game.user.isGM;");
  assert.match(result.content[0].text, /DM declined this code; do not retry it\./);
  assert.deepEqual(calls, []);
});

test("A3 结果呈现：completed 空增量只回 value；带注记附尾（- path [status] note / - feature ×count）", async () => {
  const empty = pageEvalHarness({ receipt: { status: "completed", value: { hp: 7 }, touched: [], missing: [] } });
  const plain = await empty.tool.execute("eval-1", { code: "return { hp: 7 };" });
  assert.equal(plain.content[0].text, JSON.stringify({ hp: 7 }, null, 2));
  assert.doesNotMatch(plain.content[0].text, /touched\/missing/);
  assert.equal(empty.calls[0].action, "pageEval");
  assert.equal(empty.calls[0].args.code, "return { hp: 7 };");
  assert.equal("requestId" in empty.calls[0].args, false);
  assert.equal(empty.calls[0].options.executionTimeoutMs, 60_000);
  assert.deepEqual(empty.calls[0].options.signal, undefined);

  const annotated = pageEvalHarness({ receipt: { status: "completed", value: { ok: true },
    touched: [{ path: "canvas.pan", status: "stub-noop", note: "视角固定无平移概念" }],
    missing: [{ feature: "MidiQOL.completeItemUse", count: 2 }] } });
  const text = (await annotated.tool.execute("eval-2", { code: "return { ok: true };", requestId: "req-1" })).content[0].text;
  assert.match(text, /^\{\n  "ok": true\n\}/);
  assert.match(text, /touched\/missing（必须读；报了踩桩就按 note 绕开重写）:/);
  assert.match(text, /- canvas\.pan \[stub-noop\] 视角固定无平移概念/);
  assert.match(text, /- MidiQOL\.completeItemUse ×2/);
  assert.equal(annotated.calls[0].args.requestId, "req-1");
  assert.equal(annotated.calls[0].args.code, "return { ok: true };");
});

test("A3 结果呈现：rejected 的 code+message 显眼，注记同样附尾；无返回值不伪造正文", async () => {
  const rejected = pageEvalHarness({ receipt: { status: "rejected", code: "CAPABILITY_UNAVAILABLE", message: "api surface registry not installed",
    touched: [{ path: "TextEditor.enrichHTML", status: "stub-fixed", note: "透传不富化" }], missing: [] } });
  const result = await rejected.tool.execute("eval-1", { code: "return __MT_AGENT_RUNTIME__('apiSurface', {});" });
  assert.match(result.content[0].text, /^REJECTED \[CAPABILITY_UNAVAILABLE\]: api surface registry not installed/);
  assert.match(result.content[0].text, /- TextEditor\.enrichHTML \[stub-fixed\] 透传不富化/);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "rejected");

  const empty = pageEvalHarness({ receipt: { status: "completed", touched: [], missing: [] } });
  assert.equal((await empty.tool.execute("eval-2", { code: "return undefined;" })).content[0].text,
    "completed (the code returned no value)");
});

test("A3 旧源降级：ACTION_UNKNOWN 照实呈现并指路，不抛不重试", async () => {
  const failure = Object.assign(new Error("Foundry runtime read failed: ACTION_UNKNOWN: pageEval"),
    { code: "FOUNDRY_SDK_EVALUATION_FAILED" });
  const { tool } = pageEvalHarness({ failure });
  const result = await tool.execute("eval-1", { code: "return 1;" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ACTION_UNKNOWN/);
  assert.match(result.content[0].text, /pageEval unavailable/);
  assert.match(result.content[0].text, /v0\.5\.0/);
  assert.match(result.content[0].text, /Do not retry this call as-is\./);
  assert.equal(result.details.error, "FOUNDRY_SDK_EVALUATION_FAILED");
});

test("A3 描述：三规则调用形态在位（typed 优先 / apiSurface 直调形态 / 注记必读）", () => {
  const { tool } = pageEvalHarness({ receipt: { status: "completed", touched: [], missing: [] } });
  assert.match(tool.description, /prefer typed actions, eval is the fallback/);
  assert.match(tool.description, /__MT_AGENT_RUNTIME__\("apiSurface", \{prefix:"<domain>"\}\)/);
  assert.match(tool.description, /always read the `touched`\/`missing` annotations/);
  assert.match(tool.description, /rewrite the call per the note instead of retrying/);
  assert.match(tool.promptGuidelines.join("\n"), /__MT_AGENT_RUNTIME__\("apiSurface", \{prefix:"<domain>"\}\)/);
});

test("A3 无面板兜底：runtime 缺席时失败文本仍可读，不抛", async () => {
  const { host, tool } = pageEvalHarness({ receipt: { status: "completed", touched: [], missing: [] } });
  host.foundryRuntime = null;
  const result = await tool.execute("eval-1", { code: "return 1;" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /runtime is unavailable/);
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
