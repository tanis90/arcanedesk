#!/usr/bin/env node
// world-content-audit — 世界包内容审计(仅本地/测试运行,依赖 classic-level)。
//
// 背景:heroes-to-yuanshan@0.1.3 的 users 记录是 password:"" 且无 passwordSalt
// 的半截形态——登录路径 testPassword 因 salt=undefined 抛 ERR_INVALID_ARG_TYPE
// 并被上层吞成 false,任何密码恒 401。该缺陷能进入工件,是因为打包侧零内容
// 校验、脱敏靠人肉(0.1.1 撤回教训:data/users、data/messages、世界外路径引用
// 必须扫,而 LevelDB 是二进制,ripgrep 会静默跳过)。本模块把这三类检查工具化:
//   1. users 凭证成对:password ⟺ passwordSalt 同在同无;password 必须是
//      64 字节 hex(Foundry pbkdf2 sha512/1000 轮/64 字节输出的形态);
//   2. messages 清空(CN 脱敏纪律,intl 通过选项豁免);
//   3. 世界外路径引用:Data/ 非本世界前缀、App 资产目录、操作系统绝对路径。
//
// 注意:审计用 classic-level 打开 LevelDB,会在目录里产生 LOCK/LOG 运行时
// 文件,且首次打开可能触发 WAL 恢复改写 pack 字节(语义不变)——只对可丢弃的
// staging/临时副本运行,永不原地审计源世界目录。

import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ClassicLevel } from "classic-level";

const TEXT_SUFFIXES = new Set([
  ".json", ".js", ".mjs", ".cjs", ".md", ".html", ".htm",
  ".css", ".txt", ".svg", ".hbs", ".xml", ".yaml", ".yml", ".csv",
]);

