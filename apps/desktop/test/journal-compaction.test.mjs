import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { InputJournal } from "../src/main/tasks/input-journal.js";
import { TaskCoordinator } from "../src/main/tasks/task-coordinator.js";
import { SessionDeletions } from "../src/main/conversations/session-deletions.js";
const directory = () => mkdtempSync(path.join(os.tmpdir(), "arcane-compact-"));
const tick = () => new Promise(resolve => setImmediate(resolve));

test("atomic journal replacement preserves the original on encoding failure and remains appendable", () => {
  const root = directory(), file = path.join(root, "task.jsonl"), journal = new InputJournal(file);
  journal.append({ type: "old", value: 1 }); const original = readFileSync(file, "utf8");
  assert.throws(() => journal.compact([{ invalid: 1n }]));
  assert.equal(readFileSync(file, "utf8"), original); assert.equal(journal.records[0].type, "old");
  assert.deepEqual(readdirSync(root), ["task.jsonl"]);
  journal.compact([{ type: "checkpoint", value: 2 }]); journal.append({ type: "later", value: 3 });
  assert.deepEqual(new InputJournal(file).records.map(record => record.type), ["checkpoint", "later"]);
});

test("compacted tasks preserve input and answer idempotency without retaining terminal image payloads", async () => {
  const file = path.join(directory(), "task.jsonl"); let coordinator, attentionId, answer;
  coordinator = new TaskCoordinator({ sessionId: "A", journal: new InputJournal(file), adapter: {
    prompt: async () => { answer = await coordinator.ask({ question: "choose" }); },
  } });
  const images = [{ data: "x".repeat(100_000), mimeType: "image/png" }];
  const accepted = coordinator.submit({ commandId: "input", text: "request", images });
  await tick(); attentionId = coordinator.snapshotAttentions()[0].id;
  assert.equal(coordinator.compact(true), false); // never rewrite an active tool's inputs
  const response = { commandId: "answer", taskId: accepted.taskId, attentionId, response: "yes" };
  const receipt = coordinator.respond(response); await coordinator.run;
  assert.deepEqual(answer, { response: "yes" });
  coordinator.setPendingModel({ providerId: "provider", modelId: "model" }); coordinator.compact(true);
  assert.equal(readFileSync(file).length < 10_000, true);
  let calls = 0;
  const restored = new TaskCoordinator({ sessionId: "A", journal: new InputJournal(file), adapter: { prompt: async () => { calls++; } } });
  assert.deepEqual(restored.submit({ commandId: "input", text: "request", images }), { ...accepted, duplicate: true });
  assert.deepEqual(restored.respond(response), { ...receipt, duplicate: true });
  assert.equal(restored.submit({ commandId: "input", text: "changed" }).code, "COMMAND_CONFLICT");
  assert.equal(restored.task.state, "completed"); assert.equal(restored.snapshotAttentions()[0].state, "answered");
  assert.equal(restored.pendingModel.modelId, "model"); assert.equal(calls, 0);
});

test("compaction failure cannot turn a completed task into failure or lose retry identity", async () => {
  const journal = new InputJournal();
  const coordinator = new TaskCoordinator({ sessionId: "A", journal, adapter: { prompt: async () => {} } });
  coordinator.submit({ commandId: "input", text: "work" }); await coordinator.run;
  journal.compact = () => { throw new Error("write failed"); };
  assert.equal(coordinator.compact(true), false); assert.equal(coordinator.task.state, "completed");
  assert.equal(coordinator.compactionError, "write failed");
  assert.equal(coordinator.submit({ commandId: "input", text: "work" }).duplicate, true);
});

test("interrupted unconsumed attachments survive compaction for explicit recovery", () => {
  const journal = new InputJournal();
  journal.append({ type: "accepted", commandId: "queued", fingerprint: "fingerprint", ack: { ok: true },
    task: { id: "task", state: "queued" }, input: { id: "input", commandId: "queued", taskId: "task", state: "accepted",
      text: "look", images: [{ data: "unconsumed", mimeType: "image/png" }], executionText: "look at the attached file" } });
  const coordinator = new TaskCoordinator({ sessionId: "A", journal, adapter: { prompt: () => assert.fail() } });
  assert.equal(coordinator.task.state, "interrupted"); coordinator.compact(true);
  const restored = new TaskCoordinator({ sessionId: "A", journal, adapter: {} });
  assert.equal(restored.inputs.get("input").images[0].data, "unconsumed");
  assert.equal(restored.inputs.get("input").state, "interrupted");
});

test("deletion journal compaction discards cancelled intentions and keeps committed deletion identities", () => {
  const root = directory(), options = { file: path.join(root, "deletions.jsonl"), tasksDir: path.join(root, "tasks") };
  const log = new SessionDeletions(options);
  log.begin("deleted", path.join(root, "gone.jsonl")); log.commit("deleted");
  for (let i = 0; i < 100; i++) { log.begin(`cancelled-${i}`, path.join(root, `${i}.jsonl`)); log.cancel(`cancelled-${i}`); }
  assert.equal(log.journal.records.length < 128, true);
  const restored = new SessionDeletions(options);
  assert.deepEqual(restored.snapshot().sessionIds, ["deleted"]);
});
