import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { ResourceCoordinator, filesystemResource } from "../src/main/scheduling/resource-coordinator.js";
import { AgentHost, arcaneShellTool } from "../src/main/agent-host.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function directory() { return mkdtempSync(path.join(os.tmpdir(), "arcane-resource-")); }
function host(id, cwd, resources) {
  const h = new AgentHost({ resources, profile: { mode: "prep", getCwd: () => cwd }, sendToRenderer() {}, log() {} });
  h.sessionManager = { getSessionId: () => id, getSessionName: () => `Task ${id}` };
  h.taskCoordinator().task = { id, state: "running" };
  return h;
}

test("canonical resources identify aliases and nonexistent child targets", () => {
  const root = directory(); const real = path.join(root, "real"), alias = path.join(root, "alias");
  mkdirSync(real); symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(filesystemResource(real), filesystemResource(alias));
  assert.equal(filesystemResource(path.join(real, "future", "a.txt")), filesystemResource(path.join(alias, "future", "a.txt")));
});

test("SDK path aliases conflict with the actual target in another workspace", async () => {
  for (const spelling of [file => `@${file}`, file => pathToFileURL(file).href]) {
    const cwd = directory(), target = directory(), r = new ResourceCoordinator();
    const a = host("alias", cwd, r), held = await r.acquire([filesystemResource(target)], { taskId: "holder" });
    let writes = 0;
    const tool = a.coordinateWorkspaceTool(createWriteTool(cwd, { operations: { mkdir: async () => {}, writeFile: async () => { writes++; } } }));
    const work = tool.execute("alias", { path: spelling(path.join(target, "file.txt")), content: "x" });
    await tick(); assert.equal(writes, 0); assert.equal(a.task.state, "waiting_resource");
    held.release(); await work; assert.equal(writes, 1);
  }
});

test("conflicting waiters stay FIFO while unrelated resources proceed; multi-resource requests do not deadlock", async () => {
  const r = new ResourceCoordinator(); const waits = [];
  const held = await r.acquire(["page", "world"], { taskId: "holder" });
  const a = r.acquire(["world", "page"], { taskId: "A" }, null, info => waits.push(info));
  const b = r.acquire(["page"], { taskId: "B" });
  const independent = await r.acquire(["other"], { taskId: "C" });
  assert.equal(r.active.size, 2); assert.equal(waits[0].holders[0].taskId, "holder");
  held.release(); const leaseA = await a;
  assert.equal(r.queue.length, 1); leaseA.release(); const leaseB = await b;
  independent.release(); leaseB.release(); assert.equal(r.active.size, 0);
});

test("queued cancellation is removed before any operation and does not strand following waiters", async () => {
  const r = new ResourceCoordinator(); const held = await r.acquire(["shared"], { taskId: "holder" });
  const signal = new AbortController(); let calls = 0;
  const wait = r.run(["shared"], { taskId: "cancel" }, signal.signal, () => {}, async () => { calls++; }).catch(e => e.name);
  const next = r.acquire(["shared"], { taskId: "next" });
  signal.abort(); assert.equal(await wait, "AbortError");
  held.release(); (await next).release(); assert.equal(calls, 0); assert.equal(r.queue.length, 0);
});

test("wait callbacks can release or cancel without stranding or removing another waiter", async () => {
  const r = new ResourceCoordinator();
  const held = await r.acquire(["shared"], {});
  const next = await r.acquire(["shared"], {}, null, () => held.release());
  next.release();
  const blocker = await r.acquire(["shared"], {});
  const abort = new AbortController();
  const cancelledWait = r.acquire(["shared"], {}, abort.signal, () => { abort.abort(); throw new Error("observer failed"); }).catch(e => e.name);
  const following = r.acquire(["shared"], {});
  assert.equal(await cancelledWait, "AbortError");
  blocker.release(); (await following).release(); assert.equal(r.active.size, 0);
});

