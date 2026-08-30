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
const WORLD_STAGE_PREFIX = "arcane-fvtt-world-";
const MAX_PROFILE_PACKAGES = 256;

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

function validateWorldIndexEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`mirror index world ${index} must be an object`);
  }
  const id = requireString(value.id, `mirror world ${index} id`, 128);
  if (!ID_PATTERN.test(id)) throw new Error(`mirror world ${index} has an unsafe id: ${id}`);
  const version = requireString(value.version, `mirror world ${id} version`, 128);
  const manifestBytes = Number(value.manifestBytes);
  if (!Number.isSafeInteger(manifestBytes) || manifestBytes < 1 || manifestBytes > MAX_JSON_BYTES) {
    throw new Error(`mirror world ${id} has invalid manifestBytes`);
  }
  const manifestSha256 = requireString(value.manifestSha256, `mirror world ${id} manifest SHA256`, 64).toLowerCase();
  if (!SHA256_PATTERN.test(manifestSha256)) throw new Error(`mirror world ${id} has invalid manifest SHA256`);
  const bytes = Number(value.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`mirror world ${id} has invalid bytes`);
  }
  const sha256 = requireString(value.sha256, `mirror world ${id} ZIP SHA256`, 64).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`mirror world ${id} has invalid ZIP SHA256`);
  const defaultProfile = requireString(value.defaultProfile, `mirror world ${id} defaultProfile`, 128);
  if (!ID_PATTERN.test(defaultProfile)) throw new Error(`mirror world ${id} has an unsafe defaultProfile`);
  return {
    ...value,
    kind: "world",
    id,
    title: typeof value.title === "string" && value.title ? value.title : id,
    version,
    manifestUrl: contentManifestUrl(value.manifestUrl, "world", `mirror world ${id} manifest URL`),
    manifestBytes,
    manifestSha256,
    downloadUrl: httpsUrl(value.downloadUrl, `mirror world ${id} download URL`),
    bytes,
    sha256,
    defaultProfile,
  };
}

function validateProfileIndexEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`mirror index profile ${index} must be an object`);
  }
  const id = requireString(value.id, `mirror profile ${index} id`, 128);
  if (!ID_PATTERN.test(id)) throw new Error(`mirror profile ${index} has an unsafe id: ${id}`);
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`mirror profile ${id} has invalid revision`);
  const profileBytes = Number(value.profileBytes);
  if (!Number.isSafeInteger(profileBytes) || profileBytes < 1 || profileBytes > MAX_JSON_BYTES) {
    throw new Error(`mirror profile ${id} has invalid profileBytes`);
  }
  const profileSha256 = requireString(value.profileSha256, `mirror profile ${id} SHA256`, 64).toLowerCase();
  if (!SHA256_PATTERN.test(profileSha256)) throw new Error(`mirror profile ${id} has invalid SHA256`);
  return {
    ...value,
    id,
    revision,
    profileUrl: httpsUrl(value.profileUrl, `mirror profile ${id} URL`),
    profileBytes,
    profileSha256,
  };
}

function contentManifestUrl(value, kind, label) {
  const href = httpsUrl(value, label);
  const expected = kind === "module" ? "module.json" : kind === "system" ? "system.json" : "world.json";
  if (path.posix.basename(new URL(href).pathname).toLowerCase() !== expected) {
    throw new Error(`${label} must point to ${expected}`);
  }
  return href;
}

export function validateEnvironmentProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("environment profile must be an object");
  }
  if (value.schemaVersion !== 1 || value.kind !== "foundry-environment-profile") {
    throw new Error("environment profile must use foundry-environment-profile schemaVersion 1");
  }
  const id = requireString(value.id, "environment profile id", 128);
  if (!ID_PATTERN.test(id)) throw new Error(`environment profile has an unsafe id: ${id}`);
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("environment profile has invalid revision");
  const system = requireString(value.system, "environment profile system", 128);
  if (!ID_PATTERN.test(system)) throw new Error(`environment profile has an unsafe system id: ${system}`);
  if (value.packageChannel !== "stable") throw new Error("environment profile packageChannel must be stable");
  if (!Array.isArray(value.modules) || value.modules.length > MAX_PROFILE_PACKAGES) {
    throw new Error(`environment profile modules must be an array of at most ${MAX_PROFILE_PACKAGES} ids`);
  }
  const modules = value.modules.map((entry, index) => {
    const moduleId = requireString(entry, `environment profile module ${index}`, 128);
    if (!ID_PATTERN.test(moduleId)) throw new Error(`environment profile has an unsafe module id: ${moduleId}`);
    return moduleId;
  });
  const seenModuleIds = new Set();
  for (const moduleId of modules) {
    if (seenModuleIds.has(moduleId)) throw new Error(`environment profile repeats module id: ${moduleId}`);
    seenModuleIds.add(moduleId);
  }
  return {
    ...value,
    id,
    title: typeof value.title === "string" && value.title ? value.title : id,
    revision,
    packageChannel: "stable",
    system,
    modules,
  };
}

