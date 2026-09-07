import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/main/conversations/session-registry.js";
import { AgentHost } from "../src/main/agent-host.js";
import { ModeHostController } from "../src/main/mode-host-controller.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  let count = 0;
  const created = [];
  const registry = new SessionRegistry({ createHost: () => {
    const events = [];
    const host = new AgentHost({ sendToRenderer: e => events.push(e), log: () => {} });
    const gate = deferred();
    host.start = async ({ sessionPath } = {}) => {
      const id = sessionPath ?? `session-${++count}`;
      host.sessionManager = { getSessionId: () => id, getSessionFile: () => id,
        getSessionName: () => "test" };
      host.session = { messages: [], prompt: () => gate.promise, abort: async () => gate.resolve(), dispose() {} };
    };
    host.listSessions = async () => [];
    created.push({ host, gate, events });
    return host;
  } });
  return { registry, created };
}

test("same-mode A to B to A retains running host; stopping A does not stop B", async () => {
  const { registry, created } = harness();
  const a = await registry.start();
  const aRun = a.prompt("A");
  const aTask = a.task.id;
  const b = await registry.select(null, true);
  const bRun = b.prompt("B");
  assert.notEqual(a, b);
  assert.equal(a.busy, true);
  assert.equal(b.busy, true);
  assert.equal(await registry.select(a.describeCurrent().path), a);
  assert.equal(created.length, 2);
  assert.equal(a.task.id, aTask);
  assert.equal((await registry.listSessions()).filter(s => s.busy).length, 2);
  await a.abort(aTask);
  await aRun;
  assert.equal(a.task.state, "stopped");
  assert.equal(b.busy, true);
  created[1].gate.resolve();
  await bRun;
  assert.equal(b.task.state, "completed");
});

test("stale task stop never aborts a later task", async () => {
  const { registry } = harness();
  const host = await registry.start();
  const run = host.prompt("task");
  assert.deepEqual(await host.abort("old-task"), { ok: false, code: "STALE_TASK" });
  assert.equal(host.busy, true);
  await host.abort(host.task.id);
  await run;
});

test("last selection wins even if an earlier session loads later", async () => {
  const slow = deferred();
  const registry = new SessionRegistry({ createHost: () => {
    let id;
    return { async start({ sessionPath }) { id = sessionPath; if (id === "slow") await slow.promise; },
      describeCurrent: () => ({ id, path: id }), dispose() {} };
  } });
  const earlier = registry.select("slow");
  const fast = await registry.select("fast");
  slow.resolve();
  await earlier;
  assert.equal(registry.activeHost, fast);
  assert.equal(registry.allHosts().length, 2);
});

test("mode snapshots capture the actual session host, not a mutable registry", async () => {
  const prep = harness().registry;
  const combat = harness().registry;
  const controller = new ModeHostController({ hosts: { prep, combat } });
  const a = await controller.readySnapshot();
  const b = await prep.select(null, true);
  assert.notEqual(a.host, b);
  assert.equal(controller.matches(a), false);
  assert.equal(controller.snapshot().host, b);
  await controller.switchTo("combat");
  await controller.switchTo("prep");
  assert.equal(controller.snapshot().host, b);
});

test("renderer ignores another session and a previous task's terminal event", () => {
  const source = readFileSync(new URL("../src/renderer/chat.js", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("function onEvent(event)"), source.indexOf("// ---------- slash 候选弹窗"));
  const states = [];
  const context = vm.createContext({ currentMode: "prep", selectedSessionId: "B", selectedTaskId: "new",
    setBusy: value => states.push(value) });
  vm.runInContext(handler, context);
  context.onEvent({ type: "task_state", mode: "prep", sessionId: "A", taskId: "a", task: { id: "a", state: "completed" } });
  context.onEvent({ type: "task_state", mode: "prep", sessionId: "B", taskId: "old", task: { id: "old", state: "completed" } });
  assert.deepEqual(states, []);
  context.onEvent({ type: "task_state", mode: "prep", sessionId: "B", taskId: "new", task: { id: "new", state: "completed" } });
  assert.deepEqual(states, [false]);
});
