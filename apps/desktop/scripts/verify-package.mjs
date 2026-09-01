#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  directDependencyPackages,
  readJson,
  validateRuntimeMetadata,
} from "./desktop-release-metadata.mjs";
import { macBundleRoot } from "./mac-adhoc-sign.mjs";

export const requiredFiles = [
  "package.json",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "preload.cjs",
  "src/main/main.js",
  "src/main/fvtt-ops-runtime.mjs",
  "system-prompts/combat.md",
  "system-prompts/prep.md",
  "skills/prep/bundle.json",
  "skills/prep/arcane-fvtt-ops/SKILL.md",
  "skills/prep/arcane-fvtt-setup/SKILL.md",
  "skills/prep/arcane-fvtt-setup/references/windows-install.md",
  "skills/prep/arcane-fvtt-setup/references/macos-install.md",
  "skills/prep/arcane-fvtt-mods/SKILL.md",
  "skills/prep/arcane-fvtt-mods/references/install.md",
  "skills/prep/arcane-fvtt-mods/references/updates.md",
  "skills/prep/arcane-fvtt-mods/references/demo-world.md",
  "skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs",
  "skills/prep/arcane-fvtt-mods/scripts/archive-zip.mjs",
  "skills/prep/arcane-fvtt-mods/scripts/node_modules/yauzl/package.json",
  "skills/prep/arcane-fvtt-mods/scripts/node_modules/pend/package.json",
  "skills/prep/arcane-actor-update/SKILL.md",
  "skills/prep/arcane-module-reader/SKILL.md",
  "scripts/archive-zip.mjs",
  "scripts/archive.mjs",
  "distribution/community-distribution.json",
  "generated/desktop-release.json",
  "generated/renderer-assets/marked/lib/marked.umd.js",
  "generated/renderer-assets/highlightjs/cdn-assets/highlight.min.js",
  "generated/renderer-assets/highlightjs/cdn-assets/styles/nord.min.css",
  "generated/renderer-assets/highlightjs/cdn-assets/styles/stackoverflow-light.min.css",
  "generated/renderer-assets/katex/dist/katex.min.js",
  "generated/renderer-assets/katex/dist/katex.min.css",
  "generated/renderer-assets/katex/dist/fonts/KaTeX_Main-Regular.woff2",
  "generated/renderer-assets/mermaid/dist/mermaid.min.js",
  "node_modules/@arcanedesk/foundry-sdk/package.json",
  "node_modules/@earendil-works/pi-coding-agent/package.json",
  "node_modules/typebox/package.json",
  "node_modules/marked/lib/marked.umd.js",
  "node_modules/@highlightjs/cdn-assets/highlight.min.js",
  "node_modules/@highlightjs/cdn-assets/styles/nord.min.css",
  "node_modules/@highlightjs/cdn-assets/styles/stackoverflow-light.min.css",
  "node_modules/katex/dist/katex.min.js",
  "node_modules/katex/dist/katex.min.css",
  "node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2",
  "node_modules/mermaid/dist/mermaid.min.js",
];

const forbiddenPaths = [
  "vendor/foundry-vtt-mcp",
  "node_modules/better-sqlite3",
  "git-bash",
  "mingw64",
  "usr/bin/bash.exe",
];

export const exactDirectories = new Map([
  ["system-prompts", ["combat.md", "prep.md"]],
  ["skills/prep", ["arcane-actor-update", "arcane-fvtt-mods", "arcane-fvtt-ops", "arcane-fvtt-setup", "arcane-module-reader", "bundle.json"]],
  ["skills/prep/arcane-fvtt-mods/scripts", ["archive-zip.mjs", "mod-manager.mjs", "node_modules"]],
  ["scripts", ["archive-zip.mjs", "archive.mjs"]],
  ["distribution", ["community-distribution.json"]],
  ["generated", ["desktop-release.json", "renderer-assets"]],
]);

function packagedElectronPath(appRoot, productName) {
  const resources = path.dirname(appRoot);
  if (process.platform === "win32") return path.join(path.dirname(resources), `${productName}.exe`);
  if (process.platform === "darwin") return path.join(path.dirname(resources), "MacOS", productName);
  return null;
}

