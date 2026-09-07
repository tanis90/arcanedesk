import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopNotifications } from "../src/main/conversations/desktop-notifications.js";
import { ActivityCenter } from "../src/main/conversations/activity-center.js";

function harness(file = path.join(mkdtempSync(path.join(os.tmpdir(), "arcane-notice-")), "settings.json")) {
  const created = [], rows = new Map(); let focus = false, activated = 0;
  const options = { file, supported: () => true, foreground: () => focus, lookup: id => rows.get(id),
    activate: () => { activated++; }, text: kind => kind, create: options => {
      const native = new EventEmitter(); native.options = options;
      native.show = () => { native.shown = true; };
      native.close = () => { native.closed = true; native.emit("close"); };
      created.push(native); return native;
    } };
  const broker = new DesktopNotifications(options);
  const notice = { sessionId: "A", taskId: "a", key: "task:a:completed", kind: "completed", name: "A" };
  rows.set("A", { sessionId: "A", taskId: "a", state: "completed", unread: true, attentionIds: [] });
  return { broker, options, notice, created, rows, setFocus: value => { focus = value; }, activated: () => activated };
}

test("notifications default off, persist opt-in and remain quiet in the foreground", () => {
  const h = harness();
  h.broker.deliver(h.notice); assert.equal(h.created.length, 0);
  assert.equal(h.broker.setEnabled(true).ok, true);
  assert.equal(new DesktopNotifications(h.options).enabled, true);
  h.setFocus(true); h.broker.deliver(h.notice); assert.equal(h.created.length, 0);
  h.setFocus(false); h.broker.deliver({ ...h.notice, text: "PRIVATE_BODY", args: "PRIVATE_ARGS" });
  assert.equal(h.created.length, 1); assert.equal(h.activated(), 0);
  assert.deepEqual(h.created[0].options, { title: "A", body: "completed", silent: true });
  h.created[0].emit("click"); assert.equal(h.activated(), 1);
  assert.equal(h.broker.takeTarget().row.sessionId, "A");
  assert.equal(h.broker.takeTarget(), null);
});

test("read, answered, removed and disabled notifications cannot redirect to stale work", () => {
  const h = harness(); h.broker.setEnabled(true);
  h.broker.deliver(h.notice);
  h.rows.get("A").unread = false; h.broker.reconcile("A");
  assert.equal(h.created[0].closed, true);
  h.created[0].emit("click"); assert.equal(h.activated(), 0);
  const question = { ...h.notice, key: "question:q", kind: "waiting_user", attentionId: "q" };
  h.rows.get("A").attentionIds = ["question:q", "question:q2"];
  h.broker.deliver(question);
  h.rows.get("A").attentionIds = ["question:q2"]; h.broker.reconcile("A");
  assert.equal(h.created[1].closed, true);
  h.broker.deliver({ ...question, key: "question:q2", attentionId: "q2" });
  h.rows.delete("A"); h.broker.reconcile("A"); assert.equal(h.created[2].closed, true);
  h.broker.setEnabled(false); h.created[2].emit("click"); assert.equal(h.activated(), 0);
});

test("ActivityCenter consumption suppresses historical and disabled-period notification replay", () => {
  const h = harness();
  const center = new ActivityCenter({ describe: () => ({ mode: "prep", name: "A" }),
    notify: notice => h.broker.deliver(notice) });
  h.options.lookup = id => center.get(id); h.broker.lookup = h.options.lookup;
  const done = { sessionId: "A", runtimeEpoch: "boot", seq: 1, taskId: "a", type: "task_state", task: { id: "a", state: "completed" } };
  center.observe(done); // intentionally disabled
  h.broker.setEnabled(true);
  center.observe(done); center.observe({ ...done, seq: 2 });
  assert.equal(h.created.length, 0);
  center.observe({ ...done, seq: 3, taskId: "b", task: { id: "b", state: "completed" } });
  assert.equal(h.created.length, 1);
  center.observe({ ...done, seq: 4, taskId: "b", task: { id: "b", state: "completed" } });
  assert.equal(h.created.length, 1); center.flush();
});

test("write and native delivery failures do not claim success or interrupt execution", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arcane-notice-fail-"));
  const blocker = path.join(dir, "file"); writeFileSync(blocker, "not a directory");
  const h = harness(path.join(blocker, "settings.json"));
  assert.equal(h.broker.setEnabled(true).ok, false); assert.equal(h.broker.enabled, false);
  h.broker.enabled = true; h.broker.create = () => { throw new Error("OS unavailable"); };
  assert.doesNotThrow(() => h.broker.deliver(h.notice));
  assert.equal(h.broker.status().deliveryFailed, true);
});
