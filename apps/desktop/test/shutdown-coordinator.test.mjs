import test from "node:test";
import assert from "node:assert/strict";
import { ShutdownCoordinator } from "../src/main/conversations/shutdown-coordinator.js";
import { SessionRegistry } from "../src/main/conversations/session-registry.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("exit waits for all actual task stops and resource settlement before finish", async () => {
  const a = deferred(), b = deferred(), resource = deferred(); let finished = false, closed = false;
  const host = (id, gate) => ({ busy: true, task: { id }, async abort(taskId) { assert.equal(taskId, id); await gate.promise; this.busy = false; return { ok: true }; } });
  const hosts = [host("A", a), host("B", b)];
  const shutdown = new ShutdownCoordinator({ registries: [{ allHosts: () => hosts, pending: new Map() }],
    gate: value => { closed = value; }, quiesce: () => resource.promise, finish: () => { finished = true; } });
  const run = shutdown.stop(); assert.equal(closed, true); await tick();
  a.resolve(); await tick(); assert.equal(shutdown.snapshot().remaining, 1); assert.equal(finished, false);
  b.resolve(); await tick(); assert.equal(shutdown.snapshot().remaining, 0); assert.equal(finished, false);
  resource.resolve(); await run; assert.equal(finished, true);
});

test("cancelled exit cannot quit after late stop completion and a later exit includes new tasks", async () => {
  const stop = deferred(); let finished = 0, closed = false;
  const first = { busy: true, task: { id: "A" }, async abort() { await stop.promise; this.busy = false; } };
  const hosts = [first];
  const shutdown = new ShutdownCoordinator({ registries: [{ allHosts: () => hosts, pending: new Map() }],
    gate: value => { closed = value; }, quiesce: async () => {}, finish: () => { finished++; } });
  const old = shutdown.stop(); await tick(); shutdown.cancel(); assert.equal(closed, false);
  stop.resolve(); await old; assert.equal(finished, 0);
  const next = { busy: true, task: { id: "B" }, async abort() { this.busy = false; } }; hosts.push(next);
  await shutdown.stop(); assert.equal(next.busy, false); assert.equal(finished, 1);
});

test("stop failure keeps the app open and releases admission instead of pretending it quit", async () => {
  const host = { busy: true, task: { id: "A" }, abort: async () => { throw new Error("stop failed"); } };
  let closed;
  const shutdown = new ShutdownCoordinator({ registries: [{ allHosts: () => [host], pending: new Map() }],
    gate: value => { closed = value; }, quiesce: async () => {}, finish: () => assert.fail() });
  await shutdown.stop(); assert.equal(closed, false); assert.equal(host.busy, true);
  assert.equal(shutdown.snapshot().state, "failed");
});

test("shutdown retires an in-progress host load before it can become a new resident session", async () => {
  const load = deferred(); let disposed = false, finished = false;
  const registry = new SessionRegistry({ createHost: () => ({ start: () => load.promise,
    describeCurrent: () => ({ id: "A", path: "history" }), dispose: () => { disposed = true; } }) });
  const opening = registry.select("history").catch(error => error.code);
  const shutdown = new ShutdownCoordinator({ registries: [registry], gate: value => { registry.closing = value; },
    quiesce: async () => {}, finish: () => { finished = true; } });
  const exiting = shutdown.stop(); load.resolve(); await exiting;
  assert.equal(await opening, "APP_STOPPING"); assert.equal(disposed, true); assert.equal(finished, true);
  assert.equal(registry.allHosts().length, 0);
});
