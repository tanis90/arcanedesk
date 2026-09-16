import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ActivityCenter } from "../src/main/conversations/activity-center.js";
import { SessionProjection } from "../src/main/sync/session-projection.js";

function fixture(options = {}) {
  const notices = [], updates = [];
  const center = new ActivityCenter({ describe: id => ({ name: id, mode: id === "C" ? "combat" : "prep", path: `${id}.jsonl` }),
    emit: e => updates.push(e), notify: n => notices.push(n), ...options });
  const projections = new Map();
  const send = (id, payload) => {
    if (!projections.has(id)) projections.set(id, new SessionProjection({ sessionId: id, epoch: "boot-1" }));
    const event = projections.get(id).publish(payload);
    center.observe(event);
    return event;
  };
  const read = id => center.opened(id);
  return { center, notices, updates, send, read, projections };
}

test("deleting an unloaded session still publishes the frontend cleanup signal", () => {
  const f = fixture();
  f.center.remove("unloaded");
  assert.equal(f.updates.at(-1).type, "activity_removed");
  assert.equal(f.updates.at(-1).sessionId, "unloaded");
  assert.equal(f.notices.length, 0);
});

test("same-mode and cross-mode activity are independent; read never erases task state", () => {
  const f = fixture();
  f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
  f.send("B", { type: "task_state", task: { id: "b", state: "running" } });
  f.send("C", { type: "task_state", task: { id: "c", state: "running" } });
  f.send("A", { type: "message_delta", key: "assistant:1", text: "half" });
  f.send("B", { type: "task_state", task: { id: "b", state: "failed" } });
  f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
  assert.equal(f.read("A").ok, true);
  assert.equal(f.center.get("A").unread, false);
  assert.equal(f.center.get("A").state, "completed");
  assert.equal(f.center.get("B").unread, true);
  assert.equal(f.center.get("C").state, "running");
  assert.deepEqual(f.notices.map(n => [n.sessionId, n.kind]), [["B", "failed"], ["A", "completed"]]);
  assert.deepEqual(f.center.snapshot().rows.map(r => r.sessionId), ["A", "B", "C"]);
  f.center.flush();
});

test("opening clears the coarse dot, background progress lights it again, foreground progress does not", () => {
  let foreground = false;
  const f = fixture({ foreground: () => foreground });
  f.send("A", { type: "message_delta", text: "first" });
  assert.equal(f.center.get("A").unread, true);
  f.read("A");
  assert.equal(f.center.get("A").unread, false);
  foreground = true;
  f.send("A", { type: "message_delta", text: "visible" });
  assert.equal(f.center.get("A").unread, false);
  foreground = false;
  f.send("A", { type: "attention", attention: { id: "q", state: "pending" } });
  assert.equal(f.center.get("A").unread, true);
  f.read("A");
  assert.equal(f.center.get("A").needsAttention, true);
  f.center.flush();
});

test("question and approval notifications are per item, not duplicated by waiting state", () => {
  const f = fixture();
  f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
  const question = f.send("A", { type: "attention", attention: { id: "q1", state: "pending" } });
  f.center.observe(question);
  f.send("A", { type: "task_state", task: { id: "a", state: "waiting_user" } });
  f.send("A", { type: "attention", attention: { id: "q1", state: "pending" } });
  f.send("A", { type: "approval_request", approvalId: "p1", args: { secret: "NEVER_PERSIST" } });
  f.send("A", { type: "approval_request", approvalId: "p2" });
  f.send("A", { type: "approval_resolved", approvalId: "p1" });
  assert.deepEqual(f.center.get("A").attentionIds, ["question:q1", "approval:p2"]);
  assert.equal(f.notices.length, 3);
  f.send("A", { type: "attention", attention: { id: "q1", state: "answered" } });
  f.send("A", { type: "approval_resolved", approvalId: "p2" });
  f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
  assert.equal(f.center.get("A").needsAttention, false);
  f.center.flush();
});

