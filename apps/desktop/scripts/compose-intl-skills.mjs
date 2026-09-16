#!/usr/bin/env node
// compose-intl-skills.mjs — intl 技能包组合器（国际化方案 M4）。
//
// cn 树 skills/prep 是全文事实源（脚本单源，脚本日志/报错本身即英文）；
// intl 覆盖树 skills/prep-intl 只放翻译后的散文（.md）与自己的 bundle.json
// （intl revision 独立计数，远端指针在 R2 独立前缀，见 publish-skills.mjs --region）。
//
// 组合规则：cn 树每个文件，intl 树有同相对路径文件则取 intl 版，否则取 cn 版。
// 门禁（fail closed，任一不满足拒绝输出）：
//   1. intl 树不得有 cn 树不存在的游离文件（防止翻译树悄悄长出未审内容）
//   2. intl 树的 .md 不得含 CJK 字符（「无中文渗漏」硬门禁）
//   3. cn 树的原创散文（.md 且不在 node_modules 内）必须 100% 有 intl 对应
//      （vendored README 等第三方英文文档豁免——它们本来就是英文）
//   4. intl 树必须有自己的 bundle.json（schemaVersion 1 + 单调 revision）

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectSkillFiles } from "./publish-skills.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CN_SKILLS_DIR = path.join(desktopRoot, "skills", "prep");
const INTL_SKILLS_DIR = path.join(desktopRoot, "skills", "prep-intl");

// CJK 统一表意文字（含扩展 A 与兼容表意）；标点全角符号不在其列——翻译稿不该有表意字。
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿]/;

/** 「无中文渗漏」门禁：文本含 CJK 表意字即抛错。system-prompts-intl 复用本检查。 */
export function assertNoCjkLeak(body, label) {
  if (CJK_PATTERN.test(body)) throw new Error(`${label} contains CJK characters (Chinese leakage)`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "end of command"}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function isAuthoredProse(relativePath) {
  return relativePath.toLowerCase().endsWith(".md") && !relativePath.includes("/node_modules/");
}

/** intl bundle.json 必须有独立的合法单调 revision。 */
async function assertIntlBundleMeta(intlDir) {
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(path.join(intlDir, "bundle.json"), "utf8"));
  } catch (error) {
    throw new Error(`intl bundle.json is missing or not valid JSON: ${error.message}`);
  }
  if (!(meta?.schemaVersion === 1 && Number.isSafeInteger(meta?.revision) && meta.revision >= 1)) {
    throw new Error("intl bundle.json is missing a valid monotonic revision");
  }
}

/**
 * 组合 intl 技能包到 outDir。返回 { files, overrides }（POSIX 相对路径清单）。
 * @param {object} [options]
 * @param {string} [options.cnDir]
 * @param {string} [options.intlDir]
 * @param {string} [options.outDir]
 */
export async function composeIntlSkills({ cnDir = CN_SKILLS_DIR, intlDir = INTL_SKILLS_DIR, outDir } = {}) {
  const resolvedOut = path.resolve(requireString(outDir, "--output"));
  const cnFiles = await collectSkillFiles(path.resolve(cnDir));
  const intlFiles = await collectSkillFiles(path.resolve(intlDir));
  const cnSet = new Set(cnFiles);
  const intlSet = new Set(intlFiles);

  // 门禁 1：游离文件
  const orphans = intlFiles.filter((name) => !cnSet.has(name));
  if (orphans.length) {
    throw new Error(`intl skills tree has files the cn tree does not:\n  ${orphans.join("\n  ")}`);
  }

  // 门禁 4：独立 revision 计数器
  if (!intlSet.has("bundle.json")) {
    throw new Error("intl skills tree is missing bundle.json");
  }
  await assertIntlBundleMeta(path.resolve(intlDir));

  // 门禁 2：intl 提供的 .md 必须 CJK-free
  const cjkOffenders = [];
  for (const name of intlFiles.filter(isAuthoredProse)) {
    const body = await fsp.readFile(path.join(path.resolve(intlDir), ...name.split("/")), "utf8");
    if (CJK_PATTERN.test(body)) cjkOffenders.push(name);
  }
  if (cjkOffenders.length) {
    throw new Error(`intl skills files contain CJK characters (Chinese leakage):\n  ${cjkOffenders.join("\n  ")}`);
  }

  // 门禁 3：cn 原创散文必须 100% 有 intl 对应
  const missing = cnFiles.filter((name) => isAuthoredProse(name) && !intlSet.has(name));
  if (missing.length) {
    throw new Error(`cn authored prose missing intl translations:\n  ${missing.join("\n  ")}`);
  }

  // 组合：先全量复制 cn 树，再用 intl 版本覆盖同路径文件。
  await fsp.rm(resolvedOut, { recursive: true, force: true });
  await fsp.mkdir(resolvedOut, { recursive: true });
  for (const name of cnFiles) {
    const target = path.join(resolvedOut, ...name.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(path.resolve(cnDir), ...name.split("/")), target);
  }
  for (const name of intlFiles) {
    await fsp.copyFile(
      path.join(path.resolve(intlDir), ...name.split("/")),
      path.join(resolvedOut, ...name.split("/")),
    );
  }
  return { files: cnFiles, overrides: intlFiles };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { files, overrides } = await composeIntlSkills({
    cnDir: args["cn-dir"] ?? CN_SKILLS_DIR,
    intlDir: args["intl-dir"] ?? INTL_SKILLS_DIR,
    outDir: requireString(args.output, "--output"),
  });
  console.log(`intl skills composed: ${files.length} files (${overrides.length} intl overrides) -> ${path.resolve(args.output)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
