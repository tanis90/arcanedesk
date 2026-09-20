// entrypoint.mjs — 容器入口（幂等，每次启动都跑同一套检查）。
//
// 职责顺序（方案 docs/server-deploy-plan.md §4）：
//   1. 解析 region（ARCANE_REGION=cn|intl），从镜像内生成的 region-defaults.mjs
//      拿 mod 索引端点——与 desktop 的 src/main/region.mjs 同一张表（构建期生成）。
//   2. 核对/安装 Foundry 本体到 ${ARCANE_FOUNDRY}/${FOUNDRY_VERSION}/：
//      已有 main.js 则跳过；缺则按序取 挂载 zip → FOUNDRY_RELEASE_URL；
//      版本/结构与 pins.mjs 钉版不符直接拒启（fail-closed）。
//   3. 首启安装环境（ARCANE_SKIP_MODS=1 可跳过——CI 冒烟用）：
//      cn 索引有 arcane-demo 世界 profile 时走 world-inspect → world-stage →
//      world-commit（dnd5e 与策展 mod 一并装入，字节级校验都在协议内）；
//      intl 无 worlds 则跳过。
//   4. 清 Config/options.json.lock；options.json 缺失时写入 {port:30000} 最小骨架。
//   5. 启动 node main.js --dataPath=<data> 并转发 SIGTERM/SIGINT（docker stop 走优雅停机）。
//
// 纪律：license key / adminKey 永不打印（用户在面板里自己完成激活）；
// FOUNDRY_RELEASE_URL 下载完成即弃，绝不缓存或再分发（EULA）。

import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { FOUNDRY_VERSION } from "./pins.mjs";
import { REGION_DEFAULTS } from "./region-defaults.mjs";

// 官方 Node.JS 构建的 zip 含符号链接(node_modules/.bin/*),vendored yauzl 的
// symlink 拒绝是 mod 防线、不适用用户自供的本体——压缩包操作一律走镜像内
// 的 unzip CLI(apt 层已装),符号链接原样保留。
function unzip(args) {
  return new Promise((resolve, reject) => {
    execFile("unzip", args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`unzip ${args.join(" ")} failed: ${error.message}`));
      else resolve(stdout);
    });
  });
}
async function unzipEntry(zipFile, entryName) {
  const text = await unzip(["-p", zipFile, entryName]);
  return text.length ? text : null;
}

