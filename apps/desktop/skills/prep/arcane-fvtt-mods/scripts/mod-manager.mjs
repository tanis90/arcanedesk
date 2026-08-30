#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { extractArchiveFile } from "../../../../scripts/archive.mjs";

export const MIRROR_INDEX_URL = "https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STAGE_PREFIX = "arcane-fvtt-mod-";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value, label, maxLength = 2048) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function httpsUrl(value, label) {
  const raw = requireString(value, label);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or a fragment`);
  }
  return url.href;
}

function moduleManifestUrl(value, label = "manifest URL") {
  const href = httpsUrl(value, label);
  const url = new URL(href);
  if (path.posix.basename(url.pathname).toLowerCase() !== "module.json") {
    throw new Error(`${label} must point to module.json`);
  }
  return href;
}

function manifestShape(value, { requireDownload = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("module manifest must be an object");
  }
  const id = requireString(value.id, "module manifest id", 128);
  if (!ID_PATTERN.test(id)) throw new Error(`module manifest id is unsafe: ${id}`);
  const version = requireString(value.version, "module manifest version", 128);
  const download = value.download == null
    ? (requireDownload ? httpsUrl(value.download, "module manifest download") : null)
    : httpsUrl(value.download, "module manifest download");
  const declaredManifest = value.manifest == null ? null : moduleManifestUrl(value.manifest, "module manifest self URL");
  return {
    ...value,
    id,
    version,
    title: typeof value.title === "string" && value.title ? value.title : id,
    download,
    manifest: declaredManifest,
  };
}

export function validateModuleManifest(value, manifestUrl) {
  const source = moduleManifestUrl(manifestUrl);
  const manifest = manifestShape(value, { requireDownload: true });
  if (manifest.manifest && manifest.manifest !== source) {
    throw new Error(`module manifest self URL mismatch: expected ${source}; got ${manifest.manifest}`);
  }
  return { ...manifest, manifestUrl: source };
}

function validateIndexEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`mirror index package ${index} must be an object`);
  }
  const id = requireString(value.id, `mirror package ${index} id`, 128);
  if (!ID_PATTERN.test(id)) throw new Error(`mirror package ${index} has an unsafe id: ${id}`);
  const version = requireString(value.version, `mirror package ${index} version`, 128);
  const group = requireString(value.group, `mirror package ${index} group`, 128);
  const bytes = Number(value.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`mirror package ${id} has invalid bytes`);
  }
  const sha256 = requireString(value.sha256, `mirror package ${id} SHA256`, 64).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`mirror package ${id} has invalid SHA256`);
  return {
    ...value,
    id,
    version,
    group,
    bytes,
    sha256,
    zipUrl: httpsUrl(value.zipUrl, `mirror package ${id} ZIP URL`),
    manifestUrl: httpsUrl(value.manifestUrl, `mirror package ${id} manifest URL`),
  };
}

export function validateMirrorIndex(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.packages)) {
    throw new Error("mirror index must be an object with a packages array");
  }
  const packages = value.packages.map(validateIndexEntry);
  const seenManifestUrls = new Set();
  const seenModuleIds = new Set();
  for (const entry of packages) {
    if (seenManifestUrls.has(entry.manifestUrl)) {
      throw new Error(`mirror index repeats manifest URL: ${entry.manifestUrl}`);
    }
    seenManifestUrls.add(entry.manifestUrl);
    if (isModuleIndexEntry(entry)) {
      if (seenModuleIds.has(entry.id)) throw new Error(`mirror index repeats module id: ${entry.id}`);
      seenModuleIds.add(entry.id);
    }
  }
  return {
    ...value,
    generated: typeof value.generated === "string" ? value.generated : null,
    packages,
  };
}

function isModuleIndexEntry(entry) {
  try {
    return entry.group !== "system" && path.posix.basename(new URL(entry.manifestUrl).pathname).toLowerCase() === "module.json";
  } catch {
    return false;
  }
}

async function responseBuffer(response, maxBytes, label) {
  if (!response?.ok) throw new Error(`${label} request failed: HTTP ${response?.status ?? "unknown"}`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  if (!response.body) throw new Error(`${label} response has no body`);
  const chunks = [];
  let bytes = 0;
  const source = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, { cache: "no-store", redirect: "follow" });
  const finalUrl = response.url || url;
  httpsUrl(finalUrl, `${label} final URL`);
  const buffer = await responseBuffer(response, MAX_JSON_BYTES, label);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

async function loadIndex(fetchImpl = fetch, indexUrl = MIRROR_INDEX_URL) {
  const source = httpsUrl(indexUrl, "mirror index URL");
  return validateMirrorIndex(await fetchJson(fetchImpl, source, "mirror index"));
}

async function loadManifest(fetchImpl, manifestUrl) {
  const source = moduleManifestUrl(manifestUrl);
  return validateModuleManifest(await fetchJson(fetchImpl, source, "module manifest"), source);
}

function parseVersion(value) {
  const raw = String(value).trim().replace(/^v(?=\d)/i, "");
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!match) return null;
  return {
    core: match[1].split(".").map((part) => BigInt(part)),
    prerelease: match[2] == null ? null : match[2].split("."),
  };
}

function comparePrerelease(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] == null) return -1;
    if (right[index] == null) return 1;
    const aNumeric = /^\d+$/.test(left[index]);
    const bNumeric = /^\d+$/.test(right[index]);
    if (aNumeric && bNumeric) {
      const a = BigInt(left[index]);
      const b = BigInt(right[index]);
      if (a !== b) return a > b ? 1 : -1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

export function compareVersions(left, right) {
  if (String(left) === String(right)) return 0;
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const length = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.core[index] ?? 0n;
    const bv = b.core[index] ?? 0n;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

async function assertDataDirectory(dataDir) {
  const resolved = path.resolve(requireString(dataDir, "Foundry Data directory"));
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Foundry Data directory does not exist: ${resolved}`);
  const contentRoot = path.join(resolved, "Data");
  const contentStat = await fsp.stat(contentRoot).catch(() => null);
  if (!contentStat?.isDirectory()) throw new Error(`Foundry Data directory is missing Data/: ${resolved}`);
  return { dataDir: resolved, contentRoot, modulesRoot: path.join(contentRoot, "modules") };
}

