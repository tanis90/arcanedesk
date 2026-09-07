import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionScheduler, TaskAdmission } from "../src/main/scheduling/execution-scheduler.js";
import { TaskCoordinator } from "../src/main/tasks/task-coordinator.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("two tasks run concurrently, FIFO waiters cancel without starting, and release is idempotent", async () => {
  const scheduler = new ExecutionScheduler({ capacity: 2 });
  const a = await scheduler.acquire({ taskId: "a" });
  const b = await scheduler.acquire({ taskId: "b" });
  const signal = new AbortController(); const order = [];
  const c = scheduler.acquire({ taskId: "c" }, signal.signal).then(() => order.push("c"), error => error.name);
  const d = scheduler.acquire({ taskId: "d" }).then(lease => { order.push("d"); return lease; });
  signal.abort(); assert.equal(await c, "AbortError");
  a.release(); a.release();
  const lease = await d;
  assert.deepEqual(order, ["d"]); assert.equal(scheduler.active.size, 2);
  b.release(); lease.release(); assert.equal(scheduler.active.size, 0);
});

test("cancelling a queued coordinator never calls its prompt and retains cancelled inputs", async () => {
  const scheduler = new ExecutionScheduler({ capacity: 1 });
  const lease = await scheduler.acquire({ taskId: "holder" });
  let calls = 0;
  const coordinator = new TaskCoordinator({ sessionId: "A", scheduler, adapter: { prompt: async () => { calls++; }, abort: async () => {} } });
  const ack = coordinator.submit({ text: "wait" });
  await tick(); assert.equal(coordinator.task.state, "queued");
  await coordinator.stop(ack.taskId);
  assert.equal(coordinator.task.state, "cancelled"); assert.equal(calls, 0);
  assert.equal(coordinator.inputs.get(ack.inputId).state, "cancelled");
  lease.release(); await tick(); assert.equal(calls, 0);
});

test("waiting for multiple user answers releases once and resumes only after all answers and capacity", async () => {
  const scheduler = new ExecutionScheduler({ capacity: 1 }); const states = [];
  const admission = new TaskAdmission(scheduler, { taskId: "A" }, state => states.push(state));
  await admission.acquire();
  const first = deferred(), second = deferred(); let resumed = 0;
  const one = admission.waitForUser(first.promise).then(() => resumed++);
  const two = admission.waitForUser(second.promise).then(() => resumed++);
  const other = await scheduler.acquire({ taskId: "B" });
  first.resolve(); await tick(); assert.equal(resumed, 0);
  second.resolve(); await tick(); assert.equal(states.at(-1), "queued"); assert.equal(resumed, 0);
  other.release(); await Promise.all([one, two]);
  assert.equal(resumed, 2); assert.equal(scheduler.active.size, 1);
  admission.release(); assert.equal(scheduler.active.size, 0);
});

test("stop keeps the execution lease until the actual prompt exits", async () => {
  const scheduler = new ExecutionScheduler({ capacity: 1 }); const gate = deferred(); let stopped = false;
  const a = new TaskCoordinator({ sessionId: "A", scheduler, adapter: { prompt: () => gate.promise, abort: async () => { stopped = true; } } });
  const b = new TaskCoordinator({ sessionId: "B", scheduler, adapter: { prompt: async () => {}, abort: async () => {} } });
  a.submit({ text: "A" }); await tick(); b.submit({ text: "B" });
  const stopping = a.stop(a.task.id); await tick();
  assert.equal(stopped, true); assert.equal(b.task.state, "queued");
  gate.resolve(); await stopping; await b.run;
  assert.equal(a.task.state, "stopped"); assert.equal(b.task.state, "completed");
  assert.equal(scheduler.active.size, 0);
});
