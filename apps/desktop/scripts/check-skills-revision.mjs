#!/usr/bin/env node
// check-skills-revision.mjs — PR 检查:apps/desktop/skills/prep(及 intl 覆盖树
// skills/prep-intl)有内容变更时,对应 bundle.json 的单调 revision 必须随之增大。
// 这个 revision 是 app 包内基线与 OSS skills 通道共用的计数器(见
// publish-skills.mjs / skills-updater.mjs;intl 树由 compose-intl-skills.mjs 组合),
// 漏 bump 不会发错版本(发布端有远端指针校验兜底),但会让"revision 唯一标识
// 内容"这条不变量从仓库侧失效,所以在 PR 阶段直接拦下,而不是等发布时才报错。
//
// 用法:node apps/desktop/scripts/check-skills-revision.mjs <base-ref>
// 例:node apps/desktop/scripts/check-skills-revision.mjs origin/main
// base 上还没有 bundle.json 时按 r0 处理;对应树无变更直接通过;
// 某棵树在 base 与 HEAD 都不存在(如旧分支上的 prep-intl)时跳过。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const SKILLS_PREFIX = "apps/desktop/skills/prep";
const BUNDLE_FILE = `${SKILLS_PREFIX}/bundle.json`;
// 每棵树各自携带 bundle.json、各自单调计数;两棵树都要过同一条 bump 规则。
const SKILLS_TREES = [SKILLS_PREFIX, "apps/desktop/skills/prep-intl"];

export { parseBundleRevision, assertRevisionBump, checkSkillsRevision };

/** 解析 bundle.json 文本里的单调 revision;text 为 null(该 ref 上不存在)时返回 0。 */
function parseBundleRevision(text, source) {
  if (text == null) return 0;
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
  const revision = meta?.schemaVersion === 1 && Number.isSafeInteger(meta?.revision) && meta.revision >= 1
    ? meta.revision
    : null;
  if (!revision) throw new Error(`${source} is missing a valid monotonic revision`);
  return revision;
}

/** 指定树下任意文件变更(含 bundle.json 自身)时,HEAD 的 revision 必须严格大于 base。 */
function assertRevisionBump({ changedFiles, baseRevision, headRevision, bundleFile = BUNDLE_FILE }) {
  if (!changedFiles.length) return;
  if (headRevision > baseRevision) return;
  throw new Error(
    `skills content changed but the bundle.json revision was not bumped (base r${baseRevision}, head r${headRevision}):\n`
    + changedFiles.map((name) => `  - ${name}`).join("\n")
    + `\nBump the monotonic revision in ${bundleFile}; the app baseline and the OSS skills channel share this counter.`,
  );
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
}

/** 返回 { changedFiles, baseRevision, headRevision };规则不满足时抛错。 */
function checkSkillsRevision({ repoRoot: root = repoRoot, baseRef, skillsPrefix = SKILLS_PREFIX }) {
  if (!baseRef) throw new TypeError("checkSkillsRevision requires a baseRef");
  const bundleFile = `${skillsPrefix}/bundle.json`;
  let diff;
  try {
    diff = git(root, ["diff", "--name-only", `${baseRef}...HEAD`, "--", skillsPrefix]);
  } catch (error) {
    throw new Error(
      `cannot diff against ${baseRef} (shallow checkout? use actions/checkout fetch-depth: 0): ${error.message}`,
    );
  }
  const changedFiles = diff.split("\n").map((name) => name.trim()).filter(Boolean);
  let baseText = null;
  try {
    baseText = git(root, ["show", `${baseRef}:${bundleFile}`]);
  } catch {
    baseText = null; // base 提交上还没有 bundle.json:按 r0 处理。
  }
  const baseRevision = parseBundleRevision(baseText, `${baseRef}:${bundleFile}`);
  let headText = null;
  try {
    headText = fs.readFileSync(path.join(root, bundleFile), "utf8");
  } catch {
    headText = null; // 该树在 HEAD 不存在(如旧分支上的 prep-intl):按 r0 处理。
  }
  const headRevision = parseBundleRevision(headText, bundleFile);
  assertRevisionBump({ changedFiles, baseRevision, headRevision, bundleFile });
  return { changedFiles, baseRevision, headRevision };
}

function main(argv) {
  const baseRef = argv[0];
  if (!baseRef) {
    throw new Error("usage: node apps/desktop/scripts/check-skills-revision.mjs <base-ref>");
  }
  for (const skillsPrefix of SKILLS_TREES) {
    const { changedFiles, baseRevision, headRevision } = checkSkillsRevision({ baseRef, skillsPrefix });
    if (!changedFiles.length) {
      console.log(`skills check OK: no changes under ${skillsPrefix} against ${baseRef}`);
    } else {
      console.log(
        `skills check OK [${skillsPrefix}]: ${changedFiles.length} file(s) changed, revision bumped r${baseRevision} -> r${headRevision}`,
      );
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
