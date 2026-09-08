import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/main/conversations/session-registry.js";
import { AgentHost } from "../src/main/agent-host.js";
import { ModeHostController } from "../src/main/mode-host-controller.js";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function runInput(host, text) { host.submitInput(text, []); return host.tasks.run; }

function harness(root = null) {
  let count = 0;
  const created = [];
  const registry = new SessionRegistry({ createHost: () => {
    const events = [];
    const host = new AgentHost({ sendToRenderer: e => events.push(e), log: () => {} });
    const gate = deferred();
    host.start = async ({ sessionPath } = {}) => {
      if (root && sessionPath && !existsSync(sessionPath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const name = `session-${++count}`;
      const id = sessionPath ?? (root ? path.join(root, name) : name);
      host.sessionManager = { getSessionId: () => id, getSessionFile: () => id,
        getSessionName: () => "test" };
      host.session = { messages: [], prompt: () => gate.promise, abort: async () => gate.resolve(), dispose() {} };
    };
    host.listSessions = async () => [];
    if (root) host.openSessionManager = () => {};
    created.push({ host, gate, events });
    return host;
  } });
  return { registry, created };
}

test("resident list metadata uses the native journal while the first turn is not flushed", async () => {
  const { registry } = harness();
  const host = await registry.start();
  const id = host.describeCurrent().id;
  host.listSessions = async () => [{ id, firstMessage: "(no messages)", messageCount: 0, modified: 10 }];
  host.sessionManager.getEntries = () => [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "First\n request" }] } },
    { type: "message", message: { role: "assistant", content: "previous branch" } },
    { type: "session_info", name: "test" },
  ];
  host.session.messages = []; // Compacted/selected branch is not the entire native journal.
  const [row] = await registry.listSessions();
  assert.equal(row.firstMessage, "First request");
  assert.equal(row.messageCount, 2);
  assert.equal(row.modified, 10, "metadata correction must not invent newer activity ordering");
  assert.equal(row.name, "test");
});

test("deletion blocks input and reopening, waits for stop, coalesces retries and preserves later selection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-delete-"));
  const { registry, created } = harness(root);
  const a = await registry.start(), file = a.describeCurrent().path;
  writeFileSync(file, "history");
  const run = runInput(a, "work"), stopped = deferred(); let aborts = 0;
  await new Promise(resolve => setImmediate(resolve));
  a.session.abort = async () => { aborts++; await stopped.promise; created[0].gate.resolve(); };
  const deleting = registry.deleteSession(file), again = registry.deleteSession(file);
  assert.equal(a.submitInput("late", [], "late").code, "SESSION_DELETING");
  await assert.rejects(registry.select(file), { code: "SESSION_DELETING" });
  const b = await registry.select(null, true);
  assert.equal(existsSync(file), true); assert.equal(a.busy, true);
  stopped.resolve(); assert.equal((await deleting).ok, true); assert.equal((await again).ok, true); await run;
  assert.equal(aborts, 1); assert.equal(existsSync(file), false); assert.equal(a.session, null);
  assert.equal(registry.activeHost, b); assert.equal(registry.get(a.describeCurrent().id), undefined);
  await assert.rejects(registry.select(file), { code: "ENOENT" });
});

test("deletion during historical loading retires the uninstalled host before removing the file", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "arcane-delete-load-")), "history.jsonl");
  writeFileSync(file, "history");
  const gate = deferred(); let disposed = 0;
  const registry = new SessionRegistry({ createHost: () => ({
    start: () => gate.promise, describeCurrent: () => ({ id: "loaded", path: file }), dispose: () => { disposed++; },
  }) });
  registry.activeHost = { openSessionManager() { return { getSessionId: () => "loaded" }; } };
  const loading = registry.select(file).catch(error => error.code);
  const deleting = registry.deleteSession(file);
  assert.equal(existsSync(file), true); gate.resolve();
  assert.equal(await loading, "SESSION_DELETING"); assert.equal((await deleting).ok, true);
  assert.equal(disposed, 1); assert.equal(registry.allHosts().length, 0); assert.equal(existsSync(file), false);
});

test("deletion waits for an already started model write before unlinking history", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-delete-model-"));
  const { registry } = harness(root);
  const host = await registry.start(), file = host.describeCurrent().path, gate = deferred();
  writeFileSync(file, "original");
  host.modelRuntime = { getModel: (provider, id) => ({ provider, id }) };
  host.session.model = { provider: "p", id: "old" };
  host.session.setModel = async () => { await gate.promise; writeFileSync(file, "model change"); };
  const changing = host.setCurrentModel("p", "new");
  const deleting = registry.deleteSession(file);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(existsSync(file), true);
  gate.resolve(); await changing;
  assert.equal((await deleting).ok, true);
  assert.equal(existsSync(file), false); assert.equal(host.retired, true);
});

