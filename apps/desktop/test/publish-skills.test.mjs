import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSkillsManifest, collectSkillFiles, parseArgs } from "../scripts/publish-skills.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(desktopRoot, "skills", "prep");

async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-skills-publish-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("skills publisher rejects typoed options", () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(["--dry-run", "--skip-latest"]), { dryRun: true, skipLatest: true });
  assert.throws(() => parseArgs(["--dryrun"]), /unknown option/);
});

test("collectSkillFiles lists the real skill set sorted, including the bundle baseline", async () => {
  const files = await collectSkillFiles(SKILLS_DIR);
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.includes("bundle.json"));
  for (const skill of ["arcane-fvtt-ops", "arcane-fvtt-setup", "arcane-fvtt-mods", "arcane-actor-update", "arcane-module-reader"]) {
    assert.ok(files.includes(`${skill}/SKILL.md`), `missing ${skill}/SKILL.md`);
  }
});

test("collectSkillFiles refuses a directory without any skill", async (t) => {
  const empty = path.join(await makeTempDir(t), "empty");
  await fsp.mkdir(empty, { recursive: true });
  await assert.rejects(() => collectSkillFiles(empty), /empty/);
  await fsp.writeFile(path.join(empty, "notes.txt"), "not a skill\n", "utf8");
  await assert.rejects(() => collectSkillFiles(empty), /no SKILL\.md/);
});

test("buildSkillsManifest pins every file and the tarball with sha256 and bytes", async (t) => {
  const workDir = await makeTempDir(t);
  const bundleFile = path.join(workDir, "bundle.tar.gz");
  await fsp.writeFile(bundleFile, "fake tarball bytes", "utf8");
  const manifest = await buildSkillsManifest({
    skillsDir: SKILLS_DIR,
    revision: 7,
    minAppVersion: null,
    bundleFile,
    publishedAt: "2026-08-31T00:00:00Z",
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.revision, 7);
  assert.equal("minAppVersion" in manifest, false);
  assert.equal(manifest.bundle.file, "bundle.tar.gz");
  assert.equal(manifest.bundle.bytes, 18);
  assert.match(manifest.bundle.sha256, /^[a-f0-9]{64}$/);
  for (const [name, meta] of Object.entries(manifest.files)) {
    assert.match(meta.sha256, /^[a-f0-9]{64}$/);
    assert.ok(meta.bytes > 0, `${name} has no byte size`);
    assert.equal(name.startsWith("/"), false);
    assert.equal(name.includes(".."), false);
  }
});
