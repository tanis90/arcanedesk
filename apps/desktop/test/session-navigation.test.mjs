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
  assert.throws(() => restoredProcess.assertWritable("a"), { code: "SESSION_ARCHIVED" });
  restoredProcess.mutate("a", "restore"); restoredProcess.assertWritable("a");
  assert.equal(restoredProcess.get("a").pinnedOrder, undefined);
  assert.equal(readFileSync(history, "utf8"), "history and external results");
});
test("admission ordering: work accepted first prevents archive; archive first prevents execution", t => {
  const { store } = fixture(t);
  for (const state of ["queued", "running", "waiting_resource", "waiting_user", "stopping"]) {
    assert.throws(() => store.mutate("a", "archive", null, { busy: true, task: { state } }), { code: "SESSION_BUSY" });
    assert.equal(store.get("a").archivedAt, undefined);
  }
  assert.throws(() => store.mutate("a", "archive", null, { operations: 1 }), { code: "SESSION_BUSY" });
  assert.throws(() => store.assertDeletable("a"), { code: "SESSION_NOT_ARCHIVED" });
  store.mutate("a", "archive", null, { busy: false });
  assert.throws(() => store.assertWritable("a"), { code: "SESSION_ARCHIVED" });
  assert.throws(() => store.mutate("a", "pin", true), { code: "SESSION_ARCHIVED" });
  store.assertDeletable("a");
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
test("corrupt navigation fails closed instead of reviving archived sessions or overwriting data", t => {
  const { file } = fixture(t); writeFileSync(file, "corrupt");
  const store = new SessionNavigation({ file });
  assert.throws(() => store.assertWritable("a"), { code: "NAVIGATION_UNAVAILABLE" });
  assert.throws(() => store.mutate("a", "restore"), { code: "NAVIGATION_UNAVAILABLE" });
  assert.equal(readFileSync(file, "utf8"), "corrupt");
});
test("project keys normalize absolute paths without merging equal folder names", () => {
  assert.notEqual(projectKey(path.resolve("first/game")), projectKey(path.resolve("second/game")));
  assert.equal(projectKey(path.resolve("first/game/../game")), projectKey(path.resolve("first/game")));
  assert.equal(projectKey(null), "");
});
