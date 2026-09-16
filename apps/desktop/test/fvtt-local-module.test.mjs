import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { inspectLocalModule, stageLocalModule, commitStage, runCli } from "../skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs";

const exec = promisify(execFile);
async function fixture(t, entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-local-module-test-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "foundry-data"); await mkdir(path.join(dataDir, "Data", "modules"), { recursive: true });
  const archive = path.join(root, "original.zip");
  await exec("python", ["-c", "import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in json.loads(sys.argv[2])]; z.close()", archive, JSON.stringify(entries)]);
  return { root, dataDir, archive };
}
const manifest = { id: "original-local", title: "Original local module", version: "2.0.0", relationships: { requires: [{ id: "original-dependency", type: "module" }] } };
const entries = prefix => [[`${prefix}module.json`, JSON.stringify(manifest)], [`${prefix}description.html`, "<p>Original complete description.</p>"]];
function plan(inspected) {
  return { archivePath: inspected.archivePath, expectedId: inspected.id, expectedVersion: inspected.version,
    expectedSha256: inspected.archiveSha256, expectedBytes: inspected.archiveBytes };
}
async function cleanupStage(stage) {
  assert.equal(path.dirname(stage.stageDir), os.tmpdir());
  assert.ok(path.basename(stage.stageDir).startsWith("arcane-fvtt-mod-"));
  await rm(stage.stageDir, { recursive: true, force: true });
}

test("local inspect is read-only and local module activation backs up existing content", async t => {
  const f = await fixture(t, entries("original-local/"));
  const installed = path.join(f.dataDir, "Data", "modules", manifest.id); await mkdir(installed);
  await writeFile(path.join(installed, "module.json"), JSON.stringify({ ...manifest, version: "1.0.0" }));
  await writeFile(path.join(installed, "description.html"), "Original previous description.");
  const before = await readdir(f.root);
  const inspected = await runCli(["local-inspect", "--archive", f.archive, "--data-dir", f.dataDir]);
  assert.deepEqual(await readdir(f.root), before);
  assert.equal(inspected.local.version, "1.0.0");
  assert.equal(inspected.target, installed);
  assert.equal(inspected.integrity, "local-file-sha256");
  assert.equal(inspected.requiredModules[0].id, "original-dependency");
  const staged = await stageLocalModule(plan(inspected)); t.after(() => cleanupStage(staged));
  assert.equal(staged.trustedByMirrorIndex, false);
  assert.equal(staged.manifestUrl, null);
  assert.equal(await readFile(path.join(installed, "description.html"), "utf8"), "Original previous description.");
  const result = await commitStage({ stageDir: staged.stageDir, dataDir: f.dataDir, expectedCurrentVersion: "1.0.0", acceptSha256: inspected.archiveSha256 });
  assert.equal(result.installed, true); assert.equal(result.worldEnabled, false);
  assert.equal(await readFile(path.join(result.target, "description.html"), "utf8"), "<p>Original complete description.</p>");
  assert.equal(await readFile(path.join(result.backup, "description.html"), "utf8"), "Original previous description.");
});

test("local stage rejects changed identity, bytes or hash before installation", async t => {
  const f = await fixture(t, entries(""));
  const inspected = await inspectLocalModule({ archivePath: f.archive, dataDir: f.dataDir });
  for (const change of [{ expectedId: "other" }, { expectedVersion: "3.0.0" }, { expectedSha256: "0".repeat(64) }, { expectedBytes: inspected.archiveBytes + 1 }]) {
    await assert.rejects(stageLocalModule({ ...plan(inspected), ...change }), /changed/);
  }
  await writeFile(f.archive, "changed archive");
  await assert.rejects(stageLocalModule(plan(inspected)));
  assert.deepEqual(await readdir(path.join(f.dataDir, "Data", "modules")), []);
});

test("local archive inspection rejects ambiguous manifests, traversal and case-colliding paths", async t => {
  for (const input of [
    [...entries("one/"), ...entries("two/")],
    [...entries("one/"), ["outside.txt", "outside"]],
    [...entries(""), ["../escape.txt", "escape"]],
    [...entries(""), ["MODULE.JSON", JSON.stringify(manifest)]],
  ]) {
    const f = await fixture(t, input);
    await assert.rejects(inspectLocalModule({ archivePath: f.archive, dataDir: f.dataDir }));
  }
});

test("local staged archive tampering cannot reach the existing commit path", async t => {
  const f = await fixture(t, entries(""));
  const inspected = await inspectLocalModule({ archivePath: f.archive, dataDir: f.dataDir });
  const staged = await runCli(["local-stage", "--archive", f.archive, "--expected-id", inspected.id, "--expected-version", inspected.version,
    "--expected-sha256", inspected.archiveSha256, "--expected-bytes", String(inspected.archiveBytes)]);
  t.after(() => cleanupStage(staged));
  await writeFile(path.join(staged.stageDir, "package.zip"), "changed stage");
  await assert.rejects(commitStage({ stageDir: staged.stageDir, dataDir: f.dataDir, expectedCurrentVersion: "none", acceptSha256: inspected.archiveSha256 }), /ZIP changed/);
  assert.deepEqual(await readdir(path.join(f.dataDir, "Data", "modules")), []);
});
