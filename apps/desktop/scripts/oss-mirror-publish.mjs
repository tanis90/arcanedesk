#!/usr/bin/env node
// arcane-package OSS 镜像发布工具（契约见 apps/desktop/distribution/oss-mirror-contract.md）。
//
// 用法：
//   node oss-mirror-publish.mjs add --id <id> --version <v> --group <g> --zip <zip> --manifest <module.json>
//   node oss-mirror-publish.mjs remove --id <id> --version <v> [--delete-objects] [--force]
//   node oss-mirror-publish.mjs fix-manifest --id <id> --version <v>
//   node oss-mirror-publish.mjs fix-all
//   node oss-mirror-publish.mjs verify
//
// 凭证：aliyun CLI 的当前 profile（~/.aliyun/config.json；本机为 arcane-admin OAuth）。
// 可用 ALIYUN_BIN 覆盖 aliyun 可执行文件路径。
//
// 契约规则映射：
//   路径版本化不可见 -> add 拒绝覆盖已存在的 id+version 目录
//   文件即哈希      -> zip sha256/bytes 写入 index.json 并在回读校验
//   上传完成 != 交付 -> 每次操作后自动跑全量 HEAD 校验（verify 也可单独跑）

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BUCKET = 'arcane-package';
const BASE_URL = 'https://arcane-package.oss-cn-beijing.aliyuncs.com';
const INDEX_URL = `${BASE_URL}/index.json`;
const INDEX_CACHE_CONTROL = 'no-cache, max-age=0, must-revalidate';

/** @returns {never} */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i]?.startsWith('--')) fail(`unexpected argument: ${argv[i] ?? ''}`);
    const key = argv[i].slice(2);
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function resolveAliyunBin() {
  if (process.env.ALIYUN_BIN) return process.env.ALIYUN_BIN;
  const winget = path.join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft/WinGet/Packages/Alibaba.AlibabaCloudCLI_Microsoft.Winget.Source_8wekyb3d8bbwe/aliyun.exe',
  );
  try {
    await fs.access(winget);
    return winget;
  } catch {
    return 'aliyun';
  }
}

/**
 * @param {string} localPath
 * @param {string} objectKey
 * @param {{ cacheControl?: string }} [options]
 */
async function ossUpload(localPath, objectKey, { cacheControl } = {}) {
  const bin = await resolveAliyunBin();
  const args = ['oss', 'cp', localPath, `oss://${BUCKET}/${objectKey}`, '--force'];
  if (cacheControl) args.push('--meta', `Cache-Control:${cacheControl}`);
  const { stdout, stderr } = await execFileAsync(bin, args, { encoding: 'utf8' });
  if (/error|fail/i.test(stderr)) fail(`upload failed for ${objectKey}: ${stderr.trim()}`);
  console.log(`uploaded oss://${BUCKET}/${objectKey}${stdout.includes('\n') ? '' : ` (${stdout.trim()})`}`);
}

/**
 * @param {string | URL} url
 * @param {{ cache?: RequestCache }} [options]
 */