function inspectElectronRuntime(executable) {
  if (!executable || !fs.existsSync(executable)) {
    throw new Error(`packaged Electron executable is missing: ${executable ?? "unsupported platform"}`);
  }
  return JSON.parse(execFileSync(
    executable,
    ["-e", "process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,chromium:process.versions.chrome}))"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 15_000,
      windowsHide: true,
    },
  ));
}

function electronLicensePaths(appRoot) {
  const resources = path.dirname(appRoot);
  // darwin 上 Electron 各版本把 license 放置的位置不一致（Resources/ 或 bundle 根），
  // 逐个候选探测；全部缺失则由调用方降级为警告（Windows 仍然强制）。
  const candidates = (file) =>
    process.platform === "win32"
      ? [path.join(path.dirname(resources), file)]
      : [path.join(resources, file), path.join(path.dirname(path.dirname(resources)), file)];
  return [candidates("LICENSE.electron.txt"), candidates("LICENSES.chromium.html")];
}

function verifyBundledNode(appRoot, releaseManifest, distribution, expectedPlatform) {
  const errors = [];
  const bundledRoot = path.join(path.dirname(appRoot), "runtime", "node");
  if (!releaseManifest.runtime.foundryNodeBundled) {
    if (fs.existsSync(bundledRoot)) errors.push("bundled Node exists but release manifest marks it unbundled");
    return errors;
  }
  try {
    const manifest = readJson(path.join(bundledRoot, "manifest.json"));
    // 平台以包内 manifest 声明为准（交叉构建时 runner 架构 ≠ 目标架构），
    // 只接受 distribution 固定的四个目标。
    const platformKey = manifest.platform;
    const expected = distribution.core.nodeArtifacts[platformKey];
    if (!expected) return [`bundled Node declares an unpinned platform: ${platformKey}`];
    if (expectedPlatform && platformKey !== expectedPlatform) {
      errors.push(`bundled Node platform: expected ${expectedPlatform}; got ${platformKey}`);
    }
    const archive = path.join(bundledRoot, manifest.file);
    const actualSha256 = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (manifest.version !== releaseManifest.runtime.foundryNode) {
      errors.push(`bundled Node version: expected ${releaseManifest.runtime.foundryNode}; got ${manifest.version}`);
    }
    if (manifest.file !== expected.file) errors.push(`bundled Node file: expected ${expected.file}; got ${manifest.file}`);
    if (manifest.sha256 !== expected.sha256) errors.push("bundled Node manifest SHA256 differs from the distribution");
    if (actualSha256 !== expected.sha256) errors.push(`bundled Node archive SHA256 mismatch: ${actualSha256}`);
    if (manifest.source !== `https://nodejs.org/dist/v${manifest.version}/${manifest.file}`) {
      errors.push(`bundled Node source is not the pinned official URL: ${manifest.source}`);
    }
    if (!manifest.license) errors.push("bundled Node license declaration is missing");
  } catch (error) {
    errors.push(`bundled Node inspection failed: ${error.message}`);
  }
  return errors;
}

// macOS 分发未走 Developer ID 签名/公证，但包内签名必须"有效"：签名失效时
// Gatekeeper 报"已损坏"且无 GUI 绕过；有效的 ad-hoc 签名则回落为可绕过的
// "无法验证开发者"提示（accepted 为将来签名+公证后的形态）。
function verifyMacBundleSignature(bundlePath) {
  const errors = [];
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", bundlePath], { encoding: "utf8" });
  if (verify.status !== 0) {
    const detail = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
    errors.push(`macOS bundle signature is invalid; Gatekeeper would report the app as damaged: ${detail}`);
    return errors;
  }
  const assess = spawnSync("spctl", ["--assess", "--type", "execute", "--verbose", bundlePath], { encoding: "utf8" });
  const output = `${assess.stdout ?? ""}${assess.stderr ?? ""}`;
  if (!/\b(accepted|rejected)\b/.test(output)) {
    errors.push(`unexpected Gatekeeper assessment for ${bundlePath}: ${output.trim() || `exit ${assess.status}`}`);
  }
  return errors;
}

