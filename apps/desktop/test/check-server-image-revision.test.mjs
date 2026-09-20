// check-server-image-revision 的 PR 闸单测:
//   1) 配方或 mod-manager 单源树无变更 → 直接通过
//   2) 有变更但 image-revision.json 未 bump → 拦下
//   3) bump 后通过;base 上没有 image-revision.json 时按 r0 处理
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkServerImageRevision } from "../scripts/check-server-image-revision.mjs";

async function makeRepo(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-server-image-revision-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["config", "commit.gpgsign", "false"]);
  const recipeDir = path.join(dir, "apps", "desktop", "distribution", "server-image");
  const modTree = path.join(dir, "apps", "desktop", "skills", "prep", "arcane-fvtt-mods");
  await fsp.mkdir(recipeDir, { recursive: true });
  await fsp.mkdir(modTree, { recursive: true });
  const writeRevision = (revision) => fsp.writeFile(
    path.join(recipeDir, "image-revision.json"),
    `${JSON.stringify({ schemaVersion: 1, revision })}\n`,
    "utf8",
  );
  const commitAll = (message) => {
    git(["add", "-A"]);
    git(["commit", "-qm", message]);
  };
  return { dir, git, recipeDir, modTree, writeRevision, commitAll };
}

test("checkServerImageRevision passes when neither the recipe nor the mod-manager tree changed", async (t) => {
  const { dir, git, writeRevision, commitAll } = await makeRepo(t);
  await writeRevision(3);
  commitAll("base");
  git(["checkout", "-q", "-b", "feature"]);
  await fsp.writeFile(path.join(dir, "README.md"), "unrelated\n", "utf8");
  commitAll("unrelated change");
  const result = checkServerImageRevision({ repoRoot: dir, baseRef: "main" });
  assert.equal(result.changedFiles.length, 0);
  assert.equal(result.headRevision, 3);
});

test("checkServerImageRevision rejects a recipe change without a revision bump", async (t) => {
  const { dir, git, writeRevision, commitAll } = await makeRepo(t);
  await writeRevision(3);
  commitAll("base");
  git(["checkout", "-q", "-b", "feature"]);
  await fsp.writeFile(path.join(dir, "apps", "desktop", "distribution", "server-image", "Dockerfile"), "FROM node\n", "utf8");
  commitAll("recipe change");
  assert.throws(
    () => checkServerImageRevision({ repoRoot: dir, baseRef: "main" }),
    /revision was not bumped \(base r3, head r3\)/,
  );
});

test("checkServerImageRevision rejects a mod-manager tree change without a bump, accepts it with one", async (t) => {
  const { dir, git, writeRevision, commitAll } = await makeRepo(t);
  await writeRevision(3);
  commitAll("base");
  git(["checkout", "-q", "-b", "feature"]);
  const modManager = path.join(dir, "apps", "desktop", "skills", "prep", "arcane-fvtt-mods", "scripts", "mod-manager.mjs");
  await fsp.mkdir(path.dirname(modManager), { recursive: true });
  await fsp.writeFile(modManager, "// touched\n", "utf8");
  commitAll("mod-manager change");
  assert.throws(() => checkServerImageRevision({ repoRoot: dir, baseRef: "main" }), /not bumped/);
  await writeRevision(4);
  commitAll("bump");
  const result = checkServerImageRevision({ repoRoot: dir, baseRef: "main" });
  assert.equal(result.headRevision, 4);
  assert.ok(result.changedFiles.some((name) => name.endsWith("mod-manager.mjs")));
});

test("checkServerImageRevision treats a missing base revision as r0", async (t) => {
  const { dir, git, recipeDir, modTree, writeRevision, commitAll } = await makeRepo(t);
  // base 上配方目录为空(r0),PR 引入配方 + r1。
  await fsp.writeFile(path.join(modTree, "keep.txt"), "keep\n", "utf8");
  commitAll("base without recipe");
  git(["checkout", "-q", "-b", "feature"]);
  await fsp.writeFile(path.join(recipeDir, "Dockerfile"), "FROM node\n", "utf8");
  await writeRevision(1);
  commitAll("introduce recipe");
  const result = checkServerImageRevision({ repoRoot: dir, baseRef: "main" });
  assert.equal(result.baseRevision, 0);
  assert.equal(result.headRevision, 1);
});