// 官方包的版本写法与下载页不同源:zip 内 package.json 是三段("13.351.0"),
// 我们的钉版沿用 community-distribution 的两段("13.351")。规范化到三段再比,
// 既容忍尾段 0,也不放前缀误匹配("13.351"绝不等于"13.3519")。
function normalizeVersion(value) {
  const segments = String(value ?? "").split(".").map(Number);
  if (segments.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  while (segments.length < 3) segments.push(0);
  return segments.slice(0, 3).join(".");
}

const foundryRoot = process.env.ARCANE_FOUNDRY ?? "/arcane/foundry";
const dataDir = process.env.ARCANE_DATA ?? "/arcane/data";
const incomingDir = process.env.ARCANE_INCOMING ?? "/arcane/incoming";
const regionId = process.env.ARCANE_REGION ?? "cn";

if (!REGION_DEFAULTS[regionId]) {
  console.error(`ARCANE_REGION must be one of ${Object.keys(REGION_DEFAULTS).join("/")}; got: ${regionId}`);
  process.exit(1);
}
const modIndexUrl = REGION_DEFAULTS[regionId].modIndexUrl;

function log(step, message) {
  console.log(`[arcane:${step}] ${message}`);
}

async function ensureDirs() {
  // 数据目录契约(Config/Data/Logs;Data 下三件套):mod-manager 的 assertDataDirectory
  // 要求 <data-dir>/Data/ 已存在,首启必须先铺好,否则 world 协议在 staging 前的
  // 盘点阶段就会拒止。
  const dirs = [
    path.join(foundryRoot, FOUNDRY_VERSION),
    incomingDir,
    path.join(dataDir, "Config"),
    path.join(dataDir, "Data", "systems"),
    path.join(dataDir, "Data", "modules"),
    path.join(dataDir, "Data", "worlds"),
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

// zip 内布局做有界探测：Node.JS 构建的 zip 里 main.js/package.json 可能在根，
// 也可能在 resources/app/ 下（官方打包两个通道都有过），两个候选都认；
// 版本号必须与 pins.mjs 的钉版完全一致，否则拒装。
async function resolveZipLayout(zipFile) {
  for (const prefix of ["", "resources/app/"]) {
    const mainJs = await unzipEntry(zipFile, `${prefix}main.js`).catch(() => null);
    if (!mainJs) continue;
    const packageJson = await unzipEntry(zipFile, `${prefix}package.json`).catch(() => null);
    if (packageJson) {
      const pkg = JSON.parse(packageJson);
      const declared = normalizeVersion(pkg?.version);
      const pinned = normalizeVersion(FOUNDRY_VERSION);
      if (!declared || declared !== pinned) {
        throw new Error(
          `foundry zip is version ${String(pkg?.version)}, this image pins ${FOUNDRY_VERSION}; `
          + `download the matching Node.JS build from Purchased Licenses → Older Stable`,
        );
      }
    }
    return { mainJs: `${prefix}main.js` };
  }
  throw new Error("foundry zip does not contain main.js (expected the Node.JS build, not a desktop installer)");
}

async function installFoundry() {
  const installDir = path.join(foundryRoot, FOUNDRY_VERSION);
  if (await fsp.stat(path.join(installDir, "main.js")).then(() => true).catch(() => false)) {
    log("foundry", `core ${FOUNDRY_VERSION} already installed at ${installDir}`);
    return installDir;
  }

  let zipFile = null;
  const candidates = (await fsp.readdir(incomingDir).catch(() => [])).filter((name) => /^foundryvtt.*\.zip$/i.test(name));
  if (candidates.length > 1) {
    throw new Error(`multiple foundry zips in ${incomingDir}: ${candidates.join(", ")}; keep exactly one`);
  }
  if (candidates.length === 1) zipFile = path.join(incomingDir, candidates[0]);

  if (!zipFile && process.env.FOUNDRY_RELEASE_URL) {
    const releaseUrl = process.env.FOUNDRY_RELEASE_URL;
    if (!/^https:\/\//.test(releaseUrl)) throw new Error("FOUNDRY_RELEASE_URL must be https");
    log("foundry", "downloading from the timed URL (valid for ~5 minutes; not cached, not re-served)");
    const response = await fetch(releaseUrl, { redirect: "error" });
    if (!response.ok) throw new Error(`FOUNDRY_RELEASE_URL download failed: HTTP ${response.status}`);
    zipFile = path.join(incomingDir, `foundryvtt-${FOUNDRY_VERSION}.zip`);
    await fsp.writeFile(zipFile, Buffer.from(await response.arrayBuffer()));
  }

  if (!zipFile) {
    throw new Error(
      `no foundry core: drop foundryvtt-${FOUNDRY_VERSION}.zip (Node.JS build) into the incoming volume `
      + `(${incomingDir}) or set FOUNDRY_RELEASE_URL, then restart the container`,
    );
  }

  const layout = await resolveZipLayout(zipFile);
  log("foundry", `extracting ${path.basename(zipFile)} (main.js at ${layout.mainJs}) into ${installDir}`);
  await unzip(["-q", "-o", zipFile, "-d", installDir]);
  // 解压目录可能是 zip 根布局，也可能是外层单目录包裹——统一收敛到 installDir/main.js。
  if (!(await fsp.stat(path.join(installDir, "main.js")).then(() => true).catch(() => false))) {
    const top = (await fsp.readdir(installDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (top.length === 1) {
      const inner = path.join(installDir, top[0].name);
      if (await fsp.stat(path.join(inner, "main.js")).then(() => true).catch(() => false)) {
        for (const entry of await fsp.readdir(inner)) {
          await fsp.rename(path.join(inner, entry), path.join(installDir, entry));
        }
        await fsp.rmdir(inner);
      }
    }
  }
  if (!(await fsp.stat(path.join(installDir, "main.js")).then(() => true).catch(() => false))) {
    throw new Error(`extracted archive has no main.js at ${installDir}`);
  }
  return installDir;
}

// 首启环境安装：dnd5e 是 system,mod-manager 的 module 通道(inspect/stage)不收
// system——正确路径是 world 环境协议:cn 索引发布 arcane-demo 世界 + profile
// (world-inspect → world-stage → world-commit),dnd5e 与策展 mod 作为 profile
// 依赖一并装入,字节级校验/receipt 全在协议内。intl 索引暂无 worlds,跳过
// (正式世界由用户经 arcane-fvtt-mods skill 或自建)。
// mod-manager 懒加载:依赖闭包里有原生模块(classic-level),跳过或已就位时零感知。
async function installDemoEnvironment() {
  if (process.env.ARCANE_SKIP_MODS === "1") {
    log("mods", "ARCANE_SKIP_MODS=1 — skipping first-boot environment install");
    return;
  }
  const demoWorldMarker = path.join(dataDir, "Data", "worlds", "arcane-demo", "world.json");
  const dnd5eMarker = path.join(dataDir, "Data", "systems", "dnd5e", "system.json");
  if (await fsp.stat(demoWorldMarker).then(() => true).catch(() => false)
    && await fsp.stat(dnd5eMarker).then(() => true).catch(() => false)) {
    log("mods", "demo environment already present; skipping");
    return;
  }

  log("mods", `reading mod index ${modIndexUrl}`);
  const response = await fetch(modIndexUrl, { redirect: "error" });
  if (!response.ok) throw new Error(`mod index fetch failed: HTTP ${response.status}`);
  const index = await response.json();
  const worldEntry = (index?.worlds ?? []).find((entry) => entry?.defaultProfile);
  if (!worldEntry) {
    log("mods", "region index publishes no world profile — skipping first-boot environment (install via the arcane-fvtt-mods skill)");
    return;
  }

  const { runCli } = await import("./mod-manager/mod-manager.mjs");
  const plan = await runCli([
    "world-inspect", "--world-id", String(worldEntry.id), "--data-dir", dataDir, "--allow-missing-data-dir",
  ]);
  if (!plan?.actionable?.length) {
    log("mods", "environment already current per world-inspect; skipping");
    return;
  }
  log("mods", `staging world environment ${plan.id} r${plan.profile.revision} (${plan.actionable.length} artifact(s), ${plan.plannedArchiveBytes} bytes)`);
  const staged = await runCli([
    "world-stage",
    "--world-id", String(worldEntry.id),
    "--data-dir", dataDir,
    "--expected-world-version", String(plan.version),
    "--expected-world-sha256", String(plan.archiveSha256),
    "--expected-profile-id", String(plan.profile.id),
    "--expected-profile-revision", String(plan.profile.revision),
    "--expected-profile-sha256", String(plan.profile.profileSha256),
    "--expected-index-generated", String(plan.generated),
    "--expected-resolution-sha256", String(plan.resolutionSha256),
  ]);
  // expected-current-version 要的是"已安装版本"(missing → none),不是目标版本。
  const installedWorld = plan.world?.installedVersion ?? null;
  const committed = await runCli([
    "world-commit",
    "--stage-dir", String(staged.stageDir),
    "--data-dir", dataDir,
    "--expected-current-version", installedWorld ?? "none",
  ]);
  log("mods", `environment installed: world ${committed.id ?? plan.id} v${committed.version ?? plan.version}, receipt ${committed.receiptPath ?? "kept"}`);
}

async function prepareDataDir() {
  const lockFile = path.join(dataDir, "Config", "options.json.lock");
  await fsp.rm(lockFile, { force: true });
  const optionsFile = path.join(dataDir, "Config", "options.json");
  if (!(await fsp.stat(optionsFile).then(() => true).catch(() => false))) {
    await fsp.writeFile(optionsFile, `${JSON.stringify({ port: 30000 }, null, 2)}\n`);
    log("data", "wrote minimal options.json (port 30000)");
  }
}

async function main() {
  log("boot", `region=${regionId} foundry=${FOUNDRY_VERSION} modIndex=${modIndexUrl}`);
  await ensureDirs();
  const installDir = await installFoundry();
  await installDemoEnvironment();
  await prepareDataDir();

  // Foundry 只认等号形式(--dataPath=<dir>):空格分隔时它的 argv 解析拿不到值,
  // paths.mjs 会在 path.resolve(undefined) 上崩。
  const args = [path.join(installDir, "main.js"), `--dataPath=${dataDir}`];
  if (process.env.ARCANE_WORLD) args.push("--world", process.env.ARCANE_WORLD);
  log("boot", `starting foundry: node ${args.join(" ")}`);
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const forward = (signal) => () => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  const code = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? 0)));
  process.exit(code);
}

main().catch((error) => {
  console.error(`[arcane:fatal] ${error?.stack ?? error}`);
  process.exit(1);
});
