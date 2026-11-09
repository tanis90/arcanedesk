import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRevisionBump,
  checkSkillsRevision,
  parseBundleRevision,
} from "../scripts/check-skills-revision.mjs";

test("parseBundleRevision accepts a valid monotonic revision and treats a missing file as r0", () => {
  assert.equal(parseBundleRevision(null, "base:bundle.json"), 0);
  assert.equal(parseBundleRevision('{"schemaVersion":1,"revision":5}\n', "bundle.json"), 5);
  assert.throws(() => parseBundleRevision("not json", "bundle.json"), /not valid JSON/);
  assert.throws(() => parseBundleRevision('{"schemaVersion":1}', "bundle.json"), /monotonic revision/);
  assert.throws(() => parseBundleRevision('{"schemaVersion":1,"revision":0}', "bundle.json"), /monotonic revision/);
  assert.throws(() => parseBundleRevision('{"schemaVersion":2,"revision":5}', "bundle.json"), /monotonic revision/);
});

test("assertRevisionBump only fires when skills content changed without a strictly newer revision", () => {
  assert.doesNotThrow(() => assertRevisionBump({ changedFiles: [], baseRevision: 5, headRevision: 5 }));
  assert.doesNotThrow(() => assertRevisionBump({ changedFiles: ["apps/desktop/skills/prep/arcane-x/SKILL.md"], baseRevision: 5, headRevision: 6 }));
  assert.throws(
    () => assertRevisionBump({ changedFiles: ["apps/desktop/skills/prep/arcane-x/SKILL.md"], baseRevision: 5, headRevision: 5 }),
    /not bumped \(base r5, head r5\)/,
  );
  assert.throws(
    () => assertRevisionBump({ changedFiles: ["apps/desktop/skills/prep/bundle.json"], baseRevision: 5, headRevision: 4 }),
    /not bumped \(base r5, head r4\)/,
  );
});

async function makeRepo(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-skills-revision-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["config", "commit.gpgsign", "false"]);
  const skillsDir = path.join(dir, "apps", "desktop", "skills", "prep");
  await fsp.mkdir(path.join(skillsDir, "arcane-x"), { recursive: true });
  const writeBundle = (revision) => fsp.writeFile(
    path.join(skillsDir, "bundle.json"),
    `${JSON.stringify({ schemaVersion: 1, revision })}\n`,
    "utf8",
  );
  const commitAll = (message) => {
    git(["add", "-A"]);
    git(["commit", "-qm", message]);
  };
  return { dir, git, skillsDir, writeBundle, commitAll };
}

test("checkSkillsRevision passes a PR that does not touch skills/prep", async (t) => {
  const { dir, git, skillsDir, writeBundle, commitAll } = await makeRepo(t);
  await writeBundle(3);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x\n", "utf8");
  commitAll("base");
  git(["checkout", "-qb", "pr"]);
  await fsp.writeFile(path.join(dir, "README.md"), "unrelated\n", "utf8");
  commitAll("unrelated change");
  const result = checkSkillsRevision({ repoRoot: dir, baseRef: "main" });
  assert.deepEqual(result, { changedFiles: [], baseRevision: 3, headRevision: 3 });
});

test("checkSkillsRevision rejects a skill content change without a revision bump", async (t) => {
  const { dir, git, skillsDir, writeBundle, commitAll } = await makeRepo(t);
  await writeBundle(3);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x\n", "utf8");
  commitAll("base");
  git(["checkout", "-qb", "pr"]);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x v2\n", "utf8");
  commitAll("edit skill without bump");
  assert.throws(
    () => checkSkillsRevision({ repoRoot: dir, baseRef: "main" }),
    /not bumped \(base r3, head r3\)/,
  );
});

test("checkSkillsRevision accepts a skill change with a strictly newer revision", async (t) => {
  const { dir, git, skillsDir, writeBundle, commitAll } = await makeRepo(t);
  await writeBundle(3);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x\n", "utf8");
  commitAll("base");
  git(["checkout", "-qb", "pr"]);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x v2\n", "utf8");
  await writeBundle(4);
  commitAll("edit skill with bump");
  const result = checkSkillsRevision({ repoRoot: dir, baseRef: "main" });
  assert.equal(result.baseRevision, 3);
  assert.equal(result.headRevision, 4);
  assert.deepEqual(result.changedFiles.sort(), [
    "apps/desktop/skills/prep/arcane-x/SKILL.md",
    "apps/desktop/skills/prep/bundle.json",
  ]);
});

test("checkSkillsRevision rejects a bundle.json-only edit that leaves the revision unchanged", async (t) => {
  const { dir, git, skillsDir, writeBundle, commitAll } = await makeRepo(t);
  await writeBundle(3);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x\n", "utf8");
  commitAll("base");
  git(["checkout", "-qb", "pr"]);
  await fsp.writeFile(
    path.join(skillsDir, "bundle.json"),
    `${JSON.stringify({ schemaVersion: 1, revision: 3, minAppVersion: "0.3.0" })}\n`,
    "utf8",
  );
  commitAll("minAppVersion without bump");
  assert.throws(
    () => checkSkillsRevision({ repoRoot: dir, baseRef: "main" }),
    /not bumped \(base r3, head r3\)/,
  );
});

test("checkSkillsRevision treats a base without bundle.json as r0", async (t) => {
  const { dir, git, skillsDir, writeBundle, commitAll } = await makeRepo(t);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x\n", "utf8");
  commitAll("base without bundle.json");
  git(["checkout", "-qb", "pr"]);
  await writeBundle(1);
  commitAll("introduce bundle.json");
  const result = checkSkillsRevision({ repoRoot: dir, baseRef: "main" });
  assert.equal(result.baseRevision, 0);
  assert.equal(result.headRevision, 1);
});

test("checkSkillsRevision rejects a revision that moved backwards", async (t) => {
  const { dir, git, skillsDir, writeBundle, commitAll } = await makeRepo(t);
  await writeBundle(3);
  await fsp.writeFile(path.join(skillsDir, "arcane-x", "SKILL.md"), "# x\n", "utf8");
  commitAll("base");
  git(["checkout", "-qb", "pr"]);
  await writeBundle(2);
  commitAll("downgrade");
  assert.throws(
    () => checkSkillsRevision({ repoRoot: dir, baseRef: "main" }),
    /not bumped \(base r3, head r2\)/,
  );
});
