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
//   5. 期望世界(ARCANE_WORLD 或 options.json 的 world)存在性 fail-closed 校验；
//      启动 node main.js --dataPath=<data> 并转发 SIGTERM/SIGINT（docker stop 走优雅停机）；
//      世界活性看门狗轮询 /api/status，长期未 active 打显著告警（license 失效/世界 id 错）。
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

// 期望自动拉起的世界:ARCANE_WORLD 优先;否则 Foundry 自己的持久化配置
// options.json 的 world 字段(init.mjs 的 launchDefaultWorld 消费它,容器重启
// 世界自动续跑靠的就是这个字段)。
async function resolveExpectedWorld() {
  if (process.env.ARCANE_WORLD) return process.env.ARCANE_WORLD;
  try {
    const options = JSON.parse(await fsp.readFile(path.join(dataDir, "Config", "options.json"), "utf8"));
    return typeof options?.world === "string" && options.world ? options.world : null;
  } catch {
    return null;
  }
}

// 指了不存在的世界时 fail-closed(与本体版本校验同等纪律):Foundry 对此不报错,
// 静默停在 setup 页,端口与 healthcheck 全部正常——宁可拒启让错误显眼。
async function assertWorldExists(worldId, source) {
  const marker = path.join(dataDir, "Data", "worlds", worldId, "world.json");
  if (!(await fsp.stat(marker).then(() => true).catch(() => false))) {
    throw new Error(`${source} 指定了世界 "${worldId}" 但 ${marker} 不存在;先装入该世界或修正配置再启动`);
  }
}

// 世界活性看门狗(仅告警,不影响 HEALTHCHECK 判定)。两类静默故障的唯一可观测
// 症状都是 /api/status 的 world 长期为空:①--world 传参形式错;②license 校验
// 失败后 Foundry 跳过 launchDefaultWorld(needsSignature)——license 绑定容器
// hostname,重建容器即失效,而容器 healthy、端口正常,只有日志一行 error。
// healthcheck 不能断言 world(首启还没激活 license 时世界本就为空,变严会把
// 正常首启判成 unhealthy),所以在 entrypoint 侧做只打日志的看门狗。
function watchWorldActivation(expectedWorld) {
  const statusUrl = process.env.ARCANE_STATUS_URL ?? "http://127.0.0.1:30000/api/status";
  const graceMs = 120_000; // 首启装环境/世界迁移可能耗时,宽限期内保持安静
  const intervalMs = 15_000;
  const startedAt = Date.now();
  let lastWarnAt = 0;
  const timer = setInterval(async () => {
    let activeId = null;
    try {
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      const world = status?.world;
      activeId = typeof world === "string" ? world : (world?.id ?? null);
      if (!activeId && status?.active === true) activeId = expectedWorld;
    } catch {
      // 服务还没起来:按未激活处理,宽限期后开始告警
    }
    if (activeId) {
      log("watchdog", `world active: ${activeId}`);
      clearInterval(timer);
      return;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= graceMs && Date.now() - lastWarnAt >= 60_000) {
      lastWarnAt = Date.now();
      log("watchdog", `WARNING: expected world "${expectedWorld}" still not active after ${Math.round(elapsed / 1000)}s`
        + ` — 世界未自动启动。常见原因:license 校验失败(license 绑定容器 hostname,重建容器即失效;`
        + `日志里找 "Software license verification failed",需到面板重新激活)或世界 id 写错。`
        + `在此之前服务会一直停在 setup/join 页`);
    }
  }, intervalMs);
  timer.unref();
}

async function main() {
  log("boot", `region=${regionId} foundry=${FOUNDRY_VERSION} modIndex=${modIndexUrl}`);
  await ensureDirs();
  const installDir = await installFoundry();
  await installDemoEnvironment();
  await prepareDataDir();

  // Foundry 只认等号形式(--dataPath=<dir>):空格分隔时它的 argv 解析拿不到值,
  // paths.mjs 会在 path.resolve(undefined) 上崩。--world 同理:空格分隔时值退化成
  // 布尔 true(init.mjs parseArgs 只认 --key=value),Foundry 去找名为 "true" 的
  // 世界并静默停在 setup 页。
  const expectedWorld = await resolveExpectedWorld();
  if (expectedWorld) {
    await assertWorldExists(expectedWorld, process.env.ARCANE_WORLD ? "ARCANE_WORLD" : "Config/options.json 的 world 字段");
  }
  const args = [path.join(installDir, "main.js"), `--dataPath=${dataDir}`];
  if (process.env.ARCANE_WORLD) args.push(`--world=${process.env.ARCANE_WORLD}`);
  log("boot", `starting foundry: node ${args.join(" ")}`);
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  if (expectedWorld) watchWorldActivation(expectedWorld);
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
