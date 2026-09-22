#!/usr/bin/env node
// publish-release.mjs — Arcane Desktop 发布唯一入口（CI 与本地 hotfix 共用）。
//
// 职责（顺序固定）：
//   1. 组装 staging 树（--from-dist 按 artifact 名自动分拣，或 --staging 直读平台子目录；
//      --signed-dir 用签名副本覆盖同名 artifact，实现先签后发）
//   2. 计算 bytes/sha256/sha512，合并 generated/desktop-release.json 生成 release.json
//   3. 上传到 region 对应的对象存储 desktop/arcane-desk[-intl]/releases/<id>/（路径版本化、不可变）
//   4. 上传后全量 verify：每个 URL HEAD，200 且 content-length == bytes（镜像契约规则 3）
//   5. 更新 desktop/arcane-desk[-intl]/latest.json（唯一可覆盖对象，no-cache）；
//      同一步生成 update/<channel>/latest.yml + latest-mac.yml（electron-updater feed）
//      一并上传 verify——含 Windows .exe 且 windowsInstallersSigned=false 时硬失败
//      （--allow-unsigned-feed 仅限应急）
//   6. 回写仓库元数据 distribution/releases/<id>.json + distribution/desktop-latest[-intl].json
//
// 子命令：
//   --promote-release <id>   回滚/复切：从桶读 release.json 重切 latest + 重生成 feed
//   --finalize               分阶段发布收口（CI 分片 + 本地签名 exe）
//   --backfill-feeds <id>    存量版本（pre-feed manifest，如 0.4.3）feed 回填：从桶读
//                            manifest，逐件锚定 sha512——优先 --assets-dir 本地已签名
//                            字节，缺件回源桶内已发布字节下载现算（两种来源都要求
//                            与 manifest sha256 逐件一致）。只写 update/<channel>/*.yml，
//                            不触碰 latest.json 与不可变版本目录；feed 可覆写可重跑。
//
// 发布双轨（国际化方案 D5）：--region cn|intl，默认读 generated/region.json，再回落 cn。
//   cn   → 阿里云 OSS arcane-package 桶，公网 <bucket>.oss-cn-beijing.aliyuncs.com
//   intl → Cloudflare R2 arcane-desk-intl 桶（S3 兼容），公网 https://dl.arcanedesk.app
// 显式 --region 与 generated/region.json 不一致时直接报错，杜绝 cn 产物发进 intl 桶。
//
// 凭证：cn   — OSS_RELEASE_KEY_ID / OSS_RELEASE_KEY_SECRET 环境变量优先；
//             本地回退 ~/.ossutil/arcane-release.conf 的 [ArcaneDeskRelease] 段（RAM: ArcaneDeskRelease）。
//       intl — CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 环境变量。
// 纪律：hotfix 也必须用新 releaseId，绝不覆盖既有版本目录（RAM 策略无 Delete 权限；
//       R2 没有 x-oss-forbid-overwrite，不可变性由上传前的 head 预检保证）。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { REGION_IDS, readBuildRegion } from "../src/main/region.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUCKET = "arcane-package";
const REGION = "oss-cn-beijing";
const BASE_URL = `https://${BUCKET}.${REGION}.aliyuncs.com`;
const RELEASE_ROOT = "desktop/arcane-desk/releases";
const LATEST_KEY = "desktop/arcane-desk/latest.json";

// 各 region 的存储目标。key 前缀与 latest 指针两侧各自独立，互不覆盖。
const TARGETS = Object.freeze({
  cn: Object.freeze({
    clientKind: "oss",
    bucket: BUCKET,
    baseUrl: BASE_URL,
    releaseRoot: RELEASE_ROOT,
    latestKey: LATEST_KEY,
    repoLatestFile: "desktop-latest.json",
    skillsRoot: "desktop/arcane-desk/skills",
    serverRoot: "desktop/arcane-desk/server",
  }),
  intl: Object.freeze({
    clientKind: "r2",
    bucket: "arcane-desk-intl",
    baseUrl: "https://dl.arcanedesk.app",
    releaseRoot: "desktop/arcane-desk-intl/releases",
    latestKey: "desktop/arcane-desk-intl/latest.json",
    repoLatestFile: "desktop-latest-intl.json",
    skillsRoot: "desktop/arcane-desk-intl/skills",
    serverRoot: "desktop/arcane-desk-intl/server",
  }),
});

function resolveTarget(region) {
  const target = TARGETS[region];
  if (!target) throw new Error(`unknown publish region: ${String(region)} (expected ${REGION_IDS.join("/")})`);
  return target;
}

// 发布 region 解析：--region 显式指定 > generated/region.json（构建期写入）> cn。
// 显式值与构建产物不一致时抛错——cn 产物发进 intl 桶（或反向）不可接受。
function resolvePublishRegion(args, regionFile = path.join(desktopRoot, "generated", "region.json")) {
  const explicit = args.region ?? null;
  if (explicit && !REGION_IDS.includes(explicit)) {
    throw new Error(`--region must be one of ${REGION_IDS.join("/")}; got: ${explicit}`);
  }
  const buildRegion = readBuildRegion(regionFile);
  if (explicit && buildRegion && explicit !== buildRegion) {
    throw new Error(
      `--region ${explicit} disagrees with generated/region.json (${buildRegion}); `
      + `rerun prepare:desktop-release with ARCANE_BUILD_REGION=${explicit}`,
    );
  }
  return explicit ?? buildRegion ?? "cn";
}

const PLATFORM_DIRS = ["macos-arm64", "macos-x64", "windows-x64", "windows-arm64"];

const CONTENT_TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".exe": "application/x-msdownload",
  ".yml": "application/yaml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const args = {};
  const takeValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from-dist") args.fromDist = takeValue(a, i++);
    else if (a === "--staging") args.staging = takeValue(a, i++);
    else if (a === "--release-id") args.releaseId = takeValue(a, i++);
    else if (a === "--promote-release") args.promoteRelease = takeValue(a, i++);
    else if (a === "--backfill-feeds") args.backfillFeeds = takeValue(a, i++);
    else if (a === "--assets-dir") args.assetsDir = takeValue(a, i++);
    else if (a === "--channel") args.channel = takeValue(a, i++);
    else if (a === "--region") args.region = takeValue(a, i++);
    else if (a === "--signed-dir") args.signedDir = takeValue(a, i++);
    else if (a === "--platforms") args.platforms = takeValue(a, i++).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--skip-latest") args.skipLatest = true;
    else if (a === "--allow-unsigned-feed") args.allowUnsignedFeed = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-repo-metadata") args.noRepoMetadata = true;
    else if (a === "--finalize") args.finalize = true;
    else if (a === "--fragment") (args.fragments ??= []).push(takeValue(a, i++));
    else throw new Error(`unknown option: ${a}`);
  }
  if (args.fromDist && args.staging) throw new Error("use only one of --from-dist or --staging");
  if (args.promoteRelease && (args.fromDist || args.staging || args.releaseId || args.skipLatest || args.signedDir)) {
    throw new Error("--promote-release cannot be combined with staging, release-id, signed-dir, or skip-latest options");
  }
  if (args.backfillFeeds && (args.fromDist || args.staging || args.releaseId || args.promoteRelease || args.skipLatest || args.signedDir || args.finalize)) {
    throw new Error("--backfill-feeds cannot be combined with staging, release-id, promote-release, signed-dir, finalize, or skip-latest options");
  }
  if (args.finalize) {
    if (args.promoteRelease || args.fromDist || args.platforms) {
      throw new Error("--finalize cannot be combined with promote-release, from-dist, or platforms");
    }
    if (!args.fragments?.length) throw new Error("--finalize requires at least one --fragment (stage-release output; repeatable, mac from CI + windows zips from local)");
    if (!args.staging) throw new Error("--finalize requires --staging (windows installer directory)");
    if (!args.signedDir) throw new Error("--finalize requires --signed-dir (signed installer overlay)");
  }
  if (args.region && !REGION_IDS.includes(args.region)) {
    throw new Error(`unsupported region: ${args.region} (expected ${REGION_IDS.join("/")})`);
  }
  const unsupportedPlatforms = args.platforms?.filter((platform) => !PLATFORM_DIRS.includes(platform)) ?? [];
  if (unsupportedPlatforms.length) throw new Error(`unsupported platform(s): ${unsupportedPlatforms.join(", ")}`);
  if (!args.promoteRelease && !args.fromDist && !args.staging && !args.backfillFeeds) {
    args.fromDist = path.join(desktopRoot, "dist");
  }
  return args;
}

