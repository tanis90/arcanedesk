#!/usr/bin/env node
// publish-skills.mjs — 内置 skills 的独立发布入口:改 skill 文本不再发 app 版。
//
// 职责(顺序固定,镜像 publish-release 的不可变+指针纪律):
//   1. 读 bundle.json 的单调 revision(cn = skills/prep/bundle.json,
//      intl = skills/prep-intl/bundle.json,两棵树的计数器与远端指针各自独立)
//   2. 拉远端 skills/latest.json,要求新 revision 严格更大(防回滚、防重传)
//   3. 把技能树全量打成 bundle.tar.gz,生成逐文件 SHA256 的 manifest.json
//      (intl 先经 compose-intl-skills.mjs 组合:cn 树脚本单源 + intl 翻译覆盖)
//   4. 上传不可变对象 <skillsRoot>/<revision>/{bundle.tar.gz,manifest.json}
//   5. HEAD 全量验收通过后才切换可变指针 <skillsRoot>/latest.json
//
// region 路由(--region cn|intl,默认 cn)与 publish-release 同一 TARGETS 表:
// cn 发 OSS 北京 desktop/arcane-desk/skills/,intl 发 R2 desktop/arcane-desk-intl/skills/。
// 凭证与 publish-release 相同:cn 用 OSS_RELEASE_KEY_ID / OSS_RELEASE_KEY_SECRET
// 环境变量(或 ~/.ossutil/arcane-release.conf 的 [ArcaneDeskRelease] 段),
// intl 用 CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY。

import fs from "node:fs";
import { checkModuleBuilderVendor } from "./vendor-module-builder.mjs";
import fsp from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";

import { createStorageClient, resolveTarget, uploadObject, verifyUrl } from "./publish-release.mjs";
import { composeIntlSkills } from "./compose-intl-skills.mjs";
import { REGION_IDS } from "../src/main/region.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(desktopRoot, "skills", "prep");
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const a = argv[index];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--skip-latest") args.skipLatest = true;
    else if (a === "--region") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--region requires a value");
      args.region = value;
      index += 1;
    } else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

