import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findMirrorStageRoots } from "../src/main/lobby-mirror-cache.js";
import { prepareLobbySourceFile } from "../src/main/mt-lobby-file.js";

function scratch(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "arcane-mirror-cache-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("world/module stage dirs are accepted only when their mirror metadata and ZIPs are present", async (t) => {
  const tmpdir = scratch(t);
  const sha = "a".repeat(64);

  const world = path.join(tmpdir, "arcane-fvtt-world-demo");
  mkdirSync(path.join(world, "artifacts", "000-world-demo"), { recursive: true });
  writeFileSync(path.join(world, "artifacts", "000-world-demo", "package.zip"), "world zip");
  writeFileSync(path.join(world, "stage.json"), JSON.stringify({
    kind: "foundry-world-profile-stage",
    mirrorGenerated: "2026-11-11T00:00:00.000Z",
    world: { sha256: sha },
    artifacts: [{ archive: "artifacts/000-world-demo/package.zip" }],
  }));

  const moduleStage = path.join(tmpdir, "arcane-fvtt-mod-demo");
  mkdirSync(moduleStage, { recursive: true });
  writeFileSync(path.join(moduleStage, "package.zip"), "module zip");
  writeFileSync(path.join(moduleStage, "stage.json"), JSON.stringify({
    schemaVersion: 2,
    trustedByMirrorIndex: true,
    archive: "package.zip",
    archiveSha256: sha,
  }));

  const untrusted = path.join(tmpdir, "arcane-fvtt-mod-local");
  mkdirSync(untrusted, { recursive: true });
  writeFileSync(path.join(untrusted, "package.zip"), "local zip");
  writeFileSync(path.join(untrusted, "stage.json"), JSON.stringify({
    schemaVersion: 2,
    trustedByMirrorIndex: false,
    archive: "package.zip",
    archiveSha256: sha,
  }));

  const missingZip = path.join(tmpdir, "arcane-fvtt-world-missing");
  mkdirSync(missingZip, { recursive: true });
  writeFileSync(path.join(missingZip, "stage.json"), JSON.stringify({
    kind: "foundry-world-profile-stage",
    mirrorGenerated: "2026-11-11T00:00:00.000Z",
    world: { sha256: sha },
    artifacts: [{ archive: "artifacts/missing.zip" }],
  }));

  const roots = findMirrorStageRoots({ tmpdir }).sort();
  assert.deepEqual(roots, [path.resolve(world), path.resolve(moduleStage)].sort());

  const archive = path.join(world, "artifacts", "000-world-demo", "package.zip");
  const prepared = await prepareLobbySourceFile(archive, { roots });
  assert.equal(prepared.filename, "package.zip");
  await assert.rejects(
    prepareLobbySourceFile(path.join(untrusted, "package.zip"), { roots }),
    error => error.code === "FILE_OUTSIDE_FENCE",
  );
});

test("unrelated temp directories are never exposed", (t) => {
  const tmpdir = scratch(t);
  const unrelated = path.join(tmpdir, "arcane-lobby-mirror-xyz");
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(path.join(unrelated, "world.zip"), "not a mirror stage");
  assert.deepEqual(findMirrorStageRoots({ tmpdir }), []);
  assert.deepEqual(findMirrorStageRoots({ tmpdir: path.join(tmpdir, "missing") }), []);
});
