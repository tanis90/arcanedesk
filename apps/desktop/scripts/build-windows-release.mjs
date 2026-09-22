#!/usr/bin/env node
// build-windows-release.mjs — Windows 四变体本机构建编排（2026-09 拍板重构：
// Windows 不再走 GitHub Actions，构建/校验全本机，签名紧随其后。消掉两件
// 慢事：构件跨境下载（810MB exe 从 GH 拉本地，0.4.3/0.5.1/0.6.0 三次都拖过
// 后腿）与「构建完到签名」的数小时窗口里 SimplySign 会话过期）。
//
// 与被删除的 CI windows 腿逐项对等的门禁序列（差异只有一处：本机没有 OIDC
// 主体，产不出 provenance attestation——下游目前无消费方，runbook 有记）：
//   1. 钉提交：--release-id 的 sha8 必须 == HEAD；tracked 文件不得有未提交
//      改动（untracked 不参与打包，放行）。0.6.0 发版中途 HEAD 被另一会话
//      推进过，这道卡就是为那种时刻设的；
//   2. 逐 (region × arch) 四变体：prepare:dist + electron-builder（经
//      dist.mjs，CSC_IDENTITY_AUTO_DISCOVERY=false），随后 verify-package
//      （--expected-node-platform/--expected-region；arm64 交叉构建加
//      --runtime-from-manifest）——app-update.yml 位置 bug 就是这道门禁抓的；
//   3. 每变体构建后立刻把 exe/zip 移出 dist/（杜绝变体间残留串味），zip 进
//      stage 树、exe 进 installers 树，另存未签名基线 SHA256SUMS 供核对。
//
// 前置：npm ci 已跑、npm run build:sdk 已跑、SimplySign 已登录（若接着签名）。
// 后续（runbook 分阶段流程）：sign-windows --in <out>/installers →
// stage-release --staging <out>/stage/<region>（仅 zip）→ publish-release
// --finalize --fragment <mac 分片> --fragment <本机 windows 分片>。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const VARIANTS = [
  { region: "cn", arch: "x64", suffix: "" },
  { region: "cn", arch: "arm64", suffix: "" },
  { region: "intl", arch: "x64", suffix: "-intl" },
  { region: "intl", arch: "arm64", suffix: "-intl" },
];

function parseArgs(argv) {
  const args = {};
  const takeValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--release-id") args.releaseId = takeValue(a, i++);
    else if (a === "--out") args.out = takeValue(a, i++);
    else if (a === "--only") args.only = takeValue(a, i++).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help") args.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (!args.help && !args.releaseId) throw new Error("--release-id is required (e.g. 0.6.1-1a2b3c4d)");
  return args;
}

function usage() {
  return [
    "usage: node scripts/build-windows-release.mjs --release-id <version>-<sha8>[-intl]",
    "                  [--out <dir>] [--only cn,intl|x64,arm64] [--dry-run]",
    "",
    "  --release-id   发版 id；sha8 必须等于当前 HEAD（钉提交纪律）",
    `  --out          产物树根目录，默认 ${path.join(desktopRoot, "windows-release-build")}`,
    "  --only         逗号分隔的 region/arch 过滤（默认四个变体全建）",
    "  --dry-run      只打印计划（提交校验仍执行），不构建",
  ].join("\n");
}