async function readJsonFile(file, label) {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error(`${label} is not a small JSON file: ${file}`);
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${file}: ${errorMessage(error)}`);
  }
}

export async function listInstalledModules(dataDir) {
  const layout = await assertDataDirectory(dataDir);
  const entries = await fsp.readdir(layout.modulesRoot, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const modules = [];
  const invalid = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(layout.modulesRoot, entry.name);
    const manifestFile = path.join(directory, "module.json");
    try {
      const manifest = manifestShape(await readJsonFile(manifestFile, "installed module manifest"), { requireDownload: false });
      modules.push({
        id: manifest.id,
        title: manifest.title,
        version: manifest.version,
        directory,
        directoryName: entry.name,
        manifest,
      });
    } catch (error) {
      invalid.push({ directory, error: errorMessage(error) });
    }
  }
  return { ...layout, modules, invalid };
}

function versionStatus(localVersion, remoteVersion) {
  const comparison = compareVersions(remoteVersion, localVersion);
  if (comparison == null) return "unknown";
  if (comparison > 0) return "update";
  if (comparison < 0) return "local-newer";
  return "current";
}

export function buildCatalog(indexValue, installedValue) {
  const index = validateMirrorIndex(indexValue);
  const installed = Array.isArray(installedValue?.modules) ? installedValue.modules : [];
  const mirrorModules = index.packages.filter(isModuleIndexEntry);
  const byId = new Map(mirrorModules.map((entry) => [entry.id, entry]));
  const rows = [];
  const notInMirror = [];
  for (const local of installed) {
    const remote = byId.get(local.id);
    if (!remote) {
      notInMirror.push({ id: local.id, title: local.title, version: local.version, directory: local.directory });
      continue;
    }
    rows.push({
      id: local.id,
      title: local.title,
      localVersion: local.version,
      mirrorVersion: remote.version,
      status: versionStatus(local.version, remote.version),
      bytes: remote.bytes,
      sha256: remote.sha256,
      manifestUrl: remote.manifestUrl,
      downloadUrl: remote.zipUrl,
      directory: local.directory,
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  notInMirror.sort((a, b) => a.id.localeCompare(b.id));
  return {
    indexUrl: MIRROR_INDEX_URL,
    generated: index.generated,
    foundry: index.foundry ?? null,
    dnd5e: index.dnd5e ?? null,
    rows,
    updates: rows.filter((row) => row.status === "update"),
    notInMirror,
    invalidLocal: Array.isArray(installedValue?.invalid) ? installedValue.invalid : [],
  };
}

export async function catalogModules({ dataDir, fetchImpl = fetch, indexUrl = MIRROR_INDEX_URL }) {
  const [index, installed] = await Promise.all([
    loadIndex(fetchImpl, indexUrl),
    listInstalledModules(dataDir),
  ]);
  return buildCatalog(index, installed);
}

function requiredModuleRows(manifest, installedModules) {
  const requires = Array.isArray(manifest.relationships?.requires) ? manifest.relationships.requires : [];
  return requires
    .filter((entry) => entry?.type === "module" && typeof entry.id === "string" && ID_PATTERN.test(entry.id))
    .map((entry) => {
      const matches = installedModules.filter((local) => local.id === entry.id);
      const minimum = typeof entry.compatibility?.minimum === "string" ? entry.compatibility.minimum : null;
      const localVersion = matches.length === 1 ? matches[0].version : null;
      let status = matches.length === 0 ? "missing" : matches.length > 1 ? "duplicate" : "installed";
      if (status === "installed" && minimum) {
        const comparison = compareVersions(localVersion, minimum);
        if (comparison == null) status = "unknown";
        else if (comparison < 0) status = "version-too-low";
      }
      return { id: entry.id, minimum, installedVersion: localVersion, status };
    });
}

function exactMirrorEntry(index, manifestUrl) {
  return index?.packages?.find((entry) => isModuleIndexEntry(entry) && entry.manifestUrl === manifestUrl) ?? null;
}

export async function inspectModule({ manifestUrl, dataDir, fetchImpl = fetch, indexUrl = MIRROR_INDEX_URL }) {
  const [manifest, installed] = await Promise.all([
    loadManifest(fetchImpl, manifestUrl),
    listInstalledModules(dataDir),
  ]);
  let index = null;
  let indexError = null;
  try {
    index = await loadIndex(fetchImpl, indexUrl);
  } catch (error) {
    indexError = errorMessage(error);
  }
  const mirror = exactMirrorEntry(index, manifest.manifestUrl);
  if (mirror && (mirror.id !== manifest.id || mirror.version !== manifest.version || mirror.zipUrl !== manifest.download)) {
    throw new Error(`mirror index metadata does not match manifest ${manifest.id}`);
  }
  const localMatches = installed.modules.filter((entry) => entry.id === manifest.id);
  return {
    kind: "module",
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    manifestUrl: manifest.manifestUrl,
    downloadUrl: manifest.download,
    compatibility: manifest.compatibility ?? null,
    local: localMatches.length === 1
      ? { version: localMatches[0].version, directory: localMatches[0].directory }
      : null,
    localConflict: localMatches.length > 1
      ? localMatches.map((entry) => ({ version: entry.version, directory: entry.directory }))
      : null,
    requiredModules: requiredModuleRows(manifest, installed.modules),
    mirror: mirror
      ? { generated: index.generated, bytes: mirror.bytes, sha256: mirror.sha256, group: mirror.group }
      : null,
    integrity: mirror ? "mirror-index-sha256" : "no-publisher-hash",
    indexError,
  };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function downloadArchive(fetchImpl, url, file) {
  const sourceUrl = httpsUrl(url, "module download URL");
  const response = await fetchImpl(sourceUrl, { cache: "no-store", redirect: "follow" });
  if (!response?.ok) throw new Error(`module ZIP request failed: HTTP ${response?.status ?? "unknown"}`);
  const finalUrl = httpsUrl(response.url || sourceUrl, "module ZIP final URL");
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && (declared < 0 || declared > MAX_ARCHIVE_BYTES)) {
    throw new Error(`module ZIP exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  if (!response.body) throw new Error("module ZIP response has no body");
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(new Error(`module ZIP exceeds ${MAX_ARCHIVE_BYTES} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = typeof response.body.getReader === "function" ? Readable.fromWeb(response.body) : response.body;
  try {
    await pipeline(source, meter, fs.createWriteStream(file, { flags: "wx" }));
  } catch (error) {
    await fsp.rm(file, { force: true }).catch(() => {});
    throw error;
  }
  return { finalUrl, bytes, sha256: hash.digest("hex") };
}

async function findModulePayload(extractedRoot) {
  const candidates = [];
  const rootManifest = path.join(extractedRoot, "module.json");
  if ((await fsp.stat(rootManifest).catch(() => null))?.isFile()) candidates.push(extractedRoot);
  const top = await fsp.readdir(extractedRoot, { withFileTypes: true });
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractedRoot, entry.name, "module.json");
    if ((await fsp.stat(candidate).catch(() => null))?.isFile()) candidates.push(path.join(extractedRoot, entry.name));
  }
  if (candidates.length !== 1) {
    throw new Error(`module ZIP must contain exactly one root or single-directory module.json; found ${candidates.length}`);
  }
  const payload = candidates[0];
  if (payload !== extractedRoot) {
    const siblings = top.filter((entry) => path.join(extractedRoot, entry.name) !== payload);
    if (siblings.length > 0) throw new Error("module ZIP has content outside its single module directory");
  }
  return payload;
}

function assertExpected(actual, expected, label) {
  if (expected == null || expected === "") throw new Error(`${label} is required`);
  if (actual !== expected) throw new Error(`${label} changed: expected ${expected}; got ${actual}`);
}

export async function stageModule({
  manifestUrl,
  expectedId,
  expectedVersion,
  expectedDownloadUrl,
  fetchImpl = fetch,
  indexUrl = MIRROR_INDEX_URL,
  tempRoot = os.tmpdir(),
  archiveExtractor = extractArchiveFile,
}) {
  const manifest = await loadManifest(fetchImpl, manifestUrl);
  assertExpected(manifest.id, expectedId, "module id");
  assertExpected(manifest.version, expectedVersion, "module version");
  assertExpected(manifest.download, httpsUrl(expectedDownloadUrl, "expected download URL"), "module download URL");

  let index = null;
  let indexError = null;
  try {
    index = await loadIndex(fetchImpl, indexUrl);
  } catch (error) {
    indexError = errorMessage(error);
  }
  const mirror = exactMirrorEntry(index, manifest.manifestUrl);
  if (mirror && (mirror.id !== manifest.id || mirror.version !== manifest.version || mirror.zipUrl !== manifest.download)) {
    throw new Error(`mirror index metadata does not match manifest ${manifest.id}`);
  }

  await fsp.mkdir(path.resolve(tempRoot), { recursive: true });
  const stageDir = await fsp.mkdtemp(path.join(path.resolve(tempRoot), STAGE_PREFIX));
  const archive = path.join(stageDir, "package.zip");
  const extracted = path.join(stageDir, "extracted");
  try {
    const download = await downloadArchive(fetchImpl, manifest.download, archive);
    if (mirror) {
      if (download.bytes !== mirror.bytes) {
        throw new Error(`module ZIP byte length mismatch: expected ${mirror.bytes}; got ${download.bytes}`);
      }
      if (download.sha256 !== mirror.sha256) {
        throw new Error(`module ZIP SHA256 mismatch: expected ${mirror.sha256}; got ${download.sha256}`);
      }
    }
    await archiveExtractor(archive, extracted);
    const payloadRoot = await findModulePayload(extracted);
    const archived = manifestShape(await readJsonFile(path.join(payloadRoot, "module.json"), "archive module manifest"), {
      requireDownload: false,
    });
    assertExpected(archived.id, manifest.id, "archive module id");
    assertExpected(archived.version, manifest.version, "archive module version");
    if (archived.download) assertExpected(archived.download, manifest.download, "archive module download URL");
    if (archived.manifest && archived.manifest !== manifest.manifestUrl) {
      throw new Error(`archive module manifest URL mismatch: expected ${manifest.manifestUrl}; got ${archived.manifest}`);
    }
    const record = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      id: manifest.id,
      title: manifest.title,
      version: manifest.version,
      manifestUrl: manifest.manifestUrl,
      downloadUrl: manifest.download,
      finalDownloadUrl: download.finalUrl,
      archive: "package.zip",
      payload: path.relative(stageDir, payloadRoot),
      archiveBytes: download.bytes,
      archiveSha256: download.sha256,
      trustedByMirrorIndex: Boolean(mirror),
      mirrorGenerated: mirror ? index.generated : null,
      indexError,
    };
    await fsp.writeFile(path.join(stageDir, "stage.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return {
      ...record,
      stageDir,
      requiresSecondConfirmation: !record.trustedByMirrorIndex,
    };
  } catch (error) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function isDescendant(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function validatedStageDirectory(stageDir) {
  const realTemp = await fsp.realpath(os.tmpdir());
  const realStage = await fsp.realpath(path.resolve(requireString(stageDir, "stage directory")));
  if (!isDescendant(realTemp, realStage) || !path.basename(realStage).startsWith(STAGE_PREFIX)) {
    throw new Error(`stage directory is outside the Arcane temp area: ${realStage}`);
  }
  return realStage;
}

function safeBackupPart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "unknown";
}

async function exists(file) {
  return Boolean(await fsp.lstat(file).catch(() => null));
}

export async function commitStage({ stageDir, dataDir, expectedCurrentVersion, acceptSha256 = null }) {
  const stage = await validatedStageDirectory(stageDir);
  const record = await readJsonFile(path.join(stage, "stage.json"), "Arcane module stage record");
  if (record?.schemaVersion !== 1 || !ID_PATTERN.test(String(record.id ?? ""))) {
    throw new Error("Arcane module stage record is invalid");
  }
  const archive = path.resolve(stage, requireString(record.archive, "stage archive path", 128));
  const payload = path.resolve(stage, requireString(record.payload, "stage payload path", 512));
  if (!isDescendant(stage, archive) || !isDescendant(stage, payload)) {
    throw new Error("Arcane module stage record escapes its staging directory");
  }
  const actualArchive = await sha256File(archive);
  if (actualArchive.sha256 !== record.archiveSha256 || actualArchive.bytes !== record.archiveBytes) {
    throw new Error("staged module ZIP changed after verification");
  }
  if (!record.trustedByMirrorIndex) {
    const accepted = String(acceptSha256 ?? "").toLowerCase();
    if (accepted !== record.archiveSha256) {
      throw new Error(`unindexed module requires --accept-sha256 ${record.archiveSha256}`);
    }
  }
  const stagedManifest = manifestShape(await readJsonFile(path.join(payload, "module.json"), "staged module manifest"), {
    requireDownload: false,
  });
  assertExpected(stagedManifest.id, record.id, "staged module id");
  assertExpected(stagedManifest.version, record.version, "staged module version");
  if (stagedManifest.download) assertExpected(stagedManifest.download, record.downloadUrl, "staged module download URL");

  const installed = await listInstalledModules(dataDir);
  const matches = installed.modules.filter((entry) => entry.id === record.id);
  if (matches.length > 1) throw new Error(`multiple installed directories claim module id ${record.id}`);
  const current = matches[0] ?? null;
  const expected = requireString(expectedCurrentVersion, "expected current version", 128);
  if (expected === "none") {
    if (current) throw new Error(`module ${record.id} appeared after inspection at version ${current.version}`);
  } else if (!current || current.version !== expected) {
    throw new Error(`module ${record.id} current version changed: expected ${expected}; got ${current?.version ?? "none"}`);
  }

  await fsp.mkdir(installed.modulesRoot, { recursive: true });
  const target = current?.directory ?? path.join(installed.modulesRoot, record.id);
  if (!current && await exists(target)) {
    throw new Error(`target exists but is not a valid matching module: ${target}`);
  }
  const token = randomUUID();
  const incoming = path.join(installed.modulesRoot, `.${record.id}.arcane-incoming-${token}`);
  let backup = null;
  await fsp.cp(payload, incoming, { recursive: true, force: false, errorOnExist: true });
  const copiedManifest = manifestShape(await readJsonFile(path.join(incoming, "module.json"), "incoming module manifest"), {
    requireDownload: false,
  });
  assertExpected(copiedManifest.id, record.id, "incoming module id");
  assertExpected(copiedManifest.version, record.version, "incoming module version");

  try {
    if (current) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupParent = path.join(installed.contentRoot, ".arcane-mod-backups", "modules", record.id);
      await fsp.mkdir(backupParent, { recursive: true });
      backup = path.join(backupParent, `${stamp}-${safeBackupPart(current.version)}-${token.slice(0, 8)}`);
      await fsp.rename(target, backup);
    }
    await fsp.rename(incoming, target);
  } catch (error) {
    if (backup && !await exists(target) && await exists(backup)) {
      await fsp.rename(backup, target).catch(() => {});
    }
    await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    throw new Error(`could not activate module ${record.id}: ${errorMessage(error)}`);
  }

  const activated = manifestShape(await readJsonFile(path.join(target, "module.json"), "activated module manifest"), {
    requireDownload: false,
  });
  if (activated.id !== record.id || activated.version !== record.version) {
    throw new Error(`activated module verification failed for ${record.id}`);
  }
  await fsp.rm(stage, { recursive: true, force: true });
  return {
    id: record.id,
    title: record.title,
    previousVersion: current?.version ?? null,
    version: record.version,
    target,
    backup,
    archiveSha256: record.archiveSha256,
    archiveBytes: record.archiveBytes,
    trustedByMirrorIndex: Boolean(record.trustedByMirrorIndex),
    installed: true,
    worldEnabled: false,
  };
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    if (Object.hasOwn(options, key)) throw new Error(`duplicate option: --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function usage() {
  return [
    "Usage:",
    "  mod-manager inspect --manifest-url <url> --data-dir <dir>",
    "  mod-manager catalog --data-dir <dir>",
    "  mod-manager stage --manifest-url <url> --expected-id <id> --expected-version <version> --expected-download-url <url>",
    "  mod-manager commit --stage-dir <dir> --data-dir <dir> --expected-current-version <version|none> [--accept-sha256 <sha256>]",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  switch (command) {
    case "inspect":
      return inspectModule({
        manifestUrl: options["manifest-url"],
        dataDir: options["data-dir"],
      });
    case "catalog":
      return catalogModules({ dataDir: options["data-dir"] });
    case "stage":
      return stageModule({
        manifestUrl: options["manifest-url"],
        expectedId: options["expected-id"],
        expectedVersion: options["expected-version"],
        expectedDownloadUrl: options["expected-download-url"],
      });
    case "commit":
      return commitStage({
        stageDir: options["stage-dir"],
        dataDir: options["data-dir"],
        expectedCurrentVersion: options["expected-current-version"],
        acceptSha256: options["accept-sha256"] ?? null,
      });
    case "help":
    case "--help":
    case "-h":
      return { usage: usage() };
    default:
      throw new Error(`${command ? `unknown command: ${command}` : "command is required"}\n${usage()}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runCli()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`ERROR: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
