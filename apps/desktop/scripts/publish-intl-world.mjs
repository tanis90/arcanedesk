#!/usr/bin/env node
// publish-intl-world.mjs — intl demo world 的发布入口（本地运行，需 R2 凭证）。
//
// 职责（顺序固定）：
//   1. 读入 Foundry 世界目录，校验 world.json 身份（id/version/system）；
//   2. 复制到 staging 并把 world.json 的 manifest/download 改写为 R2 版本化 URL；
//   3. 打 zip（复用 skills vendored foundry-pack-builder 的 writeModuleArchive）；
//   4. 内容门禁：解包扫描 CoS/非 SRD 词表、cn 专属模块引用、CJK（零违规才继续）；
//   5. --publish 时上传 world.json + zip 到 R2（幂等：已存在且长度一致跳过）；
//   6. 写 distribution/intl-world-distribution.json（哈希 + gate 记录 + profile 声明）。
//
// 之后由 arcane-intl-mod-index 工作流（周更或手动 dispatch）读声明文件把
// worlds/profiles 段合入 index-en.json——本脚本永远不直接写索引。
// 凭证与 publish-release 相同：CF_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY。
//
// dry-run：只做 1-4 与产物落盘（output/ 下），不上传、不写 distribution 文件
// ——声明文件指向的工件必须已在线上，提前写入会让周更必然失败。

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

import { scanWorldZip } from "./intl-world-gate.mjs";
import { createR2Client, uploadObject, verifyUrl } from "./publish-release.mjs";
import { headContentLength } from "./prepare-intl-index.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR_PUBLIC_BASE = "https://dl.arcanedesk.app";

/**
 * 世界目录打包（zip 根必须是 world.json；foundry-pack-builder 的
 * writeModuleArchive 校验 module.json，不适用于 world）。确定性输出：
 * 同一目录内容产出逐字节相同的 zip，manifest/zip 的哈希才可复现。
 * @returns {Promise<{ bytes: number }>}
 */
export async function writeWorldArchive({ directory, archive }) {
  const source = path.resolve(directory);
  const output = path.resolve(archive);
  if (path.relative(source, path.dirname(output)) === "") {
    throw new Error("archive output must be outside the world directory");
  }
  const files = {};
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(source, absolute).split(path.sep).join("/");
        files[relative] = new Uint8Array(await fsp.readFile(absolute));
      }
    }
  };
  await walk(source);
  if (!files["world.json"]) throw new Error("world archive source is missing world.json");
  const zipped = zipSync(files, { level: 6 });
  await fsp.writeFile(output, zipped);
  return { bytes: zipped.length };
}

