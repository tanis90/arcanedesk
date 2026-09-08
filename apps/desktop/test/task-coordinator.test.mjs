import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskCoordinator } from "../src/main/tasks/task-coordinator.js";
import { PendingInputs } from "../src/main/tasks/pending-inputs.js";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test("stopping retains capacity until the SDK prompt settles", async () => {
  const { ExecutionScheduler } = await import("../src/main/scheduling/execution-scheduler.js");
  const scheduler = new ExecutionScheduler({ capacity: 1 }), prompt = deferred();
  const c = new TaskCoordinator({ sessionId: "A", scheduler, adapter: {
    prompt: () => prompt.promise, abort: async () => {},
  } });
  c.submit({ text: "run" }); await tick();
  const stop = c.stop(c.task.id); await tick();
  assert.equal(c.task.state, "stopping"); assert.equal(scheduler.active.size, 1);
  prompt.resolve(); await stop;
  assert.equal(c.task.state, "stopped"); assert.equal(scheduler.active.size, 0);
});

test("supplement received during a prompt continues the same task", async () => {
  const gate = deferred(), calls = [];
  const c = new TaskCoordinator({ sessionId: "A", adapter: {
    prompt: async text => { calls.push(text); await gate.promise; },
  } });
  const first = c.submit({ text: "first" }); await tick();
  const second = c.submit({ text: "second" }); assert.equal(second.taskId, first.taskId);
  gate.resolve(); await c.run;
  assert.deepEqual(calls, ["first", "second"]); assert.equal(c.task.state, "completed");
});

test("acceptance precedes execution; identical command retry executes once and changed content conflicts", async () => {
  const gate = deferred(); const calls = [];
  const coordinator = new TaskCoordinator({ sessionId: "A", adapter: {
    prompt: async text => { calls.push(text); await gate.promise; },
  } });
  const ack = coordinator.submit({ commandId: "one", text: "hello" });
  assert.equal(ack.status, "accepted");
  assert.deepEqual(calls, []);
  assert.equal(coordinator.submit({ commandId: "one", text: "hello" }).duplicate, true);
  assert.equal(coordinator.submit({ commandId: "one", text: "different" }).code, "COMMAND_CONFLICT");
  await tick(); assert.deepEqual(calls, ["hello"]);
  gate.resolve(); await coordinator.run;
  assert.equal(coordinator.task.state, "completed");
});

test("queued input is consumed when the model starts; a missed end-of-turn steer is drained", async () => {
  const gate = deferred(); const calls = [];
  let coordinator;
  const adapter = {
    isStreaming: () => true,
    async prompt(text) {
      calls.push(text);
      coordinator.observe({ type: "message_start", message: { role: "user", content: text } });
      coordinator.observe({ type: "message_start", message: { role: "assistant" } });
      if (text === "first") await gate.promise;
    },
    steer(text) { coordinator.observe({ type: "queue_update", steering: [text] }); },
    clearQueue() {},
  };
  coordinator = new TaskCoordinator({ sessionId: "A", adapter });
  const first = coordinator.submit({ commandId: "first", text: "first" });
  await tick();
  const second = coordinator.submit({ commandId: "second", text: "second" });
  assert.equal(second.taskId, first.taskId);
  assert.equal(coordinator.inputs.get(second.inputId).state, "queued");
  gate.resolve(); await coordinator.run;
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(coordinator.inputs.get(second.inputId).state, "consumed");
});

test("failed persistence never acknowledges or dispatches an input", async () => {
  let calls = 0;
  const pending = new PendingInputs(); pending.save = () => { throw new Error("disk full"); };
  const coordinator = new TaskCoordinator({ sessionId: "A", pending, adapter: { prompt: async () => { calls++; } } });
  assert.throws(() => coordinator.submit({ text: "work" }), /disk full/);
  await tick(); assert.equal(calls, 0); assert.equal(coordinator.task, null);
});

test("already consumed steering is not prompted a second time", async () => {
  const gate = deferred(); const calls = [];
  let coordinator;
  coordinator = new TaskCoordinator({ sessionId: "A", adapter: {
    isStreaming: () => true,
    async prompt(text) { calls.push(text); coordinator.observe({ type: "message_start", message: { role: "user", content: text } }); coordinator.observe({ type: "message_start", message: { role: "assistant" } }); await gate.promise; },
    steer(text) {
      coordinator.observe({ type: "queue_update", steering: [text] });
      coordinator.observe({ type: "message_start", message: { role: "user", content: text } });
      coordinator.observe({ type: "message_start", message: { role: "assistant" } });
    }, clearQueue() {},
  } });
  coordinator.submit({ text: "first" }); await tick();
  const ack = coordinator.submit({ text: "second" });
  assert.equal(coordinator.inputs.get(ack.inputId).state, "consumed");
  gate.resolve(); await coordinator.run;
  assert.deepEqual(calls, ["first"]);
});

