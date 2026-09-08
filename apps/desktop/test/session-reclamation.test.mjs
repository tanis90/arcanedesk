import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { SessionRegistry } from "../src/main/conversations/session-registry.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-reclaim-")), events = [];
  const registry = new SessionRegistry({ createHost: () => {
    const host = new AgentHost({ profile: { mode: "prep", getCwd: () => root }, taskStorageDir: path.join(root, "tasks"),
      sendToRenderer: event => events.push(event), log() {} });
    host.start = async ({ sessionPath } = {}) => {
      host.sessionManager = sessionPath ? SessionManager.open(sessionPath) : SessionManager.create(root, path.join(root, "sessions"));
      host.session = { model: { provider: "p", id: "m" }, messages: [], dispose() {},
        prompt: async text => { host.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); } };
      host.taskCoordinator();
    };
    return host;
  } });
  return { registry, root, events };
}

test("empty and user-only SDK sessions survive eviction with identity and appendable history", async () => {
  const { registry, events } = fixture();
  const empty = await registry.start(), emptyId = empty.describeCurrent().id;
  const worked = await registry.select(null, true), workedId = worked.describeCurrent().id;
  const accepted = worked.submitInput("hello", [], "command"); await worked.tasks.run;
  const selected = await registry.select(null, true);
  assert.equal(existsSync(empty.describeCurrent().path), false);
  const removed = registry.prune({ now: Date.now() + 600_000, idleMs: 1, keepIdle: 0 });
  assert.deepEqual(new Set(removed), new Set([emptyId, workedId]));
  const before = events.length; worked.emit({ type: "message", text: "late" }); assert.equal(events.length, before);
  const restored = await registry.getOrLoad(workedId);
  assert.notEqual(restored, worked); assert.equal(registry.activeHost, selected);
  assert.equal(restored.describeCurrent().id, workedId);
  assert.equal(restored.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.content === "hello"), true);
  const resent = restored.submitInput("hello", [], "command");
  assert.notEqual(resent.inputId, accepted.inputId);
  assert.equal(resent.duplicate, undefined);
  await restored.tasks.run;
  restored.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() });
  const lines = readFileSync(restored.describeCurrent().path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.filter(entry => entry.type === "session").length, 1);
  assert.equal((await registry.getOrLoad(emptyId)).sessionManager.getHeader().id, emptyId);
});

test("active work, operations, recent use and failed persistence prevent eviction", async () => {
  const { registry } = fixture();
  const busy = await registry.start(); busy.tasks.task = { id: "busy", state: "waiting_user" };
  const operation = await registry.select(null, true); operation.operations = 1;
  const recent = await registry.select(null, true);
  const failed = await registry.select(null, true); failed.persistForEviction = () => { throw new Error("disk full"); };
  await registry.select(null, true);
  for (const host of [busy, operation, failed]) host.lastUsedAt = 0;
  assert.deepEqual(registry.prune({ idleMs: 300_000, keepIdle: 0 }), []);
  assert.equal(registry.get(recent.describeCurrent().id), recent);
  assert.equal(registry.allHosts().length, 5);
});

test("default idle retention keeps four recent eligible hosts plus the selected session", async () => {
  const { registry } = fixture();
  for (let i = 0; i < 10; i++) { const host = await registry.select(null, true); host.lastUsedAt = i; }
  const selected = registry.activeHost;
  const removed = registry.prune({ now: 600_000 });
  assert.equal(removed.length, 5); assert.equal(registry.allHosts().length, 5);
  assert.equal(registry.activeHost, selected); assert.equal(registry.evicted.size, 5);
});
