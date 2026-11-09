#!/usr/bin/env node
// stage-release.mjs — 分阶段发布·阶段 1：上传签名器不触碰的全部对象。
// 设计与幂等契约见 docs/phased-release-design.md。要点：
// - 只收 mac dmg/zip/SHA256SUMS 与 windows zip；staging 出现 .exe 直接报错
//   （未签名安装包入桶是红线，Windows 安装器只能由本地签名后经 finalize 上传）。
// - 上传对象不可变：已存在且 HEAD 长度一致 → 视为已 staged 跳过（重跑续传）；
//   长度不一致 → 硬错误（版本目录被别的内容占用）。
// - 产出 manifest 分片（fragment）：已上传每个文件的 name/bytes/sha256/sha512/kind，
//   供本地 finalize 合成全量 release.json（mac 产物不必落地本地）；sha512 供
//   electron-updater feed 使用，finalize 不再为分片件回源下载。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  contentTypeFor,
  kindFor,
  resolveTarget,
  createStorageClient,
  uploadObject,
  verifyUrl,
  sha256File,
  sha512File,
  headStatus,
} from "./publish-release.mjs";
import { REGION_IDS } from "../src/main/region.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FRAGMENT_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const args = {};
  const takeValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--staging") args.staging = takeValue(a, i++);
    else if (a === "--region") args.region = takeValue(a, i++);
    else if (a === "--release-id") args.releaseId = takeValue(a, i++);
    else if (a === "--out-fragment") args.outFragment = takeValue(a, i++);
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (!args.staging) throw new Error("--staging is required (platform subdirectories)");
  if (!REGION_IDS.includes(args.region ?? "")) {
    throw new Error(`--region must be one of ${REGION_IDS.join("/")}; got: ${args.region}`);
  }
  if (!args.releaseId || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(args.releaseId)) {
    throw new Error(`--release-id is required and must be safe: ${args.releaseId}`);
  }
  return args;
}

// 收集 staging/<platform>/ 下的可上传对象。mac 目录收 dmg/zip/SHA256SUMS；
// windows 目录只收 zip——exe 一律报错，SHA256SUMS 是 CI 对未签名件的清单，不发布
// （windows 的 SHA256SUMS 由 finalize 按签名后文件重建）。
export function collectStageFiles(stagingDir) {
  const entries = [];
  for (const platform of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (!platform.isDirectory()) continue;
    const dir = path.join(stagingDir, platform.name);
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (/\.exe$/i.test(file.name)) {
        throw new Error(`unsigned installer must not be staged: ${platform.name}/${file.name} (finalize uploads signed installers only)`);
      }
      if (/^SHA256SUMS/i.test(file.name)) {
        if (platform.name.startsWith("macos")) entries.push({ platform: platform.name, file: path.join(dir, file.name) });
        continue;
      }
      if (!/\.(dmg|zip)$/i.test(file.name)) continue;
      entries.push({ platform: platform.name, file: path.join(dir, file.name) });
    }
  }
  if (!entries.length) throw new Error(`no stageable files found under ${stagingDir}`);
  return entries;
}

// mac 平台的 CI 清单必须与实文件一致：分片哈希以此为准，先在本地对账再上传，
// 防止把一份与对象不符的清单发进版本目录。
export async function verifyMacSums(entries) {
  const errors = [];
  for (const platform of new Set(entries.map((e) => e.platform))) {
    if (!platform.startsWith("macos")) continue;
    const sumsFile = entries.find((e) => e.platform === platform && /^SHA256SUMS/i.test(path.basename(e.file)))?.file;
    if (!sumsFile) {
      errors.push(`${platform}: CI SHA256SUMS.txt missing from staging`);
      continue;
    }
    const expected = new Map(
      fs.readFileSync(sumsFile, "utf8").split("\n").filter(Boolean).map((line) => {
        const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
        if (!match) throw new Error(`unparsable sums line in ${sumsFile}: ${line}`);
        return [match[2], match[1]];
      }),
    );
    for (const entry of entries.filter((e) => e.platform === platform && /\.(dmg|zip)$/i.test(e.file))) {
      const name = path.basename(entry.file);
      const actual = await sha256File(entry.file);
      if (expected.get(name) !== actual) {
        errors.push(`${platform}/${name}: staging hash ${actual} disagrees with CI SHA256SUMS ${expected.get(name)}`);
      }
    }
  }
  return errors;
}

export function buildFragment({ releaseId, region, files }) {
  return {
    schemaVersion: FRAGMENT_SCHEMA_VERSION,
    releaseId,
    region,
    files: files
      .map(({ platform, name, bytes, sha256, sha512 }) => ({
        platform,
        name,
        bytes,
        sha256,
        sha512,
        kind: kindFor(name),
        contentType: contentTypeFor(name),
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args.region);
  const stagingDir = path.resolve(args.staging);

  const entries = collectStageFiles(stagingDir);
  const sumErrors = await verifyMacSums(entries);
  if (sumErrors.length) throw new Error(`mac SHA256SUMS cross-check failed:\n${sumErrors.join("\n")}`);

  const files = await Promise.all(entries.map(async ({ platform, file }) => {
    const name = path.basename(file);
    const [sha256, sha512, stat] = await Promise.all([sha256File(file), sha512File(file), fsp.stat(file)]);
    return { platform, name, bytes: stat.size, sha256, sha512, file };
  }));

  const objects = files.map((f) => ({
    key: `${target.releaseRoot}/${args.releaseId}/${f.platform}/${f.name}`,
    file: f.file,
    bytes: f.bytes,
    sha256: f.sha256,
    cache: "public, max-age=31536000, immutable",
    contentType: contentTypeFor(f.name),
    immutable: true,
    url: `${target.baseUrl}/${target.releaseRoot}/${args.releaseId}/${f.platform}/${f.name}`,
  }));

  console.log(`Stage ${args.releaseId} (${args.region}, ${target.clientKind}) — ${objects.length} objects, ${(objects.reduce((n, o) => n + o.bytes, 0) / 1e6).toFixed(1)} MB`);
  for (const o of objects) console.log(`  ${o.key}  ${o.bytes}  ${o.sha256.slice(0, 12)}…`);

  const fragmentPath = args.outFragment
    ? path.resolve(args.outFragment)
    : path.join(desktopRoot, "generated", `release-fragment-${args.region}.json`);
  if (args.dryRun) {
    console.log(`dry-run: fragment would be ${fragmentPath}; no upload`);
    return;
  }

  const client = await createStorageClient(target);
  let staged = 0;
  let uploaded = 0;
  for (const obj of objects) {
    const head = await headStatus(obj.url);
    if (head.status === 200 && head.length === obj.bytes) {
      console.log(`already staged ${obj.key}`);
      staged += 1;
      continue;
    }
    if (head.status === 200) {
      throw new Error(`object exists with different length: ${obj.key} (bucket ${head.length} != local ${obj.bytes}); use a new release id`);
    }
    if (head.status !== 404) throw new Error(`unexpected HEAD status ${head.status} for ${obj.key}`);
    await uploadObject(client, obj);
    uploaded += 1;
  }

  let failures = 0;
  for (const obj of objects) {
    if (!(await verifyUrl(obj.url, obj.bytes, obj.key))) failures += 1;
  }
  if (failures) throw new Error(`${failures} staged object(s) failed verification`);

  const fragment = buildFragment({ releaseId: args.releaseId, region: args.region, files });
  await fsp.mkdir(path.dirname(fragmentPath), { recursive: true });
  await fsp.writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`, "utf8");
  console.log(`staged ${staged} pre-existing + uploaded ${uploaded}; fragment ${fragmentPath}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