test("completed notifications are memory-only; restart and live snapshots do not replay alerts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcane-activity-"));
  const file = path.join(dir, "activity.json");
  try {
    const f = fixture({ file });
    f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
    f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
    assert.equal(f.notices.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), []);
    const restored = fixture({ file });
    assert.equal(restored.center.get("A"), null);
    restored.center.reconcile({ session: { id: "A", name: "A" }, task: { id: "a", state: "completed" },
      inFlight: { runtimeEpoch: "boot-2", seq: 0 } }, "prep");
    restored.center.observe({ sessionId: "A", runtimeEpoch: "boot-2", seq: 1, type: "task_state", task: { id: "a", state: "completed" } });
    assert.equal(restored.notices.length, 0);
    f.center.flush(); restored.center.flush();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("restart does not claim running tasks survived and a live snapshot reconciles without alerts", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcane-activity-"));
  const file = path.join(dir, "activity.json");
  try {
    const f = fixture({ file });
    f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
    f.read("A");
    const restored = fixture({ file });
    assert.equal(restored.center.get("A").state, "interrupted");
    assert.equal(restored.center.get("A").available, false);
    assert.equal(restored.center.get("A").unread, true);
    restored.center.reconcile({ session: { id: "A" }, task: { id: "a", state: "interrupted" },
      inFlight: { runtimeEpoch: "boot-2", seq: 0 } }, "prep");
    assert.equal(restored.center.opened("A").ok, true);
    assert.equal(restored.notices.length, 0);
    restored.center.flush();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("streaming and read updates never write; only task membership changes persist the minimal summary", () => {
  const writes = [];
  const f = fixture({ persist: data => writes.push(structuredClone(data)) });
  f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
  for (let i = 0; i < 500; i++) {
    f.send("A", { type: "message_delta", text: `PRIVATE_${i}` });
    f.center.flush();
  }
  f.read("A");
  f.send("A", { type: "task_state", task: { id: "a", state: "waiting_user" } });
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0][0]).sort(), ["mode", "name", "path", "sessionId", "taskId"]);
  assert.equal(JSON.stringify(writes).includes("PRIVATE"), false);
  f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
  assert.deepEqual(writes[1], []);
  const snapshot = f.center.snapshot(); snapshot.rows[0].attentionIds.push("mutated");
  assert.deepEqual(f.center.get("A").attentionIds, []);
  f.center.flush();
});

test("summary write failure neither hides activity nor blocks notifications", () => {
  let fail = true;
  const f = fixture({ persist: () => { if (fail) throw new Error("disk full"); } });
  f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
  const done = f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
  assert.equal(f.center.snapshot().storageError, true);
  assert.equal(f.center.get("A").unread, true);
  assert.equal(f.notices.length, 1);
  f.read("A");
  assert.equal(f.center.get("A").unread, false);
  fail = false;
  f.center.reconcile({ session: { id: "A" }, task: { id: "a", state: "completed" }, inFlight: { runtimeEpoch: "boot-1", seq: done.seq } }, "prep");
  f.center.observe(done);
  assert.equal(f.center.snapshot().storageError, false);
  assert.equal(f.notices.length, 1);
  f.center.remove("A");
  assert.equal(f.center.get("A"), null);
  assert.equal(f.updates.at(-1).type, "activity_removed");
});

test("legacy activity data keeps only interruption identities and drops old notification/read history", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcane-activity-legacy-"));
  const file = path.join(dir, "activity.json");
  try {
    writeFileSync(file, JSON.stringify({version: 1, rows: [
      {sessionId:"A", mode:"prep", name:"A", state:"waiting_user", taskId:"a", notices:["old"], readRevision:99, retiredEpochs:["old"], attentionIds:["question:q"]},
      {sessionId:"B", mode:"prep", state:"completed"}
    ]}));
    const f = fixture({file});
    assert.equal(f.center.get("A").state, "interrupted");
    assert.equal(f.center.get("A").needsAttention, false);
    assert.equal(f.center.get("B"), null);
    assert.equal(f.notices.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(file,"utf8")), [{sessionId:"A", mode:"prep", name:"A", path:null, taskId:"a"}]);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
