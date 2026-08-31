#!/usr/bin/env node
// publish-release.mjs — Arcane Desktop 发布唯一入口（CI 与本地 hotfix 共用）。
//
// 职责（顺序固定）：
//   1. 组装 staging 树（--from-dist 按 artifact 名自动分拣，或 --staging 直读平台子目录）
//   2. 计算 bytes/sha256，合并 generated/desktop-release.json 生成 release.json
//   3. 上传到 arcane-package 桶 desktop/arcane-desk/releases/<id>/（路径版本化、不可变）
//   4. 上传后全量 verify：每个 URL HEAD，200 且 content-length == bytes（镜像契约规则 3）
//   5. 更新 desktop/arcane-desk/latest.json（唯一可覆盖对象，no-cache）
//   6. 回写仓库元数据 distribution/releases/<id>.json + distribution/desktop-latest.json
//
// 凭证：OSS_RELEASE_KEY_ID / OSS_RELEASE_KEY_SECRET 环境变量优先；
//       本地回退读 ~/.ossutil/arcane-release.conf 的 [ArcaneDeskRelease] 段（RAM: ArcaneDeskRelease）。
// 纪律：hotfix 也必须用新 releaseId，绝不覆盖既有版本目录（RAM 策略也无 Delete 权限）。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUCKET = "arcane-package";
const REGION = "oss-cn-beijing";
const BASE_URL = `https://${BUCKET}.${REGION}.aliyuncs.com`;
const RELEASE_ROOT = "desktop/arcane-desk/releases";
const LATEST_KEY = "desktop/arcane-desk/latest.json";

const PLATFORM_DIRS = ["macos-arm64", "macos-x64", "windows-x64", "windows-arm64"];

const CONTENT_TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".exe": "application/x-msdownload",
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
    else if (a === "--channel") args.channel = takeValue(a, i++);
    else if (a === "--platforms") args.platforms = takeValue(a, i++).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--skip-latest") args.skipLatest = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-repo-metadata") args.noRepoMetadata = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (args.fromDist && args.staging) throw new Error("use only one of --from-dist or --staging");
  if (args.promoteRelease && (args.fromDist || args.staging || args.releaseId || args.skipLatest)) {
    throw new Error("--promote-release cannot be combined with staging, release-id, or skip-latest options");
  }
  const unsupportedPlatforms = args.platforms?.filter((platform) => !PLATFORM_DIRS.includes(platform)) ?? [];
  if (unsupportedPlatforms.length) throw new Error(`unsupported platform(s): ${unsupportedPlatforms.join(", ")}`);
  if (!args.promoteRelease && !args.fromDist && !args.staging) {
    args.fromDist = path.join(desktopRoot, "dist");
  }
  return args;
}

export { parseArgs, platformForFile, uploadObject, verifyUrl, createOssClient, BASE_URL };

function loadCredentials() {
  if (process.env.OSS_RELEASE_KEY_ID && process.env.OSS_RELEASE_KEY_SECRET) {
    return { accessKeyId: process.env.OSS_RELEASE_KEY_ID, accessKeySecret: process.env.OSS_RELEASE_KEY_SECRET };
  }
  const conf = path.join(os.homedir(), ".ossutil", "arcane-release.conf");
  if (!fs.existsSync(conf)) {
    throw new Error("missing OSS credentials: set OSS_RELEASE_KEY_ID and OSS_RELEASE_KEY_SECRET or create ~/.ossutil/arcane-release.conf");
  }
  const text = fs.readFileSync(conf, "utf8");
  const section = text.split(/^\[(.+)\]$/m).findIndex((name) => name === "ArcaneDeskRelease");
  if (section === -1) throw new Error("arcane-release.conf has no [ArcaneDeskRelease] section");
  const body = text.split(/^\[(.+)\]$/m).slice(section + 1, section + 2)[0] ?? "";
  const pick = (key) => body.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "m"))?.[1];
  const accessKeyId = pick("accessKeyID");
  const accessKeySecret = pick("accessKeySecret");
  if (!accessKeyId || !accessKeySecret) throw new Error("arcane-release.conf is missing accessKeyID/accessKeySecret");
  return { accessKeyId, accessKeySecret };
}

