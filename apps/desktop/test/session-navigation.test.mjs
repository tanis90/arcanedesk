import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionNavigation, projectKey } from "../src/main/conversations/session-navigation.js";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-navigation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "navigation.json");
  return { file, store: new SessionNavigation({ file }) };
}
test("pin, custom title, archive and restore survive process-independent reload without deleting history", t => {
  const { file, store } = fixture(t);
  const history = file + ".history"; writeFileSync(history, "history and external results");
  store.mutate("a", "rename", "My title"); store.mutate("a", "pin", true);
  const order = store.get("a").pinnedOrder; store.mutate("a", "pin", true);
  assert.equal(store.get("a").pinnedOrder, order);
  store.mutate("b", "pin", true); assert.ok(store.get("b").pinnedOrder > order);
  store.mutate("a", "archive");
  assert.equal(store.get("a").pinnedOrder, undefined);
  const restoredProcess = new SessionNavigation({ file });
  assert.equal(restoredProcess.get("a").customTitle, "My title");
  restoredProcess.mutate("a", "restore");
  assert.equal(restoredProcess.get("a").pinnedOrder, undefined);
  assert.equal(readFileSync(history, "utf8"), "history and external results");
});
test("navigation still disables archiving active work in its own UI action", t => {
  const { store } = fixture(t);
  for (const state of ["queued", "running", "waiting_user", "stopping"]) {
    assert.throws(() => store.mutate("a", "archive", null, { busy: true, task: { state } }), { code: "SESSION_BUSY" });
    assert.equal(store.get("a").archivedAt, undefined);
  }
  assert.throws(() => store.mutate("a", "archive", null, { operations: 1 }), { code: "SESSION_BUSY" });
  store.mutate("a", "archive", null, { busy: false });
  assert.throws(() => store.mutate("a", "restore", null, { deleting: true }), { code: "SESSION_DELETING" });
});
test("failed atomic replace never changes visible metadata or publishes success", t => {
  const { file, store } = fixture(t); store.mutate("a", "rename", "Before");
  let notifications = 0; store.emit = () => notifications++;
  mkdirSync(file + ".tmp");
  assert.throws(() => store.mutate("a", "archive"));
  assert.equal(store.get("a").archivedAt, undefined); assert.equal(notifications, 0);
  assert.equal(new SessionNavigation({ file }).get("a").customTitle, "Before");
});
test("corrupt navigation can be replaced by a new metadata edit", t => {
  const { file } = fixture(t); writeFileSync(file, "corrupt");
  const store = new SessionNavigation({ file });
  store.mutate("a", "rename", "New title");
  assert.equal(new SessionNavigation({ file }).get("a").customTitle, "New title");
});
test("project keys normalize absolute paths without merging equal folder names", () => {
  assert.notEqual(projectKey(path.resolve("first/game")), projectKey(path.resolve("second/game")));
  assert.equal(projectKey(path.resolve("first/game/../game")), projectKey(path.resolve("first/game")));
  assert.equal(projectKey(null), "");
});
