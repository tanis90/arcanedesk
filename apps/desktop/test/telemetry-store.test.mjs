import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelemetryStore } from "../src/main/telemetry/telemetry-store.js";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "arcane-telemetry-store-"));
  return new TelemetryStore(join(dir, "telemetry.json"));
}

test("defaults: consent off, no installation id, free product unaffected", () => {
  const store = tempStore();
  assert.equal(store.enabled, false);
  assert.equal(store.decided, false);
  assert.equal(store.data.decidedAt, null);
  assert.equal(store.data.installationId, null);
});

test("installation id is 128-bit and stable across restarts", () => {
  const store = tempStore();
  const id = store.ensureInstallationId();
  assert.match(id, /^ins_[0-9a-f]{32}$/);
  // 重启(新实例同文件)后保持同一身份
  const reopened = new TelemetryStore(store.file);
  assert.equal(reopened.ensureInstallationId(), id);
});

test("reset issues a fresh identity for post-deletion semantics", () => {
  const store = tempStore();
  const first = store.ensureInstallationId();
  store.resetInstallationId();
  assert.notEqual(store.ensureInstallationId(), first);
});

test("setEnabled persists consent decision with timestamp", () => {
  const store = tempStore();
  store.setEnabled(true);
  const reopened = new TelemetryStore(store.file);
  assert.equal(reopened.enabled, true);
  assert.equal(reopened.decided, true);
  assert.equal(typeof reopened.data.decidedAt, "string");
});

test("corrupt config falls back to defaults instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcane-telemetry-store-"));
  const file = join(dir, "telemetry.json");
  writeFileSync(file, "{not json");
  const store = new TelemetryStore(file);
  assert.equal(store.enabled, false);
});

test("uncreatable config directory cannot crash TelemetryStore construction", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcane-telemetry-store-"));
  const blocker = join(dir, "config");
  writeFileSync(blocker, "this path is a file, not a directory");
  const logs = [];
  let store;
  assert.doesNotThrow(() => {
    store = new TelemetryStore(join(blocker, "telemetry.json"), (...args) => logs.push(args));
  });
  assert.equal(store.enabled, false);
  assert.ok(logs.some((args) => String(args[0]).includes("config directory unavailable")));
});
