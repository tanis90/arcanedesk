import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalPrepCwd, PrepStore } from "../src/main/prep-store.js";

test("canonicalizes an existing prep directory before persisting it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-prep-store-"));
  const project = path.join(root, "project");
  const config = path.join(root, "prep.json");
  mkdirSync(project);

  const store = new PrepStore(config, () => {});
  const selected = path.join(project, "..", "project");
  const expected = realpathSync.native(project);
  assert.equal(store.setCwd(selected), expected);
  assert.equal(store.data.lastCwd, expected);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { lastCwd: expected });
});

test("drops missing or non-directory prep cwd instead of falling back to process.cwd", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-prep-store-invalid-"));
  const file = path.join(root, "ordinary-file.txt");
  const config = path.join(root, "prep.json");
  writeFileSync(file, "not a directory");
  writeFileSync(config, JSON.stringify({ lastCwd: file }));

  assert.equal(canonicalPrepCwd(path.join(root, "missing")), null);
  assert.equal(canonicalPrepCwd(file), null);
  assert.equal(new PrepStore(config, () => {}).data.lastCwd, null);
});