export function validateMirrorIndex(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.packages)) {
    throw new Error("mirror index must be an object with a packages array");
  }
  const packages = value.packages.map(validateIndexEntry);
  if (value.worlds != null && !Array.isArray(value.worlds)) {
    throw new Error("mirror index worlds must be an array when present");
  }
  if (value.profiles != null && !Array.isArray(value.profiles)) {
    throw new Error("mirror index profiles must be an array when present");
  }
  const worlds = (value.worlds ?? []).map(validateWorldIndexEntry);
  const profiles = (value.profiles ?? []).map(validateProfileIndexEntry);
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
  const seenWorldIds = new Set();
  const seenWorldManifestUrls = new Set();
  for (const entry of worlds) {
    if (seenWorldIds.has(entry.id)) throw new Error(`mirror index repeats world id: ${entry.id}`);
    if (seenWorldManifestUrls.has(entry.manifestUrl)) throw new Error(`mirror index repeats world manifest URL: ${entry.manifestUrl}`);
    seenWorldIds.add(entry.id);
    seenWorldManifestUrls.add(entry.manifestUrl);
  }
  const seenProfileIds = new Set();
  const seenProfileUrls = new Set();
  for (const entry of profiles) {
    if (seenProfileIds.has(entry.id)) throw new Error(`mirror index repeats profile id: ${entry.id}`);
    if (seenProfileUrls.has(entry.profileUrl)) throw new Error(`mirror index repeats profile URL: ${entry.profileUrl}`);
    seenProfileIds.add(entry.id);
    seenProfileUrls.add(entry.profileUrl);
  }
  for (const world of worlds) {
    if (!seenProfileIds.has(world.defaultProfile)) {
      throw new Error(`mirror world ${world.id} references missing profile ${world.defaultProfile}`);
    }
  }
  return {
    ...value,
    generated: typeof value.generated === "string" ? value.generated : null,
    packages,
    worlds,
    profiles,
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

async function fetchJsonDocument(fetchImpl, url, label) {
  const response = await fetchImpl(url, { cache: "no-store", redirect: "follow" });
  const finalUrl = httpsUrl(response.url || url, `${label} final URL`);
  const buffer = await responseBuffer(response, MAX_JSON_BYTES, label);
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  return {
    value,
    buffer,
    finalUrl,
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

async function loadIndex(fetchImpl = fetch, indexUrl = MIRROR_INDEX_URL) {
  const source = httpsUrl(indexUrl, "mirror index URL");
  return validateMirrorIndex(await fetchJson(fetchImpl, source, "mirror index"));
}

async function loadManifest(fetchImpl, manifestUrl) {
  return (await loadManifestDocument(fetchImpl, manifestUrl)).manifest;
}

async function loadManifestDocument(fetchImpl, manifestUrl) {
  const source = moduleManifestUrl(manifestUrl);
  const document = await fetchJsonDocument(fetchImpl, source, "module manifest");
  return {
    manifest: validateModuleManifest(document.value, source),
    document,
  };
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
  return {
    dataDir: resolved,
    contentRoot,
    modulesRoot: path.join(contentRoot, "modules"),
    systemsRoot: path.join(contentRoot, "systems"),
    worldsRoot: path.join(contentRoot, "worlds"),
  };
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

function installedContentManifestShape(value, kind) {
  if (kind === "module") return manifestShape(value, { requireDownload: false });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${kind} manifest must be an object`);
  }
  const id = requireString(value.id, `${kind} manifest id`, 128);
  if (!ID_PATTERN.test(id)) throw new Error(`${kind} manifest id is unsafe: ${id}`);
  const version = requireString(value.version, `${kind} manifest version`, 128);
  const download = value.download == null ? null : httpsUrl(value.download, `${kind} manifest download`);
  const declaredManifest = value.manifest == null
    ? null
    : contentManifestUrl(value.manifest, kind, `${kind} manifest self URL`);
  return {
    ...value,
    id,
    version,
    title: typeof value.title === "string" && value.title ? value.title : id,
    download,
    manifest: declaredManifest,
  };
}

async function listInstalledContent(dataDir, kind) {
  const layout = await assertDataDirectory(dataDir);
  const root = kind === "system" ? layout.systemsRoot : kind === "world" ? layout.worldsRoot : layout.modulesRoot;
  const fileName = kind === "system" ? "system.json" : kind === "world" ? "world.json" : "module.json";
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const items = [];
  const invalid = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try {
      const manifest = installedContentManifestShape(
        await readJsonFile(path.join(directory, fileName), `installed ${kind} manifest`),
        kind,
      );
      items.push({
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
  return { ...layout, items, invalid };
}

export async function listInstalledSystems(dataDir) {
  const result = await listInstalledContent(dataDir, "system");
  return { ...result, systems: result.items };
}

export async function listInstalledWorlds(dataDir) {
  const result = await listInstalledContent(dataDir, "world");
  return { ...result, worlds: result.items };
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

function exactWorldIndexEntry(index, worldId) {
  return index?.worlds?.find((entry) => entry.id === worldId) ?? null;
}

function exactProfileIndexEntry(index, profileId) {
  return index?.profiles?.find((entry) => entry.id === profileId) ?? null;
}

async function loadEnvironmentProfile(fetchImpl, entry) {
  const document = await fetchJsonDocument(fetchImpl, entry.profileUrl, `environment profile ${entry.id}`);
  if (document.bytes !== entry.profileBytes) {
    throw new Error(`environment profile byte length mismatch: expected ${entry.profileBytes}; got ${document.bytes}`);
  }
  if (document.sha256 !== entry.profileSha256) {
    throw new Error(`environment profile SHA256 mismatch: expected ${entry.profileSha256}; got ${document.sha256}`);
  }
  const profile = validateEnvironmentProfile(document.value);
  if (profile.id !== entry.id || profile.revision !== entry.revision) {
    throw new Error(`profile index identity does not match profile: ${entry.id}@${entry.revision}`);
  }
  return { profile, document };
}

async function loadWorldManifestForEntry(fetchImpl, entry) {
  const document = await fetchJsonDocument(fetchImpl, entry.manifestUrl, `world manifest ${entry.id}`);
  if (document.bytes !== entry.manifestBytes) {
    throw new Error(`world manifest byte length mismatch: expected ${entry.manifestBytes}; got ${document.bytes}`);
  }
  if (document.sha256 !== entry.manifestSha256) {
    throw new Error(`world manifest SHA256 mismatch: expected ${entry.manifestSha256}; got ${document.sha256}`);
  }
  const manifest = installedContentManifestShape(document.value, "world");
  assertExpected(manifest.id, entry.id, "world manifest id");
  assertExpected(manifest.version, entry.version, "world manifest version");
  if (manifest.manifest) assertExpected(manifest.manifest, entry.manifestUrl, "world manifest self URL");
  if (manifest.download) assertExpected(manifest.download, entry.downloadUrl, "world manifest download URL");
  return { manifest, document };
}

function isSystemIndexEntry(entry) {
  try {
    return entry.group === "system" && path.posix.basename(new URL(entry.manifestUrl).pathname).toLowerCase() === "system.json";
  } catch {
    return false;
  }
}

function exactCurrentPackage(index, id, kind) {
  const matches = index.packages.filter((entry) => entry.id === id && (
    kind === "system" ? isSystemIndexEntry(entry) : isModuleIndexEntry(entry)
  ));
  if (matches.length !== 1) throw new Error(`stable package index does not contain exactly one ${kind} ${id}`);
  return matches[0];
}

async function resolvedPackageArtifact(fetchImpl, entry, kind) {
  const document = await fetchJsonDocument(fetchImpl, entry.manifestUrl, `${kind} manifest ${entry.id}`);
  const manifest = installedContentManifestShape(document.value, kind);
  assertExpected(manifest.id, entry.id, `${kind} manifest id`);
  assertExpected(manifest.version, entry.version, `${kind} manifest version`);
  if (manifest.manifest) assertExpected(manifest.manifest, entry.manifestUrl, `${kind} manifest self URL`);
  if (manifest.download) assertExpected(manifest.download, entry.zipUrl, `${kind} manifest download URL`);
  return {
    kind,
    id: entry.id,
    title: manifest.title,
    version: entry.version,
    manifestUrl: entry.manifestUrl,
    manifestBytes: document.bytes,
    manifestSha256: document.sha256,
    downloadUrl: entry.zipUrl,
    bytes: entry.bytes,
    sha256: entry.sha256,
    compatibility: manifest.compatibility ?? null,
    relationships: manifest.relationships ?? null,
  };
}

function assertDependencyCompatibility(version, compatibility, label) {
  if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)) return;
  for (const [field, direction] of [["minimum", 1], ["maximum", -1]]) {
    if (compatibility[field] == null) continue;
    const required = requireString(compatibility[field], `${label} ${field} version`, 128);
    const comparison = compareVersions(version, required);
    if (comparison == null) throw new Error(`${label} has an uncomparable ${field} version ${required}`);
    if ((direction === 1 && comparison < 0) || (direction === -1 && comparison > 0)) {
      throw new Error(`${label} resolved ${version}, outside ${field} ${required}`);
    }
  }
}

async function resolveStableProfilePackages(fetchImpl, index, profile) {
  const queue = [
    { id: profile.system, kind: "system", source: "profile" },
    ...profile.modules.map((id) => ({ id, kind: "module", source: "profile" })),
  ];
  const resolved = [];
  const seen = new Map();
  while (queue.length > 0) {
    if (resolved.length > MAX_PROFILE_PACKAGES) {
      throw new Error(`resolved profile exceeds ${MAX_PROFILE_PACKAGES} packages`);
    }
    const requested = queue.shift();
    const existing = seen.get(requested.id);
    if (existing) {
      if (existing.kind !== requested.kind) throw new Error(`package ${requested.id} is required as both ${existing.kind} and ${requested.kind}`);
      assertDependencyCompatibility(existing.version, requested.compatibility, `${requested.source} dependency ${requested.id}`);
      continue;
    }
    const artifact = await resolvedPackageArtifact(
      fetchImpl,
      exactCurrentPackage(index, requested.id, requested.kind),
      requested.kind,
    );
    assertDependencyCompatibility(artifact.version, requested.compatibility, `${requested.source} dependency ${requested.id}`);
    seen.set(requested.id, artifact);
    resolved.push({ ...artifact, resolutionSource: requested.source });
    const requires = Array.isArray(artifact.relationships?.requires) ? artifact.relationships.requires : [];
    for (const dependency of requires) {
      if (!dependency || !["module", "system"].includes(dependency.type)) continue;
      if (typeof dependency.id !== "string" || !ID_PATTERN.test(dependency.id)) {
        throw new Error(`${artifact.id} declares an unsafe required package id`);
      }
      queue.push({
        id: dependency.id,
        kind: dependency.type,
        source: `required-by:${artifact.id}`,
        compatibility: dependency.compatibility ?? null,
      });
    }
  }
  return {
    system: resolved.find((artifact) => artifact.kind === "system") ?? null,
    modules: resolved.filter((artifact) => artifact.kind === "module"),
  };
}

function localContentMatch(installed, artifact) {
  const matches = installed.filter((entry) => entry.id === artifact.id);
  if (matches.length > 1) {
    return {
      status: "duplicate",
      installedVersion: null,
      directory: null,
      conflicts: matches.map((entry) => ({ version: entry.version, directory: entry.directory })),
    };
  }
  const local = matches[0] ?? null;
  if (!local) return { status: "missing", installedVersion: null, directory: null, conflicts: null };
  const comparison = compareVersions(artifact.version, local.version);
  const status = comparison == null
    ? "unknown"
    : comparison > 0
      ? "upgrade"
      : comparison < 0
        ? "downgrade"
        : "current";
  return { status, installedVersion: local.version, directory: local.directory, conflicts: null };
}

function dependencyRow(artifact, installed) {
  const local = localContentMatch(installed, artifact);
  return {
    kind: artifact.kind,
    id: artifact.id,
    title: artifact.title,
    version: artifact.version,
    requiredVersion: artifact.version,
    ...local,
    status: local.status === "downgrade" ? "local-newer" : local.status,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    manifestUrl: artifact.manifestUrl,
    manifestBytes: artifact.manifestBytes,
    manifestSha256: artifact.manifestSha256,
    downloadUrl: artifact.downloadUrl,
    compatibility: artifact.compatibility ?? null,
    resolutionSource: artifact.resolutionSource ?? null,
  };
}

function resolutionArtifact(artifact) {
  return {
    kind: artifact.kind,
    id: artifact.id,
    version: artifact.version,
    manifestUrl: artifact.manifestUrl,
    manifestBytes: artifact.manifestBytes,
    manifestSha256: artifact.manifestSha256,
    downloadUrl: artifact.downloadUrl,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    resolutionSource: artifact.resolutionSource ?? null,
  };
}

function worldResolutionSha256({ generated, profile, world, system, modules }) {
  const canonical = {
    generated,
    profile: {
      id: profile.id,
      revision: profile.revision,
      profileUrl: profile.profileUrl,
      profileBytes: profile.profileBytes,
      profileSha256: profile.profileSha256,
      packageChannel: profile.packageChannel,
      system: profile.system,
      modules: profile.modules,
    },
    world: resolutionArtifact(world),
    packages: [system, ...modules].map(resolutionArtifact),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function buildWorldCatalog(indexValue, installedValue) {
  const index = validateMirrorIndex(indexValue);
  const installed = Array.isArray(installedValue?.worlds) ? installedValue.worlds : [];
  const rows = index.worlds.map((entry) => {
    const matches = installed.filter((local) => local.id === entry.id);
    const local = matches.length === 1 ? matches[0] : null;
    return {
      id: entry.id,
      title: entry.title,
      localVersion: local?.version ?? null,
      mirrorVersion: entry.version,
      status: matches.length > 1 ? "duplicate" : local ? versionStatus(local.version, entry.version) : "missing",
      manifestUrl: entry.manifestUrl,
      downloadUrl: entry.downloadUrl,
      bytes: entry.bytes,
      sha256: entry.sha256,
      defaultProfile: entry.defaultProfile,
      directory: local?.directory ?? null,
      localConflict: matches.length > 1
        ? matches.map((match) => ({ version: match.version, directory: match.directory }))
        : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const publishedIds = new Set(index.worlds.map((entry) => entry.id));
  const notInMirror = installed
    .filter((entry) => !publishedIds.has(entry.id))
    .map((entry) => ({ id: entry.id, title: entry.title, version: entry.version, directory: entry.directory }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    indexUrl: MIRROR_INDEX_URL,
    generated: index.generated,
    rows,
    updates: rows.filter((row) => row.status === "update"),
    notInMirror,
    invalidLocal: Array.isArray(installedValue?.invalid) ? installedValue.invalid : [],
  };
}

export async function catalogWorlds({ dataDir, fetchImpl = fetch, indexUrl = MIRROR_INDEX_URL }) {
  const [index, installed] = await Promise.all([
    loadIndex(fetchImpl, indexUrl),
    listInstalledWorlds(dataDir),
  ]);
  return buildWorldCatalog(index, installed);
}

export async function inspectWorldEnvironment({ worldId, dataDir, fetchImpl = fetch, indexUrl = MIRROR_INDEX_URL }) {
  const id = requireString(worldId, "world id", 128);
  if (!ID_PATTERN.test(id)) throw new Error(`world id is unsafe: ${id}`);
  const index = await loadIndex(fetchImpl, indexUrl);
  const entry = exactWorldIndexEntry(index, id);
  if (!entry) throw new Error(`world ${id} is not published in the mirror index`);
  const profileEntry = exactProfileIndexEntry(index, entry.defaultProfile);
  if (!profileEntry) throw new Error(`world ${id} references unpublished profile ${entry.defaultProfile}`);
  const [{ manifest: worldManifest }, { profile }, installedModules, installedSystems, installedWorlds] = await Promise.all([
    loadWorldManifestForEntry(fetchImpl, entry),
    loadEnvironmentProfile(fetchImpl, profileEntry),
    listInstalledModules(dataDir),
    listInstalledSystems(dataDir),
    listInstalledWorlds(dataDir),
  ]);
  if (worldManifest.system !== profile.system) {
    throw new Error(`world ${id} uses system ${worldManifest.system}; profile requires ${profile.system}`);
  }
  const resolved = await resolveStableProfilePackages(fetchImpl, index, profile);
  const system = dependencyRow(resolved.system, installedSystems.systems);
  const modules = resolved.modules.map((artifact) => dependencyRow(artifact, installedModules.modules));
  const world = dependencyRow(entry, installedWorlds.worlds);
  const artifacts = [system, ...modules, world];
  const actionable = artifacts.filter((artifact) => ["missing", "upgrade"].includes(artifact.status));
  const profilePlan = {
    id: profile.id,
    title: profile.title,
    revision: profile.revision,
    packageChannel: profile.packageChannel,
    system: profile.system,
    modules: profile.modules,
    profileUrl: profileEntry.profileUrl,
    profileBytes: profileEntry.profileBytes,
    profileSha256: profileEntry.profileSha256,
  };
  return {
    kind: "world-profile-plan",
    indexUrl,
    generated: index.generated,
    id: entry.id,
    title: entry.title,
    version: entry.version,
    coreVersion: worldManifest.coreVersion ?? null,
    coreCompatibility: worldManifest.compatibility ?? null,
    testedSystemVersion: worldManifest.systemVersion ?? null,
    manifestUrl: entry.manifestUrl,
    manifestSha256: entry.manifestSha256,
    downloadUrl: entry.downloadUrl,
    archiveSha256: entry.sha256,
    profile: profilePlan,
    system,
    modules,
    world,
    resolutionSha256: worldResolutionSha256({
      generated: index.generated,
      profile: profilePlan,
      world,
      system,
      modules,
    }),
    changes: artifacts.filter((artifact) => artifact.status !== "current"),
    actionable,
    plannedArchiveBytes: actionable.reduce((total, artifact) => total + artifact.bytes, 0),
    hasConflicts: artifacts.some((artifact) => artifact.status === "duplicate" || artifact.status === "unknown"),
    hasLocalNewer: artifacts.some((artifact) => artifact.status === "local-newer"),
    invalidLocal: {
      modules: installedModules.invalid,
      systems: installedSystems.invalid,
      worlds: installedWorlds.invalid,
    },
  };
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

async function downloadArchive(fetchImpl, url, file, label = "module ZIP") {
  const sourceUrl = httpsUrl(url, `${label} URL`);
  const response = await fetchImpl(sourceUrl, { cache: "no-store", redirect: "follow" });
  if (!response?.ok) throw new Error(`${label} request failed: HTTP ${response?.status ?? "unknown"}`);
  const finalUrl = httpsUrl(response.url || sourceUrl, `${label} final URL`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && (declared < 0 || declared > MAX_ARCHIVE_BYTES)) {
    throw new Error(`${label} exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  if (!response.body) throw new Error(`${label} response has no body`);
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(new Error(`${label} exceeds ${MAX_ARCHIVE_BYTES} bytes`));
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
  return findContentPayload(extractedRoot, "module.json", "module ZIP");
}

async function findContentPayload(extractedRoot, manifestFileName, label) {
  const rootManifest = path.join(extractedRoot, manifestFileName);
  if ((await fsp.stat(rootManifest).catch(() => null))?.isFile()) return extractedRoot;
  const candidates = [];
  const top = await fsp.readdir(extractedRoot, { withFileTypes: true });
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractedRoot, entry.name, manifestFileName);
    if ((await fsp.stat(candidate).catch(() => null))?.isFile()) candidates.push(path.join(extractedRoot, entry.name));
  }
  if (candidates.length !== 1) {
    throw new Error(`${label} must contain exactly one root or single-directory ${manifestFileName}; found ${candidates.length}`);
  }
  const payload = candidates[0];
  if (payload !== extractedRoot) {
    const siblings = top.filter((entry) => path.join(extractedRoot, entry.name) !== payload);
    if (siblings.length > 0) throw new Error(`${label} has content outside its single content directory`);
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
  const { manifest, document: manifestDocument } = await loadManifestDocument(fetchImpl, manifestUrl);
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
    await fsp.writeFile(path.join(payloadRoot, "module.json"), manifestDocument.buffer);
    const normalized = manifestShape(
      await readJsonFile(path.join(payloadRoot, "module.json"), "normalized module manifest"),
      { requireDownload: true },
    );
    assertExpected(normalized.id, manifest.id, "normalized module id");
    assertExpected(normalized.version, manifest.version, "normalized module version");
    assertExpected(normalized.download, manifest.download, "normalized module download URL");
    if (normalized.manifest && normalized.manifest !== manifest.manifestUrl) {
      throw new Error(`normalized module manifest URL mismatch: expected ${manifest.manifestUrl}; got ${normalized.manifest}`);
    }
    const record = {
      schemaVersion: 2,
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
      manifestBytes: manifestDocument.bytes,
      manifestSha256: manifestDocument.sha256,
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

function manifestFileForKind(kind) {
  if (kind === "module") return "module.json";
  if (kind === "system") return "system.json";
  if (kind === "world") return "world.json";
  throw new Error(`unsupported Foundry content kind: ${kind}`);
}

function contentRootForKind(layout, kind) {
  if (kind === "module") return layout.modulesRoot;
  if (kind === "system") return layout.systemsRoot;
  if (kind === "world") return layout.worldsRoot;
  throw new Error(`unsupported Foundry content kind: ${kind}`);
}

function assertArtifactManifest(manifest, artifact, { archived = false, identityOnly = false } = {}) {
  assertExpected(manifest.id, artifact.id, `${archived ? "archive" : "remote"} ${artifact.kind} id`);
  assertExpected(manifest.version, artifact.version, `${archived ? "archive" : "remote"} ${artifact.kind} version`);
  if (identityOnly) return;
  if (manifest.download) {
    assertExpected(manifest.download, artifact.downloadUrl, `${archived ? "archive" : "remote"} ${artifact.kind} download URL`);
  }
  if (manifest.manifest && manifest.manifest !== artifact.manifestUrl) {
    throw new Error(`${archived ? "archive" : "remote"} ${artifact.kind} manifest URL mismatch for ${artifact.id}`);
  }
}

async function stagePlannedArtifact({
  artifact,
  stageDir,
  ordinal,
  local,
  fetchImpl,
  archiveExtractor,
}) {
  const artifactDir = path.join(stageDir, "artifacts", `${String(ordinal).padStart(3, "0")}-${artifact.kind}-${artifact.id}`);
  const manifestFile = path.join(artifactDir, "manifest.json");
  const archiveFile = path.join(artifactDir, "package.zip");
  const extracted = path.join(artifactDir, "extracted");
  await fsp.mkdir(artifactDir, { recursive: true });

  const manifestDocument = await fetchJsonDocument(fetchImpl, artifact.manifestUrl, `${artifact.kind} manifest ${artifact.id}`);
  if (manifestDocument.bytes !== artifact.manifestBytes) {
    throw new Error(`${artifact.kind} ${artifact.id} manifest byte length mismatch: expected ${artifact.manifestBytes}; got ${manifestDocument.bytes}`);
  }
  if (manifestDocument.sha256 !== artifact.manifestSha256) {
    throw new Error(`${artifact.kind} ${artifact.id} manifest SHA256 mismatch: expected ${artifact.manifestSha256}; got ${manifestDocument.sha256}`);
  }
  const remoteManifest = installedContentManifestShape(manifestDocument.value, artifact.kind);
  assertArtifactManifest(remoteManifest, artifact);
  await fsp.writeFile(manifestFile, manifestDocument.buffer);

  const download = await downloadArchive(fetchImpl, artifact.downloadUrl, archiveFile, `${artifact.kind} ZIP ${artifact.id}`);
  if (download.bytes !== artifact.bytes) {
    throw new Error(`${artifact.kind} ${artifact.id} ZIP byte length mismatch: expected ${artifact.bytes}; got ${download.bytes}`);
  }
  if (download.sha256 !== artifact.sha256) {
    throw new Error(`${artifact.kind} ${artifact.id} ZIP SHA256 mismatch: expected ${artifact.sha256}; got ${download.sha256}`);
  }
  await archiveExtractor(archiveFile, extracted);
  const manifestFileName = manifestFileForKind(artifact.kind);
  const payloadRoot = await findContentPayload(extracted, manifestFileName, `${artifact.kind} ZIP ${artifact.id}`);
  const archivedManifest = installedContentManifestShape(
    await readJsonFile(path.join(payloadRoot, manifestFileName), `archive ${artifact.kind} manifest`),
    artifact.kind,
  );
  assertArtifactManifest(archivedManifest, artifact, { archived: true, identityOnly: true });
  await fsp.writeFile(path.join(payloadRoot, manifestFileName), manifestDocument.buffer);
  const normalizedManifest = installedContentManifestShape(
    await readJsonFile(path.join(payloadRoot, manifestFileName), `normalized ${artifact.kind} manifest`),
    artifact.kind,
  );
  assertArtifactManifest(normalizedManifest, artifact);

  return {
    kind: artifact.kind,
    id: artifact.id,
    title: artifact.title,
    version: artifact.version,
    manifestUrl: artifact.manifestUrl,
    downloadUrl: artifact.downloadUrl,
    manifest: path.relative(stageDir, manifestFile),
    archive: path.relative(stageDir, archiveFile),
    payload: path.relative(stageDir, payloadRoot),
    archiveBytes: download.bytes,
    archiveSha256: download.sha256,
    manifestBytes: manifestDocument.bytes,
    manifestSha256: manifestDocument.sha256,
    expectedCurrentVersion: local.installedVersion,
    expectedCurrentDirectory: local.directory,
    replacementStatus: local.status,
  };
}

export async function stageWorldEnvironment({
  worldId,
  dataDir,
  expectedWorldVersion,
  expectedWorldSha256,
  expectedProfileId,
  expectedProfileRevision,
  expectedProfileSha256,
  expectedIndexGenerated,
  expectedResolutionSha256,
  fetchImpl = fetch,
  indexUrl = MIRROR_INDEX_URL,
  tempRoot = os.tmpdir(),
  archiveExtractor = extractArchiveFile,
}) {
  const id = requireString(worldId, "world id", 128);
  if (!ID_PATTERN.test(id)) throw new Error(`world id is unsafe: ${id}`);
  const plan = await inspectWorldEnvironment({ worldId: id, dataDir, fetchImpl, indexUrl });
  assertExpected(plan.generated, expectedIndexGenerated, "mirror index generation");
  if (typeof expectedResolutionSha256 !== "string" || expectedResolutionSha256.trim() === "") {
    throw new Error(
      "--expected-resolution-sha256 is required; rerun world-inspect and pass its resolutionSha256 from the current plan",
    );
  }
  const resolutionSha256 = requireString(expectedResolutionSha256, "expected resolution SHA256", 64).toLowerCase();
  if (!SHA256_PATTERN.test(resolutionSha256)) throw new Error("expected resolution SHA256 is invalid");
  assertExpected(plan.resolutionSha256, resolutionSha256, "world resolution SHA256");
  assertExpected(plan.version, expectedWorldVersion, "world version");
  assertExpected(
    plan.archiveSha256,
    requireString(expectedWorldSha256, "expected world SHA256", 64).toLowerCase(),
    "world SHA256",
  );
  assertExpected(plan.profile.id, expectedProfileId, "environment profile id");
  if (plan.profile.revision !== Number(expectedProfileRevision)) {
    throw new Error(`environment profile revision changed: expected ${expectedProfileRevision}; got ${plan.profile.revision}`);
  }
  assertExpected(
    plan.profile.profileSha256,
    requireString(expectedProfileSha256, "expected profile SHA256", 64).toLowerCase(),
    "environment profile SHA256",
  );
  if (plan.hasConflicts) throw new Error("world installation plan has duplicate or unorderable local package versions");
  const artifacts = [plan.system, ...plan.modules, plan.world];
  const changed = artifacts
    .filter((artifact) => ["missing", "upgrade"].includes(artifact.status))
    .map((artifact) => ({
      artifact,
      local: {
        status: artifact.status,
        installedVersion: artifact.installedVersion,
        directory: artifact.directory,
      },
    }));
  if (changed.length === 0) {
    throw new Error(`world ${id}@${plan.version} and its stable profile are already current or locally newer`);
  }

  await fsp.mkdir(path.resolve(tempRoot), { recursive: true });
  const stageDir = await fsp.mkdtemp(path.join(path.resolve(tempRoot), WORLD_STAGE_PREFIX));
  try {
    const stagedArtifacts = [];
    for (let indexValue = 0; indexValue < changed.length; indexValue += 1) {
      stagedArtifacts.push(await stagePlannedArtifact({
        artifact: changed[indexValue].artifact,
        stageDir,
        ordinal: indexValue,
        local: changed[indexValue].local,
        fetchImpl,
        archiveExtractor,
      }));
    }
    const record = {
      schemaVersion: 3,
      kind: "foundry-world-profile-stage",
      createdAt: new Date().toISOString(),
      id: plan.id,
      title: plan.title,
      version: plan.version,
      coreVersion: plan.coreVersion,
      mirrorGenerated: plan.generated,
      resolutionSha256: plan.resolutionSha256,
      profile: plan.profile,
      world: {
        kind: "world",
        id: plan.world.id,
        title: plan.world.title,
        version: plan.world.version,
        manifestUrl: plan.world.manifestUrl,
        manifestBytes: plan.world.manifestBytes,
        manifestSha256: plan.world.manifestSha256,
        downloadUrl: plan.world.downloadUrl,
        bytes: plan.world.bytes,
        sha256: plan.world.sha256,
        expectedCurrentVersion: plan.world.installedVersion,
        expectedCurrentDirectory: plan.world.directory,
        expectedCurrentStatus: plan.world.status,
      },
      resolvedPackages: [plan.system, ...plan.modules].map((artifact) => ({
        kind: artifact.kind,
        id: artifact.id,
        title: artifact.title,
        version: artifact.version,
        manifestUrl: artifact.manifestUrl,
        manifestBytes: artifact.manifestBytes,
        manifestSha256: artifact.manifestSha256,
        downloadUrl: artifact.downloadUrl,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        resolutionSource: artifact.resolutionSource,
        expectedCurrentVersion: artifact.installedVersion,
        expectedCurrentDirectory: artifact.directory,
        expectedCurrentStatus: artifact.status,
      })),
      expectedWorldVersion: plan.world.installedVersion,
      expectedWorldDirectory: plan.world.directory,
      artifacts: stagedArtifacts,
    };
    await fsp.writeFile(path.join(stageDir, "stage.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return {
      ...record,
      stageDir,
      archiveBytes: stagedArtifacts.reduce((total, artifact) => total + artifact.archiveBytes, 0),
      dependencyReplacements: stagedArtifacts
        .filter((artifact) => artifact.kind !== "world" && artifact.expectedCurrentVersion != null)
        .map((artifact) => ({
          kind: artifact.kind,
          id: artifact.id,
          from: artifact.expectedCurrentVersion,
          to: artifact.version,
          status: artifact.replacementStatus,
        })),
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

async function validatedStageDirectory(stageDir, prefix = STAGE_PREFIX) {
  const realTemp = await fsp.realpath(os.tmpdir());
  const realStage = await fsp.realpath(path.resolve(requireString(stageDir, "stage directory")));
  if (!isDescendant(realTemp, realStage) || !path.basename(realStage).startsWith(prefix)) {
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
  if (record?.schemaVersion !== 2 || !ID_PATTERN.test(String(record.id ?? ""))) {
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
  const actualManifest = await sha256File(path.join(payload, "module.json"));
  if (actualManifest.sha256 !== record.manifestSha256 || actualManifest.bytes !== record.manifestBytes) {
    throw new Error("staged module manifest changed after verification");
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
  if (stagedManifest.manifest && stagedManifest.manifest !== record.manifestUrl) {
    throw new Error(`staged module manifest URL mismatch: expected ${record.manifestUrl}; got ${stagedManifest.manifest}`);
  }

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
  const copiedManifestIdentity = await sha256File(path.join(incoming, "module.json"));
  if (copiedManifestIdentity.sha256 !== record.manifestSha256 || copiedManifestIdentity.bytes !== record.manifestBytes) {
    throw new Error("incoming module manifest changed during copy");
  }

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
  const activatedManifestIdentity = await sha256File(path.join(target, "module.json"));
  if (activatedManifestIdentity.sha256 !== record.manifestSha256 || activatedManifestIdentity.bytes !== record.manifestBytes) {
    throw new Error(`activated module manifest verification failed for ${record.id}`);
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

function validatePlannedArtifact(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !["module", "system", "world"].includes(value.kind)) {
    throw new Error(`${label} must be a module, system, or world artifact`);
  }
  const id = requireString(value.id, `${label} id`, 128);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} has an unsafe id: ${id}`);
  const version = requireString(value.version, `${label} version`, 128);
  const bytes = Number(value.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`${label} has invalid ZIP bytes`);
  }
  const sha256 = requireString(value.sha256, `${label} ZIP SHA256`, 64).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`${label} has invalid ZIP SHA256`);
  const manifestBytes = Number(value.manifestBytes);
  if (!Number.isSafeInteger(manifestBytes) || manifestBytes < 1 || manifestBytes > MAX_JSON_BYTES) {
    throw new Error(`${label} has invalid manifest bytes`);
  }
  const manifestSha256 = requireString(value.manifestSha256, `${label} manifest SHA256`, 64).toLowerCase();
  if (!SHA256_PATTERN.test(manifestSha256)) throw new Error(`${label} has invalid manifest SHA256`);
  return {
    ...value,
    id,
    title: typeof value.title === "string" && value.title ? value.title : id,
    version,
    manifestUrl: contentManifestUrl(value.manifestUrl, value.kind, `${label} manifest URL`),
    manifestBytes,
    manifestSha256,
    downloadUrl: httpsUrl(value.downloadUrl, `${label} download URL`),
    bytes,
    sha256,
    expectedCurrentVersion: value.expectedCurrentVersion == null ? null : requireString(value.expectedCurrentVersion, `${label} expected current version`, 128),
    expectedCurrentDirectory: value.expectedCurrentDirectory == null
      ? null
      : path.resolve(requireString(value.expectedCurrentDirectory, `${label} expected current directory`, 1024)),
  };
}

function validateStagedProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arcane world stage profile is invalid");
  }
  const id = requireString(value.id, "staged environment profile id", 128);
  if (!ID_PATTERN.test(id)) throw new Error(`staged environment profile has an unsafe id: ${id}`);
  const revision = Number(value.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("staged environment profile revision is invalid");
  const system = requireString(value.system, "staged environment profile system", 128);
  if (!ID_PATTERN.test(system)) throw new Error(`staged environment profile has an unsafe system id: ${system}`);
  if (value.packageChannel !== "stable") throw new Error("staged environment profile packageChannel must be stable");
  if (!Array.isArray(value.modules) || value.modules.length > MAX_PROFILE_PACKAGES) {
    throw new Error("staged environment profile modules are invalid");
  }
  const modules = value.modules.map((moduleId, index) => {
    const idValue = requireString(moduleId, `staged environment profile module ${index}`, 128);
    if (!ID_PATTERN.test(idValue)) throw new Error(`staged environment profile has an unsafe module id: ${idValue}`);
    return idValue;
  });
  if (new Set(modules).size !== modules.length) throw new Error("staged environment profile repeats a module id");
  const profileBytes = Number(value.profileBytes);
  if (!Number.isSafeInteger(profileBytes) || profileBytes < 1 || profileBytes > MAX_JSON_BYTES) {
    throw new Error("staged environment profile has invalid bytes");
  }
  const profileSha256 = requireString(value.profileSha256, "staged environment profile SHA256", 64).toLowerCase();
  if (!SHA256_PATTERN.test(profileSha256)) throw new Error("staged environment profile has invalid SHA256");
  return {
    ...value,
    id,
    revision,
    packageChannel: "stable",
    system,
    modules,
    profileUrl: httpsUrl(value.profileUrl, "staged environment profile URL"),
    profileBytes,
    profileSha256,
  };
}

function plannedArtifactByIdentity(record, kind, id) {
  return [record.world, ...record.resolvedPackages]
    .find((artifact) => artifact.kind === kind && artifact.id === id) ?? null;
}

async function validateWorldStage(stageDir) {
  const stage = await validatedStageDirectory(stageDir, WORLD_STAGE_PREFIX);
  const rawRecord = await readJsonFile(path.join(stage, "stage.json"), "Arcane world stage record");
  if (
    rawRecord?.schemaVersion !== 3 ||
    rawRecord.kind !== "foundry-world-profile-stage" ||
    !Array.isArray(rawRecord.resolvedPackages) ||
    !Array.isArray(rawRecord.artifacts)
  ) {
    throw new Error("Arcane world stage record is invalid");
  }
  const profile = validateStagedProfile(rawRecord.profile);
  const world = validatePlannedArtifact(rawRecord.world, "staged world plan");
  if (world.kind !== "world") throw new Error("Arcane world stage world plan must be a world artifact");
  assertExpected(world.id, rawRecord.id, "staged world id");
  assertExpected(world.version, rawRecord.version, "staged world version");
  if (
    world.expectedCurrentVersion !== (rawRecord.expectedWorldVersion == null ? null : String(rawRecord.expectedWorldVersion)) ||
    world.expectedCurrentDirectory !== (rawRecord.expectedWorldDirectory == null ? null : path.resolve(String(rawRecord.expectedWorldDirectory)))
  ) {
    throw new Error("Arcane world stage world snapshot is inconsistent");
  }
  const resolvedPackages = rawRecord.resolvedPackages.map((artifact, index) =>
    validatePlannedArtifact(artifact, `staged resolved package ${index}`));
  if (resolvedPackages.length > MAX_PROFILE_PACKAGES) throw new Error("Arcane world stage resolves too many packages");
  const resolvedKeys = new Set();
  for (const artifact of resolvedPackages) {
    if (artifact.kind === "world") throw new Error("Arcane world stage resolved package cannot be a world");
    const key = `${artifact.kind}:${artifact.id}`;
    if (resolvedKeys.has(key)) throw new Error(`Arcane world stage repeats resolved package ${key}`);
    resolvedKeys.add(key);
  }
  if (!resolvedKeys.has(`system:${profile.system}`)) {
    throw new Error(`Arcane world stage does not resolve profile system ${profile.system}`);
  }
  for (const moduleId of profile.modules) {
    if (!resolvedKeys.has(`module:${moduleId}`)) {
      throw new Error(`Arcane world stage does not resolve profile module ${moduleId}`);
    }
  }
  const resolutionSha256 = requireString(rawRecord.resolutionSha256, "staged resolution SHA256", 64).toLowerCase();
  if (!SHA256_PATTERN.test(resolutionSha256)) throw new Error("staged resolution SHA256 is invalid");
  const actualResolutionSha256 = worldResolutionSha256({
    generated: rawRecord.mirrorGenerated,
    profile,
    world,
    system: resolvedPackages.find((artifact) => artifact.kind === "system"),
    modules: resolvedPackages.filter((artifact) => artifact.kind === "module"),
  });
  assertExpected(actualResolutionSha256, resolutionSha256, "staged resolution SHA256");
  const record = { ...rawRecord, profile, world, resolvedPackages };
  const seen = new Set();
  const artifacts = [];
  for (const raw of record.artifacts) {
    if (!raw || typeof raw !== "object" || !["module", "system", "world"].includes(raw.kind)) {
      throw new Error("Arcane world stage contains an invalid artifact");
    }
    const key = `${raw.kind}:${raw.id}`;
    if (seen.has(key)) throw new Error(`Arcane world stage repeats artifact ${key}`);
    seen.add(key);
    const planned = plannedArtifactByIdentity(record, raw.kind, raw.id);
    if (!planned) throw new Error(`Arcane world stage artifact is not in the resolved plan: ${key}`);
    for (const field of ["version", "manifestUrl", "downloadUrl", "archiveSha256", "manifestSha256"]) {
      const expected = field === "archiveSha256" ? planned.sha256 : field === "manifestSha256" ? planned.manifestSha256 : planned[field];
      assertExpected(raw[field], expected, `staged ${key} ${field}`);
    }
    if (raw.archiveBytes !== planned.bytes || raw.manifestBytes !== planned.manifestBytes) {
      throw new Error(`staged ${key} byte lengths do not match the resolved plan`);
    }
    const rawExpectedVersion = raw.expectedCurrentVersion == null ? null : String(raw.expectedCurrentVersion);
    const rawExpectedDirectory = raw.expectedCurrentDirectory == null ? null : path.resolve(String(raw.expectedCurrentDirectory));
    if (
      rawExpectedVersion !== planned.expectedCurrentVersion ||
      rawExpectedDirectory !== planned.expectedCurrentDirectory
    ) {
      throw new Error(`staged ${key} local snapshot does not match the resolved plan`);
    }
    const manifest = path.resolve(stage, requireString(raw.manifest, `staged ${key} manifest path`, 512));
    const archive = path.resolve(stage, requireString(raw.archive, `staged ${key} archive path`, 512));
    const payload = path.resolve(stage, requireString(raw.payload, `staged ${key} payload path`, 512));
    if (!isDescendant(stage, manifest) || !isDescendant(stage, archive) || !isDescendant(stage, payload)) {
      throw new Error(`staged ${key} paths escape the staging directory`);
    }
    const [manifestIdentity, archiveIdentity] = await Promise.all([sha256File(manifest), sha256File(archive)]);
    if (manifestIdentity.bytes !== planned.manifestBytes || manifestIdentity.sha256 !== planned.manifestSha256) {
      throw new Error(`staged ${key} manifest changed after verification`);
    }
    if (archiveIdentity.bytes !== planned.bytes || archiveIdentity.sha256 !== planned.sha256) {
      throw new Error(`staged ${key} ZIP changed after verification`);
    }
    const payloadManifest = installedContentManifestShape(
      await readJsonFile(path.join(payload, manifestFileForKind(raw.kind)), `staged ${raw.kind} manifest`),
      raw.kind,
    );
    assertArtifactManifest(payloadManifest, planned, { archived: true });
    artifacts.push({ ...raw, manifest, archive, payload, planned });
  }
  return { stage, record, artifacts };
}

function backupParentFor(layout, artifact) {
  if (artifact.kind === "world") {
    return path.join(layout.contentRoot, ".arcane-world-backups", artifact.id);
  }
  const collection = artifact.kind === "module" ? "modules" : "systems";
  return path.join(layout.contentRoot, ".arcane-mod-backups", collection, artifact.id);
}

async function installedForKind(dataDir, kind) {
  if (kind === "module") return (await listInstalledModules(dataDir)).modules;
  if (kind === "system") return (await listInstalledSystems(dataDir)).systems;
  return (await listInstalledWorlds(dataDir)).worlds;
}

async function rollbackWorldOperations(operations, token) {
  const failures = [];
  for (const operation of [...operations].reverse()) {
    try {
      if (operation.activated && await exists(operation.target)) {
        const displaced = path.join(operation.root, `.${operation.artifact.id}.arcane-rollback-${token}`);
        await fsp.rename(operation.target, displaced);
        if (operation.backup) await fsp.rename(operation.backup, operation.target);
        await fsp.rm(displaced, { recursive: true, force: true });
      } else if (operation.movedCurrent && operation.backup && !await exists(operation.target)) {
        await fsp.rename(operation.backup, operation.target);
      }
      await fsp.rm(operation.incoming, { recursive: true, force: true }).catch(() => {});
    } catch (error) {
      failures.push(`${operation.artifact.kind}:${operation.artifact.id}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

async function assertInstalledSnapshot(dataDir, artifact) {
  const installed = await installedForKind(dataDir, artifact.kind);
  const matches = installed.filter((entry) => entry.id === artifact.id);
  if (matches.length > 1) throw new Error(`multiple installed directories claim ${artifact.kind} id ${artifact.id}`);
  const current = matches[0] ?? null;
  if (artifact.expectedCurrentVersion == null) {
    if (current) throw new Error(`${artifact.kind} ${artifact.id} appeared after staging at version ${current.version}`);
  } else if (
    !current ||
    current.version !== artifact.expectedCurrentVersion ||
    current.directory !== artifact.expectedCurrentDirectory
  ) {
    throw new Error(
      `${artifact.kind} ${artifact.id} changed after staging: expected ${artifact.expectedCurrentVersion} at ${artifact.expectedCurrentDirectory}; ` +
      `got ${current?.version ?? "none"} at ${current?.directory ?? "none"}`,
    );
  }
  return current;
}

async function writeProfileReceipt(layout, record, changes) {
  const receiptDir = path.join(layout.contentRoot, ".arcane-managed", "profiles");
  await fsp.mkdir(receiptDir, { recursive: true });
  const packageStates = [];
  for (const artifact of record.resolvedPackages) {
    const installed = await installedForKind(layout.dataDir, artifact.kind);
    const matches = installed.filter((entry) => entry.id === artifact.id);
    packageStates.push({
      kind: artifact.kind,
      id: artifact.id,
      resolvedVersion: artifact.version,
      installedVersion: matches.length === 1 ? matches[0].version : null,
      matchesResolvedVersion: matches.length === 1 && matches[0].version === artifact.version,
      manifestUrl: artifact.manifestUrl,
      manifestSha256: artifact.manifestSha256,
      downloadUrl: artifact.downloadUrl,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      resolutionSource: artifact.resolutionSource ?? null,
    });
  }
  const installedWorlds = await listInstalledWorlds(layout.dataDir);
  const worldMatches = installedWorlds.worlds.filter((entry) => entry.id === record.world.id);
  const receipt = {
    schemaVersion: 1,
    kind: "foundry-environment-receipt",
    installedAt: new Date().toISOString(),
    mirrorGenerated: record.mirrorGenerated ?? null,
    profile: record.profile,
    world: {
      id: record.world.id,
      resolvedVersion: record.world.version,
      installedVersion: worldMatches.length === 1 ? worldMatches[0].version : null,
      matchesResolvedVersion: worldMatches.length === 1 && worldMatches[0].version === record.world.version,
      manifestUrl: record.world.manifestUrl,
      manifestSha256: record.world.manifestSha256,
      downloadUrl: record.world.downloadUrl,
      bytes: record.world.bytes,
      sha256: record.world.sha256,
    },
    packages: packageStates,
    changes: changes.map((change) => ({
      kind: change.kind,
      id: change.id,
      previousVersion: change.previousVersion,
      version: change.version,
      archiveSha256: change.archiveSha256,
    })),
  };
  const token = randomUUID();
  const target = path.join(receiptDir, `${record.profile.id}.json`);
  const incoming = path.join(receiptDir, `.${record.profile.id}.arcane-incoming-${token}`);
  const previous = path.join(receiptDir, `.${record.profile.id}.arcane-previous-${token}`);
  await fsp.writeFile(incoming, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  let movedPrevious = false;
  try {
    if (await exists(target)) {
      await fsp.rename(target, previous);
      movedPrevious = true;
    }
    await fsp.rename(incoming, target);
    if (movedPrevious) await fsp.rm(previous, { force: true });
  } catch (error) {
    if (movedPrevious && !await exists(target) && await exists(previous)) {
      await fsp.rename(previous, target).catch(() => {});
    }
    await fsp.rm(incoming, { force: true }).catch(() => {});
    throw error;
  }
  return { path: target, receipt };
}

export async function commitWorldStage({ stageDir, dataDir, expectedCurrentVersion }) {
  const { stage, record, artifacts } = await validateWorldStage(stageDir);
  const expectedWorld = requireString(expectedCurrentVersion, "expected current world version", 128);
  const recordedWorld = record.expectedWorldVersion == null ? "none" : String(record.expectedWorldVersion);
  if (expectedWorld !== recordedWorld) {
    throw new Error(`expected current world version does not match staging: expected ${recordedWorld}; got ${expectedWorld}`);
  }
  const layout = await assertDataDirectory(dataDir);
  const installedWorlds = await listInstalledWorlds(layout.dataDir);
  const worldMatches = installedWorlds.worlds.filter((entry) => entry.id === record.world.id);
  if (worldMatches.length > 1) throw new Error(`multiple installed directories claim world id ${record.world.id}`);
  const currentWorld = worldMatches[0] ?? null;
  if (record.expectedWorldVersion == null) {
    if (currentWorld) throw new Error(`world ${record.world.id} appeared after staging at version ${currentWorld.version}`);
  } else if (
    !currentWorld ||
    currentWorld.version !== record.expectedWorldVersion ||
    currentWorld.directory !== record.expectedWorldDirectory
  ) {
    throw new Error(
      `world ${record.world.id} changed after staging: expected ${record.expectedWorldVersion} at ${record.expectedWorldDirectory}; ` +
      `got ${currentWorld?.version ?? "none"} at ${currentWorld?.directory ?? "none"}`,
    );
  }
  for (const artifact of record.resolvedPackages) {
    await assertInstalledSnapshot(layout.dataDir, artifact);
  }
  const operations = [];
  const token = randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  try {
    for (const artifact of artifacts) {
      const installed = await installedForKind(layout.dataDir, artifact.kind);
      const matches = installed.filter((entry) => entry.id === artifact.id);
      if (matches.length > 1) throw new Error(`multiple installed directories claim ${artifact.kind} id ${artifact.id}`);
      const current = matches[0] ?? null;
      const expectedVersion = artifact.expectedCurrentVersion == null ? null : String(artifact.expectedCurrentVersion);
      if (expectedVersion == null) {
        if (current) throw new Error(`${artifact.kind} ${artifact.id} appeared after staging at version ${current.version}`);
      } else if (!current || current.version !== expectedVersion || current.directory !== artifact.expectedCurrentDirectory) {
        throw new Error(
          `${artifact.kind} ${artifact.id} changed after staging: expected ${expectedVersion} at ${artifact.expectedCurrentDirectory}; ` +
          `got ${current?.version ?? "none"} at ${current?.directory ?? "none"}`,
        );
      }
      const root = contentRootForKind(layout, artifact.kind);
      await fsp.mkdir(root, { recursive: true });
      const target = current?.directory ?? path.join(root, artifact.id);
      if (!current && await exists(target)) {
        throw new Error(`target exists but is not a valid matching ${artifact.kind}: ${target}`);
      }
      const incoming = path.join(root, `.${artifact.id}.arcane-incoming-${token}`);
      const operation = { artifact, current, root, target, incoming, backup: null, movedCurrent: false, activated: false };
      operations.push(operation);
      await fsp.cp(artifact.payload, incoming, { recursive: true, force: false, errorOnExist: true });
      const copied = installedContentManifestShape(
        await readJsonFile(path.join(incoming, manifestFileForKind(artifact.kind)), `incoming ${artifact.kind} manifest`),
        artifact.kind,
      );
      assertArtifactManifest(copied, artifact.planned, { archived: true });
    }

    for (const operation of operations) {
      if (operation.current) {
        const backupParent = backupParentFor(layout, operation.artifact);
        await fsp.mkdir(backupParent, { recursive: true });
        operation.backup = path.join(
          backupParent,
          `${stamp}-${safeBackupPart(operation.current.version)}-${token.slice(0, 8)}`,
        );
        await fsp.rename(operation.target, operation.backup);
        operation.movedCurrent = true;
      }
      await fsp.rename(operation.incoming, operation.target);
      operation.activated = true;
    }
  } catch (error) {
    const rollbackFailures = await rollbackWorldOperations(operations, token);
    const suffix = rollbackFailures.length > 0 ? `; rollback needs attention: ${rollbackFailures.join(" | ")}` : "";
    throw new Error(`could not activate world/profile plan ${record.id}@${record.version}: ${errorMessage(error)}${suffix}`);
  }

  const changes = [];
  for (const operation of operations) {
    const activated = installedContentManifestShape(
      await readJsonFile(
        path.join(operation.target, manifestFileForKind(operation.artifact.kind)),
        `activated ${operation.artifact.kind} manifest`,
      ),
      operation.artifact.kind,
    );
    assertArtifactManifest(activated, operation.artifact.planned, { archived: true });
    changes.push({
      kind: operation.artifact.kind,
      id: operation.artifact.id,
      previousVersion: operation.current?.version ?? null,
      version: operation.artifact.version,
      target: operation.target,
      backup: operation.backup,
      archiveBytes: operation.artifact.archiveBytes,
      archiveSha256: operation.artifact.archiveSha256,
    });
  }
  let receipt = null;
  let receiptError = null;
  try {
    receipt = await writeProfileReceipt(layout, record, changes);
  } catch (error) {
    receiptError = errorMessage(error);
  }
  await fsp.rm(stage, { recursive: true, force: true });
  return {
    id: record.world.id,
    title: record.world.title,
    version: record.world.version,
    coreVersion: record.coreVersion ?? null,
    profile: record.profile,
    installed: true,
    changes,
    world: changes.find((change) => change.kind === "world") ?? null,
    receiptPath: receipt?.path ?? null,
    receiptError,
    backups: changes.filter((change) => change.backup).map((change) => ({
      kind: change.kind,
      id: change.id,
      path: change.backup,
    })),
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
    "  mod-manager world-inspect --world-id <id> --data-dir <dir>",
    "  mod-manager world-catalog --data-dir <dir>",
    "  mod-manager world-stage --world-id <id> --data-dir <dir> --expected-world-version <version> --expected-world-sha256 <sha256> --expected-profile-id <id> --expected-profile-revision <revision> --expected-profile-sha256 <sha256> --expected-index-generated <timestamp> --expected-resolution-sha256 <sha256>",
    "  mod-manager world-commit --stage-dir <dir> --data-dir <dir> --expected-current-version <version|none>",
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
    case "world-inspect":
      return inspectWorldEnvironment({
        worldId: options["world-id"],
        dataDir: options["data-dir"],
      });
    case "world-catalog":
      return catalogWorlds({ dataDir: options["data-dir"] });
    case "world-stage":
      return stageWorldEnvironment({
        worldId: options["world-id"],
        dataDir: options["data-dir"],
        expectedWorldVersion: options["expected-world-version"],
        expectedWorldSha256: options["expected-world-sha256"],
        expectedProfileId: options["expected-profile-id"],
        expectedProfileRevision: options["expected-profile-revision"],
        expectedProfileSha256: options["expected-profile-sha256"],
        expectedIndexGenerated: options["expected-index-generated"],
        expectedResolutionSha256: options["expected-resolution-sha256"],
      });
    case "world-commit":
      return commitWorldStage({
        stageDir: options["stage-dir"],
        dataDir: options["data-dir"],
        expectedCurrentVersion: options["expected-current-version"],
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