export {
  parseArgs,
  platformForFile,
  resolvePublishRegion,
  resolveTarget,
  stageFromDist,
  uploadObject,
  verifyUrl,
  createOssClient,
  createR2Client,
  createStorageClient,
  kindFor,
  contentTypeFor,
  sha256File,
  sha512File,
  buildUpdateFeedObjects,
  feedRelativePath,
  assertFeedGate,
  deriveWindowsSignedFlag,
  BASE_URL,
};

// ~/.ossutil/arcane-release.conf 按段读取：本地发布凭证的 ops 约定位置，
// 环境变量（CI）优先，本地回落该文件（见 release-runbook「GitHub credentials」）。
const defaultConfFile = () => path.join(os.homedir(), ".ossutil", "arcane-release.conf");

function readConfSection(sectionName, confFile = defaultConfFile()) {
  if (!fs.existsSync(confFile)) return null;
  const text = fs.readFileSync(confFile, "utf8");
  const section = text.split(/^\[(.+)\]$/m).findIndex((name) => name === sectionName);
  if (section === -1) return null;
  const body = text.split(/^\[(.+)\]$/m).slice(section + 1, section + 2)[0] ?? "";
  const pick = (key) => body.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "m"))?.[1];
  return pick;
}

function loadCredentials() {
  if (process.env.OSS_RELEASE_KEY_ID && process.env.OSS_RELEASE_KEY_SECRET) {
    return { accessKeyId: process.env.OSS_RELEASE_KEY_ID, accessKeySecret: process.env.OSS_RELEASE_KEY_SECRET };
  }
  const pick = readConfSection("ArcaneDeskRelease");
  if (!pick) {
    throw new Error("missing OSS credentials: set OSS_RELEASE_KEY_ID and OSS_RELEASE_KEY_SECRET or create ~/.ossutil/arcane-release.conf");
  }
  const accessKeyId = pick("accessKeyID");
  const accessKeySecret = pick("accessKeySecret");
  if (!accessKeyId || !accessKeySecret) throw new Error("arcane-release.conf is missing accessKeyID/accessKeySecret");
  return { accessKeyId, accessKeySecret };
}

// intl 腿（R2）与 cn 腿（OSS）同构的凭证解析：env（CI publish job）优先，
// 本地回落 arcane-release.conf 的 [ArcaneDeskIntlRelease] 段（accountId/accessKeyID/accessKeySecret）。
function loadR2Credentials(confFile) {
  if (process.env.CF_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
    return {
      accountId: process.env.CF_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    };
  }
  const pick = readConfSection("ArcaneDeskIntlRelease", confFile);
  if (!pick) {
    throw new Error("missing R2 credentials: set CF_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY or add [ArcaneDeskIntlRelease] to ~/.ossutil/arcane-release.conf");
  }
  const accountId = pick("accountId");
  const accessKeyId = pick("accessKeyID");
  const secretAccessKey = pick("accessKeySecret");
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("arcane-release.conf [ArcaneDeskIntlRelease] is missing accountId/accessKeyID/accessKeySecret");
  }
  return { accountId, accessKeyId, secretAccessKey };
}

// 按 electron-builder artifactName（Arcane-Desk-<version>-<win|mac>-<arch>[-intl].<ext>）分拣到平台目录。
function platformForFile(name) {
  if (/-mac-arm64(?:-intl)?\.(dmg|zip)$/.test(name)) return "macos-arm64";
  if (/-mac-x64(?:-intl)?\.(dmg|zip)$/.test(name)) return "macos-x64";
  if (/-win-x64(?:-intl)?\.(exe|zip)$/.test(name)) return "windows-x64";
  if (/-win-arm64(?:-intl)?\.(exe|zip)$/.test(name)) return "windows-arm64";
  if (/^SHA256SUMS/i.test(name)) return null; // dist 根下的汇总文件按平台重建
  return null;
}

