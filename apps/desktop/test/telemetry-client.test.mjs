import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelemetryClient } from "../src/main/telemetry/telemetry-client.js";
import { findForbiddenKey } from "../src/main/telemetry/telemetry-privacy.js";

function tempClient({ packaged = false, fetchImpl, log } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), "arcane-telemetry-client-"));
  const client = new TelemetryClient({
    userDataDir,
    appVersion: "0.1.0-test",
    packaged,
    fetchImpl,
    log,
  });
  return { client, userDataDir };
}

async function readAllEvents(client, userDataDir) {
  await client.whenReady;
  await client.writer.prepareQuit();
  const queue = join(userDataDir, "telemetry", "queue");
  if (!existsSync(queue)) return [];
  const files = readdirSync(queue).filter((n) => n.endsWith(".jsonl"));
  return files.flatMap((name) =>
    readFileSync(join(queue, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  );
}

test("packaged build without consent records nothing", async () => {
  const { client, userDataDir } = tempClient({ packaged: true });
  client.start();
  await client.whenReady;
  assert.deepEqual(client.consentStatus(), {
    available: true,
    userControllable: true,
    enabled: false,
    decided: false,
    recording: false,
    mode: "production",
  });
  assert.equal(client.installationId, null);
  assert.equal(existsSync(join(userDataDir, "config", "telemetry.json")), false);
  client.turnStarted("combat");
  client.inputSubmitted("combat", "hello", 0);
  const events = await readAllEvents(client, userDataDir);
  assert.equal(events.length, 0);
  await client.close();
});

test("packaged consent becomes explicit, reversible, and reflected in renderer status", async () => {
  const { client } = tempClient({ packaged: true });
  client.start();
  await client.whenReady;

  await client.consentEnabled();
  assert.match(client.installationId, /^ins_[0-9a-f]{32}$/);
  assert.deepEqual(client.consentStatus(), {
    available: true,
    userControllable: true,
    enabled: true,
    decided: true,
    recording: true,
    mode: "production",
  });

  await client.consentDisabled();
  assert.deepEqual(client.consentStatus(), {
    available: true,
    userControllable: true,
    enabled: false,
    decided: true,
    recording: false,
    mode: "production",
  });
  await client.close();
});

test("dev build records locally: envelope, app.started, and full turn lifecycle", async () => {
  const { client, userDataDir } = tempClient({ packaged: false });
  client.start();
  await client.whenReady;

  client.sessionAttached("combat", "deepseek", "deepseek-v4-flash", false);
  const turnId = client.turnStarted("combat");
  client.inputSubmitted("combat", "让圣武士攻击狗头人", 1);
  client.observeAgentEvent("combat", {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      stopReason: "stop",
      usage: { input: 1200, output: 80 },
    },
  });
  client.observeAgentEvent("combat", {
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "combat_turn_context",
  });
  client.observeAgentEvent("combat", {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "combat_turn_context",
    isError: false,
  });
  // 真实流程:combat_execute_turn 工具执行内部触发 runtime 调用,两个事实都要有
  client.observeAgentEvent("combat", {
    type: "tool_execution_start",
    toolCallId: "call_2",
    toolName: "combat_execute_turn",
  });
  client.foundryRuntimeResult({
    action: "executeTurn",
    phase: "dispatched",
    status: "completed",
    receipt: "partial",
    durationMs: 2_000,
    errorCode: null,
  });
  client.observeAgentEvent("combat", {
    type: "tool_execution_end",
    toolCallId: "call_2",
    toolName: "combat_execute_turn",
    isError: false,
  });
  client.observeAgentEvent("combat", { type: "agent_settled" });

  const events = await readAllEvents(client, userDataDir);
  await client.close();
  const names = events.map((e) => e.event);
  assert.ok(names.includes("app.started"));
  assert.ok(names.includes("agent.session_attached"));
  assert.ok(names.includes("input.submitted"));
  assert.ok(names.includes("turn.started"));
  assert.ok(names.includes("model.completed"));
  assert.ok(names.includes("tool.started"));
  assert.ok(names.includes("tool.completed"));
  assert.ok(names.includes("foundry.runtime_completed"));
  assert.ok(names.includes("turn.summary"));

  // envelope 合同
  const first = events[0];
  assert.match(first.installation_id, /^ins_[0-9a-f]{32}$/);
  assert.equal(first.app_version, "0.1.0-test");
  assert.equal(first.release_channel, "dev");
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));

  // model.completed 只含 family 映射与 usage,不含原文
  const model = events.find((e) => e.event === "model.completed");
  assert.equal(model.data.provider_family, "deepseek");
  assert.equal(model.data.input_tokens, 1200);

  // summary:transport 完成,world_outcome partial,settled 不等于成功
  const summary = events.find((e) => e.event === "turn.summary");
  const submitted = events.find((e) => e.event === "input.submitted");
  assert.equal(submitted.turn_id, turnId);
  assert.equal(summary.turn_id, turnId);
  assert.equal(summary.data.transport_status, "completed");
  assert.equal(summary.data.world_outcome, "partial");
  assert.equal(summary.data.task_category, "combat.execute_action");

  // 全量隐私扫描:任何事件不得含禁列 key
  for (const event of events) {
    assert.equal(findForbiddenKey(event), null, event.event);
  }
});

