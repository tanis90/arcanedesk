#!/usr/bin/env node
// publish-release.mjs — Arcane Desktop 发布唯一入口（CI 与本地 hotfix 共用）。
//
// 职责（顺序固定）：
//   1. 组装 staging 树（--from-dist 按 artifact 名自动分拣，或 --staging 直读平台子目录；
//      --signed-dir 用签名副本覆盖同名 artifact，实现先签后发）
//   2. 计算 bytes/sha256，合并 generated/desktop-release.json 生成 release.json
//   3. 上传到 region 对应的对象存储 desktop/arcane-desk[-intl]/releases/<id>/（路径版本化、不可变）
//   4. 上传后全量 verify：每个 URL HEAD，200 且 content-length == bytes（镜像契约规则 3）
//   5. 更新 desktop/arcane-desk[-intl]/latest.json（唯一可覆盖对象，no-cache）
//   6. 回写仓库元数据 distribution/releases/<id>.json + distribution/desktop-latest[-intl].json
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
  }),
  intl: Object.freeze({
    clientKind: "r2",
    bucket: "arcane-desk-intl",
    baseUrl: "https://dl.arcanedesk.app",
    releaseRoot: "desktop/arcane-desk-intl/releases",
    latestKey: "desktop/arcane-desk-intl/latest.json",
    repoLatestFile: "desktop-latest-intl.json",
    skillsRoot: "desktop/arcane-desk-intl/skills",
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
    else if (a === "--region") args.region = takeValue(a, i++);
    else if (a === "--signed-dir") args.signedDir = takeValue(a, i++);
    else if (a === "--platforms") args.platforms = takeValue(a, i++).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--skip-latest") args.skipLatest = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-repo-metadata") args.noRepoMetadata = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (args.fromDist && args.staging) throw new Error("use only one of --from-dist or --staging");
  if (args.promoteRelease && (args.fromDist || args.staging || args.releaseId || args.skipLatest || args.signedDir)) {
    throw new Error("--promote-release cannot be combined with staging, release-id, signed-dir, or skip-latest options");
  }
  if (args.region && !REGION_IDS.includes(args.region)) {
    throw new Error(`unsupported region: ${args.region} (expected ${REGION_IDS.join("/")})`);
  }
  const unsupportedPlatforms = args.platforms?.filter((platform) => !PLATFORM_DIRS.includes(platform)) ?? [];
  if (unsupportedPlatforms.length) throw new Error(`unsupported platform(s): ${unsupportedPlatforms.join(", ")}`);
  if (!args.promoteRelease && !args.fromDist && !args.staging) {
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
  BASE_URL,
};

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
  const accountId = overrides.accountId ?? process.env.CF_ACCOUNT_ID;
  const accessKeyId = overrides.accessKeyId ?? process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = overrides.secretAccessKey ?? process.env.R2_SECRET_ACCESS_KEY;
  const bucket = overrides.bucket ?? TARGETS.intl.bucket;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("missing R2 credentials: set CF_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY");
  }
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
  if (args.dryRun) {
    console.log(`dry-run: release ${releaseId} is complete; latest upload skipped`);
    return;
  }
  const client = await createStorageClient(target);
  await uploadObject(client, latestObject);
  if (!(await verifyObject(target, latestObject))) throw new Error("latest.json failed verification");
  console.log(`latest now points to verified release ${releaseId} (${target.clientKind})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.promoteRelease) {
    await promoteRelease(args);
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

  const staging = args.staging
    ? await stageFromStagingDir(args.staging, args.platforms, args.signedDir)
    : await stageFromDist(args.fromDist, args.platforms, args.signedDir);
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
      url: `${target.baseUrl}/${target.releaseRoot}/${releaseId}/${platform}/${name}`,
    });
  }
  files.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));

  const release = {
    ...manifest,
    channel,
    releaseId,
    publishedAt,
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

  if (args.dryRun) {
    console.log("dry-run: skip upload & verify");
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
    await uploadObject(client, plan.latestObject);
    if (!(await verifyObject(target, plan.latestObject))) {
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