// --signed-dir（先签后发，国际化方案 D5 签名场景）：同名 artifact 用签名目录里的
// 副本替换构建原件；给了目录却缺某个 .exe 的签名件时直接失败，
// 防止未签名安装包被当作已签名发布。
function applySignedOverlay(staged, signedDir) {
  if (!signedDir) return staged;
  const available = new Set(fs.existsSync(signedDir) ? fs.readdirSync(signedDir) : []);
  return staged.map(({ platform, file }) => {
    const name = path.basename(file);
    if (available.has(name)) return { platform, file: path.join(signedDir, name) };
    if (/\.exe$/i.test(name)) throw new Error(`signed copy missing for ${name} in ${signedDir}`);
    return { platform, file };
  });
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

// electron-updater 契约：sha512 必须 base64（其 hashFile 默认 base64 编码比对）。
async function sha512File(file) {
  const hash = crypto.createHash("sha512");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("base64");
}

// windowsInstallersSigned：发布含 Windows .exe 时，它们是否全部来自签名目录。
// applySignedOverlay 在给了 signedDir 却缺任一签名件时直接抛错，所以 staging 走到
// 这里时「exe 的目录 == signedDir」即等价于「全部被签名副本覆盖」。无 Windows .exe
// 时取 true（未签名门禁只看「含 .exe 且 === false」）。
function deriveWindowsSignedFlag(staged, signedDir) {
  const installers = staged.filter(({ platform, file }) => platform.startsWith("windows") && /\.exe$/i.test(file));
  if (!installers.length) return true;
  if (!signedDir) return false;
  const resolved = path.resolve(signedDir);
  return installers.every(({ file }) => path.dirname(path.resolve(file)) === resolved);
}

// ---- electron-updater feed（update/<channel>/latest*.yml）------------------
// 客户端契约已按 electron-updater 6.8.9 dist 实证（见 docs/auto-update-design.md §8）：
// 频道文件名只由平台决定（win: latest.yml / mac: latest-mac.yml），架构不进文件名；
// 架构选择在客户端下载阶段按 process.arch 匹配 files[].url 路径名，匹配不到回退
// 第一个文件。因此每个 feed 必须列齐该平台全部架构产物——单架构 feed 会让另一
// 架构静默装错包（如 arm64 装上 x64），不得按架构拆文件。

const FEED_PLATFORM_GROUPS = Object.freeze({
  "latest.yml": (f) => f.platform.startsWith("windows") && /\.exe$/i.test(f.name),
  "latest-mac.yml": (f) => f.platform.startsWith("macos") && /\.zip$/i.test(f.name),
});

function isFeedFile(f) {
  return Object.values(FEED_PLATFORM_GROUPS).some((pick) => pick(f));
}

function updateFeedPrefix(target, channel) {
  return `${target.latestKey.slice(0, target.latestKey.lastIndexOf("/"))}/update/${channel}`;
}

// feed 内相对路径：按 URL 标准从 update/<channel>/ 解析回版本目录（纯函数）。
// 拒绝任何落不到本桶前缀内的地址——feed 内容不含绝对 URL、不可外跳。
function feedRelativePath(target, channel, entry) {
  const prefix = `${target.baseUrl}/`;
  if (typeof entry.url !== "string" || !entry.url.startsWith(prefix)) {
    throw new Error(`release file url outside bucket base (${target.baseUrl}): ${entry.url}`);
  }
  const rel = entry.url.slice(prefix.length); // desktop/arcane-desk[-intl]/releases/<id>/<platform>/<name>
  return path.posix.relative(updateFeedPrefix(target, channel), rel); // ../../releases/...
}

// 手写 YAML（不新增依赖）：标量全部 JSON 双引号转义；releaseDate 沿用 electron-builder
// 习惯的未引号 ISO 形式（js-yaml 会解析成 Date，electron-updater 不做逻辑使用）。
function updateFeedYaml({ version, releaseDate, primary, files }) {
  const lines = [
    `version: ${JSON.stringify(version)}`,
    `path: ${JSON.stringify(primary.url)}`,
    `sha512: ${JSON.stringify(primary.sha512)}`,
    `releaseDate: ${releaseDate}`,
    "files:",
    ...files.flatMap((f) => [
      `  - url: ${JSON.stringify(f.url)}`,
      `    sha512: ${JSON.stringify(f.sha512)}`,
      `    size: ${f.size}`,
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

// 由 release manifest 构造 feed 上传对象（纯函数；sha512 缺失即抛错——由调用方
// 先从本地字节（backfill）或桶内字节（promote/finalize）补齐）。
function buildUpdateFeedObjects(release, target) {
  const version = release.product?.version;
  const channel = release.channel;
  if (!version || !channel) {
    throw new Error(`release manifest missing product.version/channel; cannot build update feeds (${release.manifestUrl ?? release.releaseId})`);
  }
  const objects = [];
  for (const [channelFile, pick] of Object.entries(FEED_PLATFORM_GROUPS)) {
    const entries = (release.files ?? []).filter(pick).map((f) => ({
      url: feedRelativePath(target, channel, f),
      sha512: f.sha512,
      size: f.bytes,
    }));
    if (!entries.length) continue; // 本次发布未含该平台产物：保留桶上既有 feed 不动
    const missing = entries.filter((e) => typeof e.sha512 !== "string" || !e.sha512);
    if (missing.length) {
      throw new Error(
        `${channelFile} requires sha512 for every entry (missing for ${missing.map((m) => m.url).join(", ")}); `
        + `run --backfill-feeds for pre-feed releases`,
      );
    }
    const primary = entries.find((e) => !e.url.includes("arm64")) ?? entries[0];
    const body = updateFeedYaml({ version, releaseDate: release.publishedAt, primary, files: entries });
    objects.push({
      key: `${updateFeedPrefix(target, channel)}/${channelFile}`,
      body,
      bytes: Buffer.byteLength(body),
      cache: "no-cache",
      contentType: CONTENT_TYPES[".yml"],
    });
  }
  return objects;
}

// 未签名门禁：feed 直达已安装用户，比下载页敏感。manifest 带 windowsInstallersSigned
// === false 且含 Windows .exe 时拒绝切 latest / 上传 feed；显式 --allow-unsigned-feed
// 仅限应急。manifest 缺该字段（pre-feed 存量版本）不触发——完整性由 sha512 锚定。
function assertFeedGate(release, { allowUnsignedFeed = false } = {}) {
  if (allowUnsignedFeed) return;
  const hasWindowsInstaller = (release.files ?? []).some((f) => f.platform.startsWith("windows") && /\.exe$/i.test(f.name));
  if (!hasWindowsInstaller) return;
  if (release.windowsInstallersSigned === false) {
    throw new Error(
      `refusing to publish update feeds for unsigned Windows installers (release ${release.releaseId}); `
      + `re-sign via --signed-dir, or pass --allow-unsigned-feed for emergencies only`,
    );
  }
}

// 切 latest 同批：latest 指针 + update feeds 一起上传、一起 verify，任一失败即发布失败。
async function uploadLatestWithFeeds(client, target, latestObject, release, { allowUnsignedFeed = false } = {}) {
  assertFeedGate(release, { allowUnsignedFeed });
  const feedObjects = buildUpdateFeedObjects(release, target);
  await uploadObject(client, latestObject);
  for (const feed of feedObjects) await uploadObject(client, feed);
  if (!(await verifyObject(target, latestObject))) {
    throw new Error("latest.json failed verification; do NOT announce this release");
  }
  for (const feed of feedObjects) {
    if (!(await verifyObject(target, feed))) {
      throw new Error(`update feed ${feed.key} failed verification; do NOT announce this release`);
    }
  }
}

// feed 相关条目缺 sha512（pre-feed 旧分片/旧 manifest）时，从桶内已发布字节现算
// 补齐内存对象——manifest 属不可变对象永不回写。调用前相关对象必须已在桶上。
async function fillMissingFeedSha512(files) {
  for (const f of files) {
    if (typeof f.sha512 === "string" && f.sha512) continue;
    if (!isFeedFile(f)) continue;
    const res = await fetch(f.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`cannot fetch ${f.url} to compute sha512: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length !== f.bytes) {
      throw new Error(`bucket bytes for ${f.name} (${buffer.length}) != manifest bytes (${f.bytes}); refusing to compute sha512`);
    }
    f.sha512 = crypto.createHash("sha512").update(buffer).digest("base64");
    console.log(`computed sha512 from published bytes: ${f.platform}/${f.name}`);
  }
}

// 平台内重建 SHA256SUMS.txt：对 overlay 后的实际发布文件算 hash，
// 保证 checksum 与发布件一一对应（构建机生成的 sums 记录的是未签名原件）。
async function writeSumsFile(sumsFile, staged) {
  const names = staged.map(({ file }) => path.basename(file)).sort();
  const lines = await Promise.all(
    names.map(async (name) => {
      const { file } = staged.find((s) => path.basename(s.file) === name);
      return `${await sha256File(file)}  ${name}`;
    }),
  );
  await fsp.writeFile(sumsFile, `${lines.join("\n")}\n`, "utf8");
  return sumsFile;
}

async function stageFromDist(distDir, platforms, signedDir) {
  const staging = [];
  const entries = await fsp.readdir(distDir, { withFileTypes: true });
  const stagedByPlatform = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const platform = platformForFile(entry.name);
    if (!platform) continue;
    if (platforms && !platforms.includes(platform)) continue;
    if (!stagedByPlatform.has(platform)) stagedByPlatform.set(platform, []);
    stagedByPlatform.get(platform).push({ platform, file: path.join(distDir, entry.name) });
  }
  for (const [platform, staged] of stagedByPlatform) {
    const overlaid = applySignedOverlay(staged, signedDir);
    staging.push(...overlaid);
    const sumsFile = await writeSumsFile(path.join(distDir, `SHA256SUMS-${platform}.txt`), overlaid);
    staging.push({ platform, file: sumsFile });
  }
  return staging;
}

async function stageFromStagingDir(stagingDir, platforms, signedDir) {
  const staging = [];
  for (const platform of PLATFORM_DIRS) {
    if (platforms && !platforms.includes(platform)) continue;
    const dir = path.join(stagingDir, platform);
    if (!fs.existsSync(dir)) continue;
    const staged = [];
    let existingSums = null;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^SHA256SUMS/i.test(entry.name)) {
        existingSums = path.join(dir, entry.name);
        continue;
      }
      staged.push({ platform, file: path.join(dir, entry.name) });
    }
    if (signedDir) {
      // 构建机的 SHA256SUMS.txt 对应未签名原件；overlay 后必须按实际发布件重建。
      const overlaid = applySignedOverlay(staged, signedDir);
      staging.push(...overlaid);
      const sumsFile = await writeSumsFile(existingSums ?? path.join(dir, "SHA256SUMS.txt"), overlaid);
      staging.push({ platform, file: sumsFile });
    } else {
      staging.push(...staged);
      if (existingSums) staging.push({ platform, file: existingSums });
    }
  }
  return staging;
}

function contentTypeFor(name) {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

function kindFor(name) {
  if (/\.dmg$/.test(name)) return "dmg";
  if (/\.exe$/.test(name)) return "nsis";
  if (/\.zip$/.test(name)) return "zip";
  if (/^SHA256SUMS/i.test(name)) return "checksums";
  if (/\.md$/.test(name)) return "install-guide";
  if (/release\.json$/.test(name)) return "release-manifest";
  return "file";
}

async function createOssClient() {
  const { default: OSS } = await import("ali-oss");
  const creds = loadCredentials();
  const client = new OSS({ region: REGION, bucket: BUCKET, ...creds, timeout: 600_000 });
  client.kind = "oss";
  return client;
}

// ---- Cloudflare R2（S3 兼容，SigV4 签名）----------------------------------
// 无第三方依赖的最小 S3 客户端：put / head / multipartUpload。
// R2 的 SigV4 固定 region=auto、service=s3，path-style 寻址。

const R2_REGION = "auto";
const R2_SERVICE = "s3";

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function encodeS3(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDateOf(date) {
  // 2026-09-10T20:07:00.000Z → 20260910T200700Z
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function createR2Client(overrides = {}) {
  // 完整显式覆盖（accountId/accessKeyId/secretAccessKey 三键齐备）= 测试/干跑语境：
  // 不 consult 环境变量与 ~/.ossutil 的 ops 凭证——CI 上凭证测试要用注入值而不是本机配置。
  const fullyOverridden = Boolean(overrides.accountId && overrides.accessKeyId && overrides.secretAccessKey);
  const conf = fullyOverridden
    ? { accountId: undefined, accessKeyId: undefined, secretAccessKey: undefined }
    : loadR2Credentials(overrides.confFile);
  const accountId = overrides.accountId ?? conf.accountId;
  const accessKeyId = overrides.accessKeyId ?? conf.accessKeyId;
  const secretAccessKey = overrides.secretAccessKey ?? conf.secretAccessKey;
  const bucket = overrides.bucket ?? TARGETS.intl.bucket;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const now = overrides.now ?? (() => new Date());
  const host = `${accountId}.r2.cloudflarestorage.com`;

  async function request({ method, key, query = {}, headers: extraHeaders = {}, body = Buffer.alloc(0) }) {
    const payloadHash = sha256Hex(body);
    const amzDate = amzDateOf(now());
    const dateStamp = amzDate.slice(0, 8);
    const canonicalUri = `/${[bucket, ...key.split("/")].map(encodeS3).join("/")}`;
    const canonicalQuery = Object.entries(query)
      .map(([name, value]) => `${encodeS3(name)}=${encodeS3(value)}`)
      .sort()
      .join("&");
    // 只签这三个头，其余头（Cache-Control/Content-Type 等）按要求原样透传。
    const signed = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const headerNames = Object.keys(signed).sort();
    const canonicalHeaders = headerNames.map((name) => `${name}:${signed[name]}\n`).join("");
    const signedHeaders = headerNames.join(";");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmacSha256(
      hmacSha256(hmacSha256(hmacSha256(`AWS4${secretAccessKey}`, dateStamp), R2_REGION), R2_SERVICE),
      "aws4_request",
    );
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        ...extraHeaders,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: method === "HEAD" ? undefined : body,
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = await res.text().catch(() => "");
      /** @type {Error & { status?: number }} */
      const error = new Error(`R2 ${method} ${key} failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    return res;
  }

  return {
    kind: "r2",
    bucket,
    // 与 ali-oss 对齐的调用形态：data 为 Buffer 或文件路径。
    async put(key, data, { headers = {} } = {}) {
      const body = typeof data === "string" ? await fsp.readFile(data) : Buffer.from(data);
      await request({ method: "PUT", key, headers, body });
    },
    async head(key) {
      await request({ method: "HEAD", key });
    },
    async multipartUpload(key, file, { partSize = 10 * 1024 * 1024, headers = {} } = {}) {
      const created = await request({ method: "POST", key, query: { uploads: "" }, headers });
      const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
      if (!uploadId) throw new Error(`R2 CreateMultipartUpload returned no UploadId for ${key}`);
      try {
        const parts = [];
        const handle = await fsp.open(file, "r");
        try {
          const { size } = await handle.stat();
          const partCount = Math.max(1, Math.ceil(size / partSize));
          for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            const offset = (partNumber - 1) * partSize;
            const length = Math.min(partSize, size - offset);
            const body = Buffer.alloc(length);
            if (length) await handle.read(body, 0, length, offset);
            const res = await request({
              method: "PUT",
              key,
              query: { partNumber: String(partNumber), uploadId },
              body,
            });
            const etag = res.headers.get("etag");
            if (!etag) throw new Error(`R2 UploadPart ${partNumber} for ${key} returned no ETag`);
            parts.push({ partNumber, etag });
          }
        } finally {
          await handle.close();
        }
        const xml = `<CompleteMultipartUpload>${parts
          .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
          .join("")}</CompleteMultipartUpload>`;
        await request({ method: "POST", key, query: { uploadId }, body: Buffer.from(xml, "utf8") });
      } catch (error) {
        // 中断的分片会一直占存储配额，尽力 abort。
        await request({ method: "DELETE", key, query: { uploadId } }).catch(() => {});
        throw error;
      }
    },
  };
}

async function createStorageClient(target) {
  if (target.clientKind === "r2") return createR2Client({ bucket: target.bucket });
  return createOssClient();
}

async function uploadObject(client, obj) {
  const headers = { "Cache-Control": obj.cache, "Content-Type": obj.contentType };
  // R2/S3 没有等价的 forbid-overwrite 头；不可变纪律由上传前的 head 预检承担。
  if (obj.immutable && client.kind !== "r2") headers["x-oss-forbid-overwrite"] = "true";
  if (obj.body !== undefined) {
    await client.put(obj.key, Buffer.from(obj.body, "utf8"), { headers });
  } else if (obj.bytes > 32 * 1024 * 1024) {
    await client.multipartUpload(obj.key, obj.file, { partSize: 10 * 1024 * 1024, headers });
  } else {
    await client.put(obj.key, obj.file, { headers });
  }
  console.log(`uploaded ${obj.key}`);
}

async function verifyUrl(url, expectedBytes, label = url) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    // OSS may gzip text objects for Node's default Accept-Encoding. Its HEAD
    // response then omits the original Content-Length, so require identity.
    // 负缓存规避（2026-09-11 M3 首发事故）：Cloudflare 边缘会按 URL 把对象
    // 上传前的 404 缓存数分钟，上传后立刻 HEAD 同一 URL 读到的是陈旧 404。
    // 每次尝试带独立 cache-buster，强制回源取真值。
    const bust = `_cb=${Date.now().toString(36)}-${attempt}`;
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}${bust}`, {
      method: "HEAD",
      cache: "no-store",
      headers: { "accept-encoding": "identity" },
    });
    const length = Number(res.headers.get("content-length"));
    if (res.status === 200 && length === expectedBytes) {
      console.log(`verified ${label}`);
      return true;
    }
    if (attempt === 4) {
      console.error(`VERIFY FAIL ${url} -> HTTP ${res.status}, content-length ${length} != ${expectedBytes}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  return false;
}

async function verifyObject(target, obj) {
  return verifyUrl(`${target.baseUrl}/${obj.key}`, obj.bytes, obj.key);
}

async function promoteRelease(args) {
  const releaseId = args.promoteRelease;
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error(`unsafe release id: ${releaseId}`);
  }
  const target = resolveTarget(resolvePublishRegion(args));
  const manifestUrl = `${target.baseUrl}/${target.releaseRoot}/${releaseId}/release.json`;
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`cannot load release to promote: HTTP ${response.status} ${manifestUrl}`);
  const release = await response.json();
  if (release.releaseId !== releaseId || !release.product?.version || !release.channel) {
    throw new Error(`release manifest is invalid or mismatched: ${manifestUrl}`);
  }
  const prefix = `${target.baseUrl}/${target.releaseRoot}/${releaseId}/`;
  for (const file of release.files ?? []) {
    if (!file.url?.startsWith(prefix) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`release manifest contains an unsafe file entry: ${JSON.stringify(file)}`);
    }
    if (!(await verifyUrl(file.url, file.bytes, `${file.platform}/${file.name}`))) {
      throw new Error(`release ${releaseId} is incomplete; latest remains unchanged`);
    }
  }
  if (!release.files?.length) throw new Error(`release ${releaseId} has no files`);

  // pre-feed 旧 manifest 可能缺 sha512 / windowsInstallersSigned：sha512 现算补齐
  // （feed 派生对象需要），门禁只对显式 false 生效；二者都不回写不可变 manifest。
  await fillMissingFeedSha512(release.files);
  assertFeedGate(release, { allowUnsignedFeed: args.allowUnsignedFeed });

  const latest = {
    schemaVersion: 1,
    channel: release.channel,
    releaseId,
    version: release.product.version,
    publishedAt: release.publishedAt,
    manifest: manifestUrl,
  };
  const latestBody = `${JSON.stringify(latest, null, 2)}\n`;
  const latestObject = {
    key: target.latestKey,
    body: latestBody,
    bytes: Buffer.byteLength(latestBody),
    cache: "no-cache",
    contentType: CONTENT_TYPES[".json"],
  };
  if (!args.noRepoMetadata) {
    await fsp.writeFile(
      path.join(desktopRoot, "distribution", target.repoLatestFile),
      latestBody,
      "utf8",
    );
  }
  const feedObjects = buildUpdateFeedObjects(release, target);
  if (args.dryRun) {
    console.log(`dry-run: release ${releaseId} is complete; ${feedObjects.length} update feed(s) ready; latest upload skipped`);
    return;
  }
  const client = await createStorageClient(target);
  await uploadLatestWithFeeds(client, target, latestObject, release, { allowUnsignedFeed: args.allowUnsignedFeed });
  console.log(`latest now points to verified release ${releaseId} (${target.clientKind})`);
}

