#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_DATA_SCHEMA_VERSION,
  DESKTOP_RELEASE_SCHEMA_VERSION,
  minimumOsForElectron,
  readJson,
} from "./desktop-release-metadata.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "..", "..");
const require = createRequire(import.meta.url);
const electronPath = /** @type {string} */ (require("electron"));
const appPackage = readJson(path.join(desktopRoot, "package.json"));
const distribution = readJson(path.join(desktopRoot, "distribution", "community-distribution.json"));

function packageJsonFromEntry(packageName) {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
  while (true) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      const packageJson = readJson(candidate);
      if (packageJson.name === packageName) return packageJson;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`could not locate package.json for ${packageName}`);
    directory = parent;
  }
}

const piPackage = packageJsonFromEntry("@earendil-works/pi-coding-agent");

const electronRuntime = JSON.parse(execFileSync(
  electronPath,
  ["-e", "process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,chromium:process.versions.chrome}))"],
  {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 15_000,
    windowsHide: true,
  },
));

function resolveSourceCommit() {
  const explicit = String(process.env.ARCANE_SOURCE_COMMIT ?? "").trim();
  if (explicit) {
    if (!/^[0-9a-f]{40}$/i.test(explicit)) {
      throw new Error("ARCANE_SOURCE_COMMIT must be a full Git commit hash");
    }
    return explicit;
  }
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // A freshly initialized public repository has no HEAD until its first commit.
    // Keep directory builds testable while retaining a schema-valid sentinel.
    return "0".repeat(40);
  }
}

// 构建期 region flavor（国际化方案 D1）：ARCANE_BUILD_REGION 默认 cn，生成
// 包内 generated/region.json，运行期由 src/main/region.mjs 读取。
const buildRegion = String(process.env.ARCANE_BUILD_REGION ?? "cn").trim() || "cn";
if (!["cn", "intl"].includes(buildRegion)) {
  throw new Error(`ARCANE_BUILD_REGION must be one of cn/intl; got: ${buildRegion}`);
}

const commit = resolveSourceCommit();
// rollback 链按 region 各自回指：读本区 latest 指针文件，否则 cn 先发版会把
// intl 基座的 previousReleaseId 带成 cn 的 release id（跨区错链）。
const latestFile = path.join(
  desktopRoot,
  "distribution",
  buildRegion === "intl" ? "desktop-latest-intl.json" : "desktop-latest.json",
);
const previousReleaseId = fs.existsSync(latestFile) ? readJson(latestFile).releaseId ?? null : null;
const sourceLabel = /^0+$/.test(commit) ? "working-tree" : commit.slice(0, 8);
// intl 默认 releaseId 带 -intl 后缀（国际化方案 D5），与 cn 版本目录/GitHub tag 区分；
// 显式 ARCANE_RELEASE_ID 原样尊重。
const releaseId = process.env.ARCANE_RELEASE_ID
  || `${appPackage.version}-${sourceLabel}${buildRegion === "intl" ? "-intl" : ""}`;

const manifest = {
  schemaVersion: DESKTOP_RELEASE_SCHEMA_VERSION,
  releaseId,
  channel: process.env.ARCANE_RELEASE_CHANNEL || "development",
  product: {
    id: appPackage.name,
    name: appPackage.productName,
    appId: appPackage.build.appId,
    version: appPackage.version,
    license: appPackage.license,
  },
  source: { commit },
  runtime: {
    ...electronRuntime,
    pi: piPackage.version,
    foundryNode: distribution.core.node,
    foundryNodeBundled: Boolean(appPackage.build?.extraResources?.some?.((entry) => entry?.to === "runtime/node")),
    foundryNodeArtifacts: distribution.core.nodeArtifacts,
  },
  compatibility: {
    minimumOs: minimumOsForElectron(electronRuntime.electron),
    foundry: distribution.core.foundry,
    dnd5e: distribution.systems.find((system) => system.id === "dnd5e")?.version ?? null,
  },
  rollback: { previousReleaseId },
  dataSchemaVersion: DESKTOP_DATA_SCHEMA_VERSION,
};

if (process.env.ARCANE_RELEASE_PUBLISHED_AT) manifest.publishedAt = process.env.ARCANE_RELEASE_PUBLISHED_AT;

const regionManifest = { schemaVersion: 1, region: buildRegion };

// electron-updater 运行期硬依赖（auto-update-design §5.1/§5.4）：下载阶段必读
// resources/app-update.yml 的 updaterCacheDirName（缺失 ENOENT），不走 builder publish
// 则 electron-builder 不会生成它。占位 url 无发布语义，运行期被 setFeedURL 整体覆盖。
const appUpdateManifest = {
  provider: "generic",
  url: "https://127.0.0.1/",
  updaterCacheDirName: appPackage.productName,
};

const output = path.join(desktopRoot, "generated", "desktop-release.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.writeFileSync(
  path.join(desktopRoot, "generated", "region.json"),
  `${JSON.stringify(regionManifest, null, 2)}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(desktopRoot, "generated", "app-update.yml"),
  [
    `# ${appPackage.productName} auto-update runtime config (placeholder; overridden by setFeedURL at runtime).`,
    `provider: ${appUpdateManifest.provider}`,
    `url: ${appUpdateManifest.url}`,
    `updaterCacheDirName: ${appUpdateManifest.updaterCacheDirName}`,
    "",
  ].join("\n"),
  "utf8",
);

// intl flavor 的包内英文基线：skills 两 flavor 共用中文单源 skills/prep（skill 是
// 模型侧指令，不随界面语言分叉）；system-prompts-intl 仍是独立英文树，复制时过
// CJK 渗漏门禁。运行期目录选择见 region.mjs 默认值表。
// cn 构建清掉可能残留的 intl 基线，避免陈旧内容随包。
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿]/;
const assertNoCjkLeak = (body, label) => {
  if (CJK_PATTERN.test(body)) throw new Error(`${label} contains CJK characters (Chinese leakage)`);
};
const intlPromptsOut = path.join(desktopRoot, "generated", "system-prompts-intl");
if (buildRegion === "intl") {
  const promptsSource = path.join(desktopRoot, "system-prompts-intl");
  fs.rmSync(intlPromptsOut, { recursive: true, force: true });
  fs.mkdirSync(intlPromptsOut, { recursive: true });
  for (const name of fs.readdirSync(promptsSource)) {
    const body = fs.readFileSync(path.join(promptsSource, name), "utf8");
    assertNoCjkLeak(body, `system-prompts-intl/${name}`);
    fs.writeFileSync(path.join(intlPromptsOut, name), body, "utf8");
  }
  process.stdout.write("Intl baseline composed: generated/system-prompts-intl\n");
} else {
  fs.rmSync(intlPromptsOut, { recursive: true, force: true });
}
process.stdout.write(`Prepared Desktop release ${releaseId} (${electronRuntime.electron}/${electronRuntime.node}, region ${buildRegion})\n`);
