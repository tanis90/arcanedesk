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
const latestFile = path.join(desktopRoot, "distribution", "desktop-latest.json");
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

const output = path.join(desktopRoot, "generated", "desktop-release.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
fs.writeFileSync(
  path.join(desktopRoot, "generated", "region.json"),
  `${JSON.stringify(regionManifest, null, 2)}\n`,
  "utf8",
);

// intl flavor 的包内英文基线（国际化方案 M4）：组合 skills（cn 脚本单源 +
// skills/prep-intl 翻译覆盖，组合器自带孤儿/覆盖率/CJK 渗漏门禁），并复制
// system-prompts-intl（同样过 CJK 门禁）。运行期目录选择见 region.mjs 默认值表。
// cn 构建清掉可能残留的 intl 基线，避免陈旧内容随包。
const intlSkillsOut = path.join(desktopRoot, "generated", "skills-intl", "prep");
const intlPromptsOut = path.join(desktopRoot, "generated", "system-prompts-intl");
if (buildRegion === "intl") {
  const { composeIntlSkills, assertNoCjkLeak } = await import("./compose-intl-skills.mjs");
  await composeIntlSkills({ outDir: intlSkillsOut });
  const promptsSource = path.join(desktopRoot, "system-prompts-intl");
  fs.rmSync(intlPromptsOut, { recursive: true, force: true });
  fs.mkdirSync(intlPromptsOut, { recursive: true });
  for (const name of fs.readdirSync(promptsSource)) {
    const body = fs.readFileSync(path.join(promptsSource, name), "utf8");
    assertNoCjkLeak(body, `system-prompts-intl/${name}`);
    fs.writeFileSync(path.join(intlPromptsOut, name), body, "utf8");
  }
  process.stdout.write("Intl baselines composed: generated/skills-intl/prep + generated/system-prompts-intl\n");
} else {
  fs.rmSync(path.join(desktopRoot, "generated", "skills-intl"), { recursive: true, force: true });
  fs.rmSync(intlPromptsOut, { recursive: true, force: true });
}
process.stdout.write(`Prepared Desktop release ${releaseId} (${electronRuntime.electron}/${electronRuntime.node}, region ${buildRegion})\n`);
