import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FoundryOperationStore } from "../src/main/foundry-operation-store.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "foundry-operations-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const create = () => new FoundryOperationStore({ directory, sessionId: "session-1" });
  return { create, store: create(), file: path.join(directory, "session-1.jsonl"),
    input: { taskId: "task", toolCallId: "call", world: { origin: "https://foundry.test", id: "w" },
      action: "conditionsSet", args: { privateName: "not persisted" } } };
}

test("duplicate delivery shares dispatch and completed result survives restart", async t => {
  const f = fixture(t);
  let count = 0;
  const dispatch = async () => { count++; return { status: "completed", steps: [] }; };
  const [a, b] = await Promise.all([f.store.execute(f.input, dispatch), f.store.execute(f.input, dispatch)]);
  assert.deepEqual(a, b);
  assert.equal(count, 1);
  assert.deepEqual(await f.create().execute(f.input, dispatch), a);
  assert.equal(count, 1);
  assert.equal(readFileSync(f.file, "utf8").includes("not persisted"), false);
  assert.equal(f.store.lookup("another-session-ref"), null);
  await f.store.execute({ ...f.input, toolCallId: "new" }, dispatch);
  assert.equal(count, 2, "a new explicit command is not deduplicated by arguments");
});

test("restart during dispatched work returns unknown and never replays", async t => {
  const f = fixture(t);
  let finish;
  const pending = f.store.execute(f.input, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  let replayed = false;
  const result = await f.create().execute(f.input, () => { replayed = true; });
  assert.equal(result.status, "indeterminate");
  assert.equal(result.retry, false);
  assert.equal(replayed, false);
  finish({ status: "completed", steps: [] });
  await pending;
});

test("disk failure before dispatch is zero-write; downstream failure is non-replayable", async t => {
  const f = fixture(t);
  const append = f.store.journal.append.bind(f.store.journal);
  f.store.journal.append = () => { throw Error("disk full"); };
  let called = false;
  await assert.rejects(f.store.execute(f.input, () => { called = true; }), /disk full/);
  assert.equal(called, false);
  f.store.journal.append = append;
  const result = await f.store.execute(f.input, () => { throw Error("connection lost"); });
  assert.equal(result.status, "indeterminate");
  assert.deepEqual(await f.create().execute(f.input, () => { called = true; }), result);
  assert.equal(called, false);
});

test("changed arguments under the same identity and invalid committed history reject", async t => {
  const f = fixture(t);
  await f.store.execute(f.input, async () => ({ status: "partial", steps: [] }));
  await assert.rejects(f.store.execute({ ...f.input, args: {} }, () => {}), /TOOL_CALL_CONFLICT/);
  writeFileSync(f.file, '{"kind":"bad"}\n');
  assert.throws(f.create, /Invalid Foundry operation history/);
});

test("replay uses original model arguments across lost handles and rejects changed input", async t => {
  const f = fixture(t), input = { actorUuid: "Actor.a", readRef: "old-handle", changes: { name: "New" } };
  const record = { ...f.input, action: "actorEdit", input, args: { world: f.input.world, readState: { fields: { name: "Old" } } } };
  const result = await f.store.execute(record, async () => ({ status: "completed", steps: [] }));
  const identity = { taskId: record.taskId, toolCallId: record.toolCallId, action: record.action, input };
  assert.deepEqual(f.create().replay(identity),result);
  assert.equal(f.create().replay({ ...identity, input: { ...input, changes: { name: "Different" } } }).code,"TOOL_CALL_CONFLICT");
  assert.deepEqual(await f.create().execute({ ...record, args: { readState: null } }, () => { throw Error("must never dispatch"); }),result);
});
