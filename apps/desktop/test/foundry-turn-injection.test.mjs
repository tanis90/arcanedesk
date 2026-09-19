import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnInjector, renderInjectedTurn, turnInjectionEnabled } from "../src/main/foundry-turn-injection.js";
import { FoundryServices } from "../src/main/foundry-services.js";
import { AgentHost } from "../src/main/agent-host.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "turn-injection-"));
const signal = () => new AbortController().signal;

const liveTurn = { contextRef: "snapshot", turn: { tokenId: "t", actorId: "a", round: 1, index: 0 },
  combatants: [{ tokenUuid: "Scene.s.Token.t", resources: { hp: 12 }, availableActionIds: ["native-id"] }] };
const staticManual = { scope: { combatId: "c", world: { origin: "https://test", id: "w" } }, contextRef: "snapshot",
  combatants: [{ tokenUuid: "Scene.s.Token.t", actorUuid: "Actor.a", actions: [{ actionRef: "ref", id: "native-id", itemId: "item", activityId: "activity" }] }] };
const binding = () => ({ taskId: "task", metadata: Promise.resolve({ world: { origin: "https://test", id: "w" }, selectedTokenUuids: [] }) });

test("ARCANE_TURN_INJECTION flag defaults on and =0 disables", () => {
  assert.equal(turnInjectionEnabled({}), true);
  assert.equal(turnInjectionEnabled({ ARCANE_TURN_INJECTION: "0" }), false);
  assert.equal(turnInjectionEnabled({ ARCANE_TURN_INJECTION: "1" }), true);
});

test("injected block body is byte-identical to the tool's textResult rendering", () => {
  const block = renderInjectedTurn(3, liveTurn, "zh-CN");
  assert.ok(block.startsWith("── 注入现场 #3 · "), block.slice(0, 40));
  assert.ok(block.includes(JSON.stringify(liveTurn)));
  assert.ok(block.includes("非 DM 发言"));
  const en = renderInjectedTurn(3, liveTurn, "en-US");
  assert.ok(en.startsWith("── Injected live state #3 · "));
  assert.ok(en.includes(JSON.stringify(liveTurn)));
});

test("prepend prepends the block and the serial increments per delivery", async () => {
  const injector = createTurnInjector({ getServices: () => ({ readPlay: async () => structuredClone(liveTurn) }), mode: "combat" });
  const first = await injector.prepend("格蕾斯治疗汉娜");
  assert.ok(first.startsWith("── 注入现场 #1 · "));
  assert.ok(first.includes(JSON.stringify(liveTurn)));
  assert.ok(first.endsWith("\n格蕾斯治疗汉娜"));
  assert.ok((await injector.prepend("再打一下")).startsWith("── 注入现场 #2 · "));
});

test("injection is evidence: first execute passes without a model turn read, then the gate is unchanged", async () => {
  const calls = [];
  const services = new FoundryServices({ sessionId: "s", directory: mkdtempSync(path.join(scratch, "ops-")), mode: "combat",
    withPage: (sig, operation) => operation(),
    call: async (action) => {
      calls.push(action);
      return structuredClone(action === "staticContext" ? staticManual : action === "executeAction" ? { status: "completed" } : liveTurn);
    } });
  await services.readStatic(signal());
  const injector = createTurnInjector({ getServices: () => services, mode: "combat" });
  assert.ok((await injector.prepend("阿弗林攻击")).startsWith("── 注入现场 #1"));
  assert.ok(services.turnSnapshot, "delivery-time read backfilled turn evidence");
  assert.deepEqual(calls, ["staticContext", "playContext"]);
  const receipt = await services.executeAction({ actionRef: "ref" }, binding(), "call-1", signal());
  assert.equal(receipt.status, "completed");
  assert.deepEqual(calls, ["staticContext", "playContext", "executeAction"]);
  // 写后失忆不变:第二个动作不做模型读时被门禁拒绝。
  const second = await services.executeAction({ actionRef: "ref" }, binding(), "call-2", signal());
  assert.equal(second.code, "TURN_CONTEXT_REQUIRED");
  // 读手册仍清除注入建立的证据(战斗开场首条消息仍需 static → turn → execute)。
  assert.ok((await injector.prepend("继续")).startsWith("── 注入现场 #2"));
  await services.readStatic(signal());
  const third = await services.executeAction({ actionRef: "ref" }, binding(), "call-3", signal());
  assert.equal(third.code, "TURN_CONTEXT_REQUIRED");
});

