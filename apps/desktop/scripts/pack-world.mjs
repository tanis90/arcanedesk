#!/usr/bin/env node
// pack-world.mjs — CN 镜像世界打包器(仅本地/测试运行,依赖 classic-level/fflate)。
//
// 替代已废弃老仓库里的 pack_world.py,保留其全部既有契约:
//   - 确定性 zip(排序条目 + 固定 mtime;fflate 默认取 Date.now(),不显式固定
//     则每次打包哈希都不同,已实测);
//   - 改写 world.json 的 id/title/version/system/coreVersion/systemVersion/
//     compatibility/manifest/download,剔除 lastPlayed/playtime;
//   - 剔除 LOCK/LOG/LOG.old/.DS_Store/Thumbs.db(注意:LevelDB 的 WAL 是
//     000xxx.log 编号文件,承载真实数据,不在剔除之列;剔的只是文本日志);
//   - 拒绝 symlink 与逃逸路径;源目录永不修改(所有改动落在 staging 副本)。
//
// 新增(0.1.1 撤回与 0.1.3 半截凭证事故的教训,把人肉纪律变成工具兜底):
//   - 打包前强制跑 world-content-audit(users 凭证成对/messages 清空/世界外
//     路径引用),违规即拒绝打包;
//   - 显式脱敏开关,替代不在版本控制内的临场脚本:
//       --clear-messages     删除 data/messages pack(Foundry 首启自建空 pack);
//       --set-empty-password 重写全部 users 记录为 createPassword("") 同构的
//                            hash+salt 对(密码框留空可登录),写入前用与
//                            Foundry 登录路径相同的 testPassword 公式自检。
//
// 用法:
//   node scripts/pack-world.mjs <世界目录> --out <输出目录> --id <world-id> \
//     --title <标题> --version <x.y.z> [--clear-messages] [--set-empty-password] \
//     [--allow-messages] [--base-url <url>] [--core-version <v>] [--system-version <v>]
//
// 输出:输出目录下的 world.json + <id>-<version>.zip,stdout 打印两者的
// bytes/SHA256(与 pack_world.py 的输出契约一致,供 distribution 登记)。

import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { zipSync } from "fflate";
import { ClassicLevel } from "classic-level";

import { auditWorldDirectory } from "./world-content-audit.mjs";

const DEFAULT_BASE_URL = "https://arcane-package.oss-cn-beijing.aliyuncs.com";
const DEFAULT_CORE_VERSION = "13.351";
const DEFAULT_SYSTEM_VERSION = "5.3.3";
const EXCLUDE_NAMES = new Set([".DS_Store", "Thumbs.db", "LOCK", "LOG", "LOG.old"]);
const FIXED_MTIME = "1980-01-02T00:00:00Z";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// 与 Foundry 13 dist/core/auth.mjs 同构:pbkdf2(sha512, 1000 轮, 64 字节)。
function foundryCreatePassword(plaintext) {
  const salt = randomBytes(32).toString("hex");
  const hash = pbkdf2Sync(plaintext, salt, 1000, 64, "sha512").toString("hex");
  return { hash, salt };
}

