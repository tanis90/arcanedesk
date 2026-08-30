import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledNodePlatformKey,
  minimumOsForElectron,
  validateRuntimeMetadata,
} from "../scripts/desktop-release-metadata.mjs";
import { exactDirectories, requiredFiles } from "../scripts/verify-package.mjs";

const artifact = (file) => ({ file, sha256: "a".repeat(64) });

function fixture() {
  const nodeArtifacts = {
    "win-x64": artifact("node-win.zip"),
    "win-arm64": artifact("node-win-arm64.zip"),
    "darwin-x64": artifact("node-mac-x64.tar.gz"),
    "darwin-arm64": artifact("node-mac-arm64.tar.gz"),
  };
  return {
    appPackage: {
      version: "0.1.0",
      license: "Apache-2.0",
      dependencies: {
        "@arcanedesk/foundry-sdk": "0.1.0",
        "@earendil-works/pi-coding-agent": "0.84.3",
      },
    },
    releaseManifest: {
      schemaVersion: 2,
      releaseId: "0.1.0-deadbeef",
      product: { version: "0.1.0" },
      source: { commit: "a".repeat(40) },
      runtime: {
        electron: "44.0.0",
        node: "24.18.1",
        chromium: "152.0.0.0",
        pi: "0.84.3",
        foundryNode: "22.23.2",
        foundryNodeBundled: true,
        foundryNodeArtifacts: nodeArtifacts,
      },
      compatibility: { minimumOs: { windows: "10.0.17763", macos: "13.0" } },
      rollback: { previousReleaseId: "0.1.0-previous" },
      dataSchemaVersion: 1,
    },
    distribution: { core: { node: "22.23.2", nodeArtifacts } },
    electronRuntime: { electron: "44.0.0", node: "24.18.1", chromium: "152.0.0.0" },
    directPackages: [
      { name: "@arcanedesk/foundry-sdk", package: { version: "0.1.0", license: "Apache-2.0" } },
      { name: "@earendil-works/pi-coding-agent", package: { version: "0.84.3", license: "MIT" } },
    ],
  };
}

test("release metadata pins the supported OS floor per Electron line", () => {
  assert.deepEqual(minimumOsForElectron("37.10.3"), { windows: "10.0.17763", macos: "10.15" });
  assert.deepEqual(minimumOsForElectron("43.4.1"), { windows: "10.0.17763", macos: "12.0" });
  assert.deepEqual(minimumOsForElectron("44.0.0"), { windows: "10.0.17763", macos: "13.0" });
});

test("bundled Node target uses an explicit cross-build override", () => {
  assert.equal(bundledNodePlatformKey("win32", "x64"), "win-x64");
  assert.equal(bundledNodePlatformKey("win32", "x64", "win-arm64"), "win-arm64");
  assert.equal(bundledNodePlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.throws(
    () => bundledNodePlatformKey("win32", "x64", "linux-x64"),
    /unsupported bundled Node target override/,
  );
});

test("packaged runtime metadata accepts a fully exact matrix", () => {
  assert.deepEqual(validateRuntimeMetadata(fixture()), []);
});

test("packaged app must carry project and third-party legal notices", () => {
  assert.deepEqual(
    ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"].filter((file) => requiredFiles.includes(file)),
    ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"],
  );
});

test("packaged app verifier requires the mod-management skill and helper", () => {
  assert.equal(requiredFiles.includes("skills/prep/arcane-fvtt-mods/SKILL.md"), true);
  assert.equal(requiredFiles.includes("skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs"), true);
  assert.equal(exactDirectories.get("skills/prep").includes("arcane-fvtt-mods"), true);
});

test("old Pi content fails even when all expected files exist", () => {
  const input = fixture();
  input.directPackages.find(({ name }) => name === "@earendil-works/pi-coding-agent").package.version = "0.84.1";
  assert.match(validateRuntimeMetadata(input).join("\n"), /Pi package version: expected 0\.84\.3; got 0\.84\.1/);
});

test("runtime drift and malformed Node hashes are rejected", () => {
  const input = fixture();
  input.electronRuntime.node = "22.21.1";
  input.distribution.core.nodeArtifacts["win-x64"].sha256 = "bad";
  const errors = validateRuntimeMetadata(input).join("\n");
  assert.match(errors, /Electron Node version/);
  assert.match(errors, /Foundry Node artifact SHA256 is invalid: win-x64/);
});