test("SDK 事件里的 args/result 原文不会进入遥测", async () => {
  const { client, userDataDir } = tempClient({ packaged: false });
  client.start();
  await client.whenReady;
  client.turnStarted("prep");
  client.observeAgentEvent("prep", {
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "rm -rf / && cat ~/.aws/credentials" },
  });
  client.observeAgentEvent("prep", {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    isError: false,
    result: { stdout: "AKIA_SECRET", path: "C:\\Users\\dm\\secret.txt" },
  });
  client.observeAgentEvent("prep", { type: "agent_settled" });
  const events = await readAllEvents(client, userDataDir);
  await client.close();
  const toolEvents = events.filter((e) => e.event.startsWith("tool."));
  assert.ok(toolEvents.length >= 2);
  const raw = JSON.stringify(events);
  assert.ok(!raw.includes("AKIA_SECRET"));
  assert.ok(!raw.includes("rm -rf"));
  assert.ok(!raw.includes("secret.txt"));
});

test("consentDisabled stops recording and wipes the local queue", async () => {
  const { client, userDataDir } = tempClient({ packaged: false });
  client.start();
  await client.whenReady;
  await client.consentEnabled();
  client.turnStarted("combat");
  client.inputSubmitted("combat", "hi", 0);
  await client.consentDisabled();
  const queue = join(userDataDir, "telemetry", "queue");
  assert.equal(readdirSync(queue).length, 0);
  assert.equal(client.recording, false);
  assert.equal(JSON.parse(readFileSync(join(userDataDir, "config", "telemetry.json"), "utf8")).enabled, false);

  // 同一 boot 再开启必须重新启用 writer，并恢复落盘。
  await client.consentEnabled();
  client.turnStarted("combat");
  client.inputSubmitted("combat", "after re-enable", 0);
  await client.writer.flush();
  assert.ok(readdirSync(queue).length > 0);
  assert.equal(client.writer.disabled, false);
  const restartedEvents = await readAllEvents(client, userDataDir);
  assert.ok(restartedEvents.some((event) => event.event === "app.started"));
  assert.ok(restartedEvents.some((event) => event.event === "turn.started"));
  await client.close();
});

test("enabling consent after Agent attach emits a self-contained session dimension", async () => {
  const { client, userDataDir } = tempClient({ packaged: true });
  client.start();
  await client.whenReady;
  client.sessionAttached("combat", "deepseek", "deepseek-v4-flash", false);
  await client.consentEnabled();
  const events = await readAllEvents(client, userDataDir);
  assert.ok(events.some((event) => event.event === "app.started"));
  const attached = events.find((event) => event.event === "agent.session_attached");
  assert.equal(attached.data.provider_family, "deepseek");
  assert.match(attached.agent_session_id, /^agss_[0-9a-f]{8}$/);
  await client.close();
});

test("retry completion records one event with the real recovered outcome", async () => {
  const { client, userDataDir } = tempClient({ packaged: false });
  client.start();
  await client.whenReady;
  client.turnStarted("combat");
  client.observeAgentEvent("combat", {
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    errorMessage: "HTTP 429 too many requests",
  });
  client.observeAgentEvent("combat", { type: "auto_retry_end", success: true });
  client.observeAgentEvent("combat", { type: "agent_settled" });

  const events = await readAllEvents(client, userDataDir);
  const retries = events.filter((event) => event.event === "model.retry");
  const summary = events.find((event) => event.event === "turn.summary");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].data.attempt, 2);
  assert.equal(retries[0].data.error_class, "model_rate_limit");
  assert.equal(retries[0].data.recovered, true);
  assert.equal(summary.data.provider_retries, 1);
  assert.equal(summary.data.error_class, "none");
  await client.close();
});

test("each Agent attach gets a fresh boot-local agent_session_id", async () => {
  const { client, userDataDir } = tempClient({ packaged: false });
  client.start();
  await client.whenReady;
  client.sessionAttached("combat", "deepseek", "deepseek-v4-flash", false);
  client.sessionAttached("combat", "deepseek", "deepseek-v4-flash", false);
  const events = await readAllEvents(client, userDataDir);
  const attached = events.filter((event) => event.event === "agent.session_attached");
  assert.equal(attached.length, 2);
  assert.notEqual(attached[0].agent_session_id, attached[1].agent_session_id);
  await client.close();
});

test("public semantic entrypoints swallow collaborator failures", () => {
  const logs = [];
  const { client } = tempClient({ log: (...args) => logs.push(args) });
  const boom = () => {
    throw new Error("injected telemetry failure");
  };
  client.recording = true;
  client.writer.append = () => {};

  client.agentSessionInfo = { set: boom };
  assert.doesNotThrow(() => client.sessionAttached("combat", "deepseek", "deepseek-v4", false));

  client.summarizer = { hasActive: boom };
  assert.equal(client.turnStarted("combat"), null);

  client.activeTurns.set("combat", { turnId: "turn_test", startedMonotonicMs: 0 });
  client.summarizer = { noteSteer: boom };
  assert.doesNotThrow(() => client.turnSteered("combat"));
  client.summarizer = { noteAbort: boom };
  assert.doesNotThrow(() => client.turnAborted("combat"));
  client.summarizer = { noteError: boom };
  assert.doesNotThrow(() => client.turnFailed("combat", new Error("prompt failed")));

  const hostileText = { [Symbol.toPrimitive]: boom };
  assert.doesNotThrow(() => client.inputSubmitted("combat", hostileText, 0, "keyboard"));
  client.summarizer = { noteApprovalDenied: boom };
  assert.doesNotThrow(() => client.approvalResolved("combat", "combat_execute_turn", "denied", 10));

  const hostileEvent = Object.defineProperty({}, "type", { get: boom });
  assert.doesNotThrow(() => client.observeAgentEvent("combat", hostileEvent));
  assert.doesNotThrow(() => client.foundryRuntimeResult(null));

  assert.ok(logs.length >= 8);
  assert.ok(logs.every((args) => String(args[0]).startsWith("[telemetry]")));
});