async function fetchJson(url, { cache = 'no-store' } = {}) {
  const response = await fetch(url, { cache });
  if (!response.ok) fail(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

async function headOk(url, expectedBytes = null) {
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!response.ok) return `HTTP ${response.status}`;
  if (expectedBytes !== null) {
    const length = Number(response.headers.get('content-length'));
    if (length !== expectedBytes) return `content-length ${length} != ${expectedBytes}`;
  }
  return null;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

function packageDir(id, version) {
  return `packages/${id}/${version}`;
}

function ossUrls(id, version) {
  return {
    zipUrl: `${BASE_URL}/${packageDir(id, version)}/${id}-${version}.zip`,
    manifestUrl: `${BASE_URL}/${packageDir(id, version)}/module.json`,
  };
}

// 镜像 manifest 的 download/manifest 必须指向本桶：Foundry “URL 安装”才会全程走 OSS。
function rewriteManifest(manifest, id, version) {
  const next = { ...manifest };
  next.download = ossUrls(id, version).zipUrl;
  next.manifest = ossUrls(id, version).manifestUrl;
  return next;
}

function serializeJsonCrlf(value) {
  return `${JSON.stringify(value, null, 2).replace(/\n/g, '\r\n')}\r\n`;
}

function generatedTimestamp() {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

function sortKey(entry) {
  return `${entry.group}/${entry.id}`;
}

// 纯 JS 读 zip 中央目录：只为了断言 module.json 位于压缩包根目录（镜像解包约定）。
function zipRootEntries(buffer) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('zip: end-of-central-directory not found');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) fail('zip: central directory signature mismatch');
    const nameLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return names;
}

async function fetchIndex() {
  return fetchJson(INDEX_URL);
}

async function uploadIndex(index) {
  const next = {
    ...index,
    generated: generatedTimestamp(),
    packages: [...index.packages].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
  };
  const staging = path.join(tmpdir(), `arcane-index-${Date.now()}.json`);
  await fs.writeFile(staging, serializeJsonCrlf(next), 'utf8');
  await ossUpload(staging, 'index.json', { cacheControl: INDEX_CACHE_CONTROL });
  await fs.rm(staging, { force: true });
  return next;
}

async function verifyAll({ deep = [] } = {}) {
  const index = await fetchIndex();
  const problems = [];
  const orientation = [];
  for (const entry of index.packages) {
    for (const [url, expectedBytes] of [
      [entry.zipUrl, entry.bytes],
      [entry.manifestUrl, null],
    ]) {
      const error = await headOk(url, expectedBytes);
      if (error) problems.push(`${entry.id}@${entry.version}: HEAD ${url} -> ${error}`);
    }
    const manifest = await fetchJson(entry.manifestUrl);
    if (manifest.id !== entry.id || String(manifest.version) !== String(entry.version)) {
      problems.push(`${entry.id}@${entry.version}: manifest id/version mismatch`);
    }
    const download = typeof manifest.download === 'string' && manifest.download ? new URL(manifest.download) : null;
    const mirrored = download?.host === new URL(BASE_URL).host;
    orientation.push(`${mirrored ? 'oss  ' : download ? 'ext  ' : 'none '} ${entry.id}@${entry.version} -> ${manifest.download ?? '(no download field)'}`);
    if (deep.includes(entry.id)) {
      const zipResponse = await fetch(entry.zipUrl, { cache: 'no-store' });
      const hash = createHash('sha256').update(Buffer.from(await zipResponse.arrayBuffer())).digest('hex');
      if (hash !== entry.sha256) problems.push(`${entry.id}@${entry.version}: deep sha256 mismatch`);
    }
  }
  for (const line of orientation) console.log(line);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    fail(`verification failed: ${problems.length} problem(s)`);
  }
  console.log(`verified ${index.packages.length} packages: all HEAD/sha256 checks passed`);
}

async function cmdAdd(args) {
  const { id, version, group, zip, manifest } = args;
  for (const [key, value] of Object.entries({ id, version, group, zip, manifest })) {
    if (!value) fail(`add: missing --${key}`);
  }

  const zipBuffer = await fs.readFile(zip).catch(() => fail(`add: cannot read zip: ${zip}`));
  const names = zipRootEntries(zipBuffer);
  if (!names.includes('module.json')) fail(`add: module.json not at zip root (entries: ${names.slice(0, 5).join(', ')}…)`);
  const manifestOriginal = JSON.parse(await fs.readFile(manifest, 'utf8').catch(() => fail(`add: cannot read manifest: ${manifest}`)));
  if (manifestOriginal.id !== id) fail(`add: manifest id "${manifestOriginal.id}" != --id "${id}"`);
  if (String(manifestOriginal.version) !== String(version)) {
    fail(`add: manifest version "${manifestOriginal.version}" != --version "${version}"`);
  }

  const index = await fetchIndex();
  if (index.packages.some((entry) => entry.id === id && entry.version === version)) {
    fail(`add: ${id}@${version} already in index (paths are immutable; publish a new version instead)`);
  }
  const bytes = zipBuffer.length;
  const sha256 = createHash('sha256').update(zipBuffer).digest('hex');

  const staging = path.join(tmpdir(), `arcane-${id}-${Date.now()}`);
  await fs.mkdir(staging, { recursive: true });
  const zipPath = path.join(staging, `${id}-${version}.zip`);
  const manifestPath = path.join(staging, 'module.json');
  await fs.writeFile(zipPath, zipBuffer);
  await fs.writeFile(manifestPath, `${JSON.stringify(rewriteManifest(manifestOriginal, id, version), null, 2)}\n`, 'utf8');

  await ossUpload(zipPath, `${packageDir(id, version)}/${id}-${version}.zip`);
  await ossUpload(manifestPath, `${packageDir(id, version)}/module.json`);
  await uploadIndex({
    ...index,
    packages: [...index.packages, { id, version, group, bytes, sha256, ...ossUrls(id, version) }],
  });

  console.log(`published ${id}@${version} (${bytes} bytes, sha256 ${sha256})`);
  await verifyAll({ deep: [id] });
  await fs.rm(staging, { recursive: true, force: true });
}

