import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionDeletions } from "../src/main/conversations/session-deletions.js";
import { SessionRegistry } from "../src/main/conversations/session-registry.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-deletion-log-"));
  const options = { file: path.join(root, "deletions.jsonl"), tasksDir: path.join(root, "tasks") };
  mkdirSync(options.tasksDir);
  const history = path.join(root, "history.jsonl"), task = path.join(options.tasksDir, "A.jsonl");
  writeFileSync(history, "history"); writeFileSync(task, "private task data");
  return { ...options, options, history, task };
}

test("deletion intent preserves task data until history unlink, then removes only the matching journal", () => {
  const f = fixture(), log = new SessionDeletions(f.options);
  const unrelated = path.join(f.tasksDir, "B.jsonl"); writeFileSync(unrelated, "keep");
  log.begin("A", f.history); assert.equal(existsSync(f.task), true);
  unlinkSync(f.history); log.commit("A");
  assert.equal(existsSync(f.task), false); assert.equal(existsSync(unrelated), true);
  const restored = new SessionDeletions(f.options);
  assert.deepEqual(restored.snapshot().sessionIds, ["A"]); assert.equal(restored.isDeleted(f.history), true);
});

test("registry deletion invokes durable intent and cleanup at the actual unlink boundary", async () => {
  const f = fixture(), deletions = new SessionDeletions(f.options);
  let disposed = false;
  const host = { describeCurrent: () => ({ id: "A", path: f.history }), openSessionManager() {}, busy: false,
    abort: async () => ({ ok: true }), dispose: () => { disposed = true; } };
  const registry = new SessionRegistry({ deletions, createHost() { throw new Error("unexpected replacement"); } });
  registry.hosts.set("A", host); registry.activeHost = { id: "unrelated" };
  assert.equal((await registry.deleteSession(f.history)).ok, true);
  assert.equal(disposed, true); assert.equal(existsSync(f.task), false);
  assert.deepEqual(new SessionDeletions(f.options).snapshot().sessionIds, ["A"]);
});

test("restart before history deletion cancels intent and does not delete or replay the surviving task", () => {
  const f = fixture(); new SessionDeletions(f.options).begin("A", f.history);
  const restored = new SessionDeletions(f.options);
  assert.deepEqual(restored.snapshot().sessionIds, []);
  assert.equal(existsSync(f.task), true); assert.equal(existsSync(f.history), true);
});

test("restart after history unlink completes an uncommitted cleanup and publishes the tombstone", () => {
  const f = fixture(); new SessionDeletions(f.options).begin("A", f.history); unlinkSync(f.history);
  const restored = new SessionDeletions(f.options);
  assert.equal(existsSync(f.task), false); assert.deepEqual(restored.snapshot().sessionIds, ["A"]);
});

test("cleanup failure retains a durable tombstone and is retried on the next startup", () => {
  const f = fixture(), log = new SessionDeletions(f.options);
  log.begin("A", f.history); unlinkSync(f.history); unlinkSync(f.task); mkdirSync(f.task);
  assert.throws(() => log.commit("A")); assert.deepEqual(log.snapshot().sessionIds, ["A"]);
  rmdirSync(f.task); writeFileSync(f.task, "retry cleanup");
  const restored = new SessionDeletions(f.options);
  assert.equal(restored.snapshot().ok, true); assert.equal(existsSync(f.task), false);
});

test("corrupt identities cannot escape the task directory; failed durable acceptance leaves history untouched", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ type: "begin", id: "../history", sessionPath: f.history }) + "\n");
  const corrupt = new SessionDeletions(f.options);
  assert.equal(corrupt.snapshot().ok, false); assert.throws(() => corrupt.begin("A", f.history));
  assert.equal(existsSync(f.history), true); assert.equal(existsSync(f.task), true);
  const g = fixture(), failed = new SessionDeletions(g.options);
  failed.journal.append = () => { throw new Error("disk full"); };
  assert.throws(() => failed.begin("A", g.history), /disk full/);
  assert.equal(failed.entries.size, 0); assert.equal(existsSync(g.history), true);
});