test("dynamic resources are rechecked after queue admission before the operation starts", async () => {
  const r = new ResourceCoordinator();
  const workspace = await r.acquire(["workspace"], {});
  const target = await r.acquire(["new-target"], {});
  let destination = "old-target", calls = 0;
  const work = r.run(() => ["workspace", destination], {}, null, () => {}, () => { calls++; });
  destination = "new-target"; workspace.release(); await tick();
  assert.equal(calls, 0); assert.equal(r.queue.length, 1);
  target.release(); await work; assert.equal(calls, 1);
});

test("native shell wrapper and file writes share the workspace lease through shell failure", async () => {
  const cwd = directory(), r = new ResourceCoordinator();
  const a = host("shell", cwd, r), b = host("file", cwd, r);
  const started = deferred(), gate = deferred();
  const shell = a.coordinateWorkspaceTool(arcaneShellTool(cwd, process.execPath, process.platform, {
    exec: async () => { started.resolve(); await gate.promise; throw new Error("shell failed"); },
  }));
  const first = shell.execute("shell", { command: "controlled test" }).catch(e => e.message);
  await started.promise;
  const second = b.coordinateWorkspaceTool(createWriteTool(cwd)).execute("file", { path: "after.txt", content: "done" });
  await tick(); assert.equal(b.task.state, "waiting_resource");
  gate.resolve(); assert.match(await first, /shell failed/); await second;
  assert.equal(readFileSync(path.join(cwd, "after.txt"), "utf8"), "done");
  assert.equal(r.active.size, 0);
});

test("real SDK write retains the workspace lease through abort until its filesystem operation settles", async () => {
  const root = directory(), child = path.join(root, "child"); mkdirSync(child);
  const r = new ResourceCoordinator(), a = host("A", root, r), b = host("B", child, r);
  const gate = deferred(), started = deferred();
  const writeA = a.coordinateWorkspaceTool(createWriteTool(root, { operations: {
    mkdir: async () => {}, writeFile: async (file, content) => { started.resolve(); await gate.promise; writeFileSync(file, content); },
  } }));
  const writeB = b.coordinateWorkspaceTool(createWriteTool(child));
  const signal = new AbortController();
  const first = writeA.execute("a", { path: "a.txt", content: "A" }, signal.signal).catch(error => error.message);
  await started.promise;
  const second = writeB.execute("b", { path: "b.txt", content: "B" });
  await tick(); assert.equal(b.task.state, "waiting_resource");
  assert.equal(b.task.waitingFor.holders[0].sessionId, "A");
  signal.abort(); await tick(); assert.equal(r.active.size, 1); assert.equal(b.task.state, "waiting_resource");
  gate.resolve(); assert.match(await first, /aborted/); await second;
  assert.equal(readFileSync(path.join(child, "b.txt"), "utf8"), "B");
  assert.equal(b.task.state, "running"); assert.equal(r.active.size, 0);
});

test("tools in separate workspaces run concurrently and a cancelled waiter never writes", { timeout: 5000 }, async () => {
  const r = new ResourceCoordinator(), rootA = directory(), rootB = directory();
  const a = host("A", rootA, r), b = host("B", rootB, r);
  const gate = deferred(), bothStarted = deferred(); let started = 0;
  const build = (h, cwd) => h.coordinateWorkspaceTool(createWriteTool(cwd, { operations: {
    mkdir: async () => {}, writeFile: async () => { started++; if (started === 2) bothStarted.resolve(); await gate.promise; },
  } }));
  const first = build(a, rootA).execute("a", { path: "a.txt", content: "A" });
  const second = build(b, rootB).execute("b", { path: "b.txt", content: "B" });
  await bothStarted.promise; assert.equal(started, 2);
  const signal = new AbortController();
  const cancelled = build(a, rootA).execute("c", { path: "c.txt", content: "C" }, signal.signal).catch(error => error.name);
  signal.abort(); assert.equal(await cancelled, "AbortError");
  gate.resolve(); await Promise.all([first, second]); assert.equal(started, 2); assert.equal(r.active.size, 0);
});
