#!/usr/bin/env node
// prepare-intl-index.mjs — 国际版 mod 索引生成器（国际化方案 D2/M3）。
//
// 输入：distribution/intl-mod-curation.json 策展清单，逐条钉住上游稳定 manifest URL
// （GitHub Releases 的 latest module.json/system.json）。
// 过程：逐个拉取上游 manifest 校验身份 → 实测下载 ZIP 计算 bytes/sha256（不轻信
// 任何第三方声明的哈希）→ 与线上已发布的 index-en.json 比对做哈希漂移报警：
//   同 id 同 version 同 manifestUrl/zipUrl 而 sha256 变化 = 供应链事件，直接失败；
//   版本升级（manifest 身份变化）是正常上游发版，放行并体现在报告里。
// 闭包：所有包的 relationships.requires 必须也能在索引中解析（system/module），
// 缺哪个报哪个，由人把依赖补进策展清单——不自动追加上游引用的任意包。
// 镜像模式（策展条目 mirror: true）：上游自指 URL 不稳定时（dnd5e 自指 master 分支），
// manifest/download 改写为 R2 版本化 URL（mods/packages/<id>/<version>/）随索引发布。
// 输出：--output 目录下 index-en.json（与 cn 索引同 schema、CRLF 序列化）+
// publish-plan.json（审计报告）+ mirror/（镜像工件）；--publish 时先传镜像对象
// （已存在且一致则跳过），再上传 R2 mods/index-en.json 并 HEAD 校验。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createR2Client, uploadObject, verifyUrl } from "./publish-release.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INDEX_KEY = "mods/index-en.json";
const INDEX_PUBLIC_URL = `https://dl.arcanedesk.app/${INDEX_KEY}`;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const result = { booleans: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    if (key === "--publish" || key === "--dry-run") {
      result.booleans.add(key.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function safeId(value, label) {
  const id = requireString(value, label);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} is unsafe: ${id}`);
  return id;
}

function httpsUrl(value, label) {
  let url;
  try {
    url = new URL(requireString(value, label));
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url.href;
}

function manifestUrlFor(value, kind, label) {
  const href = httpsUrl(value, label);
  const expected = kind === "system" ? "system.json" : "module.json";
  if (path.posix.basename(new URL(href).pathname).toLowerCase() !== expected) {
    throw new Error(`${label} must point to ${expected}`);
  }
  return href;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function serializeIndex(value) {
  // 与 cn 索引（prepare-world-profile.mjs）一致的 CRLF 序列化。
  return `${JSON.stringify(value, null, 2).replace(/\n/g, "\r\n")}\r\n`;
}

function generatedTimestamp() {
  return new Date().toISOString().replace("Z", "+00:00");
}

// ---- 策展清单 ------------------------------------------------------------
// { packages: [{ id, kind: "module"|"system", group, manifestUrl }] }
// group 是展示/归类字段（如 "system"、"automation"、"utility"），由策展人指定。

function validateCuration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.packages)) {
    throw new Error("curation must be an object with a packages array");
  }
  const seen = new Set();
  return value.packages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`curation package ${index} must be an object`);
    }
    const id = safeId(entry.id, `curation package ${index} id`);
    const kind = entry.kind === "system" ? "system" : entry.kind === "module" ? "module" : null;
    if (!kind) throw new Error(`curation package ${id} kind must be module/system`);
    const group = requireString(entry.group, `curation package ${id} group`);
    // 与 mod-manager 的分类语义对齐：system 条目必须 group="system"（world 流程据此解析），
    // module 条目不得占用 "system" 组名。
    if (kind === "system" && group !== "system") {
      throw new Error(`curation system ${id} must use group "system"`);
    }
    if (kind === "module" && group === "system") {
      throw new Error(`curation module ${id} must not use group "system"`);
    }
    const manifestUrl = manifestUrlFor(entry.manifestUrl, kind, `curation package ${id} manifest URL`);
    // mirror: true 表示「镜像模式」——上游自指 URL 不稳定（如 dnd5e 自指 master 分支，
    // 版本一推进就指向新版）时，把 manifest/download 改写为 R2 版本化 URL 随索引一起发布。
    if (entry.mirror != null && typeof entry.mirror !== "boolean") {
      throw new Error(`curation package ${id} mirror must be a boolean`);
    }
    const mirror = entry.mirror === true;
    const key = `${kind}:${id}`;
    if (seen.has(key)) throw new Error(`curation repeats ${key}`);
    seen.add(key);
    return { id, kind, group, manifestUrl, mirror };
  });
}

// ---- 上游实测 ------------------------------------------------------------

const MIRROR_PUBLIC_BASE = "https://dl.arcanedesk.app";

// 镜像对象按版本不可变存放：mods/packages/<id>/<version>/<manifest|zip>。
function mirrorLayout(curated, version) {
  const base = `mods/packages/${curated.id}/${version}`;
  const manifestFile = curated.kind === "system" ? "system.json" : "module.json";
  return {
    manifestKey: `${base}/${manifestFile}`,
    zipKey: `${base}/${curated.id}-${version}.zip`,
  };
}

async function measurePackage(curated, { fetchImpl = fetch } = {}) {
  const label = `${curated.kind} ${curated.id}`;
  // 策展 URL 允许是 /latest/download/ 这类发现地址：跟随重定向拿到当前版本 manifest。
  // 索引 manifestUrl 优先取上游自指 URL，否则取版本化最终 URL（见下）。
  const manifestDocument = await fetchJsonDocumentWith(fetchImpl, curated.manifestUrl, `${label} manifest`);
  const manifest = manifestDocument.value;
  if (manifest?.id !== curated.id) throw new Error(`${label} manifest id mismatch: ${manifest?.id}`);
  const version = requireString(String(manifest.version ?? ""), `${label} manifest version`);
  const downloadUrl = httpsUrl(requireString(manifest.download, `${label} manifest download`), `${label} download URL`);
  const { buffer: archive } = await fetchBufferWith(fetchImpl, downloadUrl, `${label}@${version} ZIP`);
  const requires = (Array.isArray(manifest.relationships?.requires) ? manifest.relationships.requires : [])
    .filter((dep) => dep && ["module", "system"].includes(dep.type) && typeof dep.id === "string")
    .map((dep) => ({ id: dep.id, kind: dep.type }));

  if (curated.mirror) {
    // 镜像模式：manifest/download 改写为 R2 版本化 URL，索引条目指向镜像；
    // 不采信上游自指 URL（镜像存在的意义正是上游自指不稳定）。
    const layout = mirrorLayout(curated, version);
    const manifestUrl = `${MIRROR_PUBLIC_BASE}/${layout.manifestKey}`;
    const zipUrl = `${MIRROR_PUBLIC_BASE}/${layout.zipKey}`;
    const rewritten = Buffer.from(
      `${JSON.stringify({ ...manifest, manifest: manifestUrl, download: zipUrl }, null, 2)}\n`,
      "utf8",
    );
    return {
      entry: {
        id: curated.id,
        version,
        group: curated.group,
        bytes: archive.length,
        sha256: sha256(archive),
        zipUrl,
        manifestUrl,
      },
      requires,
      mirror: { ...layout, manifestUrl, zipUrl, zipBuffer: archive, manifestBuffer: rewritten },
    };
  }

  const selfUrl = manifest.manifest ? httpsUrl(manifest.manifest, `${label} self URL`) : null;
  // mod-manager 安装时强校验「manifest 自指 URL === 索引 manifestUrl」，因此上游声明了
  // 自指 URL 就必须用它（典型：dnd5e 自指 raw.githubusercontent.com 的 master 分支）。
  // 自指 URL 与策展 URL 不同源时，实测两边安装关键字段一致才采纳（见下）。
  let resolvedManifestUrl = manifestDocument.finalUrl;
  if (selfUrl) {
    if (selfUrl !== manifestDocument.finalUrl) {
      // 字节可以不同（上游 release asset 常带额外 flags 元数据），只校验安装链路
      // 实际断言的四个字段：id / version / download / manifest。
      const selfDocument = await fetchJsonDocumentWith(fetchImpl, selfUrl, `${label} self URL document`);
      const other = selfDocument.value ?? {};
      for (const [field, expected] of [["id", curated.id], ["version", version], ["download", manifest.download], ["manifest", selfUrl]]) {
        if (other[field] !== expected) {
          throw new Error(`${label} self URL document ${field} mismatch: ${other[field]}`);
        }
      }
    }
    resolvedManifestUrl = selfUrl;
  }
  return {
    entry: {
      id: curated.id,
      version,
      group: curated.group,
      bytes: archive.length,
      sha256: sha256(archive),
      zipUrl: downloadUrl,
      manifestUrl: resolvedManifestUrl,
    },
    requires,
    mirror: null,
  };
}

// fetch 注入点（测试用）：包一层保持与全局 fetch 相同的调用形态。
async function fetchJsonDocumentWith(fetchImpl, url, label) {
  const response = await fetchImpl(httpsUrl(url, label), { cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_JSON_BYTES) throw new Error(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${errorMessage(error)}`);
  }
  return {
    value,
    buffer,
    bytes: buffer.length,
    sha256: sha256(buffer),
    finalUrl: httpsUrl(response.url || url, `${label} final URL`),
  };
}