function parseArgs(argv) {
  const result = { booleans: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument near ${key ?? "end"}`);
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

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.booleans.has("publish") && args.booleans.has("dry-run")) {
    throw new Error("--publish and --dry-run are mutually exclusive");
  }
  const worldDir = path.resolve(requireString(args["world-dir"], "--world-dir"));
  const outputDir = path.resolve(requireString(args.output, "--output"));
  const distributionFile = path.resolve(
    args.distribution ?? path.join(desktopRoot, "distribution", "intl-world-distribution.json"),
  );
  const profileId = args["profile-id"] ?? "arcane-demo-full";
  const profileTitle = args["profile-title"] ?? "Arcane Demo Full";
  const revision = Number(requireString(args.revision, "--revision"));

  let previous = null;
  try {
    previous = JSON.parse(await fsp.readFile(distributionFile, "utf8"));
  } catch { /* 首次发布 */ }
  const modules = String(args.modules ?? previous?.profile?.modules?.join(",") ?? "")
    .split(",").map((id) => id.trim()).filter(Boolean);
  if (!modules.length) throw new Error("profile modules are required: pass --modules <id,id,...> on first publish");

  const worldJsonPath = path.join(worldDir, "world.json");
  const worldJson = JSON.parse(await fsp.readFile(worldJsonPath, "utf8"));
  const worldId = requireString(worldJson.id, "world.json id");
  const version = String(requireString(worldJson.version, "world.json version"));
  const system = requireString(worldJson.system, "world.json system");
  const title = typeof worldJson.title === "string" && worldJson.title ? worldJson.title : "Arcane Demo";

  const baseKey = `mods/worlds/${worldId}/${version}`;
  const manifestKey = `${baseKey}/world.json`;
  const zipKey = `${baseKey}/${worldId}-${version}.zip`;
  const manifestUrl = `${MIRROR_PUBLIC_BASE}/${manifestKey}`;
  const downloadUrl = `${MIRROR_PUBLIC_BASE}/${zipKey}`;

  // staging：改写 manifest/download 为 R2 版本化 URL 后打包；绝不改源世界目录。
  await fsp.mkdir(outputDir, { recursive: true });
  const staging = path.join(outputDir, `world-staging-${worldId}-${version}`);
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fsp.cp(worldDir, staging, { recursive: true });
  const rewritten = `${JSON.stringify({ ...worldJson, manifest: manifestUrl, download: downloadUrl }, null, 2)}\n`;
  await fsp.writeFile(path.join(staging, "world.json"), rewritten, "utf8");

  const zipPath = path.join(outputDir, `${worldId}-${version}.zip`);
  await writeWorldArchive({ directory: staging, archive: zipPath });

  const gate = await scanWorldZip(zipPath, outputDir);
  if (gate.violations.length) {
    for (const violation of gate.violations) {
      process.stderr.write(`BLOCKED ${violation.file}: [${violation.kind}] ${violation.term}\n`);
    }
    throw new Error(`world content gate rejected the archive (${gate.violations.length} violations); fix and rebuild`);
  }

  const manifestBytes = Buffer.byteLength(rewritten);
  const manifestSha256 = sha256(Buffer.from(rewritten, "utf8"));

  if (args.booleans.has("publish")) {
    const client = await createR2Client({});
    for (const object of [
      { key: manifestKey, url: manifestUrl, body: rewritten, bytes: manifestBytes, contentType: "application/json; charset=utf-8" },
      { key: zipKey, url: downloadUrl, file: zipPath, bytes: gate.bytes, contentType: "application/zip" },
    ]) {
      const head = await headContentLength(fetch, object.url);
      if (head.status === 200 && head.length === object.bytes) {
        console.log(`world object already current: ${object.key}`);
        continue;
      }
      if (head.status === 200) {
        throw new Error(`immutable world object differs from measured content: ${object.key}`);
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
      if (!(await verifyUrl(object.url, object.bytes, object.key))) {
        throw new Error(`${object.key} failed HEAD verification after publish`);
      }
    }
  }

  const distribution = {
    schemaVersion: 1,
    world: {
      id: worldId,
      title,
      version,
      system,
      manifestUrl,
      downloadUrl,
      manifestBytes,
      manifestSha256,
      bytes: gate.bytes,
      sha256: gate.sha256,
      gate: { sha256: gate.sha256, violations: gate.violations.length, checkedAt: new Date().toISOString() },
    },
    profile: { id: profileId, title: profileTitle, revision, modules },
  };
  const distributionBody = `${JSON.stringify(distribution, null, 2)}\n`;

  if (args.booleans.has("publish")) {
    await fsp.writeFile(distributionFile, distributionBody, "utf8");
    console.log(`distribution written: ${distributionFile}`);
    console.log("next: dispatch arcane-intl-mod-index.yml to merge worlds/profiles into index-en.json");
  } else {
    await fsp.writeFile(path.join(outputDir, "intl-world-distribution.json"), distributionBody, "utf8");
    console.log("dry-run: artifacts staged and gate passed; distribution preview written to output dir only");
  }
}

const invokedPath = process.argv[1] ? (await import("node:url")).pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
