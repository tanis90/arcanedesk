#!/usr/bin/env node
// sign-windows.mjs — Windows NSIS 安装包本地签名（先签后发，2026-09 拍板方案）。
//
// 为什么不在 CI 签：Windows 证书是 Certum 云签名证书（SimplySign CSP，私钥不可
// 导出），只存在于装有 SimplySign Desktop 且已登录的机器上；GitHub 托管 runner
// 既拿不到私钥，也无法导出 p12 塞进 secrets。因此 Windows 的签名纪律是：
//   1. CI 只跑 build-only（skip_oss=true），产出未签名构件；
//   2. 本地用本脚本对 NSIS .exe 做 Authenticode 签名（SHA-256 + RFC3161 时间戳）；
//   3. publish-release.mjs --signed-dir 用签名副本覆盖同名构建件，按实际发布文件
//      重建 SHA256SUMS、把签名后的 bytes/sha256 写进 release.json，以新 releaseId
//      一次性不可变发布——绝不覆写已发布的版本目录。
//
// 只签 .exe 安装器（主要分发物）；.zip 内的解包 exe 保持未签名，与 0.4.3 首签口径
// 一致。mac 产物在 CI 已完成 Developer ID 签名 + 公证，不经本脚本。
//
// 前置：SimplySign Desktop 已登录（签名会话可能需要在手机 App 确认 OTP）。
// signtool 发现顺序：--signtool / ARCANE_SIGNTOOL → Windows Kits →
// electron-builder winCodeSign 缓存 → PATH。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 证书 SHA-1 钉死（与 mac identity 钉 SHA-1 同一纪律）。公开信息：随每个已签名
// 二进制分发。轮换证书时更新默认值或设 ARCANE_WIN_CERT_SHA1。
// 当前：Certum OV 代码签名（CN=Qi Yang），2027-09-07 到期。
export const DEFAULT_CERT_SHA1 = "C4D07AF1EAB836D3036774B0765994716543D392";
const DEFAULT_TIMESTAMP_SERVER = "http://timestamp.sectigo.com";

// electron-builder artifactName：Arcane-Desk-<version>-win-<arch>[-intl].exe
const INSTALLER_NAME_PATTERN = /^Arcane-Desk-[0-9][A-Za-z0-9.]*-win-(x64|arm64)(?:-intl)?\.exe$/;

export function isInstallerName(name) {
  return INSTALLER_NAME_PATTERN.test(name);
}

// 递归收集 NSIS 安装器（cn/intl 同名规则一起收），返回排序后的绝对路径。
export function collectInstallerExes(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && isInstallerName(entry.name)) found.push(absolute);
    }
  };
  walk(root);
  return found.sort();
}

// signtool 候选路径（纯函数，存在性由 findSigntool 检查）。Windows Kits 取版本号
// 排序后最新；winCodeSign 缓存优先 windows-10（electron-builder 26 签名实际用的
// 就是它），回落 windows-6。
/**
 * @param {{ explicit?: string | null, programFilesX86?: string | null, localAppData?: string | null }} [options]
 */
export function signtoolSearchPaths({ explicit, programFilesX86, localAppData } = {}) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (programFilesX86) {
    const kitsBin = path.join(programFilesX86, "Windows Kits", "10", "bin");
    let versions = [];
    try {
      versions = fs.readdirSync(kitsBin).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true })); // 版本号降序：最新优先
    } catch {
      // 未安装 Windows SDK：跳过该来源。
    }
    for (const version of versions) candidates.push(path.join(kitsBin, version, "x64", "signtool.exe"));
  }
  if (localAppData) {
    const cache = path.join(localAppData, "electron-builder", "Cache", "winCodeSign");
    try {
      const packages = fs.readdirSync(cache).filter((n) => /^winCodeSign-/.test(n))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true })); // 包版本降序：最新优先
      for (const name of packages) {
        candidates.push(path.join(cache, name, "windows-10", "x64", "signtool.exe"));
        candidates.push(path.join(cache, name, "windows-6", "signtool.exe"));
      }
    } catch {
      // electron-builder 从未在本机构建过 Windows 包：跳过该来源。
    }
  }
  candidates.push("signtool.exe"); // PATH 兜底
  return candidates;
}

function findSigntool(options) {
  for (const candidate of signtoolSearchPaths(options)) {
    if (candidate === "signtool.exe") {
      const probe = spawnSync(candidate, ["verify", "/?"], { encoding: "utf8", windowsHide: true });
      if (probe.status === 0 || probe.status === 1) return candidate; // signtool verify /? 退出码不固定
      continue;
    }
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function buildSignArgs({ certSha1, timestampServer, file }) {
  return ["sign", "/fd", "SHA256", "/tr", timestampServer, "/td", "SHA256", "/sha1", certSha1, file];
}

export function buildVerifyArgs({ file }) {
  return ["verify", "/pa", "/all", file];
}

// PowerShell 读取现有签名状态：status（Valid/NotSigned/…）、签名者指纹、是否带
// RFC3161 时间戳。读不到签名者时 thumbprint/timestamped 为 null。
function signatureState(file) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = Get-AuthenticodeSignature -LiteralPath ${JSON.stringify(file)}`,
    "[pscustomobject]@{ status = $s.Status.ToString(); thumbprint = $s.SignerCertificate.Thumbprint; timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Get-AuthenticodeSignature failed for ${file}: ${(result.stderr ?? "").trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Get-AuthenticodeSignature returned unparsable output for ${file}: ${result.stdout.trim()}`);
  }
}

