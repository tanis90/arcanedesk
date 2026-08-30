import fs from "node:fs";
import path from "node:path";

export const DESKTOP_RELEASE_SCHEMA_VERSION = 2;
export const DESKTOP_DATA_SCHEMA_VERSION = 1;
export const DESKTOP_NODE_PLATFORMS = ["win-x64", "win-arm64", "darwin-x64", "darwin-arm64"];

export function bundledNodePlatformKey(platform, arch, override = "") {
  const requested = String(override ?? "").trim();
  if (requested) {
    if (!DESKTOP_NODE_PLATFORMS.includes(requested)) {
      throw new Error(`unsupported bundled Node target override: ${requested}`);
    }
    return requested;
  }
  const detected = platform === "win32" && ["x64", "arm64"].includes(arch)
    ? `win-${arch}`
    : platform === "darwin" && ["x64", "arm64"].includes(arch)
      ? `darwin-${arch}`
      : null;
  if (!detected) throw new Error(`unsupported bundled Node target: ${platform}-${arch}`);
  return detected;
}

export function minimumOsForElectron(electronVersion) {
  const major = Number.parseInt(String(electronVersion).split(".")[0], 10);
  if (!Number.isInteger(major)) throw new TypeError(`invalid Electron version: ${electronVersion}`);
  return {
    windows: "10.0.17763",
    macos: major >= 44 ? "13.0" : major >= 43 ? "12.0" : "10.15",
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function directDependencyPackages(appRoot, appPackage) {
  return Object.keys(appPackage.dependencies ?? {}).map((name) => ({
    name,
    package: readJson(path.join(appRoot, "node_modules", ...name.split("/"), "package.json")),
  }));
}

export function validateRuntimeMetadata({
  appPackage,
  releaseManifest,
  distribution,
  electronRuntime,
  directPackages,
}) {
  const errors = [];
  const runtime = releaseManifest?.runtime ?? {};

  const expectEqual = (label, actual, expected) => {
    if (actual !== expected) errors.push(`${label}: expected ${expected}; got ${actual ?? "(missing)"}`);
  };

  expectEqual("release schema", releaseManifest?.schemaVersion, DESKTOP_RELEASE_SCHEMA_VERSION);
  expectEqual("release product version", releaseManifest?.product?.version, appPackage?.version);
  expectEqual("data schema", releaseManifest?.dataSchemaVersion, DESKTOP_DATA_SCHEMA_VERSION);
  expectEqual("Electron version", electronRuntime?.electron, runtime.electron);
  expectEqual("Electron Node version", electronRuntime?.node, runtime.node);
  expectEqual("Chromium version", electronRuntime?.chromium, runtime.chromium);
  expectEqual("Foundry Node version", distribution?.core?.node, runtime.foundryNode);
  if (typeof runtime.foundryNodeBundled !== "boolean") {
    errors.push("runtime.foundryNodeBundled must be a boolean");
  }

  const pi = directPackages.find(({ name }) => name === "@earendil-works/pi-coding-agent")?.package;
  expectEqual("Pi package version", pi?.version, runtime.pi);
  expectEqual(
    "Pi dependency pin",
    appPackage?.dependencies?.["@earendil-works/pi-coding-agent"],
    runtime.pi,
  );

  if (!appPackage?.license) errors.push("app package is missing a license declaration");
  for (const { name, package: dependencyPackage } of directPackages) {
    if (!dependencyPackage?.license && !dependencyPackage?.licenses) {
      errors.push(`direct dependency is missing a license declaration: ${name}`);
    }
  }

  if (!releaseManifest?.releaseId || !/^[A-Za-z0-9._-]+$/.test(releaseManifest.releaseId)) {
    errors.push("releaseId is missing or contains unsafe characters");
  }
  if (!releaseManifest?.source?.commit || !/^[0-9a-f]{40}$/i.test(releaseManifest.source.commit)) {
    errors.push("source.commit must be a full Git commit hash");
  }
  if (!("previousReleaseId" in (releaseManifest?.rollback ?? {}))) {
    errors.push("rollback.previousReleaseId is missing");
  }

  let expectedMinimumOs;
  try {
    expectedMinimumOs = minimumOsForElectron(runtime.electron);
  } catch {
    expectedMinimumOs = {};
    errors.push(`invalid release Electron version: ${runtime.electron ?? "(missing)"}`);
  }
  expectEqual("minimum Windows version", releaseManifest?.compatibility?.minimumOs?.windows, expectedMinimumOs.windows);
  expectEqual("minimum macOS version", releaseManifest?.compatibility?.minimumOs?.macos, expectedMinimumOs.macos);

  const artifacts = distribution?.core?.nodeArtifacts ?? {};
  const manifestArtifacts = releaseManifest?.runtime?.foundryNodeArtifacts ?? {};
  for (const key of DESKTOP_NODE_PLATFORMS) {
    const artifact = artifacts[key];
    if (!artifact?.file) errors.push(`Foundry Node artifact file is missing: ${key}`);
    if (!/^[0-9a-f]{64}$/i.test(artifact?.sha256 ?? "")) {
      errors.push(`Foundry Node artifact SHA256 is invalid: ${key}`);
    }
    expectEqual(`${key} release artifact file`, manifestArtifacts[key]?.file, artifact?.file);
    expectEqual(`${key} release artifact SHA256`, manifestArtifacts[key]?.sha256, artifact?.sha256);
  }

  return errors;
}