async function fetchBufferWith(fetchImpl, url, label) {
  const response = await fetchImpl(httpsUrl(url, label), { cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_PACKAGE_BYTES) throw new Error(`${label} exceeds ${MAX_PACKAGE_BYTES} bytes`);
  return { buffer, finalUrl: response.url || url };
}

// ---- 漂移报警 ------------------------------------------------------------
// 分类与 mod-manager 一致：按 manifest basename 判断（system.json → system）。
function entryKind(entry) {
  try {
    return path.posix.basename(new URL(entry.manifestUrl).pathname).toLowerCase() === "system.json" ? "system" : "module";
  } catch {
    return "module";
  }
}

// 已发布条目里同 id+kind 的版本与本次实测一致时，manifestUrl/zipUrl/sha256 必须
// 完全一致；任何一项不同都视为供应链异常。版本不同视为上游正常发版。
function driftCheck(previousPackages, measured) {
  const previous = new Map((previousPackages ?? []).map((entry) => [`${entryKind(entry)}:${entry.id}@${entry.version}`, entry]));
  const problems = [];
  for (const { entry } of measured) {
    const key = `${entryKind(entry)}:${entry.id}@${entry.version}`;
    const old = previous.get(key);
    if (!old) continue;
    if (old.manifestUrl !== entry.manifestUrl || old.zipUrl !== entry.zipUrl) {
      problems.push(`${entry.id}@${entry.version}: upstream URL changed (${old.manifestUrl} -> ${entry.manifestUrl})`);
    } else if (old.sha256 !== entry.sha256 || old.bytes !== entry.bytes) {
      problems.push(`${entry.id}@${entry.version}: hash drift (${old.sha256} -> ${entry.sha256})`);
    }
  }
  if (problems.length) {
    throw new Error(`upstream hash drift detected; investigate before publishing:\n  ${problems.join("\n  ")}`);
  }
}

function closureCheck(measured) {
  const available = new Set(measured.map(({ entry }) => `${entry.id}`));
  const missing = [];
  for (const { entry, requires } of measured) {
    for (const dep of requires) {
      if (!available.has(dep.id)) missing.push(`${entry.id} requires ${dep.kind} ${dep.id}`);
    }
  }
  if (missing.length) {
    throw new Error(`curation is not dependency-closed; add these to intl-mod-curation.json:\n  ${missing.join("\n  ")}`);
  }
}

/**
 * @param {object} options
 * @param {string} options.curationFile
 * @param {string} options.outputDir
 * @param {string} [options.previousIndexUrl]
 * @param {{ foundry?: string | null, dnd5e?: string | null }} [options.compatibility]
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function prepareIntlIndex({
  curationFile,
  outputDir,
  previousIndexUrl = INDEX_PUBLIC_URL,
  compatibility = {},
  fetchImpl = fetch,
}) {
  const curation = validateCuration(JSON.parse(await fsp.readFile(path.resolve(curationFile), "utf8")));

  // 线上已发布索引是漂移基线；首次发布（404/不存在）视为空基线。
  let previous = { packages: [] };
  let previousError = null;
  try {
    previous = (await fetchJsonDocumentWith(fetchImpl, previousIndexUrl, "published intl index")).value;
  } catch (error) {
    previousError = errorMessage(error);
    console.warn(`warning: cannot load published index for drift baseline (treated as first publish): ${previousError}`);
  }

  const measured = [];
  for (const curated of curation) {
    measured.push(await measurePackage(curated, { fetchImpl }));
  }
  driftCheck(previous.packages, measured);
  closureCheck(measured);

  const index = {
    generated: generatedTimestamp(),
    foundry: compatibility.foundry ?? null,
    // dnd5e 字段是目录展示用的兼容基线：优先取调用方给定值，否则取本次实测的 dnd5e 系统版本。
    dnd5e: compatibility.dnd5e
      ?? measured.find(({ entry }) => entry.id === "dnd5e" && entry.group === "system")?.entry.version
      ?? null,
    packages: measured.map(({ entry }) => entry).sort((a, b) => a.id.localeCompare(b.id)),
    worlds: [],
    profiles: [],
  };
  const indexBuffer = Buffer.from(serializeIndex(index));

  const resolvedOutput = path.resolve(outputDir);
  await fsp.mkdir(resolvedOutput, { recursive: true });
  await fsp.writeFile(path.join(resolvedOutput, "index-en.json"), indexBuffer);

  // 镜像工件落盘到 mirror/<key>：--publish 时按 plan.mirrors 从盘上读取上传，
  // 不落盘只存在内存里的 100MB+ ZIP 无法在发布阶段复用。
  const mirrorPlans = [];
  for (const { mirror } of measured) {
    if (!mirror) continue;
    for (const [key, buffer] of [[mirror.zipKey, mirror.zipBuffer], [mirror.manifestKey, mirror.manifestBuffer]]) {
      const target = path.join(resolvedOutput, "mirror", key);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, buffer);
    }
    mirrorPlans.push({
      manifestKey: mirror.manifestKey,
      manifestUrl: mirror.manifestUrl,
      manifestBytes: mirror.manifestBuffer.length,
      zipKey: mirror.zipKey,
      zipUrl: mirror.zipUrl,
      zipBytes: mirror.zipBuffer.length,
      zipSha256: sha256(mirror.zipBuffer),
    });
  }

  const plan = {
    generatedAt: new Date().toISOString(),
    outputDir: resolvedOutput,
    previousIndex: { url: previousIndexUrl, baselineError: previousError },
    packages: measured.map(({ entry, requires }) => ({ ...entry, requires })),
    mirrors: mirrorPlans,
    nextIndex: { key: INDEX_KEY, url: INDEX_PUBLIC_URL, bytes: indexBuffer.length, sha256: sha256(indexBuffer) },
  };
  await fsp.writeFile(path.join(resolvedOutput, "publish-plan.json"), Buffer.from(`${JSON.stringify(plan, null, 2)}\n`));
  return { plan, index, indexBuffer };
}

async function headContentLength(fetchImpl, url) {
  const response = await fetchImpl(httpsUrl(url, "mirror object URL"), {
    method: "HEAD",
    cache: "no-store",
    headers: { "accept-encoding": "identity" },
  });
  return { status: response.status, length: Number(response.headers.get("content-length")) };
}

// 镜像对象版本化不可变：已存在且长度一致 = 上周已传过，跳过；已存在但长度不同
// = 不可变纪律被破坏（上游 re-tag 或存储被改），必须人工介入。
/**
 * @param {{ put: (key: string, data: unknown, options?: { headers?: Record<string, string> }) => Promise<void>, multipartUpload: (key: string, file: string, options?: { headers?: Record<string, string> }) => Promise<void> }} client
 * @param {Array<{ manifestKey: string, manifestUrl: string, manifestBytes: number, zipKey: string, zipUrl: string, zipBytes: number }>} mirrorPlans
 * @param {object} [options]
 * @param {string} [options.outputDir]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(url: string, expectedBytes: number, label?: string) => Promise<boolean>} [options.verifyImpl]
 */
export async function publishMirrors(client, mirrorPlans, { outputDir, fetchImpl = fetch, verifyImpl = verifyUrl } = {}) {
  const resolvedOutput = path.resolve(requireString(outputDir, "mirror output dir"));
  for (const mirror of mirrorPlans ?? []) {
    const objects = [
      {
        key: mirror.zipKey,
        url: mirror.zipUrl,
        file: path.join(resolvedOutput, "mirror", mirror.zipKey),
        bytes: mirror.zipBytes,
        contentType: "application/zip",
      },
      {
        key: mirror.manifestKey,
        url: mirror.manifestUrl,
        body: await fsp.readFile(path.join(resolvedOutput, "mirror", mirror.manifestKey), "utf8"),
        bytes: mirror.manifestBytes,
        contentType: "application/json; charset=utf-8",
      },
    ];
    for (const object of objects) {
      const head = await headContentLength(fetchImpl, object.url);
      if (head.status === 200 && head.length === object.bytes) {
        console.log(`mirror object already current: ${object.key}`);
        continue;
      }
      if (head.status === 200) {
        throw new Error(`immutable mirror object differs from measured content: ${object.key}`);
      }
      await uploadObject(client, {
        key: object.key,
        file: object.file,
        body: object.body,
        bytes: object.bytes,
        cache: "public, max-age=31536000, immutable",
        contentType: object.contentType,
        immutable: true,
      });
      if (!(await verifyImpl(object.url, object.bytes, object.key))) {
        throw new Error(`${object.key} failed HEAD verification after publish`);
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distribution = JSON.parse(await fsp.readFile(path.join(desktopRoot, "distribution", "community-distribution.json"), "utf8"));
  const compatibility = {
    foundry: distribution.core?.foundry ?? null,
    dnd5e: distribution.systems?.find((system) => system.id === "dnd5e")?.version ?? null,
  };
  const { plan, indexBuffer } = await prepareIntlIndex({
    curationFile: args.curation ?? path.join(desktopRoot, "distribution", "intl-mod-curation.json"),
    outputDir: requireString(args.output, "--output"),
    previousIndexUrl: args["previous-index-url"] ?? INDEX_PUBLIC_URL,
    compatibility,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);

  if (args.booleans.has("publish") && !args.booleans.has("dry-run")) {
    const client = await createR2Client({});
    const output = path.resolve(requireString(args.output, "--output"));
    await publishMirrors(client, plan.mirrors, { outputDir: output });
    const object = {
      key: INDEX_KEY,
      file: path.join(output, "index-en.json"),
      bytes: indexBuffer.length,
      cache: "no-cache",
      contentType: "application/json; charset=utf-8",
    };
    await uploadObject(client, object);
    if (!(await verifyUrl(INDEX_PUBLIC_URL, object.bytes, INDEX_KEY))) {
      throw new Error("index-en.json failed HEAD verification after publish");
    }
    console.log(`intl index published and verified: ${INDEX_PUBLIC_URL}`);
  } else if (args.booleans.has("publish")) {
    console.log("dry-run: mirror objects and index-en.json not uploaded");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
