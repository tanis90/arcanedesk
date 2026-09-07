import test from "node:test";
import assert from "node:assert/strict";
import { PanelCommands } from "../src/main/scheduling/panel-commands.js";
import { ResourceCoordinator } from "../src/main/scheduling/resource-coordinator.js";
const tick = () => new Promise(resolve => setImmediate(resolve));

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