// 按 electron-builder artifactName（Arcane-Desk-<version>-<win|mac>-<arch>.<ext>）分拣到平台目录。
function platformForFile(name) {
  if (/-mac-arm64\.(dmg|zip)$/.test(name)) return "macos-arm64";
  if (/-mac-x64\.(dmg|zip)$/.test(name)) return "macos-x64";
  if (/-win-x64\.(exe|zip)$/.test(name)) return "windows-x64";
  if (/-win-arm64\.(exe|zip)$/.test(name)) return "windows-arm64";
  if (/^SHA256SUMS/i.test(name)) return null; // dist 根下的汇总文件按平台重建
  return null;
}

async function stageFromDist(distDir, platforms) {
  const staging = [];
  const entries = await fsp.readdir(distDir, { withFileTypes: true });
  const sumsByPlatform = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const platform = platformForFile(entry.name);
    if (!platform) continue;
    if (platforms && !platforms.includes(platform)) continue;
    if (/^SHA256SUMS/i.test(entry.name)) continue;
    staging.push({ platform, file: path.join(distDir, entry.name) });
    if (!sumsByPlatform.has(platform)) sumsByPlatform.set(platform, []);
    sumsByPlatform.get(platform).push(entry.name);
  }
  // 平台内重建 SHA256SUMS.txt，保证 checksum 与本目录文件一一对应。
  for (const [platform, names] of sumsByPlatform) {
    const lines = await Promise.all(
      names.sort().map(async (name) => {
        const sha = await sha256File(path.join(distDir, name));
        return `${sha}  ${name}`;
      }),
    );
    const sumsFile = path.join(distDir, `SHA256SUMS-${platform}.txt`);
    await fsp.writeFile(sumsFile, `${lines.join("\n")}\n`, "utf8");
    staging.push({ platform, file: sumsFile });
  }
  return staging;
}

async function stageFromStagingDir(stagingDir, platforms) {
  const staging = [];
  for (const platform of PLATFORM_DIRS) {
    if (platforms && !platforms.includes(platform)) continue;
    const dir = path.join(stagingDir, platform);
    if (!fs.existsSync(dir)) continue;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) staging.push({ platform, file: path.join(dir, entry.name) });
    }
  }
  return staging;
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
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
  return new OSS({ region: REGION, bucket: BUCKET, ...creds, timeout: 600_000 });
}