// --backfill-feeds <release-id>：pre-feed 存量版本（0.4.3）的 feed 回填。从桶读
// manifest，逐件锚定 sha512——优先 --assets-dir 本地字节（sha256 与 manifest 一致
// 才采用），缺件回源桶内已发布字节下载现算（同一 sha256 锚定，下错即失败）。
// 只写 update/<channel>/*.yml，不触碰 latest.json 与不可变版本目录；可重复执行。
async function backfillReleaseFeeds(args) {
  const releaseId = args.backfillFeeds;
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error(`unsafe release id: ${releaseId}`);
  }
  const target = resolveTarget(resolvePublishRegion(args));
  const manifestUrl = `${target.baseUrl}/${target.releaseRoot}/${releaseId}/release.json`;
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`cannot load release manifest: HTTP ${response.status} ${manifestUrl}`);
  const release = await response.json();
  if (release.releaseId !== releaseId || !release.product?.version || !release.channel) {
    throw new Error(`release manifest is invalid or mismatched: ${manifestUrl}`);
  }
  const assetsDir = args.assetsDir ? path.resolve(args.assetsDir) : null;
  if (assetsDir && !fs.existsSync(assetsDir)) throw new Error(`--assets-dir not found: ${assetsDir}`);
  // 完整性锚定：sha256 一致 ⇒ 字节 == 桶上已发布件 ⇒ 算的 sha512 可进 feed。
  for (const f of release.files ?? []) {
    if (!isFeedFile(f)) continue;
    const local = assetsDir ? path.join(assetsDir, f.name) : null;
    if (local && fs.existsSync(local)) {
      const [sha256, stat] = await Promise.all([sha256File(local), fsp.stat(local)]);
      if (sha256 !== f.sha256 || stat.size !== f.bytes) {
        throw new Error(
          `local bytes for ${f.name} do not match published manifest `
          + `(local sha256 ${sha256.slice(0, 12)}… vs manifest ${String(f.sha256).slice(0, 12)}…); refusing to backfill from mismatched bytes`,
        );
      }
      f.sha512 = await sha512File(local);
      console.log(`anchored sha512 on local bytes: ${f.platform}/${f.name}`);
      continue;
    }
    const res = await fetch(f.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`cannot fetch ${f.url} (and no matching local bytes in --assets-dir): HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length !== f.bytes) {
      throw new Error(`bucket bytes for ${f.name} (${buffer.length}) != manifest bytes (${f.bytes}); refusing to compute sha512`);
    }
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== f.sha256) {
      throw new Error(`bucket bytes for ${f.name} fail sha256 anchor (${sha256.slice(0, 12)}… vs manifest ${String(f.sha256).slice(0, 12)}…)`);
    }
    f.sha512 = crypto.createHash("sha512").update(buffer).digest("base64");
    console.log(`anchored sha512 on published bytes: ${f.platform}/${f.name}`);
  }
  assertFeedGate(release, { allowUnsignedFeed: args.allowUnsignedFeed });
  const feedObjects = buildUpdateFeedObjects(release, target);
  if (args.dryRun) {
    for (const feed of feedObjects) console.log(`--- ${feed.key} (${feed.bytes} bytes) ---\n${feed.body}`);
    console.log(`dry-run: ${feedObjects.length} update feed(s) for ${releaseId} (${target.clientKind}); upload skipped`);
    return;
  }
  const client = await createStorageClient(target);
  for (const feed of feedObjects) await uploadObject(client, feed);
  for (const feed of feedObjects) {
    if (!(await verifyObject(target, feed))) {
      throw new Error(`update feed ${feed.key} failed verification`);
    }
  }
  console.log(`backfilled ${feedObjects.length} update feed(s) for ${releaseId} (${target.clientKind})`);
}

// ---- 分阶段发布·阶段 2：finalize（设计见 docs/phased-release-design.md）-----
//
// 分片（stage-release 产物）提供 mac 与 windows zip 的条目；本地只补签名后的
// exe、按签名件重建 windows SHA256SUMS、合成全量 release.json 并收口。journal
// 记录本命令上传过的每个对象：重跑时哈希一致跳过、哈希变化硬拦——Authenticode
// 签名内嵌时间戳，重签字节必变，若放行会把桶里旧签名对象与 manifest 新哈希
// 静默错配（HEAD 验证只比长度查不出同长错配）。

function journalFileFor(releaseId) {
  return path.join(desktopRoot, "generated", `release-journal-${releaseId}.json`);
}

export function loadJournal(releaseId, file = journalFileFor(releaseId)) {
  if (!fs.existsSync(file)) return new Map();
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(entries)) throw new Error(`journal is malformed: ${file}`);
  return new Map(entries.map((entry) => [`${entry.region}:${entry.key}`, entry]));
}

async function saveJournal(releaseId, journal) {
  await fsp.mkdir(path.join(desktopRoot, "generated"), { recursive: true });
  await fsp.writeFile(journalFileFor(releaseId), `${JSON.stringify([...journal.values()], null, 2)}\n`, "utf8");
}

// 单次 HEAD：区分 404（待上传）与 200 长度比对（已上传/污染）。不重试——
// verifyUrl 的重试语义仅用于上传后的最终验证。
export async function headStatus(url) {
  const bust = `_cb=${Date.now().toString(36)}`;
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}${bust}`, {
    method: "HEAD",
    cache: "no-store",
    headers: { "accept-encoding": "identity" },
  });
  return { status: res.status, length: Number(res.headers.get("content-length")) };
}

