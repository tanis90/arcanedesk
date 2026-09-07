import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { evaluateNavigationSafe, readFoundryPageState } from "../src/main/foundry-web.js";
import { ResourceCoordinator } from "../src/main/scheduling/resource-coordinator.js";
import { AgentHost } from "../src/main/agent-host.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

class FakeWebContents extends EventEmitter {
  constructor(evaluate) {
    super();
    this.evaluate = evaluate;
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  executeJavaScript(code) {
    return this.evaluate(code, this);
  }
}

test("browser evaluation returns ordinary values", async () => {
  const webContents = new FakeWebContents(async () => ({ ready: true }));
  const result = await evaluateNavigationSafe(webContents, "window.game", { timeoutMs: 100 });

  assert.deepEqual(result, { status: "completed", value: { ready: true } });
});

test("browser evaluation settles on navigation even when the old page promise hangs", async () => {
  const webContents = new FakeWebContents(() => new Promise(() => {}));
  const resultPromise = evaluateNavigationSafe(webContents, "location.reload()", { timeoutMs: 1_000 });
  queueMicrotask(() => {
    webContents.emit("did-start-navigation", {}, "http://localhost:30000/game", false, true);
  });

  assert.deepEqual(await resultPromise, {
    status: "navigated",
    url: "http://localhost:30000/game",
  });
});

test("browser evaluation supports timeout and abort", async () => {
  const webContents = new FakeWebContents(() => new Promise(() => {}));
  assert.deepEqual(await evaluateNavigationSafe(webContents, "never", { timeoutMs: 10 }), {
    status: "timeout",
    timeoutMs: 10,
  });

  const controller = new AbortController();
  const aborted = evaluateNavigationSafe(webContents, "never", { timeoutMs: 1_000, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { status: "aborted" });
});

test("Foundry page state reports direct runtime readiness without module state", async () => {
  let expression = "";
  const webContents = new FakeWebContents(async (code) => {
    expression = code;
    return { detected: true, path: "/game", ready: true, gm: true, runtimeReady: true };
  });

  assert.deepEqual(await readFoundryPageState(webContents), {
    ok: true,
    state: { detected: true, path: "/game", ready: true, gm: true, runtimeReady: true },
  });
  assert.match(expression, /runtimeReady/);
  assert.doesNotMatch(expression, /arcane-agent-bridge|moduleActive/);
});

test("timed-out page execution retains its resource until the underlying promise settles", async () => {
  const raw = deferred(), r = new ResourceCoordinator();
  const wc = new FakeWebContents(() => raw.promise);
  const outcome = await r.run(["foundry:page"], { taskId: "A" }, null, () => {},
    () => evaluateNavigationSafe(wc, "slow write", { timeoutMs: 5 }));
  assert.equal(outcome.status, "timeout");
  let calls = 0;
  const next = r.run(["foundry:page"], { taskId: "B" }, null, () => {}, () => { calls++; });
  await tick(); assert.equal(calls, 0); assert.equal(r.active.size, 1);
  raw.resolve("written"); await next;
  assert.equal(calls, 1); assert.equal(r.active.size, 0); assert.equal(wc.eventNames().length, 0);
});

test("abort after dispatch cannot release a page operation; a queued follower can be cancelled", async () => {
  const raw = deferred(), started = deferred(), r = new ResourceCoordinator();
  const wc = new FakeWebContents(() => { started.resolve(); return raw.promise; });
  const abort = new AbortController();
  const first = r.run(["foundry:page"], {}, abort.signal, () => {},
    () => evaluateNavigationSafe(wc, "slow", { signal: abort.signal }));
  await started.promise; abort.abort(); assert.equal((await first).status, "aborted");
  const queued = new AbortController(); let calls = 0;
  const second = r.run(["foundry:page"], {}, queued.signal, () => {}, () => { calls++; }).catch(e => e.name);
  queued.abort(); assert.equal(await second, "AbortError"); assert.equal(calls, 0); assert.equal(r.active.size, 1);
  raw.resolve(); await tick(); assert.equal(r.active.size, 0);
});

test("navigation request is insufficient: lease waits for committed navigation or destroyed renderer", async () => {
  for (const event of ["did-navigate", "destroyed", "render-process-gone"]) {
    const r = new ResourceCoordinator(), raw = deferred();
    const wc = new FakeWebContents(() => raw.promise);
    const work = r.run(["foundry:page"], {}, null, () => {}, () => evaluateNavigationSafe(wc, "navigate"));
    await tick(); wc.emit("did-start-navigation", {}, "/game", false, true);
    assert.equal((await work).status, "navigated");
    raw.resolve(); await tick(); assert.equal(r.active.size, 1);
    wc.emit(event); await tick(); assert.equal(r.active.size, 0); assert.equal(wc.eventNames().length, 0);
  }
});

test("failed navigation does not release a still-running script", async () => {
  const r = new ResourceCoordinator(), raw = deferred();
  const wc = new FakeWebContents(() => raw.promise);
  const work = r.run(["foundry:page"], {}, null, () => {}, () => evaluateNavigationSafe(wc, "navigate"));
  await tick(); wc.emit("did-start-navigation", {}, "/game", false, true); await work;
  wc.emit("did-fail-load", {}, -2, "failed", "/game", true);
  await tick(); assert.equal(r.active.size, 1);
  raw.resolve(); await tick(); assert.equal(r.active.size, 0); assert.equal(wc.eventNames().length, 0);
});

test("agent page tools and structured runtime share admission and reacquire the current view", async () => {
  const r = new ResourceCoordinator(), raw = deferred(), started = deferred();
  let view = { webContents: new FakeWebContents(() => { started.resolve(); return raw.promise; }) };
  const create = id => {
    const h = new AgentHost({ resources: r, profile: { mode: "prep" }, getFoundryView: () => view, sendToRenderer() {},
      foundryRuntime: { call: async () => ({ ready: true }) }, openFoundry: async () => ({ ok: true, summary: "opened" }), log() {} });
    h.sessionManager = { getSessionId: () => id, getSessionName: () => id };
    h.taskCoordinator().task = { id, state: "running" }; return h;
  };
  const a = create("A"), b = create("B");
  const tool = (h, name) => h.buildTools().find(t => t.name === name);
  const first = tool(a, "browser_evaluate").execute("one", { code: "write" });
  await started.promise;
  const second = tool(b, "browser_evaluate").execute("two", { code: "read" });
  await tick(); assert.equal(b.task.state, "waiting_resource"); assert.equal(b.task.waitingFor.holders[0].taskId, "A");
  let newCalls = 0;
  view = { webContents: new FakeWebContents(async () => { newCalls++; return "new-page"; }) };
  raw.resolve("done"); await first; await second; assert.equal(newCalls, 1);
  const held = await r.acquire(["foundry:page"], { taskId: "external" });
  const structured = tool(b, "world_status").execute("status", {});
  await tick(); assert.equal(b.task.state, "waiting_resource");
  held.release(); await structured; assert.equal(b.task.state, "running");
});

test("AgentHost stop stays stopping until an aborted page script actually finishes", async () => {
  const r = new ResourceCoordinator(), raw = deferred(), started = deferred(), abort = new AbortController();
  const wc = new FakeWebContents(() => { started.resolve(); return raw.promise; });
  const h = new AgentHost({ resources: r, profile: { mode: "prep" }, getFoundryView: () => ({ webContents: wc }),
    sendToRenderer() {}, log() {} });
  h.sessionManager = { getSessionId: () => "A", getSessionName: () => "A" };
  h.session = {
    prompt: () => h.buildTools().find(tool => tool.name === "browser_evaluate").execute("write", { code: "slow" }, abort.signal),
    abort: async () => abort.abort(), clearQueue() {},
  };
  h.submitInput("write", [], "command"); await started.promise;
  const stop = h.tasks.stop(h.task.id); await tick();
  assert.equal(h.task.state, "stopping"); assert.equal(h.busy, true); assert.equal(r.active.size, 1);
  assert.equal(h.submitInput("next", [], "next").code, "TASK_STOPPING");
  raw.resolve("done"); await stop;
  assert.equal(h.task.state, "stopped"); assert.equal(h.busy, false); assert.equal(r.active.size, 0);
});
