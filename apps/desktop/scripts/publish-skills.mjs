#!/usr/bin/env node
// publish-skills.mjs — 内置 skills 的独立发布入口:改 skill 文本不再发 app 版。
//
// 职责(顺序固定,镜像 publish-release 的不可变+指针纪律):
//   1. 读 skills/prep/bundle.json 的单调 revision(改 skill 的 PR 必须把它 +1)
//   2. 拉远端 skills/latest.json,要求新 revision 严格更大(防回滚、防重传)
//   3. 把 skills/prep 全量打成 bundle.tar.gz,生成逐文件 SHA256 的 manifest.json
//   4. 上传不可变对象 skills/<revision>/{bundle.tar.gz,manifest.json}
//   5. HEAD 全量验收通过后才切换可变指针 skills/latest.json
//
// 凭证与 publish-release 相同:OSS_RELEASE_KEY_ID / OSS_RELEASE_KEY_SECRET
// 环境变量,或 ~/.ossutil/arcane-release.conf 的 [ArcaneDeskRelease] 段。

import fs from "node:fs";
import fsp from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";

import { BASE_URL, createOssClient, uploadObject, verifyUrl } from "./publish-release.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(desktopRoot, "skills", "prep");
const SKILLS_ROOT = "desktop/arcane-desk/skills";
const LATEST_KEY = `${SKILLS_ROOT}/latest.json`;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--skip-latest") args.skipLatest = true;
    else throw new Error(`unknown option: ${a}`);
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
async function remoteRevision({ tolerateFailure }) {
  try {
    const response = await fetch(`${BASE_URL}/${LATEST_KEY}`, {
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
  const bundleMeta = JSON.parse(await fsp.readFile(path.join(SKILLS_DIR, "bundle.json"), "utf8"));
  const revision = bundleMeta?.schemaVersion === 1 && Number.isSafeInteger(bundleMeta?.revision) && bundleMeta.revision >= 1
    ? bundleMeta.revision
    : null;
  if (!revision) throw new Error("skills/prep/bundle.json is missing a valid monotonic revision");
  const minAppVersion = bundleMeta.minAppVersion ?? null;
  if (minAppVersion != null && !/^\d+\.\d+\.\d+$/.test(minAppVersion)) {
    throw new Error(`skills/prep/bundle.json minAppVersion is not a three-part version: ${minAppVersion}`);
  }

  // 本地静态门禁先行:bundle 必须自包含(可脱离 app 树运行),再谈网络与上传。
  const entries = await collectSkillFiles(SKILLS_DIR);
  await assertSkillsSelfContained(SKILLS_DIR, entries);

  const current = await remoteRevision({ tolerateFailure: args.dryRun });
  if (current != null && revision <= current) {
    throw new Error(`skills revision ${revision} is not newer than the published r${current}; bump skills/prep/bundle.json`);
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-skills-publish-"));
  try {
    const bundleFile = path.join(workDir, "bundle.tar.gz");
    await tar.c({ file: bundleFile, cwd: SKILLS_DIR, gzip: true, portable: true }, entries);
    const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const manifest = await buildSkillsManifest({
      skillsDir: SKILLS_DIR,
      revision,
      minAppVersion,
      bundleFile,
      publishedAt,
    });

    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    const latestBody = `${JSON.stringify({ schemaVersion: 1, revision, publishedAt }, null, 2)}\n`;
    const immutableObjects = [
      {
        key: `${SKILLS_ROOT}/${revision}/bundle.tar.gz`,
        file: bundleFile,
        bytes: manifest.bundle.bytes,
        cache: IMMUTABLE_CACHE,
        contentType: "application/gzip",
        immutable: true,
      },
      {
        key: `${SKILLS_ROOT}/${revision}/manifest.json`,
        body: manifestBody,
        bytes: Buffer.byteLength(manifestBody),
        cache: IMMUTABLE_CACHE,
        contentType: JSON_CONTENT_TYPE,
        immutable: true,
      },
    ];
    const latestObject = {
      key: LATEST_KEY,
      body: latestBody,
      bytes: Buffer.byteLength(latestBody),
      cache: "no-cache",
      contentType: JSON_CONTENT_TYPE,
    };

    console.log(
      `Skills bundle r${revision} — ${Object.keys(manifest.files).length} files, `
      + `${manifest.bundle.bytes} bytes, sha256 ${manifest.bundle.sha256.slice(0, 12)}…`
      + (minAppVersion ? `, requires app >= ${minAppVersion}` : ""),
    );

    if (args.dryRun) {
      console.log("dry-run: skip upload & verify");
      return;
    }

    const client = await createOssClient();
    // 已存在的 revision 目录拒绝重传(不可变纪律);latest 指针除外。
    for (const obj of immutableObjects) {
      let exists = false;
      try {
        await client.head(obj.key);
        exists = true;
      } catch (error) {
        if (Number(error?.status) !== 404) throw error;
      }
      if (exists) throw new Error(`immutable object already exists: ${obj.key} (bump skills/prep/bundle.json)`);
    }
    for (const obj of immutableObjects) await uploadObject(client, obj);

    // verify 纪律:不可变对象全部通过后,才允许切换 latest 指针。
    for (const obj of immutableObjects) {
      if (!(await verifyUrl(`${BASE_URL}/${obj.key}`, obj.bytes, obj.key))) {
        throw new Error(`${obj.key} failed verification; skills latest remains unchanged`);
      }
    }
    if (args.skipLatest) {
      console.log(`skills bundle r${revision} uploaded and verified; latest unchanged (--skip-latest)`);
      return;
    }
    await uploadObject(client, latestObject);
    if (!(await verifyUrl(`${BASE_URL}/${latestObject.key}`, latestObject.bytes, latestObject.key))) {
      throw new Error("skills latest.json failed verification; do NOT announce this publish");
    }
    console.log(`skills latest now points to verified bundle r${revision}`);
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
