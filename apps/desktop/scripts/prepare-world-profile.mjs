#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://arcane-package.oss-cn-beijing.aliyuncs.com";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "end of command"}`);
    }
    result[key.slice(2)] = value;
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

function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive integer`);
  return result;
}

function httpsUrl(value, label) {
  const url = new URL(requireString(value, label));
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url.href;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchBuffer(url, label, { method = "GET", maxBytes = null } = {}) {
  const response = await fetch(httpsUrl(url, label), { method, cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  if (method === "HEAD") return { response, buffer: null };
  const buffer = Buffer.from(await response.arrayBuffer());
  if (maxBytes != null && buffer.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return { response, buffer };
}

async function fetchJsonDocument(url, label) {
  const { buffer } = await fetchBuffer(url, label, { maxBytes: MAX_JSON_BYTES });
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { value, buffer, bytes: buffer.length, sha256: sha256(buffer) };
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeIndex(value) {
  return `${JSON.stringify(value, null, 2).replace(/\n/g, "\r\n")}\r\n`;
}

function generatedTimestamp() {
  return new Date().toISOString().replace("Z", "+00:00");
}

function packageKind(entry) {
  const fileName = path.posix.basename(new URL(entry.manifestUrl).pathname).toLowerCase();
  if (entry.group === "system" || fileName === "system.json") return "system";
  if (fileName === "module.json") return "module";
  return null;
}

function currentPackage(index, id, kind) {
  const matches = index.packages.filter((entry) => entry.id === id && packageKind(entry) === kind);
  if (matches.length !== 1) throw new Error(`mirror index does not contain exactly one current ${kind} ${id}`);
  return matches[0];
}

async function verifyResolvablePackage(index, id, kind) {
  const entry = currentPackage(index, id, kind);
  const manifestUrl = httpsUrl(entry.manifestUrl, `${kind} ${id} manifest URL`);
  const manifestDocument = await fetchJsonDocument(manifestUrl, `${kind} ${id}@${entry.version} manifest`);
  const manifest = manifestDocument.value;
  if (manifest?.id !== id || String(manifest?.version) !== String(entry.version)) {
    throw new Error(`${kind} ${id}@${entry.version} manifest identity mismatch`);
  }
  if (manifest.manifest && manifest.manifest !== manifestUrl) {
    throw new Error(`${kind} ${id}@${entry.version} manifest self URL mismatch`);
  }
  if (manifest.download && manifest.download !== httpsUrl(entry.zipUrl, `${kind} ${id} ZIP URL`)) {
    throw new Error(`${kind} ${id}@${entry.version} manifest download URL mismatch`);
  }
  return { id, kind, currentVersion: String(entry.version) };
}

async function worldArtifact(world) {
  const manifestUrl = httpsUrl(world.manifest, "world manifest URL");
  const downloadUrl = httpsUrl(world.download, "world ZIP URL");
  const [manifestDocument, archiveDocument] = await Promise.all([
    fetchJsonDocument(manifestUrl, `${world.id}@${world.version} world manifest`),
    fetchBuffer(downloadUrl, `${world.id}@${world.version} world ZIP`),
  ]);
  const manifest = manifestDocument.value;
  for (const [field, expected] of Object.entries({
    id: world.id,
    version: String(world.version),
    system: world.system,
    manifest: manifestUrl,
    download: downloadUrl,
  })) {
    if (String(manifest?.[field]) !== String(expected)) {
      throw new Error(`${world.id}@${world.version} world manifest ${field} mismatch`);
    }
  }
  const archiveSha256 = sha256(archiveDocument.buffer);
  if (world.manifestBytes != null && manifestDocument.bytes !== world.manifestBytes) {
    throw new Error(`world manifest length differs from distribution: ${manifestDocument.bytes} != ${world.manifestBytes}`);
  }
  if (world.manifestSha256 != null && manifestDocument.sha256 !== world.manifestSha256) {
    throw new Error("world manifest SHA256 differs from distribution");
  }
  if (world.bytes != null && archiveDocument.buffer.length !== world.bytes) {
    throw new Error(`world ZIP length differs from distribution: ${archiveDocument.buffer.length} != ${world.bytes}`);
  }
  if (world.sha256 != null && archiveSha256 !== world.sha256) {
    throw new Error("world ZIP SHA256 differs from distribution");
  }
  return {
    id: safeId(world.id, "world id"),
    title: typeof manifest.title === "string" && manifest.title ? manifest.title : world.title,
    version: String(world.version),
    manifestUrl,
    manifestBytes: manifestDocument.bytes,
    manifestSha256: manifestDocument.sha256,
    downloadUrl,
    bytes: archiveDocument.buffer.length,
    sha256: archiveSha256,
  };
}

export async function prepareWorldProfile({
  distributionFile,
  worldId,
  profileId,
  profileTitle,
  profileRevision,
  outputDir,
  expectedCurrentWorldVersion,
  expectedCurrentProfileRevision,
  baseUrl = DEFAULT_BASE_URL,
}) {
  const distribution = JSON.parse(await fs.readFile(path.resolve(distributionFile), "utf8"));
  const requestedWorldId = safeId(worldId, "world id");
  const requestedProfileId = safeId(profileId, "profile id");
  const requestedProfileRevision = positiveInteger(profileRevision, "profile revision");
  const world = distribution.worlds?.find((entry) => entry.id === requestedWorldId);
  if (!world) throw new Error(`distribution does not declare world ${requestedWorldId}`);
  const base = httpsUrl(`${baseUrl.replace(/\/$/, "")}/`, "base URL").replace(/\/$/, "");
  const indexUrl = `${base}/index.json`;
  const indexDocument = await fetchJsonDocument(indexUrl, "mirror index");
  const index = indexDocument.value;
  if (!Array.isArray(index.packages)) throw new Error("mirror index has no packages array");
  const existingWorlds = Array.isArray(index.worlds) ? index.worlds : [];
  const existingProfiles = Array.isArray(index.profiles) ? index.profiles : [];
  const existingWorld = existingWorlds.find((entry) => entry.id === requestedWorldId);
  const existingProfile = existingProfiles.find((entry) => entry.id === requestedProfileId);
  const actualWorldVersion = existingWorld?.version == null ? "none" : String(existingWorld.version);
  if (actualWorldVersion !== requireString(expectedCurrentWorldVersion, "expected current world version")) {
    throw new Error(`world ${requestedWorldId} pointer changed: expected ${expectedCurrentWorldVersion}; got ${actualWorldVersion}`);
  }
  const actualProfileRevision = existingProfile?.revision == null ? "none" : String(existingProfile.revision);
  if (actualProfileRevision !== requireString(expectedCurrentProfileRevision, "expected current profile revision")) {
    throw new Error(`profile ${requestedProfileId} pointer changed: expected ${expectedCurrentProfileRevision}; got ${actualProfileRevision}`);
  }
  if (existingProfile && requestedProfileRevision < Number(existingProfile.revision)) {
    throw new Error(`profile revision cannot move backwards from ${existingProfile.revision} to ${requestedProfileRevision}`);
  }
  if (existingProfile && requestedProfileRevision > Number(existingProfile.revision) + 1) {
    throw new Error(`profile revision must advance by one from ${existingProfile.revision}`);
  }

  const moduleIds = (distribution.modules ?? []).map((entry) => safeId(entry.id, "module id"));
  if (new Set(moduleIds).size !== moduleIds.length) throw new Error("distribution repeats a module id");
  const systemId = safeId(world.system, "world system id");
  const resolved = await Promise.all([
    verifyResolvablePackage(index, systemId, "system"),
    ...moduleIds.map((moduleId) => verifyResolvablePackage(index, moduleId, "module")),
  ]);

  const profile = {
    schemaVersion: 1,
    kind: "foundry-environment-profile",
    id: requestedProfileId,
    title: requireString(profileTitle, "profile title"),
    revision: requestedProfileRevision,
    packageChannel: "stable",
    system: systemId,
    modules: moduleIds,
  };
  const profileBuffer = Buffer.from(serializeJson(profile));
  const profileUrl = `${base}/profiles/${requestedProfileId}/${requestedProfileRevision}/profile.json`;
  const profileEntry = {
    id: requestedProfileId,
    title: profile.title,
    revision: requestedProfileRevision,
    profileUrl,
    profileBytes: profileBuffer.length,
    profileSha256: sha256(profileBuffer),
  };
  let writeProfile = true;
  if (existingProfile && requestedProfileRevision === Number(existingProfile.revision)) {
    if (
      existingProfile.profileUrl !== profileEntry.profileUrl ||
      existingProfile.profileBytes !== profileEntry.profileBytes ||
      existingProfile.profileSha256 !== profileEntry.profileSha256
    ) {
      throw new Error(`immutable profile ${requestedProfileId}@${requestedProfileRevision} differs; publish a new revision`);
    }
    const existingProfileDocument = await fetchJsonDocument(existingProfile.profileUrl, "current environment profile");
    if (existingProfileDocument.bytes !== profileEntry.profileBytes || existingProfileDocument.sha256 !== profileEntry.profileSha256) {
      throw new Error(`published profile ${requestedProfileId}@${requestedProfileRevision} does not match its index identity`);
    }
    writeProfile = false;
  }

  const artifact = await worldArtifact(world);
  const worldEntry = { ...artifact, defaultProfile: requestedProfileId };
  const worldUnchanged = existingWorld && [
    "version", "manifestUrl", "manifestBytes", "manifestSha256", "downloadUrl", "bytes", "sha256", "defaultProfile",
  ].every((field) => existingWorld[field] === worldEntry[field]);
  if (worldUnchanged && !writeProfile) {
    throw new Error("world and environment profile are already current; there is nothing to publish");
  }

  const nextIndex = {
    ...index,
    generated: generatedTimestamp(),
    worlds: [...existingWorlds.filter((entry) => entry.id !== requestedWorldId), worldEntry]
      .sort((left, right) => left.id.localeCompare(right.id)),
    profiles: [...existingProfiles.filter((entry) => entry.id !== requestedProfileId), profileEntry]
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const indexBuffer = Buffer.from(serializeIndex(nextIndex));
  const resolvedOutput = path.resolve(outputDir);
  await fs.mkdir(resolvedOutput, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(resolvedOutput, "profile.json"), profileBuffer),
    fs.writeFile(path.join(resolvedOutput, "index.before.json"), indexDocument.buffer),
    fs.writeFile(path.join(resolvedOutput, "index.json"), indexBuffer),
  ]);
  const plan = {
    generatedAt: new Date().toISOString(),
    outputDir: resolvedOutput,
    sourceIndex: {
      url: indexUrl,
      generated: index.generated ?? null,
      bytes: indexDocument.bytes,
      sha256: indexDocument.sha256,
    },
    profile: {
      key: `profiles/${requestedProfileId}/${requestedProfileRevision}/profile.json`,
      url: profileUrl,
      revision: requestedProfileRevision,
      bytes: profileBuffer.length,
      sha256: profileEntry.profileSha256,
      immutableWrite: writeProfile,
      packageIds: resolved,
    },
    world: worldEntry,
    nextIndex: {
      key: "index.json",
      generated: nextIndex.generated,
      bytes: indexBuffer.length,
      sha256: sha256(indexBuffer),
    },
  };
  await fs.writeFile(path.join(resolvedOutput, "publish-plan.json"), Buffer.from(serializeJson(plan)));
  return { plan, profile, nextIndex };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareWorldProfile({
    distributionFile: requireString(args.distribution, "--distribution"),
    worldId: requireString(args["world-id"], "--world-id"),
    profileId: requireString(args["profile-id"], "--profile-id"),
    profileTitle: requireString(args["profile-title"], "--profile-title"),
    profileRevision: requireString(args["profile-revision"], "--profile-revision"),
    outputDir: requireString(args.output, "--output"),
    expectedCurrentWorldVersion: requireString(args["expected-current-world-version"], "--expected-current-world-version"),
    expectedCurrentProfileRevision: requireString(args["expected-current-profile-revision"], "--expected-current-profile-revision"),
    baseUrl: args["base-url"] ?? DEFAULT_BASE_URL,
  });
  process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
