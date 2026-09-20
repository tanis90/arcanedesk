#!/usr/bin/env node
// check-server-image-revision.mjs — PR 检查:distribution/server-image 配方或其
// 单源输入(mod-manager 所在的 skills/prep/arcane-fvtt-mods 树)有变更时,
// image-revision.json 的单调 revision 必须随之增大。
// 与 check-skills-revision 同一纪律:漏 bump 会被发布端的远端指针校验拦下,
// 但 PR 阶段先拦能让"revision 唯一标识内容"的不变量从仓库侧成立。
//
// 用法:node apps/desktop/scripts/check-server-image-revision.mjs <base-ref>
// 例:node apps/desktop/scripts/check-server-image-revision.mjs origin/main
// base 上还没有 image-revision.json 时按 r0 处理;两棵树都无变更直接通过。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertRevisionBump, parseBundleRevision } from "./check-skills-revision.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const RECIPE_PREFIX = "apps/desktop/distribution/server-image";
const REVISION_FILE = `${RECIPE_PREFIX}/image-revision.json`;
// 配方的单源输入:mod-manager 是构建期从这棵树复制的,树变了镜像内容就变了。
const MOD_MANAGER_TREE = "apps/desktop/skills/prep/arcane-fvtt-mods";

export { checkServerImageRevision };

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
}

function readRevision(root, ref, relativeFile) {
  if (ref === "HEAD") {
    try {
      return parseBundleRevision(fs.readFileSync(path.join(root, relativeFile), "utf8"), relativeFile);
    } catch {
      return 0; // HEAD 上没有该文件:按 r0 处理。
    }
  }
  try {
    return parseBundleRevision(git(root, ["show", `${ref}:${relativeFile}`]), `${ref}:${relativeFile}`);
  } catch (error) {
    if (error?.message?.includes("is not valid JSON") || error?.message?.includes("monotonic revision")) throw error;
    return 0; // ref 上没有该文件:按 r0 处理。
  }
}

/**
 * @param {{ repoRoot?: string, baseRef?: string }} [options]
 * @returns {{ changedFiles: string[], baseRevision: number, headRevision: number }}
 */
function checkServerImageRevision({ repoRoot: root = repoRoot, baseRef } = {}) {
  if (!baseRef) throw new TypeError("checkServerImageRevision requires a baseRef");
  let diff;
  try {
    diff = git(root, ["diff", "--name-only", `${baseRef}...HEAD`, "--", RECIPE_PREFIX, MOD_MANAGER_TREE]);
  } catch (error) {
    throw new Error(
      `cannot diff against ${baseRef} (shallow checkout? use actions/checkout fetch-depth: 0): ${error.message}`,
    );
  }
  const changedFiles = diff.split("\n").map((name) => name.trim()).filter(Boolean);
  const baseRevision = readRevision(root, baseRef, REVISION_FILE);
  const headRevision = readRevision(root, "HEAD", REVISION_FILE);
  assertRevisionBump({
    changedFiles,
    baseRevision,
    headRevision,
    bundleFile: REVISION_FILE,
  });
  return { changedFiles, baseRevision, headRevision };
}

function main(argv) {
  const baseRef = argv[0];
  if (!baseRef) {
    throw new Error("usage: node apps/desktop/scripts/check-server-image-revision.mjs <base-ref>");
  }
  const { changedFiles, baseRevision, headRevision } = checkServerImageRevision({ baseRef });
  if (!changedFiles.length) {
    console.log(`server image check OK: no changes under ${RECIPE_PREFIX} or ${MOD_MANAGER_TREE} against ${baseRef}`);
  } else {
    console.log(
      `server image check OK: ${changedFiles.length} file(s) changed, revision bumped r${baseRevision} -> r${headRevision}`,
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
