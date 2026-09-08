import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { InputJournal } from "../src/main/tasks/input-journal.js";
import { SessionDeletions } from "../src/main/conversations/session-deletions.js";
const directory = () => mkdtempSync(path.join(os.tmpdir(), "arcane-compact-"));

test("atomic journal replacement preserves the original on encoding failure and remains appendable", () => {
  const root = directory(), file = path.join(root, "task.jsonl"), journal = new InputJournal(file);
  journal.append({ type: "old", value: 1 }); const original = readFileSync(file, "utf8");
  assert.throws(() => journal.compact([{ invalid: 1n }]));
  assert.equal(readFileSync(file, "utf8"), original); assert.equal(journal.records[0].type, "old");
  assert.deepEqual(readdirSync(root), ["task.jsonl"]);
  journal.compact([{ type: "checkpoint", value: 2 }]); journal.append({ type: "later", value: 3 });
  assert.deepEqual(new InputJournal(file).records.map(record => record.type), ["checkpoint", "later"]);
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
