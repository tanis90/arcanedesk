import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingInputs } from "../src/main/tasks/pending-inputs.js";
import { TaskCoordinator } from "../src/main/tasks/task-coordinator.js";
const directory = () => mkdtempSync(path.join(os.tmpdir(), "arcane-pending-"));
const input = id => ({ id, commandId: id, text: id, images: [{ data: "image", mimeType: "image/png" }] });

test("whole-file replacement preserves prior data on serialization failure", () => {
  const file = path.join(directory(), "pending.json"), pending = new PendingInputs(file);
  pending.save([input("one")]); const previous = readFileSync(file, "utf8");
  assert.throws(() => pending.save([{ ...input("two"), text: 1n }]));
  assert.equal(readFileSync(file, "utf8"), previous);
  assert.deepEqual(pending.inputs.map(i => i.id), ["one"]);
});

test("legacy migration retains only unconsumed bodies and model intent, then removes the old file", () => {
  const root = directory(), old = path.join(root, "old.jsonl"), file = path.join(root, "pending.json");
  const model = { providerId: "p", modelId: "m" }; let saved;
  writeFileSync(old, [
    { type: "checkpoint", inputs: [input("one"), input("two")], pendingModel: model },
    { type: "input_state", inputId: "one", state: "consumed" },
    { type: "accepted", input: input("three") },
    { type: "attention", attention: { id: "question" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const pending = new PendingInputs(file); pending.migrate(old, model => { saved = model; });
  assert.equal(existsSync(old), false); assert.deepEqual(saved, model);
  assert.deepEqual(new PendingInputs(file).inputs.map(i => i.id), ["two", "three"]);
});

test("migration does not remove source when the model destination cannot save", () => {
  const root = directory(), old = path.join(root, "old.jsonl");
  writeFileSync(old, JSON.stringify({ type: "pending_model", model: { providerId: "p", modelId: "m" } }));
  const pending = new PendingInputs(path.join(root, "pending.json"));
  assert.throws(() => pending.migrate(old, () => { throw Error("disk full"); }), /disk full/);
  assert.equal(existsSync(old), true);
});

test("corrupt pending data is isolated and does not prevent accepting new input", () => {
  const root = directory(), file = path.join(root, "pending.json"); writeFileSync(file, "broken");
  const pending = new PendingInputs(file);
  assert.ok(pending.warning); assert.deepEqual(pending.inputs, []);
  assert.ok(readdirSync(root).some(name => name.endsWith(".damaged")));
  pending.save([input("new")]); assert.equal(new PendingInputs(file).inputs[0].text, "new");
});

test("explicit resend uses a new command, replaces one recovered body and preserves other inputs", async () => {
  const file = path.join(directory(), "pending.json"), pending = new PendingInputs(file);
  pending.save([input("one"), input("two")]);
  const c = new TaskCoordinator({ sessionId: "A", pending, adapter: { prompt: async () => {} } });
  const ack = c.submit({ commandId: "new", text: "one", replacesInputId: "one" });
  assert.equal(ack.duplicate, undefined); assert.notEqual(ack.inputId, "one");
  assert.deepEqual(new PendingInputs(file).inputs.map(i => i.commandId), ["two", "new"]);
  await c.run;
  assert.deepEqual(new PendingInputs(file).inputs.map(i => i.commandId), ["two"]);
});
