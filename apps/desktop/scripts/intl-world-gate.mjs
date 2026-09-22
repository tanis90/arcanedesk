#!/usr/bin/env node
// intl-world-gate — 世界包的解包级内容门禁(仅本地/测试运行,依赖 yauzl)。
//
// publish-intl-world.mjs 在上传前强制跑:把 zip 解到临时目录,对每个文件做
// 词表+CJK 扫描(文本文件按 utf8,LevelDB/二进制按 utf8 宽松解码兜底)。
// 零违规才允许上传;结果连同 zip SHA256 写进 distribution 的 gate 记录,
// prepare-intl-index.mjs(CI,builtin-only)只核对记录与工件哈希一致,不重复解包。

import { createHash } from "node:crypto";

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { extractZip } from "./archive-zip.mjs";
import { scanText } from "./intl-world-policy.mjs";

const TEXT_SUFFIXES = new Set([".json", ".js", ".mjs", ".md", ".html", ".css", ".txt", ".svg"]);

// 位图/媒体文件整体豁免:压缩字节做宽松 utf8 解码只会产出策略无关的噪音
// (snappy/png/webp 的随机字节会松散解出 CJK 假阳性,见搭建实测),而位图本身
// 不承载词表语义。SVG 是文本,不豁免。
const RASTER_SUFFIXES = new Set([".png", ".webp", ".jpg", ".jpeg", ".gif", ".bmp", ".mp3", ".ogg", ".wav", ".webm", ".mp4"]);

/** 扫描一个已解包的世界目录;返回 [{ file, kind, term }],不抛错。 */
export async function scanWorldDirectory(rootDir) {
  const violations = [];
  const walk = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (RASTER_SUFFIXES.has(path.extname(entry.name).toLowerCase())) continue;
      const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
      // 二进制(主要是 LevelDB)不做 utf8 严格校验:宽松解码仍能还原有效 CJK/ASCII 序列。
      const text = await fsp.readFile(absolute, "utf8").catch(() => "");
      const isText = TEXT_SUFFIXES.has(path.extname(entry.name).toLowerCase());
      for (const violation of scanText(text, { binary: !isText })) {
        violations.push({ file: relative, ...violation });
      }
    }
  };
  await walk(path.resolve(rootDir));
  return violations;
}

/**
 * 打包好的世界 zip 门禁:解包到 tempRoot 下的临时目录,扫描后清理。
 * @returns {Promise<{ violations: Array<{file,kind,term}>, sha256: string, bytes: number }>}
 */
export async function scanWorldZip(zipPath, tempRoot = os.tmpdir()) {
  const file = path.resolve(zipPath);
  const bytes = (await fsp.stat(file)).size;
  const sha256 = createHash("sha256").update(await fsp.readFile(file)).digest("hex");
  const staging = await fsp.mkdtemp(path.join(path.resolve(tempRoot), "arcane-world-gate-"));
  try {
    await extractZip(file, staging);
    const violations = await scanWorldDirectory(staging);
    return { violations, sha256, bytes };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- 本地直接运行:node scripts/intl-world-gate.mjs <world.zip> ----
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const [target] = process.argv.slice(2);
  if (!target) {
    process.stderr.write("usage: node scripts/intl-world-gate.mjs <world.zip>\n");
    process.exitCode = 1;
  } else {
    const result = await scanWorldZip(target);
    if (result.violations.length) {
      for (const violation of result.violations) {
        process.stderr.write(`BLOCKED ${violation.file}: [${violation.kind}] ${violation.term}\n`);
      }
      process.exitCode = 1;
    } else {
      process.stdout.write(`gate OK: sha256=${result.sha256} bytes=${result.bytes}\n`);
    }
  }
}