function foundryTestPassword(plaintext, hash, salt) {
  const derived = pbkdf2Sync(plaintext, salt, 1000, 64, "sha512");
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** 收集源目录文件;拒绝 symlink/逃逸路径,剔除运行时与平台垃圾文件。 */
async function collectSourceFiles(source) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (EXCLUDE_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in world releases: ${absolute}`);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const archivePath = path.relative(source, absolute).split(path.sep).join("/");
        if (archivePath.startsWith("../") || archivePath.startsWith("/")) {
          throw new Error(`unsafe world path: ${archivePath}`);
        }
        files.push({ archivePath, absolute });
      }
    }
  };
  await walk(source);
  return files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

async function readSourceManifest(source) {
  const manifestPath = path.join(source, "world.json");
  const stat = await fsp.stat(manifestPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`source world has no world.json: ${source}`);
  const manifest = JSON.parse((await fsp.readFile(manifestPath, "utf8")).replace(/^﻿/, ""));
  if (manifest?.system !== "dnd5e") {
    throw new Error(`source world system must be dnd5e, got ${manifest?.system}`);
  }
  return manifest;
}

function releaseManifest(sourceManifest, { worldId, title, version, baseUrl, coreVersion, systemVersion }) {
  const base = baseUrl.replace(/\/+$/, "");
  const manifest = { ...sourceManifest };
  delete manifest.lastPlayed;
  delete manifest.playtime;
  return {
    ...manifest,
    id: worldId,
    title,
    version,
    system: "dnd5e",
    coreVersion,
    systemVersion,
    compatibility: { minimum: "13", verified: coreVersion },
    manifest: `${base}/worlds/${worldId}/${version}/world.json`,
    download: `${base}/worlds/${worldId}/${version}/${worldId}-${version}.zip`,
  };
}

/** 清空聊天记录:整包删除,Foundry 首启自建空 pack。 */
async function clearMessagesPack(staging) {
  await fsp.rm(path.join(staging, "data", "messages"), { recursive: true, force: true });
}

/** 全部 users 记录重写为「空密码」的成对 hash+salt,返回改写条数。 */
async function setEmptyPasswords(staging) {
  const packDir = path.join(staging, "data", "users");
  const stat = await fsp.stat(packDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("--set-empty-password 需要已存在的 data/users pack");
  const db = new ClassicLevel(packDir, { createIfMissing: false, valueEncoding: "utf8" });
  await db.open();
  try {
    const operations = [];
    for await (const [key, value] of db.iterator({ gte: "!users!", lte: "!users!￿" })) {
      const doc = JSON.parse(value);
      const { hash, salt } = foundryCreatePassword("");
      // 写入前自检:与 Foundry 登录路径同一公式,确认「留空可登录、错密码拒绝」。
      if (!foundryTestPassword("", hash, salt) || foundryTestPassword("arcane-not-empty", hash, salt)) {
        throw new Error("empty-password credential self-check failed");
      }
      operations.push({ type: "put", key, value: JSON.stringify({ ...doc, password: hash, passwordSalt: salt }) });
    }
    if (operations.length === 0) throw new Error("data/users 没有任何用户记录");
    await db.batch(operations);
    // 落盘成 .ldb,不依赖 WAL 文件随包(WAL 虽含数据,但压实后形态与
    // Foundry 正常运行后的 pack 一致,审计/复打包更稳定)。
    await db.compactRange("!users!", "!users!￿");
    return operations.length;
  } finally {
    await db.close();
  }
}

/** 确定性 zip:排序条目 + 固定 mtime;同一目录内容产出逐字节相同的 zip。 */
async function writeDeterministicZip(staging, zipPath) {
  const entries = await collectSourceFiles(staging);
  const files = {};
  for (const { archivePath, absolute } of entries) {
    files[archivePath] = [new Uint8Array(await fsp.readFile(absolute)), { mtime: FIXED_MTIME }];
  }
  if (!files["world.json"]) throw new Error("world archive source is missing world.json");
  const zipped = zipSync(files, { level: 9 });
  await fsp.writeFile(zipPath, zipped, { flag: "wx" });
  return { bytes: zipped.length, sha256: sha256(zipped) };
}

export async function buildWorldRelease({
  sourceDir,
  outputDir,
  worldId,
  title,
  version,
  baseUrl = DEFAULT_BASE_URL,
  coreVersion = DEFAULT_CORE_VERSION,
  systemVersion = DEFAULT_SYSTEM_VERSION,
  clearMessages = false,
  setEmptyPassword = false,
  allowMessages = false,
}) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (!ID_PATTERN.test(worldId)) throw new Error(`world id is unsafe: ${worldId}`);
  if (typeof title !== "string" || !title) throw new Error("title is required");
  if (typeof version !== "string" || !version) throw new Error("version is required");
  if (clearMessages && allowMessages) throw new Error("--clear-messages and --allow-messages are mutually exclusive");
  const zipName = `${worldId}-${version}.zip`;
  const zipPath = path.join(output, zipName);
  if (!path.relative(source, zipPath)) throw new Error("archive output must be outside the world directory");

  const sourceManifest = await readSourceManifest(source);
  const sourceFiles = await collectSourceFiles(source);
  const manifest = releaseManifest(sourceManifest, { worldId, title, version, baseUrl, coreVersion, systemVersion });
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // staging 副本:脱敏、world.json 改写、内容审计都只动副本,源目录保持只读。
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-pack-world-"));
  try {
    for (const { archivePath, absolute } of sourceFiles) {
      if (archivePath === "world.json") continue;
      const target = path.join(staging, archivePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(absolute, target);
    }
    await fsp.writeFile(path.join(staging, "world.json"), manifestBuffer);

    const sanitized = {};
    if (clearMessages) {
      await clearMessagesPack(staging);
      sanitized.messages = "cleared";
    }
    if (setEmptyPassword) {
      sanitized.users = `${await setEmptyPasswords(staging)} users set to empty password`;
    }

    const violations = await auditWorldDirectory(staging, {
      requireEmptyMessages: !allowMessages,
      requireUsers: true,
      worldId,
    });
    if (violations.length) {
      for (const violation of violations) {
        process.stderr.write(`BLOCKED ${violation.file}: [${violation.kind}] ${violation.term}\n`);
      }
      throw new Error(`world content audit rejected the staged directory (${violations.length} violations); fix and repack`);
    }

    await fsp.mkdir(output, { recursive: true });
    await fsp.writeFile(path.join(output, "world.json"), manifestBuffer, { flag: "wx" });
    const zip = await writeDeterministicZip(staging, zipPath);
    return {
      id: worldId,
      version,
      sanitized,
      manifest: { file: "world.json", bytes: manifestBuffer.length, sha256: sha256(manifestBuffer) },
      zip: { file: zipName, ...zip },
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function parseArgs(argv) {
  const result = { booleans: new Set(), positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      result.positionals.push(key);
      continue;
    }
    if (["clear-messages", "set-empty-password", "allow-messages"].includes(key.slice(2))) {
      result.booleans.add(key.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positionals.length !== 1) {
    throw new Error("usage: node scripts/pack-world.mjs <world-dir> --out <dir> --id <id> --title <title> --version <x.y.z> [--clear-messages] [--set-empty-password] [--allow-messages]");
  }
  const receipt = await buildWorldRelease({
    sourceDir: args.positionals[0],
    outputDir: requireString(args.out, "--out"),
    worldId: requireString(args.id, "--id"),
    title: requireString(args.title, "--title"),
    version: requireString(args.version, "--version"),
    baseUrl: args["base-url"] ?? DEFAULT_BASE_URL,
    coreVersion: args["core-version"] ?? DEFAULT_CORE_VERSION,
    systemVersion: args["system-version"] ?? DEFAULT_SYSTEM_VERSION,
    clearMessages: args.booleans.has("clear-messages"),
    setEmptyPassword: args.booleans.has("set-empty-password"),
    allowMessages: args.booleans.has("allow-messages"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