// Foundry 13 的 createPassword 输出:pbkdf2(sha512, 1000, 64 字节) 的 hex。
const PASSWORD_HEX = /^[a-f0-9]{128}$/;
// 已知泄漏形态:App 侧资产目录(Data/arcanedesk/...),任意位置出现即违规。
const APP_ASSETS_PATH = /data[\\/]arcanedesk[\\/]/i;
// 操作系统绝对路径。Windows 盘符要求前导边界 + 冒号后不跟第二个斜杠,
// 避免误伤 https:// 等 URL(C:/x 是路径,s://x 是协议)。
const WINDOWS_ABSOLUTE = /(?:^|[\s"'(=])[A-Za-z]:[\\/](?![\\/])/;
const POSIX_ABSOLUTE = /(?:^|[\s"'(=])\/(?:Users|home|var|tmp|etc|opt|mnt|Volumes)\//;
// 文本文件里的 Windows 路径候选提取(与 WINDOWS_ABSOLUTE 同一判据的全局形态)。
const WINDOWS_PATH_IN_TEXT = /[A-Za-z]:[\\/](?![\\/])[^\s"'<>]*/g;
// 单个文件/pack 的 external-path 违规去重上限,防止损坏包刷出无限输出。
const MAX_PATH_VIOLATIONS_PER_FILE = 20;

function relativeFile(rootDir, absolute) {
  return path.relative(rootDir, absolute).split(path.sep).join("/");
}

async function readWorldId(rootDir) {
  try {
    const text = await fsp.readFile(path.join(rootDir, "world.json"), "utf8");
    const id = JSON.parse(text.replace(/^﻿/, ""))?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function* stringsOf(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsOf(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* stringsOf(item);
}

async function* walkFiles(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(absolute);
    else if (entry.isFile()) yield absolute;
  }
}

async function readPackRecords(packDir) {
  const db = new ClassicLevel(packDir, { createIfMissing: false, valueEncoding: "utf8" });
  await db.open();
  try {
    const records = [];
    for await (const [key, value] of db.iterator()) records.push([key, value]);
    return records;
  } finally {
    await db.close();
  }
}

function parseRecord(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function auditUsersPack(rootDir, violations, { requireUsers }) {
  const file = "data/users";
  const packDir = path.join(rootDir, file);
  const stat = await fsp.stat(packDir).catch(() => null);
  // 无 users pack 不强制:Foundry 首启会自建;但「存在却为空/坏」必须拦。
  if (!stat?.isDirectory()) return;
  let records;
  try {
    records = await readPackRecords(packDir);
  } catch (error) {
    violations.push({ file, kind: "users-pack-unreadable", term: error instanceof Error ? error.message : String(error) });
    return;
  }
  const users = records.filter(([key]) => key.startsWith("!users!"));
  if (users.length === 0) {
    if (requireUsers) violations.push({ file, kind: "users-empty", term: "no user records" });
    return;
  }
  for (const [key, raw] of users) {
    const doc = parseRecord(raw);
    if (!doc) {
      violations.push({ file, kind: "user-record-unparseable", term: key });
      continue;
    }
    const label = `${typeof doc.name === "string" ? doc.name : "?"} (${typeof doc._id === "string" ? doc._id : key})`;
    const hasPassword = typeof doc.password === "string";
    const hasSalt = typeof doc.passwordSalt === "string" && doc.passwordSalt.length > 0;
    if (hasPassword !== hasSalt) {
      // password:"" 无 salt 即此分支:登录必然 401,结构性不可登录。
      violations.push({ file, kind: "user-credentials-unpaired", term: label });
    } else if (hasPassword && !PASSWORD_HEX.test(doc.password)) {
      violations.push({ file, kind: "user-password-malformed", term: label });
    }
  }
}

async function auditMessagesPack(rootDir, violations) {
  const file = "data/messages";
  const packDir = path.join(rootDir, file);
  const stat = await fsp.stat(packDir).catch(() => null);
  if (!stat?.isDirectory()) return;
  let records;
  try {
    records = await readPackRecords(packDir);
  } catch (error) {
    violations.push({ file, kind: "messages-pack-unreadable", term: error instanceof Error ? error.message : String(error) });
    return;
  }
  const count = records.filter(([key]) => key.startsWith("!messages!")).length;
  if (count > 0) violations.push({ file, kind: "messages-not-empty", term: `${count} chat messages` });
}

function externalPathTerm(value, ownPrefix) {
  if (APP_ASSETS_PATH.test(value)) return value;
  if (WINDOWS_ABSOLUTE.test(value) || POSIX_ABSOLUTE.test(value)) return value;
  // Foundry 存储的资源引用一律不带 Data/ 前缀(worlds/<id>/...、systems/...);
  // 带 Data/ 前缀且不属于本世界的引用,下载者必然裂图。
  if (value.startsWith("Data/") && !value.startsWith(ownPrefix)) return value;
  return null;
}

async function auditExternalPaths(rootDir, worldId, violations) {
  const ownPrefix = `Data/worlds/${worldId ?? ""}/`;
  const flagged = new Set();
  const check = (file, value) => {
    if (flagged.size >= MAX_PATH_VIOLATIONS_PER_FILE * 50) return;
    const term = externalPathTerm(value, ownPrefix);
    if (term == null) return;
    const key = `${file}${term.slice(0, 160)}`;
    if (flagged.has(key)) return;
    const perFile = [...flagged].filter((entry) => entry.startsWith(`${file}`)).length;
    if (perFile >= MAX_PATH_VIOLATIONS_PER_FILE) return;
    flagged.add(key);
    violations.push({ file, kind: "external-path", term: term.slice(0, 160) });
  };

  // data/ 下的 LevelDB:逐条记录解 JSON 扫描(ripgrep 扫不到二进制包里的引用)。
  const dataDir = path.join(rootDir, "data");
  for (const entry of await fsp.readdir(dataDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const packDir = path.join(dataDir, entry.name);
    if (!await fsp.stat(path.join(packDir, "CURRENT")).catch(() => null)) continue;
    const file = `data/${entry.name}`;
    let records;
    try {
      records = await readPackRecords(packDir);
    } catch {
      continue; // 打不开由 users/messages 专项检查各自报告,这里不重复
    }
    for (const [, raw] of records) {
      const doc = parseRecord(raw);
      for (const value of stringsOf(doc ?? raw)) check(file, value);
    }
  }

  // data/ 之外的文本文件(world.json、说明 html/md 等):整体扫描。
  for await (const absolute of walkFiles(rootDir)) {
    const file = relativeFile(rootDir, absolute);
    if (file === "data" || file.startsWith("data/")) continue;
    if (!TEXT_SUFFIXES.has(path.extname(absolute).toLowerCase())) continue;
    const text = await fsp.readFile(absolute, "utf8").catch(() => "");
    if (!text) continue;
    for (const match of text.match(/Data\/[^\s"'<>]+/g) ?? []) check(file, match);
    for (const match of text.match(WINDOWS_PATH_IN_TEXT) ?? []) check(file, match);
    if (POSIX_ABSOLUTE.test(text)) check(file, text.match(POSIX_ABSOLUTE)?.[0] ?? file);
    if (APP_ASSETS_PATH.test(text)) check(file, text.match(APP_ASSETS_PATH)?.[0] ?? file);
  }
}

/**
 * 审计一个已解包的世界目录;返回 [{ file, kind, term }],不抛错。
 * @param {string} worldDir 世界目录(必须是可丢弃副本,见文件头注释)
 * @param {object} [options]
 * @param {boolean} [options.requireEmptyMessages=true] messages pack 必须无记录
 * @param {boolean} [options.requireUsers=true] users pack 存在时必须有用户记录
 * @param {string} [options.worldId] 默认从 world.json 读;用于本世界路径白名单
 */
export async function auditWorldDirectory(worldDir, {
  requireEmptyMessages = true,
  requireUsers = true,
  worldId,
} = {}) {
  const rootDir = path.resolve(worldDir);
  const resolvedWorldId = worldId ?? await readWorldId(rootDir);
  const violations = [];
  await auditUsersPack(rootDir, violations, { requireUsers });
  if (requireEmptyMessages) await auditMessagesPack(rootDir, violations);
  await auditExternalPaths(rootDir, resolvedWorldId, violations);
  return violations;
}

// ---- 本地直接运行:node scripts/world-content-audit.mjs <世界目录> [--allow-messages] ----
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const [target, ...flags] = process.argv.slice(2);
  if (!target) {
    process.stderr.write("usage: node scripts/world-content-audit.mjs <world-dir> [--allow-messages]\n");
    process.exitCode = 1;
  } else {
    const violations = await auditWorldDirectory(target, {
      requireEmptyMessages: !flags.includes("--allow-messages"),
    });
    if (violations.length) {
      for (const violation of violations) {
        process.stderr.write(`BLOCKED ${violation.file}: [${violation.kind}] ${violation.term}\n`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write("world content audit OK\n");
    }
  }
}