test("stop cancels undelivered inputs and an old task cannot stop the next one", async () => {
  const gate = deferred();
  const coordinator = new TaskCoordinator({ sessionId: "A", adapter: {
    prompt: () => gate.promise, abort: async () => gate.resolve(), clearQueue() {},
  } });
  const first = coordinator.submit({ text: "first" }); await tick();
  const second = coordinator.submit({ text: "second" });
  const stopped = coordinator.stop(first.taskId);
  assert.equal(coordinator.submit({ text: "too late" }).code, "TASK_STOPPING");
  await stopped;
  assert.equal(coordinator.inputs.get(second.inputId).state, "cancelled");
  const third = coordinator.submit({ text: "third" });
  assert.notEqual(third.taskId, first.taskId);
  assert.equal((await coordinator.stop(first.taskId)).code, "STALE_TASK");
  await coordinator.run;
});

test("input submitted on the terminal event starts a subsequent task despite the old promise cleanup", async () => {
  const calls = []; let coordinator; let next;
  coordinator = new TaskCoordinator({ sessionId: "A", adapter: { prompt: async text => { calls.push(text); } },
    emit: event => {
      if (event.type === "task_state" && event.task.state === "completed" && !next) {
        next = true; coordinator.submit({ text: "second" });
      }
    } });
  coordinator.submit({ text: "first" });
  await tick(); await tick();
  assert.deepEqual(calls, ["first", "second"]);
});

test("restart keeps all unconsumed input bodies without restoring command dedup or running work", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "arcane-input-test-")), "pending.json");
  const gate = deferred();
  const original = new TaskCoordinator({ sessionId: "A", pending: new PendingInputs(file), adapter: { prompt: () => gate.promise } });
  const first = original.submit({ commandId: "old", text: "first", images: [{ data: "data", mimeType: "image/png" }] });
  original.submit({ commandId: "old2", text: "second" }); await tick();
  const recovered = new TaskCoordinator({ sessionId: "A", pending: new PendingInputs(file), adapter: {} });
  assert.equal(recovered.task, null); assert.equal(recovered.commands.size, 0); assert.equal(recovered.run, null);
  assert.deepEqual(recovered.snapshotInputs().map(i => i.text), ["first", "second"]);
  assert.equal(recovered.inputs.get(first.inputId).state, "interrupted");
  assert.equal(recovered.inputs.get(first.inputId).images[0].data, "data");
  gate.resolve(); await original.run;
});

test("structured answer is scoped and idempotent within a running host, then resumes the same task", async () => {
  let coordinator; let question;
  coordinator = new TaskCoordinator({ sessionId: "A", adapter: {
    prompt: async () => { question = coordinator.ask({ question: "Which scene?", options: ["Forest", "City"] }); await question; },
  } });
  const task = coordinator.submit({ text: "prepare" }); await tick();
  assert.equal(coordinator.task.state, "waiting_user");
  const attention = coordinator.snapshotAttentions()[0];
  assert.equal(coordinator.respond({ commandId: "wrong", taskId: "old", attentionId: attention.id, response: "Forest" }).code, "STALE_ATTENTION");
  const command = { commandId: "answer", taskId: task.taskId, attentionId: attention.id, response: "Forest" };
  assert.equal(coordinator.respond(command).ok, true);
  assert.equal(coordinator.respond(command).duplicate, true);
  assert.equal(coordinator.respond({ ...command, response: "City" }).code, "COMMAND_CONFLICT");
  assert.deepEqual(await question, { response: "Forest" });
  await coordinator.run;
  assert.equal(coordinator.task.id, task.taskId);
  assert.equal(coordinator.task.state, "completed");
  assert.equal(coordinator.snapshotAttentions()[0].response, "Forest");
});

test("stop resolves a waiting question and rejects later answers", async () => {
  let coordinator; let answer;
  coordinator = new TaskCoordinator({ sessionId: "A", adapter: {
    prompt: async () => { answer = await coordinator.ask({ question: "Continue?" }); }, abort: async () => {},
  } });
  const task = coordinator.submit({ text: "work" }); await tick();
  const attentionId = coordinator.snapshotAttentions()[0].id;
  await coordinator.stop(task.taskId);
  assert.deepEqual(answer, { cancelled: true });
  assert.equal(coordinator.task.state, "stopped");
  assert.equal(coordinator.snapshotAttentions()[0].state, "cancelled");
  assert.equal(coordinator.respond({ commandId: "late", taskId: task.taskId, attentionId, response: "yes" }).code, "STALE_ATTENTION");
});

test("recovery does not restore an unresolved question or answer consumer", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcane-attention-test-"));
  const file = path.join(dir, "journal.jsonl");
  let original;
  original = new TaskCoordinator({ sessionId: "A", pending: new PendingInputs(file), adapter: {
    prompt: async () => { await original.ask({ question: "Choose?" }); }, abort: async () => {},
  } });
  const task = original.submit({ text: "work" }); await tick();
  const restored = new TaskCoordinator({ sessionId: "A", pending: new PendingInputs(file), adapter: {} });
  const attention = original.snapshotAttentions()[0];
  assert.deepEqual(restored.snapshotAttentions(), []);
  assert.equal(restored.respond({ commandId: "after-restart", taskId: task.taskId, attentionId: attention.id, response: "yes" }).code, "STALE_ATTENTION");
  await original.stop(task.taskId);
});
