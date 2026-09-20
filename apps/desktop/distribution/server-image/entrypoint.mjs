// entrypoint.mjs — 容器入口（幂等，每次启动都跑同一套检查）。
//
// 职责顺序（方案 docs/server-deploy-plan.md §4）：
//   1. 解析 region（ARCANE_REGION=cn|intl），从镜像内生成的 region-defaults.mjs
//      拿 mod 索引端点——与 desktop 的 src/main/region.mjs 同一张表（构建期生成）。
//   2. 核对/安装 Foundry 本体到 ${ARCANE_FOUNDRY}/${FOUNDRY_VERSION}/：
//      已有 main.js 则跳过；缺则按序取 挂载 zip → FOUNDRY_RELEASE_URL；
//      版本/结构与 pins.mjs 钉版不符直接拒启（fail-closed）。
//   3. 首启安装 dnd5e 系统（ARCANE_SKIP_MODS=1 可跳过——CI 冒烟用）：
//      读 region 索引找 dnd5e 条目 → mod-manager inspect → stage → commit，
//      与 skill 侧三步完全同一代码路径（索引 bytes/sha256 字节级校验都在里面）。
//   4. 清 Config/options.json.lock；options.json 缺失时写入 {port:30000} 最小骨架。
//   5. 启动 node main.js --dataPath=<data> 并转发 SIGTERM/SIGINT（docker stop 走优雅停机）。
//
// 纪律：license key / adminKey 永不打印（用户在面板里自己完成激活）；
// FOUNDRY_RELEASE_URL 下载完成即弃，绝不缓存或再分发（EULA）。

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { FOUNDRY_VERSION } from "./pins.mjs";
import { REGION_DEFAULTS } from "./region-defaults.mjs";
import { extractZip, listZipEntries, readZipEntryText } from "./mod-manager/archive-zip.mjs";

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
  for (const dir of [path.join(foundryRoot, FOUNDRY_VERSION), dataDir, incomingDir, path.join(dataDir, "Config")]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

// zip 内布局做有界探测：Node.JS 构建的 zip 里 main.js/package.json 可能在根，
// 也可能在 resources/app/ 下（官方打包两个通道都有过），两个候选都认；
// 版本号必须与 pins.mjs 的钉版完全一致，否则拒装。
async function resolveZipLayout(zipFile) {
  const entries = new Set((await listZipEntries(zipFile)).map((entry) => entry.name));
  for (const prefix of ["", "resources/app/"]) {
    if (!entries.has(`${prefix}main.js`)) continue;
    const packageEntry = `${prefix}package.json`;
    if (entries.has(packageEntry)) {
      const pkg = JSON.parse(await readZipEntryText(zipFile, packageEntry, 1024 * 1024));
      if (pkg?.version !== FOUNDRY_VERSION) {
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
  await extractZip(zipFile, installDir);
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

// 首启装 dnd5e：读 region 索引定位条目，然后走 mod-manager 与 skill 侧完全相同
// 的 inspect → stage → commit 三步（字节级校验、原子替换、备份目录都在其中）。
// 此时服务尚未启动，"commit 前停服"的纪律天然满足。
// mod-manager 是懒加载的：它的依赖闭包里有原生模块(classic-level)，顶层 import
// 会让整个镜像被预编译平台绑架——跳过 mod 或 dnd5e 已就位时不应感知它。
async function installDnd5e() {
  if (process.env.ARCANE_SKIP_MODS === "1") {
    log("mods", "ARCANE_SKIP_MODS=1 — skipping first-boot dnd5e install");
    return;
  }
  const systemsDir = path.join(dataDir, "Data", "systems", "dnd5e");
  const current = await fsp.readFile(path.join(systemsDir, "system.json"), "utf8")
    .then((text) => JSON.parse(text)?.version)
    .catch(() => null);
  if (current) {
    log("mods", `dnd5e ${current} already present; skipping`);
    return;
  }

  log("mods", `reading mod index ${modIndexUrl}`);
  const response = await fetch(modIndexUrl, { redirect: "error" });
  if (!response.ok) throw new Error(`mod index fetch failed: HTTP ${response.status}`);
  const index = await response.json();
  const entry = (index?.packages ?? []).find((pkg) => pkg?.id === "dnd5e");
  if (!entry) throw new Error(`mod index has no dnd5e entry (expected ${modIndexUrl})`);

  log("mods", `installing dnd5e ${entry.version} via mod-manager`);
  const { runCli } = await import("./mod-manager/mod-manager.mjs");
  const inspected = await runCli([
    "inspect", "--manifest-url", entry.manifestUrl, "--data-dir", dataDir, "--allow-missing-data-dir",
  ]);
  const staged = await runCli([
    "stage",
    "--manifest-url", entry.manifestUrl,
    "--expected-id", String(entry.id),
    "--expected-version", String(entry.version),
    "--expected-download-url", String(entry.zipUrl),
  ]);
  const committed = await runCli([
    "commit", "--stage-dir", staged.stageDir, "--data-dir", dataDir, "--expected-current-version", "none",
  ]);
  log("mods", `dnd5e installed: ${committed.directory ?? systemsDir} (receipt kept)`);
  void inspected;
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
  await installDnd5e();
  await prepareDataDir();

  const args = [path.join(installDir, "main.js"), "--dataPath", dataDir];
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