export { parseArgs, collectSkillFiles, buildSkillsManifest, assertSkillsSelfContained };

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** 递归收集 skills/prep 下全部文件,返回按 POSIX 相对路径排序的清单;拒绝符号链接。 */
async function collectSkillFiles(skillsDir) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`skills directory contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        files.push(path.relative(skillsDir, absolute).split(path.sep).join("/"));
      }
    }
  };
  await walk(skillsDir);
  files.sort();
  if (!files.length) throw new Error(`skills directory is empty: ${skillsDir}`);
  if (!files.some((name) => name.endsWith("/SKILL.md"))) {
    throw new Error("skills directory has no SKILL.md; refusing to publish an empty skill set");
  }
  return files;
}

// skills bundle 会被激活到 userData 单独运行(脱离 app 树),所以包内脚本必须自包含:
// 相对导入不许逃逸出 skills 目录,裸导入只允许 node builtins 或包内 vendored 依赖,
// 无豁免、无惰性加载——所有依赖在模块加载期就必须可解析。
const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:[^'"()\s][^'"]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function extractImportSpecifiers(source) {
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

function isBuiltinSpecifier(specifier) {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return builtinModules.includes(name);
}

/** 裸导入只允许解析到 skills 目录内部的 node_modules( vendored 依赖);越过根即逃逸。 */
function resolvesInsideSkills(files, fromFile, specifier) {
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  let directory = path.posix.dirname(fromFile);
  while (true) {
    if (files.has(path.posix.join(directory, "node_modules", packageName, "package.json"))) return true;
    if (directory === "." || directory === "") return false;
    directory = path.posix.dirname(directory);
  }
}

function assertSpecifierContained(files, fromFile, specifier) {
  const reject = (reason) => {
    throw new Error(`skills bundle is not self-contained: ${fromFile} imports "${specifier}" (${reason})`);
  };
  if (specifier.startsWith("node:")) {
    if (!isBuiltinSpecifier(specifier)) reject("unknown node: builtin");
    return;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
      reject("relative import escapes the skills directory");
    }
    if (!files.has(resolved)) reject("relative import target is not part of the skills bundle");
    return;
  }
  if (specifier.startsWith("/") || specifier.startsWith("\\") || /^[A-Za-z]:/.test(specifier)) {
    reject("absolute import path");
  }
  if (specifier.includes(":")) reject("only node: import schemes are allowed");
  if (!isBuiltinSpecifier(specifier) && !resolvesInsideSkills(files, fromFile, specifier)) {
    reject("bare import is neither a node builtin nor a vendored dependency inside the skills bundle");
  }
}

/** 发布前硬门禁:逐文件扫描 .mjs 导入,任何越界引用直接拒发。 */
async function assertSkillsSelfContained(skillsDir, fileList) {
  const files = new Set(fileList);
  for (const name of fileList) {
    if (!name.endsWith(".mjs")) continue;
    const source = await fsp.readFile(path.join(skillsDir, ...name.split("/")), "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      assertSpecifierContained(files, name, specifier);
    }
  }
}

/** 生成 manifest:逐文件 sha256/bytes + 整包 sha256/bytes,minAppVersion 仅在有约束时携带。 */
async function buildSkillsManifest({ skillsDir, revision, minAppVersion, bundleFile, publishedAt }) {
  const files = {};
  for (const name of await collectSkillFiles(skillsDir)) {
    const content = await fsp.readFile(path.join(skillsDir, ...name.split("/")));
    files[name] = { bytes: content.length, sha256: sha256Hex(content) };
  }
  const bundle = await fsp.readFile(bundleFile);
  return {
    schemaVersion: 1,
    revision,
    ...(minAppVersion ? { minAppVersion } : {}),
    publishedAt,
    bundle: { file: "bundle.tar.gz", bytes: bundle.length, sha256: sha256Hex(bundle) },
    files,
  };
}

/** 远端当前指针 revision;首次发布(404)视为 0。dry-run 时网络失败降级为告警。 */
async function remoteRevision({ baseUrl, latestKey, tolerateFailure }) {
  try {
    const response = await fetch(`${baseUrl}/${latestKey}`, {
      cache: "no-store",
      redirect: "error",
      headers: { "accept-encoding": "identity" },
    });
    if (response.status === 404) return 0;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pointer = await response.json();
    if (pointer?.schemaVersion !== 1 || !Number.isSafeInteger(pointer?.revision)) {
      throw new Error("remote skills latest.json is malformed");
    }
    return pointer.revision;
  } catch (error) {
    if (!tolerateFailure) throw error;
    console.warn(`warning: cannot read remote skills pointer (${error.message}); dry-run continues without the monotonic check`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = args.region ?? "cn";
  if (!REGION_IDS.includes(region)) {
    throw new Error(`--region must be one of ${REGION_IDS.join("/")}; got: ${region}`);
  }
  const target = resolveTarget(region);
  const skillsRoot = target.skillsRoot;
  const latestKey = `${skillsRoot}/latest.json`;

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-skills-publish-"));
  try {
    // intl 技能树 = cn 树脚本单源 + skills/prep-intl 翻译覆盖（含独立 bundle.json
    // 计数器），组合器自带 CJK 渗漏与翻译覆盖率门禁。
    let skillsDir = SKILLS_DIR;
    if (region === "intl") {
      skillsDir = path.join(workDir, "composed");
      await composeIntlSkills({ outDir: skillsDir });
    }

    const bundleMeta = JSON.parse(await fsp.readFile(path.join(skillsDir, "bundle.json"), "utf8"));
    const revision = bundleMeta?.schemaVersion === 1 && Number.isSafeInteger(bundleMeta?.revision) && bundleMeta.revision >= 1
      ? bundleMeta.revision
      : null;
    if (!revision) throw new Error(`bundle.json in ${skillsDir} is missing a valid monotonic revision`);
    const minAppVersion = bundleMeta.minAppVersion ?? null;
    if (minAppVersion != null && !/^\d+\.\d+\.\d+$/.test(minAppVersion)) {
      throw new Error(`bundle.json minAppVersion is not a three-part version: ${minAppVersion}`);
    }

    // 本地静态门禁先行:bundle 必须自包含(可脱离 app 树运行),再谈网络与上传。
    const entries = await collectSkillFiles(skillsDir);
    await checkModuleBuilderVendor();
    await assertSkillsSelfContained(skillsDir, entries);

    const current = await remoteRevision({ baseUrl: target.baseUrl, latestKey, tolerateFailure: args.dryRun });
    if (current != null && revision <= current) {
      throw new Error(`skills revision ${revision} is not newer than the published r${current}; bump the intl/cn bundle.json`);
    }

    const bundleFile = path.join(workDir, "bundle.tar.gz");
    await tar.c({ file: bundleFile, cwd: skillsDir, gzip: true, portable: true }, entries);
    const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const manifest = await buildSkillsManifest({
      skillsDir,
      revision,
      minAppVersion,
      bundleFile,
      publishedAt,
    });

    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    const latestBody = `${JSON.stringify({ schemaVersion: 1, revision, publishedAt }, null, 2)}\n`;
    const immutableObjects = [
      {
        key: `${skillsRoot}/${revision}/bundle.tar.gz`,
        file: bundleFile,
        bytes: manifest.bundle.bytes,
        cache: IMMUTABLE_CACHE,
        contentType: "application/gzip",
        immutable: true,
      },
      {
        key: `${skillsRoot}/${revision}/manifest.json`,
        body: manifestBody,
        bytes: Buffer.byteLength(manifestBody),
        cache: IMMUTABLE_CACHE,
        contentType: JSON_CONTENT_TYPE,
        immutable: true,
      },
    ];
    const latestObject = {
      key: latestKey,
      body: latestBody,
      bytes: Buffer.byteLength(latestBody),
      cache: "no-cache",
      contentType: JSON_CONTENT_TYPE,
    };

    console.log(
      `Skills bundle r${revision} (${region}) — ${Object.keys(manifest.files).length} files, `
      + `${manifest.bundle.bytes} bytes, sha256 ${manifest.bundle.sha256.slice(0, 12)}…`
      + (minAppVersion ? `, requires app >= ${minAppVersion}` : ""),
    );

    if (args.dryRun) {
      console.log("dry-run: skip upload & verify");
      return;
    }

    const client = await createStorageClient(target);
    // 已存在的 revision 目录拒绝重传(不可变纪律);latest 指针除外。
    for (const obj of immutableObjects) {
      let exists = false;
      try {
        await client.head(obj.key);
        exists = true;
      } catch (error) {
        if (Number(error?.status) !== 404) throw error;
      }
      if (exists) throw new Error(`immutable object already exists: ${obj.key} (bump the intl/cn bundle.json)`);
    }
    for (const obj of immutableObjects) await uploadObject(client, obj);

    // verify 纪律:不可变对象全部通过后,才允许切换 latest 指针。
    for (const obj of immutableObjects) {
      if (!(await verifyUrl(`${target.baseUrl}/${obj.key}`, obj.bytes, obj.key))) {
        throw new Error(`${obj.key} failed verification; skills latest remains unchanged`);
      }
    }
    if (args.skipLatest) {
      console.log(`skills bundle r${revision} uploaded and verified; latest unchanged (--skip-latest)`);
      return;
    }
    await uploadObject(client, latestObject);
    if (!(await verifyUrl(`${target.baseUrl}/${latestObject.key}`, latestObject.bytes, latestObject.key))) {
      throw new Error("skills latest.json failed verification; do NOT announce this publish");
    }
    console.log(`skills latest now points to verified bundle r${revision} (${region})`);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