export function verifyPackagedApp(appRootArg, options = {}) {
  const appRoot = path.resolve(appRootArg);
  const errors = [];
  if (!fs.existsSync(appRoot) || !fs.statSync(appRoot).isDirectory()) {
    return { ok: false, appRoot, errors: [`packaged app resource directory does not exist: ${appRoot}`] };
  }

  for (const relative of requiredFiles) {
    const target = path.join(appRoot, relative);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`missing required file: ${relative}`);
  }
  for (const relative of forbiddenPaths) {
    if (fs.existsSync(path.join(appRoot, relative))) errors.push(`forbidden maintainer/deprecated resource is packaged: ${relative}`);
  }
  for (const [relative, expected] of exactDirectories) {
    const target = path.join(appRoot, relative);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) continue;
    const actual = fs.readdirSync(target).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      errors.push(`${relative} contents differ: expected ${wanted.join(", ")}; got ${actual.join(", ")}`);
    }
  }

  for (const candidates of electronLicensePaths(appRoot)) {
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) continue;
    const label = path.basename(candidates[0]);
    if (process.platform === "win32") {
      errors.push(`Electron license file is missing: ${label}`);
    } else {
      // darwin 的 Electron 发行布局随版本漂移；找不到时警告而非阻断发布。
      console.warn(`warning: Electron license file not found on darwin package: ${label}`);
    }
  }

  try {
    const appPackage = readJson(path.join(appRoot, "package.json"));
    const releaseManifest = readJson(path.join(appRoot, "generated", "desktop-release.json"));
    const distribution = readJson(path.join(appRoot, "distribution", "community-distribution.json"));
    const directPackages = directDependencyPackages(appRoot, appPackage);
    const electronRuntime = options.electronRuntime ?? inspectElectronRuntime(
      packagedElectronPath(appRoot, appPackage.productName),
    );
    errors.push(...validateRuntimeMetadata({
      appPackage,
      releaseManifest,
      distribution,
      electronRuntime,
      directPackages,
    }));
    errors.push(...verifyBundledNode(appRoot, releaseManifest, distribution, options.expectedNodePlatform));
  } catch (error) {
    errors.push(`runtime metadata inspection failed: ${error.message}`);
  }

  // codesign/spctl 只在 macOS 宿主上可用；Windows 交叉产物无 bundle 可查。
  const bundle = process.platform === "darwin" ? macBundleRoot(appRoot) : null;
  if (bundle) errors.push(...verifyMacBundleSignature(bundle));

  return {
    ok: errors.length === 0,
    appRoot,
    errors,
    requiredFiles: requiredFiles.length,
    userSkills: exactDirectories.get("skills/prep"),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const argv = process.argv.slice(2);
  let appRootArg = null;
  let runtimeFromManifest = false;
  let expectedNodePlatform = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--runtime-from-manifest") runtimeFromManifest = true;
    else if (value === "--expected-node-platform") expectedNodePlatform = argv[++index] ?? null;
    else if (value.startsWith("--")) {
      console.error(`unknown option: ${value}`);
      process.exit(2);
    } else if (!appRootArg) appRootArg = value;
    else {
      console.error(`unexpected positional argument: ${value}`);
      process.exit(2);
    }
  }
  if (!appRootArg) {
    console.error("usage: node scripts/verify-package.mjs <packaged-resources-app-dir> [--runtime-from-manifest] [--expected-node-platform <platform>]");
    process.exit(2);
  }
  // 交叉构建（x64 runner 打 arm64 包）无法执行目标 exe：改用包内 manifest 的
  // runtime 元数据（由同一份 electron 在构建期生成，与打包产物一致）。
  const options = runtimeFromManifest
    ? {
        electronRuntime: (() => {
          const m = readJson(path.join(appRootArg, "generated", "desktop-release.json"));
          return { electron: m.runtime.electron, node: m.runtime.node, chromium: m.runtime.chromium };
        })(),
      }
    : {};
  options.expectedNodePlatform = expectedNodePlatform;
  const result = verifyPackagedApp(appRootArg, options);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(1);
}