// finalize 的 staging 只允许 exe（本地仅下载 -exe artifact），overlay 语义与
// 全量发布共用 applySignedOverlay：缺任一签名件即失败。
export function collectFinalizeInstallers(stagingDir, signedDir) {
  const staged = [];
  for (const platform of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    const dir = path.join(stagingDir, platform.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (!/\.exe$/i.test(file.name)) {
        throw new Error(`finalize staging accepts installers only: ${platform.name}/${file.name} (other artifacts were staged from CI)`);
      }
      staged.push({ platform: platform.name, file: path.join(dir, file.name) });
    }
  }
  if (!staged.length) throw new Error(`no installers found under ${stagingDir}`);
  return applySignedOverlay(staged, signedDir);
}

async function fetchMacSumsMap(target, releaseId, platform) {
  const url = `${target.baseUrl}/${target.releaseRoot}/${releaseId}/${platform}/SHA256SUMS.txt`;
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}_cb=${Date.now().toString(36)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`mac SHA256SUMS cross-check failed: HTTP ${res.status} ${url}`);
  const map = new Map();
  for (const line of (await res.text()).split("\n").filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    if (!match) throw new Error(`unparsable published sums line for ${platform}: ${line}`);
    map.set(match[2], match[1]);
  }
  return map;
}

