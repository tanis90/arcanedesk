import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { extractArchiveFile } from "../../scripts/archive.mjs";
import { applyArcaneFvttOpsEnvironment } from "./subprocess-env.mjs";

const execFileP = promisify(execFile);

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** @param {string} file */
async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * @param {NodeJS.Platform | string} platform
 * @param {string} arch
 */
export function fvttNodePlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) return `darwin-${arch}`;
  throw new Error(`unsupported bundled Foundry Node target: ${platform}-${arch}`);
}

/**
 * @param {string} targetDir
 * @param {NodeJS.Platform | string} platform
 */
function nodeBinaryPath(targetDir, platform) {
  return platform === "win32"
    ? path.join(targetDir, "node.exe")
    : path.join(targetDir, "bin", "node");
}

/** @param {string} binary */
async function probeNodeVersion(binary) {
  if (!fs.existsSync(binary)) return null;
  try {
    const { stdout } = await execFileP(binary, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

// Staging and destination are both below runtimeRoot, so directory renames stay
// on one volume. Keep the previous runtime until the incoming tree is ready.
async function replaceDirectory(source, destination) {
  const parent = path.dirname(destination);
  const token = randomUUID();
  const incoming = path.join(parent, `.${path.basename(destination)}.arcane-incoming-${token}`);
  const backup = path.join(parent, `.${path.basename(destination)}.arcane-backup-${token}`);
  await fsp.mkdir(parent, { recursive: true });
  await fsp.rename(source, incoming);
  const hadPrevious = fs.existsSync(destination);
  try {
    if (hadPrevious) await fsp.rename(destination, backup);
    await fsp.rename(incoming, destination);
  } catch (error) {
    if (hadPrevious && !fs.existsSync(destination) && fs.existsSync(backup)) {
      await fsp.rename(backup, destination).catch(() => {});
    }
    await fsp.rm(incoming, { recursive: true, force: true }).catch(() => {});
    throw new Error(`could not activate the bundled Foundry Node runtime: ${errorMessage(error)}`);
  }
  await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
}

/**
 * Extract and verify Arcane's packaged standalone Node before an Agent session
 * starts. This is an App-private bootstrap, not an Agent tool or setup CLI.
 *
 * @param {{
 *   runtimeRoot: string,
 *   bundledNodeRoot: string,
 *   distributionFile: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   platform?: NodeJS.Platform | string,
 *   arch?: string,
 *   versionProbe?: (binary: string) => Promise<string | null>,
 *   archiveExtractor?: (archive: string, destination: string) => Promise<unknown>,
 *   hashFile?: (file: string) => Promise<string>,
 * }} options
 */
export async function bootstrapFvttOpsRuntime({
  runtimeRoot,
  bundledNodeRoot,
  distributionFile,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  versionProbe = probeNodeVersion,
  archiveExtractor = extractArchiveFile,
  hashFile = sha256File,
}) {
  if (!runtimeRoot || !bundledNodeRoot || !distributionFile) {
    throw new TypeError("Foundry Node bootstrap requires runtimeRoot, bundledNodeRoot, and distributionFile");
  }

  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedBundledRoot = path.resolve(bundledNodeRoot);
  const resolvedDistributionFile = path.resolve(distributionFile);
  const distribution = readJson(resolvedDistributionFile);
  const version = String(distribution?.core?.node ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("distribution is missing the pinned Foundry Node version");
  }

  const platformKey = fvttNodePlatformKey(platform, arch);
  const expectedFile = platform === "win32"
    ? `node-v${version}-win-x64.zip`
    : `node-v${version}-darwin-${arch}.tar.gz`;
  const artifact = distribution?.core?.nodeArtifacts?.[platformKey];
  if (
    artifact?.file !== expectedFile
    || !/^[a-f0-9]{64}$/.test(String(artifact?.sha256 ?? ""))
  ) {
    throw new Error(`distribution is missing a trusted Foundry Node artifact for ${platformKey}`);
  }

  const targetDir = path.join(resolvedRuntimeRoot, "node", version, platformKey);
  const nodeBinary = nodeBinaryPath(targetDir, platform);
  const expectedVersion = `v${version}`;
  const installedVersion = await versionProbe(nodeBinary);
  if (installedVersion === expectedVersion) {
    applyArcaneFvttOpsEnvironment(env, nodeBinary, platform);
    return { nodeBinary, version, reused: true, source: null };
  }

  const manifestFile = path.join(resolvedBundledRoot, "manifest.json");
  const manifest = readJson(manifestFile);
  if (
    manifest?.schemaVersion !== 1
    || manifest?.version !== version
    || manifest?.platform !== platformKey
    || manifest?.file !== artifact.file
    || manifest?.sha256 !== artifact.sha256
  ) {
    throw new Error(`bundled Foundry Node manifest does not match the distribution for ${platformKey}`);
  }

  const archive = path.join(resolvedBundledRoot, artifact.file);
  if (!fs.existsSync(archive)) throw new Error(`bundled Foundry Node archive is missing: ${archive}`);
  const actualSha256 = await hashFile(archive);
  if (actualSha256 !== artifact.sha256) {
    throw new Error(`bundled Foundry Node archive SHA256 mismatch: expected ${artifact.sha256}; got ${actualSha256}`);
  }

  const staging = path.join(resolvedRuntimeRoot, ".staging", `node-${randomUUID()}`);
  const extracted = path.join(staging, "extracted");
  await fsp.mkdir(staging, { recursive: true });
  try {
    await archiveExtractor(archive, extracted);
    const preferredRoot = path.join(extracted, `node-v${version}-${platformKey}`);
    let incomingRoot = preferredRoot;
    if (!fs.existsSync(incomingRoot) || !fs.statSync(incomingRoot).isDirectory()) {
      const directories = (await fsp.readdir(extracted, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(extracted, entry.name));
      if (directories.length !== 1) {
        throw new Error(`bundled Foundry Node archive has ${directories.length} top-level directories; expected one`);
      }
      incomingRoot = directories[0];
    }

    const stagedBinary = nodeBinaryPath(incomingRoot, platform);
    const stagedVersion = await versionProbe(stagedBinary);
    if (stagedVersion !== expectedVersion) {
      throw new Error(`bundled Foundry Node version mismatch: expected ${expectedVersion}; got ${stagedVersion ?? "unavailable"}`);
    }

    await replaceDirectory(incomingRoot, targetDir);
    const activatedVersion = await versionProbe(nodeBinary);
    if (activatedVersion !== expectedVersion) {
      throw new Error(`activated Foundry Node version mismatch: expected ${expectedVersion}; got ${activatedVersion ?? "unavailable"}`);
    }
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }

  applyArcaneFvttOpsEnvironment(env, nodeBinary, platform);
  return { nodeBinary, version, reused: false, source: "bundled" };
}