// 把单个 index 条目的 manifest 改写为 OSS 指向。对象键从 entry.manifestUrl 派生,
// 因此 dnd5e 这类系统包(system.json)也能正确回写到原路径。
async function rewriteEntryManifest(entry) {
  const live = await fetchJson(entry.manifestUrl);
  if (live.id !== entry.id || String(live.version) !== String(entry.version)) {
    fail(`${entry.id}@${entry.version}: manifest id/version mismatch before rewrite`);
  }
  if (live.download === entry.zipUrl && live.manifest === entry.manifestUrl) return null;
  const before = { download: live.download ?? null, manifest: live.manifest ?? null };
  const rewritten = { ...live, download: entry.zipUrl, manifest: entry.manifestUrl };
  const objectKey = decodeURIComponent(new URL(entry.manifestUrl).pathname.slice(1));
  const staging = path.join(tmpdir(), `arcane-fix-${entry.id}-${Date.now()}.json`);
  await fs.writeFile(staging, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
  await ossUpload(staging, objectKey);
  await fs.rm(staging, { force: true });
  return { entry, before, download: rewritten.download };
}

async function cmdFixManifest(args) {
  const { id, version } = args;
  if (!id || !version) fail('fix-manifest: missing --id/--version');
  const index = await fetchIndex();
  const entry = index.packages.find((item) => item.id === id && item.version === version);
  if (!entry) fail(`fix-manifest: ${id}@${version} not found in index`);

  const result = await rewriteEntryManifest(entry);
  if (!result) {
    console.log(`${id}@${version}: manifest already OSS-oriented, nothing to do`);
    return;
  }
  console.log(`rewrote ${id}@${version} manifest: ${result.before.download} -> ${result.download}`);
  await verifyAll();
}

async function cmdFixAll() {
  const index = await fetchIndex();
  const originals = [];
  let unchanged = 0;
  for (const entry of index.packages) {
    const result = await rewriteEntryManifest(entry);
    if (!result) {
      unchanged += 1;
      console.log(`skip    ${entry.id}@${entry.version} (already OSS-oriented)`);
      continue;
    }
    originals.push({ id: entry.id, version: entry.version, ...result.before });
    console.log(`rewrote ${entry.id}@${entry.version}: ${result.before.download ?? '(none)'} -> ${result.download}`);
  }
  console.log(`\nmigrated ${originals.length} manifest(s), ${unchanged} already OSS-oriented`);
  if (originals.length) console.log(JSON.stringify(originals));
  await verifyAll();
}

async function cmdRemove(args) {
  const { id, version } = args;
  if (!id || !version) fail('remove: missing --id/--version');

  const index = await fetchIndex();
  const entry = index.packages.find(
    (item) => item.id === id && String(item.version) === String(version),
  );
  if (!entry) fail(`remove: ${id}@${version} not found in index`);

  for (const profile of index.profiles ?? []) {
    let modules = profile.modules;
    if (!modules && profile.profileUrl) {
      const profileJson = await fetchJson(profile.profileUrl);
      modules = profileJson.modules;
    }
    if (Array.isArray(modules) && modules.includes(id) && !args.force) {
      fail(`remove: ${id} is in profile ${profile.id}@${profile.revision} modules (pass --force to override)`);
    }
  }

  await uploadIndex({
    ...index,
    packages: index.packages.filter(
      (item) => !(item.id === id && String(item.version) === String(version)),
    ),
  });
  console.log(`removed ${id}@${version} from index`);
  await verifyAll();

  if (args['delete-objects']) {
    const target = `oss://${BUCKET}/${packageDir(id, version)}/`;
    const bin = await resolveAliyunBin();
    const { stderr } = await execFileAsync(bin, ['oss', 'rm', target, '--recursive', '--force'], { encoding: 'utf8' });
    if (/error|fail/i.test(stderr)) fail(`object deletion failed for ${target}: ${stderr.trim()}`);
    console.log(`deleted ${target}`);
    await verifyAll();
  } else {
    console.log(`note: objects under ${packageDir(id, version)}/ still in bucket (pass --delete-objects to remove)`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'add') return cmdAdd(args);
  if (command === 'remove') return cmdRemove(args);
  if (command === 'fix-manifest') return cmdFixManifest(args);
  if (command === 'fix-all') return cmdFixAll();
  if (command === 'verify') return verifyAll({ deep: [] });
  fail(`unknown command: ${command ?? '(none)'} — expected add | remove | fix-manifest | fix-all | verify`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.stack ?? String(error)));
}