// 基座新鲜度守卫（0.5.0 cn 事故）：releaseId 形如 <version>-<sha8>[-intl] 时，
// 本地基座的 product.version 必须一致——finalize 合并的是 generated/ 基座，
// 忘跑 prepare 会把上一版的 version/source.commit 合进本版 release.json 与 feed。
export function assertBaseManifestFresh(manifest, releaseId) {
  const idVersion = releaseId.match(/^(\d+\.\d+\.\d+)(?:[-.].+)?$/)?.[1];
  if (idVersion && manifest.product?.version !== idVersion) {
    throw new Error(
      `generated/desktop-release.json product.version (${manifest.product?.version}) != release id version (${idVersion}); `
      + `rerun npm run prepare:desktop-release (with matching ARCANE_BUILD_REGION) before --finalize`,
    );
  }
}

// 提交钉死守卫（0.6.0 intl 未遂事故）：releaseId 形如 <version>-<sha8>[-intl] 时，
// 本地基座的 source.commit 必须与之同源——发版中途 HEAD 被其它会话推进后忘钉
// ARCANE_SOURCE_COMMIT 的 prepare 会把别人的提交烤进 release.json。
export function assertSourceCommitMatchesReleaseId(manifest, releaseId) {
  const sha8 = releaseId.match(/^\d+\.\d+\.\d+-([0-9a-f]{8})(?:-intl)?$/)?.[1];
  if (!sha8) return; // 非版本-提交型 release id（自定义/工作树构建）：不设卡
  const commit = String(manifest.source?.commit ?? "");
  if (!commit.startsWith(sha8)) {
    throw new Error(
      `generated/desktop-release.json source.commit (${commit.slice(0, 8) || "missing"}) != release id sha8 (${sha8}); `
      + `rerun npm run prepare:desktop-release with ARCANE_SOURCE_COMMIT pinned to the release commit`,
    );
  }
}

// 发布 channel 守卫（0.6.0 事故，2026-09-22 定位）：包内烙入的 channel（prepare 期
// ARCANE_RELEASE_CHANNEL 写入，客户端运行期拿它拼 feed URL 的轨道名）必须与本次
// 发布 --channel 一致。不一致时 feed 发在客户端永不轮询的轨道上，已装用户静默
// 永远收不到更新，且无任何线上报错。
export function assertPublishChannelMatchesManifest(manifest, channel) {
  const baked = String(manifest?.channel ?? "");
  if (baked !== channel) {
    throw new Error(
      `generated/desktop-release.json channel (${baked || "missing"}) != publish channel (${channel}); `
      + `clients poll update/${baked || "<none>"}/latest.yml and would never see this release; `
      + `rebuild with ARCANE_RELEASE_CHANNEL=${channel} before publishing`,
    );
  }
}

// 合并多份 stage 分片（mac 来自 CI stage workflow，windows zip 来自本机
// stage-release）：逐片校验 schemaVersion/releaseId/region；分片集合本应互不
// 相交，跨片同名同平台重复即拒绝——重复意味着同一对象被两个来源各自声明。
export function mergeFragmentFiles(fragments, { releaseId, region }) {
  const files = [];
  for (const fragment of fragments) {
    if (fragment.schemaVersion !== 1) throw new Error(`unsupported fragment schemaVersion: ${fragment.schemaVersion}`);
    if (fragment.releaseId !== releaseId) throw new Error(`fragment releaseId ${fragment.releaseId} != ${releaseId}`);
    if (fragment.region !== region) throw new Error(`fragment region ${fragment.region} != ${region}`);
    const part = fragment.files ?? [];
    if (!part.length) throw new Error("fragment carries no files");
    if (part.some((f) => /\.exe$/i.test(f.name))) {
      throw new Error("fragment must not carry installers (stage-release never uploads them)");
    }
    files.push(...part);
  }
  const seen = new Set();
  for (const f of files) {
    const key = `${f.platform}/${f.name}`;
    if (seen.has(key)) throw new Error(`duplicate fragment entry across fragments: ${key}`);
    seen.add(key);
  }
  return files;
}