test("failed filesystem deletion preserves the file and allows opening a fresh host", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-delete-failure-"));
  const { registry } = harness(root);
  const a = await registry.select(root);
  const result = await registry.deleteSession(root); // unlink cannot remove a directory
  assert.equal(result.ok, false); assert.equal(a.retired, true);
  assert.notEqual(await registry.select(root), a); assert.equal(existsSync(root), true);
});

test("replacement startup failure cannot report an already committed deletion as failed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-delete-replacement-"));
  const { registry } = harness(root);
  const a = await registry.start(), file = a.describeCurrent().path;
  writeFileSync(file, "history");
  const create = registry.createHost;
  registry.createHost = () => ({ start: async () => { throw new Error("startup failed"); }, dispose() {} });
  const result = await registry.deleteSession(file);
  assert.equal(result.ok, true); assert.equal(result.warning, "startup failed");
  assert.equal(existsSync(file), false); assert.equal(registry.activeHost, null);
  registry.createHost = create; assert.ok(await registry.start());
});

test("mode controller recovers an empty registry after deletion replacement fails, sharing retry initialization", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-mode-recovery-"));
  const { registry, created } = harness(root);
  const controller = new ModeHostController({ hosts: { prep: registry, combat: harness().registry } });
  const initial = await controller.readySnapshot();
  const file = initial.host.describeCurrent().path;
  writeFileSync(file, "history");
  const create = registry.createHost;
  registry.createHost = () => ({ start: async () => { throw new Error("startup failed"); }, dispose() {} });
  assert.equal((await registry.deleteSession(file)).ok, true);
  assert.equal(registry.activeHost, null);
  assert.equal(controller.matches(initial), false);
  await assert.rejects(controller.ensureStarted("prep"), /startup failed/);
  const gate = deferred();
  registry.createHost = () => {
    const host = create(), start = host.start;
    host.start = async options => { await gate.promise; await start(options); };
    return host;
  };
  const first = controller.ensureStarted("prep"), second = controller.ensureStarted("prep");
  assert.equal(first, second, "concurrent recovery shares one start promise");
  const ready = controller.readySnapshot();
  gate.resolve(); await Promise.all([first, second]);
  const recovered = await ready;
  assert.equal(created.length, 2, "recovery creates only one replacement host");
  assert.equal(recovered.host, registry.activeHost);
  assert.notEqual(recovered.host, initial.host);
  assert.equal(controller.matches(recovered), true);
  assert.equal(existsSync(file), false, "recovery never recreates the deleted session");
  assert.equal((await controller.switchTo("prep")).host, recovered.host);
});

test("same-mode A to B to A retains running host; stopping A does not stop B", async () => {
  const { registry, created } = harness();
  const a = await registry.start();
  const aRun = runInput(a, "A");
  const aTask = a.task.id;
  const b = await registry.select(null, true);
  const bRun = runInput(b, "B");
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

test("initialization without a selected host reuses a live resident instead of recreating its SDK session", async () => {
  const { registry, created } = harness();
  const b = await registry.start();
  const running = runInput(b, "background task");
  registry.activeHost = null; // Selected A was removed and its replacement failed.
  try {
    assert.equal(await registry.start(), b);
    assert.equal(registry.get(b.describeCurrent().id), b);
    assert.equal(created.length, 1);
    assert.equal(b.busy, true);
  } finally { created[0].gate.resolve(); await running; }
});

test("stale task stop never aborts a later task", async () => {
  const { registry } = harness();
  const host = await registry.start();
  const run = runInput(host, "task");
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
    setBusy: value => states.push(value), showTaskState() {} });
  vm.runInContext(handler, context);
  context.onEvent({ type: "task_state", mode: "prep", sessionId: "A", taskId: "a", task: { id: "a", state: "completed" } });
  context.onEvent({ type: "task_state", mode: "prep", sessionId: "B", taskId: "old", task: { id: "old", state: "completed" } });
  assert.deepEqual(states, []);
  context.onEvent({ type: "task_state", mode: "prep", sessionId: "B", taskId: "new", task: { id: "new", state: "completed" } });
  assert.deepEqual(states, [false]);
});