/**
 * @param {string} cmd
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 */
function run(cmd, argv, options = {}) {
  // Windows 上 npm 是 npm.cmd：Node ≥20.12 的安全策略禁止无 shell 直接 spawn
  // .cmd/.bat（status=null 且零输出即死）。npm 调用单独走 shell；参数均为固定
  // 字面量，无注入面。node.exe（verify-package 等）无需 shell。
  const needsShell = process.platform === "win32" && cmd === "npm";
  const result = spawnSync(cmd, argv, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: needsShell,
  });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed with exit ${result.status}`);
}

async function sha256File(file) {
  const { createHash } = await import("node:crypto");
  const { pipeline } = await import("node:stream/promises");
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("build-windows-release.mjs only runs on Windows (NSIS + winCodeSign are Windows tooling)");
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  // 1. 钉提交：release id 的 sha8 == HEAD；tracked 树干净。
  const baseId = args.releaseId.replace(/-intl$/, "");
  const sha8 = baseId.match(/^\d+\.\d+\.\d+-([0-9a-f]{8})$/)?.[1];
  if (!sha8) throw new Error(`--release-id must look like <version>-<sha8>[-intl]: ${args.releaseId}`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  if (!head.startsWith(sha8)) {
    throw new Error(`HEAD (${head.slice(0, 8)}) != release id sha8 (${sha8}); checkout the release commit first`);
  }
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/).filter((line) => line && !line.startsWith("??"));
  if (dirty.length) {
    throw new Error(`tracked files have uncommitted changes (${dirty.length} paths, first: ${dirty[0].slice(0, 60)}…); commit or stash before building a release`);
  }
  const version = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;
  if (!baseId.startsWith(`${version}-`)) {
    throw new Error(`apps/desktop package version (${version}) != release id version (${baseId})`);
  }

  const variants = VARIANTS.filter((v) => !args.only || args.only.includes(v.region) || args.only.includes(v.arch));
  const outDir = path.resolve(args.out ?? path.join(desktopRoot, "windows-release-build"));
  console.log(`release ${baseId} @ ${sha8} (HEAD ok, tree clean, version ${version})`);
  console.log(`output tree ${outDir}`);
  for (const v of variants) {
    console.log(`  variant ${v.region}/${v.arch}: Arcane-Desk-${version}-win-${v.arch}${v.suffix}.{exe,zip}`);
  }
  if (args.dryRun) {
    console.log("dry-run: no builds performed");
    return;
  }

  for (const v of variants) {
    const label = `${v.region}/${v.arch}`;
    console.log(`\n=== build ${label} ===`);
    // 与被删的 CI 腿同一组 env：ARCANE_RELEASE_ID 传 base（intl 后缀由 region.json
    // 驱动 artifactName 宏，包内 manifest 的 releaseId 由 finalize 的 --release-id 覆写）。
    // channel 必须与 publish-release 的 --channel 同轨：烙错轨道的包发布后客户端
    // 轮询另一条永不发布的 feed，静默永远收不到更新（0.6.0 事故）。
    const env = {
      ARCANE_BUNDLED_NODE_PLATFORM: `win-${v.arch}`,
      ARCANE_BUILD_REGION: v.region,
      ARCANE_SOURCE_COMMIT: head,
      ARCANE_RELEASE_ID: baseId,
      ARCANE_RELEASE_CHANNEL: "private-beta",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    };
    run("npm", ["run", "dist:win", "--", `--${v.arch}`], { cwd: desktopRoot, env });

    const distDir = path.join(desktopRoot, "dist");
    const exeName = `Arcane-Desk-${version}-win-${v.arch}${v.suffix}.exe`;
    const zipName = `Arcane-Desk-${version}-win-${v.arch}${v.suffix}.zip`;
    const exe = path.join(distDir, exeName);
    const zip = path.join(distDir, zipName);
    for (const file of [exe, zip]) {
      if (!fs.existsSync(file)) throw new Error(`expected build output missing: ${file}`);
    }

    const unpackedApp = path.join(distDir, `win-${v.arch}-unpacked`, "resources", "app");
    if (!fs.statSync(unpackedApp).isDirectory()) throw new Error(`unpacked app dir missing: ${unpackedApp}`);
    const verifyArgv = [path.join("scripts", "verify-package.mjs"), unpackedApp];
    if (v.arch === "arm64") verifyArgv.push("--runtime-from-manifest"); // 交叉构建：runner 架构 ≠ 目标架构
    verifyArgv.push("--expected-node-platform", `win-${v.arch}`, "--expected-region", v.region, "--expected-channel", "private-beta");
    run(process.execPath, verifyArgv, { cwd: desktopRoot });

    const platformDir = path.join(outDir, "stage", `staging-${v.region}`, `windows-${v.arch}`);
    const installersDir = path.join(outDir, "installers");
    const recordsDir = path.join(outDir, "records", `windows-${v.arch}${v.suffix}`);
    await fsp.mkdir(platformDir, { recursive: true });
    await fsp.mkdir(installersDir, { recursive: true });
    await fsp.mkdir(recordsDir, { recursive: true });
    const [exeSha, zipSha] = await Promise.all([sha256File(exe), sha256File(zip)]);
    await fsp.writeFile(
      path.join(recordsDir, "SHA256SUMS.txt"),
      `${exeSha}  ${exeName}\n${zipSha}  ${zipName}\n`,
      "utf8",
    );
    await fsp.rename(zip, path.join(platformDir, zipName)); // stage 树只进 zip：未签名 exe 不上桶
    await fsp.rename(exe, path.join(installersDir, exeName));
    console.log(`variant ${label} built, verified, staged (records: ${path.join(recordsDir, "SHA256SUMS.txt")})`);
  }

  console.log(`\nall ${variants.length} variant(s) built and verified → ${outDir}`);
  console.log("next (runbook phased flow):");
  console.log(`  node scripts/sign-windows.mjs --in ${path.join(outDir, "installers")}`);
  for (const region of [...new Set(variants.map((v) => v.region))]) {
    console.log(`  node scripts/stage-release.mjs --staging ${path.join(outDir, "stage", `staging-${region}`)} --region ${region} --release-id ${region === "intl" ? `${baseId}-intl` : baseId}`);
  }
  console.log(`  node scripts/publish-release.mjs --finalize --staging <exe-staging> --signed-dir <signed> \\`);
  console.log(`    --fragment <mac-fragment> --fragment <windows-fragment> --region cn --release-id ${baseId} --channel <channel>`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