test("degrade paths never block the DM's message", async () => {
  let reads = 0;
  const counting = { readPlay: async () => { reads += 1; return structuredClone(liveTurn); } };
  // 命令消息与空文本:不触发读取。
  const injector = createTurnInjector({ getServices: () => counting, mode: "combat" });
  assert.equal(await injector.prepend("/compact"), "/compact");
  assert.equal(await injector.prepend(""), "");
  assert.equal(reads, 0);
  // 备团模式与开关关闭:不注入不读取。
  assert.equal(await createTurnInjector({ getServices: () => counting, mode: "prep" }).prepend("准备角色"), "准备角色");
  assert.equal(await createTurnInjector({ getServices: () => counting, mode: "combat", enabled: () => false }).prepend("打"), "打");
  assert.equal(reads, 0);
  // 读取失败:原样投递,outcome=error。
  const failures = [];
  const failing = createTurnInjector({ getServices: () => ({ readPlay: async () => { throw new Error("Foundry runtime unavailable"); } }),
    mode: "combat", onInject: outcome => failures.push(outcome) });
  assert.equal(await failing.prepend("打"), "打");
  assert.equal(failures[0].outcome, "error");
  assert.equal(failures[0].ok, false);
  // 超时:中止信号触发,原样投递,outcome=timeout。
  const timeouts = [];
  const hanging = createTurnInjector({ getServices: () => ({ readPlay: (params, sig) => new Promise((resolve, reject) => {
    sig.addEventListener("abort", () => reject(new Error("aborted")));
  }) }), mode: "combat", timeoutMs: 20, onInject: outcome => timeouts.push(outcome) });
  assert.equal(await hanging.prepend("打"), "打");
  assert.equal(timeouts[0].outcome, "timeout");
});

test("agent-host adapter funnels prompt/steer/followUp through the injector", async () => {
  const delivered = [];
  const host = new AgentHost({
    foundryRuntime: { call: async (action) => structuredClone(action === "playContext" ? liveTurn : {}) },
    operationStorageDir: mkdtempSync(path.join(scratch, "session-")),
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer: () => {},
    log: () => {},
  });
  host.describeCurrent = () => ({ id: "test" });
  host.session = {
    prompt: async (text, options) => { delivered.push(["prompt", text, options]); },
    steer: async (text, images) => { delivered.push(["steer", text, images]); },
    followUp: async (text, images) => { delivered.push(["followUp", text, images]); },
  };
  const adapter = host.taskCoordinator().adapter;
  await adapter.prompt("格蕾斯治疗汉娜");
  await adapter.steer("换个目标");
  await adapter.followUp("排队补充");
  assert.equal(delivered.length, 3);
  // 注入块正文 = readPlay 富化后的返回,与工具 textResult 给模型看的对象一字不差。
  const expectedBody = JSON.stringify(await host.foundryServices().readPlay({ view: "turn" }));
  for (const [channel, text] of delivered) {
    assert.ok(text.startsWith(`── 注入现场 #${channel === "prompt" ? 1 : channel === "steer" ? 2 : 3} · `), `${channel} got injected text`);
    assert.ok(text.includes(expectedBody), `${channel} block matches the tool rendering`);
  }
  assert.ok(delivered[0][1].endsWith("\n格蕾斯治疗汉娜"));
  assert.ok(delivered[1][1].endsWith("\n换个目标"));
  assert.ok(delivered[2][1].endsWith("\n排队补充"));
  // 注入读走的是宿主同一个 services 实例:证据落在门禁检查的地方。
  assert.ok(host.foundryServices().turnSnapshot);
  // 工具描述与注入语义同步。
  const tools = new Map(host.buildTools().map(tool => [tool.name, tool]));
  assert.match(tools.get("foundry_play_context").description, /injected snapshot/);
  assert.doesNotMatch(tools.get("foundry_play_context").description, /Use turn before and after combat actions/);
});

test("combat prompts stay in sync across locales", () => {
  const zh = readFileSync(path.join(__dirname, "../system-prompts/combat.md"), "utf8");
  const en = readFileSync(path.join(__dirname, "../system-prompts-intl/combat.md"), "utf8");
  assert.match(zh, /注入现场/);
  assert.match(zh, /证据即失效/);
  assert.match(zh, /消息没有附带注入现场/);
  assert.doesNotMatch(zh, /没有"刚读过还新鲜"的豁免/);
  assert.match(en, /## Injected live state/);
  assert.match(en, /rides on the injected state/);
  assert.doesNotMatch(en, /no "I just read it" exemption/);
  // intl 新增段落不得引入 CJK(既有 Known names 行的中文不在本次改动范围)。
  const section = en.split("## Injected live state")[1].split("\n## ")[0];
  assert.doesNotMatch(section, /[\u4e00-\u9fff]/);
});
