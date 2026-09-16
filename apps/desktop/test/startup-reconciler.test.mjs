import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { listStoredSessions } from "../src/main/conversations/session-catalog.js";
import { StartupReconciler } from "../src/main/conversations/startup-reconciler.js";
import { SessionNavigation } from "../src/main/conversations/session-navigation.js";
import { SessionRegistry } from "../src/main/conversations/session-registry.js";
import { AgentHost } from "../src/main/agent-host.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-reconcile-"));
  const directory = path.join(root, "sessions", "arcane-desktop-prep"); mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "a.jsonl");
  writeFileSync(file, [
    { type: "session", id: "a", cwd: root, timestamp: new Date().toISOString() },
    { type: "custom", customType: "arcane.session", data: { mode: "prep", schemaVersion: 1 } },
    { type: "message", message: { role: "user", content: "First input" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const config = path.join(root, "config"); mkdirSync(config);
  const navigation = new SessionNavigation({ file: path.join(config, "navigation.json") });
  const activity = { rows: new Map([["a", {}], ["orphan", {}]]), remove(id) { this.rows.delete(id); } };
  const list = () => listStoredSessions(root, "prep");
  const reconciler = new StartupReconciler({ directory: config, navigation, activity: () => activity, listSessions: list });
  return { root, directory, file, config, navigation, activity, list, reconciler };
}

test("disk inventory lists a session without constructing or starting an execution host", async () => {
  const h = fixture();
  const registry = new SessionRegistry({ listStored: h.list, createHost: () => assert.fail("must not initialize a host") });
  const rows = await registry.listSessions();
  assert.equal(rows.length, 1); assert.equal(rows[0].id, "a"); assert.equal(rows[0].firstMessage, "First input");
  assert.equal(registry.activeHost, null); assert.equal(registry.allHosts().length, 0);
  registry.hosts.set("missing", { describeCurrent: () => ({ id: "missing", path: "missing.jsonl" }) });
  assert.equal((await registry.listSessions()).length, 1, "resident metadata cannot invent a missing conversation");
});

test("complete inventory removes orphan data and ignores obsolete deletion log facts", async () => {
  const h = fixture();
  for (const folder of ["tasks", "pending-inputs"]) {
    mkdirSync(path.join(h.config, folder));
    for (const id of ["a", "orphan"]) writeFileSync(path.join(h.config, folder, id + ".json"), "retained input");
  }
  h.navigation.patch("orphan", { customTitle: "old" }); h.navigation.patch("a", { customTitle: "live" });
  writeFileSync(path.join(h.config, "session-deletions.jsonl"), "unreadable old deletion log");
  const project = path.join(h.root, "project.txt"); writeFileSync(project, "user work");
  assert.deepEqual(await h.reconciler.run(), ["a"]);
  assert.equal(existsSync(path.join(h.config, "pending-inputs", "orphan.json")), false);
  assert.equal(existsSync(path.join(h.config, "pending-inputs", "a.json")), true);
  assert.equal(h.activity.rows.has("orphan"), false); assert.deepEqual(h.navigation.get("orphan"), {});
  assert.equal(h.navigation.get("a").customTitle, "live");
  assert.equal(existsSync(path.join(h.config, "session-deletions.jsonl")), false);
  unlinkSync(h.file); await h.reconciler.run();
  assert.equal(existsSync(path.join(h.config, "pending-inputs", "a.json")), false);
  assert.equal(readFileSync(project, "utf8"), "user work");
});

test("a failed scan never authorizes orphan cleanup", async () => {
  const h = fixture(); h.navigation.patch("orphan", { customTitle: "keep" });
  mkdirSync(path.join(h.directory, "unreadable.jsonl"));
  await assert.rejects(h.reconciler.run());
  assert.equal(h.navigation.get("orphan").customTitle, "keep"); assert.equal(h.activity.rows.has("orphan"), true);
});

test("opening an absent history file fails instead of creating a replacement identity", () => {
  const h = fixture(); const host = new AgentHost({ log() {}, sendToRenderer() {} });
  host.sessionDir = () => h.directory;
  const missing = path.join(h.directory, "missing.jsonl");
  assert.throws(() => host.openSessionManager(missing), { code: "ENOENT" });
  assert.equal(existsSync(missing), false);
});

test("archive and damaged navigation metadata do not block submitting or compacting", async () => {
  const h = fixture(); h.navigation.patch("a", { archivedAt: Date.now() });
  const host = new AgentHost({ log() {}, sendToRenderer() {} }); host.navigation = h.navigation;
  host.sessionManager = { getSessionId: () => "a", getSessionName: () => "a" };
  let calls = 0;
  host.session = { prompt: async () => { calls++; }, compact: async () => ({ tokensBefore: 42 }) };
  assert.equal(host.submitInput("archived", [], "one").ok, true); await host.tasks.run;
  h.navigation.error = "damaged metadata";
  assert.equal(host.submitInput("damaged", [], "two").ok, true); await host.tasks.run;
  assert.equal((await host.compact()).tokensBefore, 42); assert.equal(calls, 2);
});