async function uploadObject(client, obj) {
  const headers = { "Cache-Control": obj.cache, "Content-Type": obj.contentType };
  if (obj.immutable) headers["x-oss-forbid-overwrite"] = "true";
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
    const res = await fetch(url, {
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

async function verifyObject(obj) {
  return verifyUrl(`${BASE_URL}/${obj.key}`, obj.bytes, obj.key);
}

async function promoteRelease(args) {
  const releaseId = args.promoteRelease;
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(releaseId)) {
    throw new Error(`unsafe release id: ${releaseId}`);
  }
  const manifestUrl = `${BASE_URL}/${RELEASE_ROOT}/${releaseId}/release.json`;
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`cannot load release to promote: HTTP ${response.status} ${manifestUrl}`);
  const release = await response.json();
  if (release.releaseId !== releaseId || !release.product?.version || !release.channel) {
    throw new Error(`release manifest is invalid or mismatched: ${manifestUrl}`);
  }
  const prefix = `${BASE_URL}/${RELEASE_ROOT}/${releaseId}/`;
  for (const file of release.files ?? []) {
    if (!file.url?.startsWith(prefix) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`release manifest contains an unsafe file entry: ${JSON.stringify(file)}`);
    }
    if (!(await verifyUrl(file.url, file.bytes, `${file.platform}/${file.name}`))) {
      throw new Error(`release ${releaseId} is incomplete; latest remains unchanged`);
    }
  }
  if (!release.files?.length) throw new Error(`release ${releaseId} has no files`);

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
    key: LATEST_KEY,
    body: latestBody,
    bytes: Buffer.byteLength(latestBody),
    cache: "no-cache",
    contentType: CONTENT_TYPES[".json"],
  };
  if (!args.noRepoMetadata) {
    await fsp.writeFile(
      path.join(desktopRoot, "distribution", "desktop-latest.json"),
      latestBody,
      "utf8",
    );
  }
  if (args.dryRun) {
    console.log(`dry-run: release ${releaseId} is complete; latest upload skipped`);
    return;
  }
  const client = await createOssClient();
  await uploadObject(client, latestObject);
  if (!(await verifyObject(latestObject))) throw new Error("latest.json failed verification");
  console.log(`latest now points to verified release ${releaseId}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.promoteRelease) {
    await promoteRelease(args);
    return;
  }
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

  const staging = args.staging
    ? await stageFromStagingDir(args.staging, args.platforms)
    : await stageFromDist(args.fromDist, args.platforms);
  if (!staging.length) throw new Error("no artifacts staged (nothing matching known platform file names)");

  const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files = [];
  for (const { platform, file } of staging) {
    const name = path.basename(file);
    const [sha256, stat] = await Promise.all([sha256File(file), fsp.stat(file)]);
    files.push({
      kind: kindFor(name),
      platform,
      name,
      bytes: stat.size,
      sha256,
      contentType: contentTypeFor(name),
      url: `${BASE_URL}/${RELEASE_ROOT}/${releaseId}/${platform}/${name}`,
    });
  }
  files.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));

  const release = {
    ...manifest,
    channel,
    releaseId,
    publishedAt,
    manifestUrl: `${BASE_URL}/${RELEASE_ROOT}/${releaseId}/release.json`,
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
      key: `${RELEASE_ROOT}/${releaseId}/${f.platform}/${f.name}`,
      file: staging.find((s) => path.basename(s.file) === f.name && s.platform === f.platform).file,
      bytes: f.bytes,
      cache: "public, max-age=31536000, immutable",
      contentType: f.contentType,
      immutable: true,
    })),
    {
      key: `${RELEASE_ROOT}/${releaseId}/release.json`,
      body: releaseBody,
      bytes: Buffer.byteLength(releaseBody),
      cache: "public, max-age=31536000, immutable",
      contentType: CONTENT_TYPES[".json"],
      immutable: true,
    },
  ];
  const latestObject = {
    key: LATEST_KEY,
    body: latestBody,
    bytes: Buffer.byteLength(latestBody),
    cache: "no-cache",
    contentType: CONTENT_TYPES[".json"],
  };
  const plan = { releaseId, channel, bucket: BUCKET, immutableObjects, latestObject };

  console.log(`Release ${releaseId} (${channel}) — ${files.length} artifacts, ${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1)} MB total`);
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
        path.join(desktopRoot, "distribution", "desktop-latest.json"),
        latestBody,
        "utf8",
      );
      console.log("repo metadata written: distribution/releases/%s.json + desktop-latest.json", releaseId);
    } else {
      console.log("repo metadata written: distribution/releases/%s.json (latest unchanged)", releaseId);
    }
  }

  if (args.dryRun) {
    console.log("dry-run: skip upload & verify");
    return;
  }

  const client = await createOssClient();

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
    if (!(await verifyObject(obj))) failures += 1;
  }
  if (failures) throw new Error(`${failures} object(s) failed verification; do NOT announce this release`);

  if (!args.skipLatest) {
    await uploadObject(client, plan.latestObject);
    if (!(await verifyObject(plan.latestObject))) {
      throw new Error("latest.json failed verification; do NOT announce this release");
    }
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
