import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bundledNodePlatformKey,
  minimumOsForElectron,
  validateRuntimeMetadata,
} from "../scripts/desktop-release-metadata.mjs";
import { exactDirectories, packagedLayout, requiredFiles, verifyPackagedApp } from "../scripts/verify-package.mjs";

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

// ---- 评审 P1 回归：packaged layout 必须随 region flavor 走 --------------------

// 在临时目录搭一个能通过 verifyPackagedApp 全部检查的最小合成包。
// region.json 是包的自声明；skipIntlBaselines 用于模拟「intl 构建没带上基线」。
function stagePackagedApp(t, region, { skipIntlBaselines = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcane-verify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // appRoot 嵌在 resources/ 下：win32 宿主的 Electron 许可证强制检查与
  // bundled Node 都相对 resources 解析，全部留在临时目录内。
  const appRoot = path.join(root, "resources", "app");
  const data = fixture();

  const write = (rel, body) => {
    const target = path.join(appRoot, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  // 先按布局铺占位文件，再覆盖需要真实内容的 JSON。
  const stagedLayout = packagedLayout(skipIntlBaselines ? "cn" : region);
  for (const rel of stagedLayout.required) write(rel, "placeholder");
  write("package.json", JSON.stringify(data.appPackage));
  write("generated/desktop-release.json", JSON.stringify(data.releaseManifest));
  write("generated/region.json", JSON.stringify({ region }));
  // 两个直连依赖会被 directDependencyPackages 真实读取并参与元数据校验。
  write("node_modules/@arcanedesk/foundry-sdk/package.json", JSON.stringify({
    name: "@arcanedesk/foundry-sdk",
    version: "0.1.0",
    license: "Apache-2.0",
  }));
  write("node_modules/@earendil-works/pi-coding-agent/package.json", JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.3",
    license: "MIT",
  }));

  // bundled Node：manifest 与 dummy 压缩包的真实 sha256 要对齐 distribution。
  const archiveBody = Buffer.from("dummy node archive");
  const archiveSha256 = createHash("sha256").update(archiveBody).digest("hex");
  const nodeArtifacts = {
    ...data.distribution.core.nodeArtifacts,
    "win-x64": { file: "node-win.zip", sha256: archiveSha256 },
  };
  const distribution = { core: { node: "22.23.2", nodeArtifacts } };
  write("distribution/community-distribution.json", JSON.stringify(distribution));
  const releaseManifest = structuredClone(data.releaseManifest);
  releaseManifest.runtime.foundryNodeArtifacts = nodeArtifacts;
  write("generated/desktop-release.json", JSON.stringify(releaseManifest));
  const bundledRoot = path.join(root, "resources", "runtime", "node");
  fs.mkdirSync(bundledRoot, { recursive: true });
  fs.writeFileSync(path.join(bundledRoot, "node-win.zip"), archiveBody);
  fs.writeFileSync(path.join(bundledRoot, "manifest.json"), JSON.stringify({
    platform: "win-x64",
    version: "22.23.2",
    file: "node-win.zip",
    sha256: archiveSha256,
    source: "https://nodejs.org/dist/v22.23.2/node-win.zip",
    license: "https://raw.githubusercontent.com/nodejs/node/v22.23.2/LICENSE",
  }));

  // win32 宿主强制 Electron 许可证文件（位于 resources 上一级），其余平台仅警告。
  for (const file of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
    fs.writeFileSync(path.join(root, file), "placeholder");
  }
  return { appRoot, data };
}

test("intl packaged layout requires the composed english baselines", () => {
  const layout = packagedLayout("intl");
  assert.deepEqual(
    [...layout.exact.get("generated")].sort(),
    ["desktop-release.json", "region.json", "renderer-assets", "skills-intl", "system-prompts-intl"],
  );
  assert.deepEqual(layout.exact.get("generated/skills-intl"), ["prep"]);
  assert.deepEqual(layout.exact.get("generated/skills-intl/prep"), exactDirectories.get("skills/prep"));
  assert.deepEqual(layout.exact.get("generated/system-prompts-intl"), ["combat.md", "prep.md"]);
  for (const rel of [
    "generated/skills-intl/prep/bundle.json",
    "generated/skills-intl/prep/arcane-fvtt-mods/SKILL.md",
    "generated/skills-intl/prep/arcane-module-reader/SKILL.md",
    "generated/system-prompts-intl/combat.md",
    "generated/system-prompts-intl/prep.md",
  ]) {
    assert.equal(layout.required.includes(rel), true, rel);
  }
});

test("cn packaged layout keeps the base generated contract", () => {
  const layout = packagedLayout("cn");
  assert.deepEqual(layout.exact.get("generated"), ["desktop-release.json", "region.json", "renderer-assets"]);
  assert.equal(layout.exact.has("generated/skills-intl"), false);
  assert.equal(layout.exact.has("generated/system-prompts-intl"), false);
  assert.equal(layout.required.includes("generated/skills-intl/prep/bundle.json"), false);
});

test("verifyPackagedApp accepts a fully staged intl package (P1 regression)", (t) => {
  const { appRoot, data } = stagePackagedApp(t, "intl");
  const result = verifyPackagedApp(appRoot, { electronRuntime: data.electronRuntime });
  assert.deepEqual(result.errors, []);
});

test("verifyPackagedApp accepts a fully staged cn package", (t) => {
  const { appRoot, data } = stagePackagedApp(t, "cn");
  const result = verifyPackagedApp(appRoot, { electronRuntime: data.electronRuntime });
  assert.deepEqual(result.errors, []);
});

test("verifyPackagedApp rejects an intl package missing the composed baselines (P1)", (t) => {
  const { appRoot, data } = stagePackagedApp(t, "intl", { skipIntlBaselines: true });
  const result = verifyPackagedApp(appRoot, { electronRuntime: data.electronRuntime });
  const text = result.errors.join("\n");
  assert.match(text, /generated contents differ/);
  assert.match(text, /missing required file: generated\/skills-intl\/prep\/bundle\.json/);
});

test("verifyPackagedApp rejects stale intl baselines leaking into a cn package (P1)", (t) => {
  const { appRoot, data } = stagePackagedApp(t, "cn");
  const stray = path.join(appRoot, "generated", "skills-intl", "prep");
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, "bundle.json"), "{}");
  const result = verifyPackagedApp(appRoot, { electronRuntime: data.electronRuntime });
  assert.match(result.errors.join("\n"), /generated contents differ/);
});

test("verifyPackagedApp rejects a packaged region that mismatches --expected-region", (t) => {
  const { appRoot, data } = stagePackagedApp(t, "intl");
  const result = verifyPackagedApp(appRoot, { electronRuntime: data.electronRuntime, expectedRegion: "cn" });
  assert.match(result.errors.join("\n"), /packaged region: expected cn; got intl/);
});
