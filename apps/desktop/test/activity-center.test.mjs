import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const read = (id, overrides = {}, focused = true) => center.markRead({ sessionId: id,
    runtimeEpoch: "boot-1", seq: projections.get(id).seq, visible: true, atBottom: true, ...overrides }, focused);
  return { center, notices, updates, send, read, projections };
}

test("same-mode and cross-mode activity are independent; read never erases task state", () => {
  const f = fixture();
  f.send("A", { type: "task_state", task: { id: "a", state: "running" } });
  f.send("B", { type: "task_state", task: { id: "b", state: "running" } });
  f.send("C", { type: "task_state", task: { id: "c", state: "running" } });
  f.send("A", { type: "message_delta", key: "assistant:1", text: "half" });
  f.send("B", { type: "task_state", task: { id: "b", state: "failed" } });
  f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
  assert.equal(f.center.get("A").firstUnreadKey, "assistant:1");
  assert.equal(f.read("A").ok, true);
  assert.equal(f.center.get("A").unread, false);
  assert.equal(f.center.get("A").state, "completed");
  assert.equal(f.center.get("B").unread, true);
  assert.equal(f.center.get("C").state, "running");
  assert.deepEqual(f.notices.map(n => [n.sessionId, n.kind]), [["B", "failed"], ["A", "completed"]]);
  assert.deepEqual(f.center.snapshot().rows.map(r => r.sessionId), ["A", "B", "C"]);
  f.center.flush();
});

test("opening, reading history, stale/future cursors and background focus cannot clear new progress", () => {
  const f = fixture();
  const first = f.send("A", { type: "message_delta", key: "m", text: "first" });
  f.send("A", { type: "message", key: "m", text: "final" });
  for (const request of [{ atBottom: false }, { visible: false }, { seq: first.seq }, { seq: 999 }, { runtimeEpoch: "old" }]) {
    assert.equal(f.read("A", request).ok, false);
  }
  assert.equal(f.read("A", {}, false).ok, false);
  assert.equal(f.center.get("A").unread, true);
  f.send("A", { type: "input_state", input: { state: "consumed" } });
  assert.equal(f.read("A", { seq: 2, readKey: "m" }).ok, true);
  assert.equal(f.center.get("A").readKey, "m");
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

test("durable notice consumption precedes dispatch; restart and new-epoch snapshot never re-notify", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcane-activity-"));
  const file = path.join(dir, "activity.json");
  try {
    const f = fixture({ file, notify: notice => {
      const data = JSON.parse(readFileSync(file, "utf8"));
      assert.ok(data.rows[0].notices.includes(notice.key));
    } });
    const done = f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
    assert.equal(f.read("A").durable, true);
    const restored = fixture({ file });
    assert.equal(restored.center.get("A").unread, false);
    restored.center.observe(done);
    restored.center.reconcile({ session: { id: "A", name: "A" }, task: { id: "a", state: "completed" },
      inFlight: { runtimeEpoch: "boot-2", seq: 0 } }, "prep");
    restored.center.observe({ ...done, runtimeEpoch: "boot-2", seq: 1 });
    restored.center.observe({ ...done, task: { id: "a", state: "running" }, seq: 100 });
    assert.equal(restored.center.get("A").state, "completed");
    assert.equal(restored.notices.length, 0);
    assert.equal(restored.center.get("A").unread, false);
    restored.center.flush();
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
    assert.equal(restored.center.markRead({ sessionId: "A", runtimeEpoch: "boot-2", seq: 0,
      visible: true, atBottom: true }, true).ok, true);
    assert.equal(restored.notices.length, 0);
    restored.center.flush();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream updates coalesce, retain ordering and never persist text or tool arguments", () => {
  let persisted;
  const f = fixture({ persist: data => { persisted = structuredClone(data); } });
  for (let i = 0; i < 500; i++) f.send("A", { type: "message_delta", key: "m", text: `PRIVATE_TEXT_${i}` });
  f.send("A", { type: "tool_start", toolCallId: "t", toolName: "bash", args: { command: "PRIVATE_COMMAND" } });
  assert.equal(f.updates.length, 0);
  assert.equal(f.notices.length, 0);
  f.center.flush();
  assert.equal(f.updates.length, 1);
  assert.equal(f.center.get("A").unread, true);
  assert.equal(JSON.stringify(persisted).includes("PRIVATE"), false);
  const snapshot = f.center.snapshot();
  snapshot.rows[0].attentionIds.push("mutated");
  assert.deepEqual(f.center.get("A").attentionIds, []);
});

test("storage failure preserves visible activity, suppresses uncommitted notifications, and permits recovery", () => {
  let fail = true;
  const f = fixture({ persist: () => { if (fail) throw new Error("disk full"); } });
  const done = f.send("A", { type: "task_state", task: { id: "a", state: "completed" } });
  assert.equal(f.center.snapshot().storageError, true);
  assert.equal(f.center.get("A").unread, true);
  assert.equal(f.notices.length, 0);
  assert.equal(f.read("A").durable, false);
  fail = false;
  f.center.flush();
  f.center.observe(done);
  assert.equal(f.center.snapshot().storageError, false);
  assert.equal(f.notices.length, 0);
  f.center.remove("A");
  assert.equal(f.center.get("A"), null);
  assert.equal(f.updates.at(-1).type, "activity_removed");
});