async function finalizeRelease(args) {
  const region = resolvePublishRegion(args);
  const target = resolveTarget(region);
  const manifestPath = path.join(desktopRoot, "generated", "desktop-release.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("generated/desktop-release.json is missing; run npm run prepare:desktop-release first");
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const releaseId = args.releaseId ?? manifest.releaseId;
  assertBaseManifestFresh(manifest, releaseId);
  assertSourceCommitMatchesReleaseId(manifest, releaseId);
  const channel = args.channel ?? "private-beta";
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) throw new Error(`unsafe release id: ${releaseId}`);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(channel)) throw new Error(`unsafe release channel: ${channel}`);
  assertPublishChannelMatchesManifest(manifest, channel);

  const fragments = await Promise.all(args.fragments.map(async (file) =>
    JSON.parse(await fsp.readFile(path.resolve(file), "utf8"))));
  const fragmentFiles = mergeFragmentFiles(fragments, { releaseId, region });

  const installers = await Promise.all(
    collectFinalizeInstallers(path.resolve(args.staging), args.signedDir).map(async ({ platform, file }) => {
      const name = path.basename(file);
      const [sha256, sha512, stat] = await Promise.all([sha256File(file), sha512File(file), fsp.stat(file)]);
      return { platform, name, bytes: stat.size, sha256, sha512, kind: kindFor(name), contentType: contentTypeFor(name), file };
    }),
  );

  const files = fragmentFiles.map((f) => ({
    ...f,
    url: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/${f.platform}/${f.name}`,
  }));
  for (const installer of installers) {
    files.push({ ...installer, url: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/${installer.platform}/${installer.name}` });
  }

  // mac 双源交叉校验：分片哈希必须与桶上 CI 清单一致（都在线，代价是两个小 GET）。
  for (const platform of new Set(fragmentFiles.filter((f) => f.platform.startsWith("macos")).map((f) => f.platform))) {
    const published = await fetchMacSumsMap(target, releaseId, platform);
    for (const f of fragmentFiles.filter((x) => x.platform === platform && /\.(dmg|zip)$/i.test(x.name))) {
      if (published.get(f.name) !== f.sha256) {
        throw new Error(`fragment hash for ${platform}/${f.name} disagrees with published SHA256SUMS (${published.get(f.name)})`);
      }
    }
  }

  // windows SHA256SUMS：签名 exe（本地）+ zip（分片），按名字排序重建。
  for (const platform of new Set(installers.map((i) => i.platform))) {
    const platformInstallers = installers.filter((i) => i.platform === platform);
    if (platformInstallers.length !== 1) {
      throw new Error(`expected exactly one installer for ${platform}; got ${platformInstallers.map((i) => i.name).join(", ")}`);
    }
    const zips = fragmentFiles.filter((f) => f.platform === platform && /\.zip$/i.test(f.name));
    if (zips.length !== 1) throw new Error(`fragment must carry exactly one zip for ${platform}`);
    const body = `${[platformInstallers[0], ...zips]
      .map((f) => ({ name: f.name, sha256: f.sha256 }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => `${f.sha256}  ${f.name}`)
      .join("\n")}\n`;
    files.push({
      platform,
      name: "SHA256SUMS.txt",
      bytes: Buffer.byteLength(body),
      sha256: crypto.createHash("sha256").update(body, "utf8").digest("hex"),
      kind: "checksums",
      contentType: CONTENT_TYPES[".txt"],
      body,
      url: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/${platform}/SHA256SUMS.txt`,
    });
  }
  files.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));

  // 分片产物（mac zip 等 feed 相关件）缺 sha512 时（旧分片 schema），此时它们已在
  // 桶上，按已发布字节现算补齐（新分片由 stage-release 直接携带 sha512）。
  await fillMissingFeedSha512(files);

  const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const release = {
    ...manifest,
    channel,
    releaseId,
    publishedAt,
    windowsInstallersSigned: deriveWindowsSignedFlag(
      installers.map(({ platform, file }) => ({ platform, file })),
      args.signedDir,
    ),
    manifestUrl: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/release.json`,
    files: files.map(({ file, body, ...entry }) => entry),
  };
  const releaseBody = `${JSON.stringify(release, null, 2)}\n`;
  const latest = {
    schemaVersion: 1,
    channel,
    releaseId,
    version: manifest.product.version,
    publishedAt,
    manifest: release.manifestUrl,
  };
  const latestBody = `${JSON.stringify(latest, null, 2)}\n`;

  console.log(`Finalize ${releaseId} (${channel}, ${target.clientKind}) — fragment ${fragmentFiles.length} + local ${installers.length} files`);
  for (const f of files) console.log(`  ${f.platform}/${f.name}  ${f.bytes}  ${f.sha256.slice(0, 12)}…`);

  if (!args.noRepoMetadata) {
    const releasesDir = path.join(desktopRoot, "distribution", "releases");
    await fsp.mkdir(releasesDir, { recursive: true });
    await fsp.writeFile(path.join(releasesDir, `${releaseId}.json`), releaseBody, "utf8");
  }
  assertFeedGate(release, { allowUnsignedFeed: args.allowUnsignedFeed });
  const feedObjects = buildUpdateFeedObjects(release, target);
  if (args.dryRun) {
    console.log(`dry-run: ${feedObjects.length} update feed(s) ready; skip upload & verify`);
    return;
  }

  const client = await createStorageClient(target);
  const journal = loadJournal(releaseId);
  const manifestObject = {
    key: `${target.releaseRoot}/${releaseId}/release.json`,
    body: releaseBody,
    bytes: Buffer.byteLength(releaseBody),
    sha256: crypto.createHash("sha256").update(releaseBody, "utf8").digest("hex"),
    cache: "public, max-age=31536000, immutable",
    contentType: CONTENT_TYPES[".json"],
    immutable: true,
    mustBeNew: true,
  };
  const objects = [
    ...installers.map((i) => ({
      key: `${target.releaseRoot}/${releaseId}/${i.platform}/${i.name}`,
      file: i.file,
      bytes: i.bytes,
      sha256: i.sha256,
      cache: "public, max-age=31536000, immutable",
      contentType: i.contentType,
      immutable: true,
      mustBeNew: false, // 同字节续传合法（崩溃重跑）；只有 release.json 必须是新的
    })),
    ...files.filter((f) => f.kind === "checksums").map((f) => ({
      key: `${target.releaseRoot}/${releaseId}/${f.platform}/${f.name}`,
      body: f.body,
      bytes: f.bytes,
      sha256: f.sha256,
      cache: "public, max-age=31536000, immutable",
      contentType: f.contentType,
      immutable: true,
      mustBeNew: false,
    })),
    manifestObject,
  ];

  for (const obj of objects) {
    const journalKey = `${region}:${obj.key}`;
    const url = `${target.baseUrl}/${obj.key}`;
    const recorded = journal.get(journalKey);
    if (recorded && recorded.sha256 !== obj.sha256) {
      throw new Error(
        `local bytes changed since the last finalize attempt for ${obj.key} `
        + `(journal ${recorded.sha256.slice(0, 12)}… != ${obj.sha256.slice(0, 12)}…); `
        + `a re-signed installer poisons this release id — use a new --release-id`,
      );
    }
    const head = await headStatus(url);
    if (head.status === 200 && obj.mustBeNew) {
      throw new Error(`release manifest already exists: ${obj.key} (this release id is finalized; run --promote-release instead)`);
    }
    if (head.status === 200 && head.length === obj.bytes) {
      // 覆盖"上传后、记账前"的崩溃窗口：桶上长度一致即收养记账。
      journal.set(journalKey, { region, key: obj.key, sha256: obj.sha256, bytes: obj.bytes });
      await saveJournal(releaseId, journal);
      console.log(`already uploaded ${obj.key}`);
      continue;
    }
    if (head.status === 200) {
      throw new Error(`object exists with different length: ${obj.key} (bucket ${head.length} != local ${obj.bytes}); use a new --release-id`);
    }
    if (head.status !== 404) throw new Error(`unexpected HEAD status ${head.status} for ${obj.key}`);
    await uploadObject(client, obj);
    journal.set(journalKey, { region, key: obj.key, sha256: obj.sha256, bytes: obj.bytes });
    await saveJournal(releaseId, journal);
  }

  // 收口验证：分片对象 + 本地对象 + release.json 全量 HEAD。
  let failures = 0;
  for (const f of files) {
    if (!(await verifyUrl(f.url, f.bytes, `${f.platform}/${f.name}`))) failures += 1;
  }
  if (!(await verifyUrl(`${target.baseUrl}/${manifestObject.key}`, manifestObject.bytes, manifestObject.key))) failures += 1;
  if (failures) throw new Error(`${failures} object(s) failed verification; do NOT announce this release`);

  if (!args.skipLatest) {
    const latestObject = {
      key: target.latestKey,
      body: latestBody,
      bytes: Buffer.byteLength(latestBody),
      cache: "no-cache",
      contentType: CONTENT_TYPES[".json"],
    };
    await uploadLatestWithFeeds(client, target, latestObject, release, { allowUnsignedFeed: args.allowUnsignedFeed });
    if (!args.noRepoMetadata) {
      await fsp.writeFile(path.join(desktopRoot, "distribution", target.repoLatestFile), latestBody, "utf8");
    }
  }
  console.log(`release ${releaseId} finalized and verified: ${release.manifestUrl}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.promoteRelease) {
    await promoteRelease(args);
    return;
  }
  if (args.backfillFeeds) {
    await backfillReleaseFeeds(args);
    return;
  }
  if (args.finalize) {
    await finalizeRelease(args);
    return;
  }
  const target = resolveTarget(resolvePublishRegion(args));
  const manifestPath = path.join(desktopRoot, "generated", "desktop-release.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("generated/desktop-release.json is missing; run npm run prepare:desktop-release first");
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const releaseId = args.releaseId ?? manifest.releaseId;
  const channel = args.channel ?? "private-beta";
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error(`unsafe release id: ${releaseId}`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(channel)) {
    throw new Error(`unsafe release channel: ${channel}`);
  }
  assertPublishChannelMatchesManifest(manifest, channel);

  const staging = args.staging
    ? await stageFromStagingDir(args.staging, args.platforms, args.signedDir)
    : await stageFromDist(args.fromDist, args.platforms, args.signedDir);
  if (!staging.length) throw new Error("no artifacts staged (nothing matching known platform file names)");

  const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files = [];
  for (const { platform, file } of staging) {
    const name = path.basename(file);
    const [sha256, sha512, stat] = await Promise.all([sha256File(file), sha512File(file), fsp.stat(file)]);
    files.push({
      kind: kindFor(name),
      platform,
      name,
      bytes: stat.size,
      sha256,
      sha512,
      contentType: contentTypeFor(name),
      url: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/${platform}/${name}`,
    });
  }
  files.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));

  const release = {
    ...manifest,
    channel,
    releaseId,
    publishedAt,
    windowsInstallersSigned: deriveWindowsSignedFlag(staging, args.signedDir),
    manifestUrl: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/release.json`,
    files,
  };

  const latest = {
    schemaVersion: 1,
    channel,
    releaseId,
    version: manifest.product.version,
    publishedAt,
    manifest: release.manifestUrl,
  };

  const releaseBody = `${JSON.stringify(release, null, 2)}\n`;
  const latestBody = `${JSON.stringify(latest, null, 2)}\n`;
  /** @type {{ key: string; file?: string; body?: string; bytes: number; cache: string; contentType: string; immutable?: boolean }[]} */
  const immutableObjects = [
    ...files.map((f) => ({
      key: `${target.releaseRoot}/${releaseId}/${f.platform}/${f.name}`,
      file: staging.find((s) => path.basename(s.file) === f.name && s.platform === f.platform).file,
      bytes: f.bytes,
      cache: "public, max-age=31536000, immutable",
      contentType: f.contentType,
      immutable: true,
    })),
    {
      key: `${target.releaseRoot}/${releaseId}/release.json`,
      body: releaseBody,
      bytes: Buffer.byteLength(releaseBody),
      cache: "public, max-age=31536000, immutable",
      contentType: CONTENT_TYPES[".json"],
      immutable: true,
    },
  ];
  const latestObject = {
    key: target.latestKey,
    body: latestBody,
    bytes: Buffer.byteLength(latestBody),
    cache: "no-cache",
    contentType: CONTENT_TYPES[".json"],
  };
  const plan = { releaseId, channel, bucket: target.bucket, immutableObjects, latestObject };

  console.log(`Release ${releaseId} (${channel}, ${target.clientKind}) — ${files.length} artifacts, ${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1)} MB total`);
  for (const f of files) console.log(`  ${f.platform}/${f.name}  ${f.bytes}  ${f.sha256.slice(0, 12)}…`);

  // 仓库元数据回写（dry-run 也落盘，便于 review；--no-repo-metadata 跳过）
  if (!args.noRepoMetadata) {
    const releasesDir = path.join(desktopRoot, "distribution", "releases");
    await fsp.mkdir(releasesDir, { recursive: true });
    await fsp.writeFile(
      path.join(releasesDir, `${releaseId}.json`),
      `${JSON.stringify(release, null, 2)}\n`,
      "utf8",
    );
    if (!args.skipLatest) {
      await fsp.writeFile(
        path.join(desktopRoot, "distribution", target.repoLatestFile),
        latestBody,
        "utf8",
      );
      console.log("repo metadata written: distribution/releases/%s.json + %s", releaseId, target.repoLatestFile);
    } else {
      console.log("repo metadata written: distribution/releases/%s.json (latest unchanged)", releaseId);
    }
  }

  assertFeedGate(release, { allowUnsignedFeed: args.allowUnsignedFeed });
  const feedObjects = buildUpdateFeedObjects(release, target);
  if (args.dryRun) {
    console.log(`dry-run: ${feedObjects.length} update feed(s) ready; skip upload & verify`);
    return;
  }

  const client = await createStorageClient(target);

  // 已存在的版本目录拒绝重传（不可变纪律）；latest 指针除外。
  for (const obj of plan.immutableObjects) {
    let exists = false;
    try {
      await client.head(obj.key);
      exists = true;
    } catch (error) {
      if (Number(error?.status) !== 404) throw error;
    }
    if (exists) throw new Error(`immutable object already exists: ${obj.key} (use a new --release-id)`);
  }

  for (const obj of plan.immutableObjects) {
    await uploadObject(client, obj);
  }

  // verify 纪律：版本化对象全部通过后，才允许切换 latest 指针。
  let failures = 0;
  for (const obj of plan.immutableObjects) {
    if (!(await verifyObject(target, obj))) failures += 1;
  }
  if (failures) throw new Error(`${failures} object(s) failed verification; do NOT announce this release`);

  if (!args.skipLatest) {
    await uploadLatestWithFeeds(client, target, plan.latestObject, release, { allowUnsignedFeed: args.allowUnsignedFeed });
  }
  console.log(`release ${releaseId} published and verified: ${release.manifestUrl}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
