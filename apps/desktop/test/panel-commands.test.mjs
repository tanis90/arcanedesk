import test from "node:test";
import assert from "node:assert/strict";
import { PanelCommands } from "../src/main/scheduling/panel-commands.js";
import { ResourceCoordinator, retainResourceUntil } from "../src/main/scheduling/resource-coordinator.js";
const tick = () => new Promise(resolve => setImmediate(resolve));

test("recovery refuses an active tool and leaves its resource and pending command intact", async () => {
  const resources = new ResourceCoordinator(), held = await resources.acquire(["foundry:page"], { taskId: "active" });
  const panel = new PanelCommands({ resources, operations: { open: async () => ({ ok: true }) } });
  const pending = panel.request("open"); await tick();
  let destroyed = false;
  const result = await panel.recover({ stopOwners() {}, destroyPage() { destroyed = true; }, reopen() {} });
  assert.equal(result.code, "PAGE_OPERATION_RUNNING"); assert.equal(destroyed, false);
  assert.equal(panel.snapshot().command.id, pending.command.id);
  held.release(); await panel.run;
});

test("recovery fences task admission, cancels queued panel work, and rebuilds only after old execution ends", async () => {
  const resources = new ResourceCoordinator(); let endOld, finishReopen;
  const old = new Promise(resolve => { endOld = resolve; });
  await resources.run(["foundry:page"], { sessionId: "A", taskId: "old" }, null, () => {}, () => { retainResourceUntil(old); });
  let opens = 0;
  const panel = new PanelCommands({ resources, operations: { open: async () => { opens++; return { ok: true }; } } });
  panel.request("open"); await tick();
  const order = [];
  const recovered = panel.recover({
    stopOwners(owners) { assert.equal(owners[0].taskId, "old"); order.push("stop"); },
    destroyPage() { order.push("destroy"); endOld(); },
    reopen() { order.push("reopen"); return new Promise(resolve => { finishReopen = resolve; }); },
  });
  await tick();
  const follower = resources.run(["foundry:page"], { taskId: "new" }, null, () => {}, () => order.push("new-task"));
  await tick(); assert.deepEqual(order, ["stop", "destroy", "reopen"]); assert.equal(opens, 0);
  assert.equal(panel.request("open").existing, true);
  finishReopen({ ok: true }); assert.equal((await recovered).ok, true); await follower;
  assert.deepEqual(order, ["stop", "destroy", "reopen", "new-task"]);
  assert.equal(panel.snapshot().command.action, "recover"); assert.equal(resources.active.size, 0);
});

test("a failed recovery retains the original unresolved resource and reports the error", async () => {
  const resources = new ResourceCoordinator(); let end;
  const old = new Promise(resolve => { end = resolve; });
  await resources.run(["foundry:page"], { taskId: "old" }, null, () => {}, () => { retainResourceUntil(old); });
  const panel = new PanelCommands({ resources, operations: {} });
  const result = await panel.recover({ stopOwners() { throw new Error("stop failed"); }, destroyPage() { assert.fail(); }, reopen() { assert.fail(); } });
  assert.equal(result.ok, false); assert.equal(panel.snapshot().command.error, "stop failed");
  assert.equal(resources.active.size, 1); end(); await tick(); assert.equal(resources.active.size, 0);
});

test("panel navigation waits behind task work, repeated requests coalesce, and queued cancellation never navigates", async () => {
  const resources = new ResourceCoordinator(), calls = [];
  const lease = await resources.acquire(["foundry:page"], { taskId: "A", name: "Task A" });
  const panel = new PanelCommands({ resources, operations: { open: async () => { calls.push("open"); return { ok: true }; } } });
  const ack = panel.request("open"); await tick();
  assert.equal(panel.snapshot().command.waitingFor.holders[0].name, "Task A");
  assert.equal(panel.request("open").command.id, ack.command.id);
  assert.equal(panel.cancel("stale").ok, false);
  assert.equal(panel.cancel(ack.command.id).ok, true); await panel.run;
  assert.equal(panel.snapshot().command.state, "cancelled"); lease.release(); await tick();
  assert.deepEqual(calls, []);
  panel.request("open"); await panel.run;
  assert.deepEqual(calls, ["open"]); assert.equal(panel.snapshot().command.state, "completed");
});

test("panel load completion gates task work and failed loads report failure", async () => {
  const resources = new ResourceCoordinator(); let complete;
  const panel = new PanelCommands({ resources, operations: { reload: () => new Promise(resolve => { complete = resolve; }) } });
  const ack = panel.request("reload"); await tick();
  assert.equal(panel.snapshot().command.state, "running");
  assert.equal(panel.cancel(ack.command.id).code, "ALREADY_STARTED");
  let began = false;
  const task = resources.run(["foundry:page"], { taskId: "B" }, null, () => {}, () => { began = true; });
  await tick(); assert.equal(began, false);
  complete({ ok: false, error: "load failed" }); await panel.run; await task;
  assert.equal(panel.snapshot().command.state, "failed"); assert.equal(began, true);
  const copy = panel.snapshot(); copy.command.state = "completed";
  assert.equal(panel.snapshot().command.state, "failed");
});