function runSigntool(signtool, args, label) {
  const result = spawnSync(signtool, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`signtool ${label} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function parseArgs(argv) {
  const args = { in: [] };
  const takeValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--in") args.in.push(takeValue(a, i++));
    else if (a === "--out") args.out = takeValue(a, i++);
    else if (a === "--sha1") args.sha1 = takeValue(a, i++);
    else if (a === "--timestamp") args.timestamp = takeValue(a, i++);
    else if (a === "--signtool") args.signtool = takeValue(a, i++);
    else if (a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help") args.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (!args.help && !args.in.length) throw new Error("--in is required (repeatable, e.g. staging-cn staging-intl)");
  return args;
}

function usage() {
  return [
    "usage: node scripts/sign-windows.mjs --in <dir> [--in <dir> ...] [--out <dir>]",
    "                  [--sha1 <cert-sha1>] [--timestamp <rfc3161-url>] [--signtool <path>]",
    "                  [--force] [--dry-run]",
    "",
    `  --in          递归收集 Arcane-Desk-*-win-*.exe 的根目录（可重复）`,
    `  --out         签名副本输出目录（扁平，喂给 publish-release.mjs --signed-dir）`,
    `                默认 ${path.join(desktopRoot, "dist-signed")}`,
    `  --sha1        证书 SHA-1，默认 ${DEFAULT_CERT_SHA1} 或 $ARCANE_WIN_CERT_SHA1`,
    `  --timestamp   RFC3161 时间戳服务，默认 ${DEFAULT_TIMESTAMP_SERVER}`,
    "  --signtool    显式指定 signtool 路径（或 $ARCANE_SIGNTOOL）",
    "  --force       对已有效签名的文件重签",
    "  --dry-run     只列出待签名文件",
  ].join("\n");
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("sign-windows.mjs only runs on Windows (Authenticode + SimplySign CSP are Windows-only)");
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const certSha1 = (args.sha1 ?? process.env.ARCANE_WIN_CERT_SHA1 ?? DEFAULT_CERT_SHA1).toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(certSha1)) throw new Error(`--sha1 must be a 40-hex-char certificate thumbprint: ${certSha1}`);
  const timestampServer = args.timestamp ?? process.env.ARCANE_WIN_TIMESTAMP ?? DEFAULT_TIMESTAMP_SERVER;
  const outDir = args.out ? path.resolve(args.out) : path.join(desktopRoot, "dist-signed");

  const installers = args.in.flatMap((root) => collectInstallerExes(path.resolve(root)));
  if (!installers.length) throw new Error("no Arcane-Desk-*-win-*.exe installers found under the given --in directories");
  const names = installers.map((file) => path.basename(file));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`duplicate installer names across --in directories: ${[...new Set(duplicates)].join(", ")}`);

  console.log(`certificate ${certSha1}, timestamp ${timestampServer}`);
  console.log(`output directory ${outDir}`);
  for (const file of installers) console.log(`  installer ${file}`);

  if (args.dryRun) {
    console.log("dry-run: no signing performed");
    return;
  }

  const signtool = findSigntool({
    explicit: args.signtool ?? process.env.ARCANE_SIGNTOOL ?? null,
    programFilesX86: process.env["ProgramFiles(x86)"] ?? null,
    localAppData: process.env.LOCALAPPDATA ?? null,
  });
  if (!signtool) {
    throw new Error(
      "signtool.exe not found; install the Windows SDK, build a Windows package once "
      + "(electron-builder caches winCodeSign), or pass --signtool / ARCANE_SIGNTOOL",
    );
  }
  console.log(`signtool ${signtool}`);

  await fsp.mkdir(outDir, { recursive: true });
  let signed = 0;
  let skipped = 0;
  for (const source of installers) {
    const name = path.basename(source);
    const existing = signatureState(source);
    if (existing.status === "Valid" && !args.force) {
      console.log(`skip ${name}: already validly signed (${existing.thumbprint}${existing.timestamped ? ", timestamped" : ", UNTIMESTAMPED"})`);
      skipped += 1;
      continue;
    }
    if (!["Valid", "NotSigned"].includes(existing.status)) {
      throw new Error(`refusing to sign ${name}: existing signature state is ${existing.status} (expected NotSigned; investigate the artifact)`);
    }

    const target = path.join(outDir, name);
    if (fs.existsSync(target) && !args.force) {
      throw new Error(`output already exists: ${target} (remove it or pass --force to re-sign)`);
    }
    await fsp.copyFile(source, target);

    console.log(`signing ${name} …`);
    runSigntool(signtool, buildSignArgs({ certSha1, timestampServer, file: target }), `sign ${name}`);
    runSigntool(signtool, buildVerifyArgs({ file: target }), `verify ${name}`);

    const state = signatureState(target);
    if (state.status !== "Valid") throw new Error(`signature is not Valid after signing ${name}: ${state.status}`);
    if (state.thumbprint?.toUpperCase() !== certSha1) {
      throw new Error(`signed with the wrong certificate for ${name}: ${state.thumbprint} (wanted ${certSha1})`);
    }
    if (!state.timestamped) {
      throw new Error(`signature has no RFC3161 timestamp: ${name} (cert expires, signature must outlive it; check ${timestampServer})`);
    }
    console.log(`signed ${name} (Authenticode Valid, ${state.thumbprint}, timestamped)`);
    signed += 1;
  }

  console.log(`done: ${signed} signed, ${skipped} skipped → ${outDir}`);
  if (signed === 0 && skipped === installers.length) {
    console.log("nothing newly signed; pass --force to re-sign existing signatures");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
