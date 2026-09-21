#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenEntries = [
  "key",
  "node_modules",
  ".idea",
  "package-lock.json",
  "distribution/releases",
];
const forbiddenText = [
  /[A-Za-z]:[\\/]code[\\/]Arcane-Desk(?:[\\/]|\b)/i,
];
const ignoredDirectories = new Set([".git", "generated", "node_modules", "dist"]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".ts",
  ".txt",
]);
const policyFiles = new Set(["scripts/verify-package.mjs", "scripts/verify-source.mjs"]);
const exactDirectories = new Map([
  ["scripts", [
    "archive-zip.mjs",
    "archive.mjs",
    "audit-package-mirror.mjs",
    "build-server-image.mjs",
    "check-server-image-revision.mjs",
    "check-skills-revision.mjs",
    "desktop-release-metadata.mjs",
    "dist.mjs",
    "e2e-drive-update.mjs",
    "e2e-local-feed-server.mjs",
    "e2e-make-feed.mjs",
    "e2e-verify-version.mjs",
    "intl-world-gate.mjs",
    "intl-world-policy.mjs",
    "mac-adhoc-sign.mjs",
    "make-fake-foundry-zip.mjs",
    "module-builder-vendor",
    "prepare-bundled-node.mjs",
    "prepare-desktop-release.mjs",
    "prepare-intl-index.mjs",
    "prepare-renderer-assets.mjs",
    "prepare-world-profile.mjs",
    "publish-intl-world.mjs",
    "publish-release.mjs",
    "publish-server-image.mjs",
    "publish-skills.mjs",
    "sign-windows.mjs",
    "stage-release.mjs",
    "vendor-module-builder.mjs",
    "verify-package.mjs",
    "verify-source.mjs",
    "verify-update-feed.mjs",
    "write-sha256sums.mjs",
  ]],
  ["distribution", {
    required: ["community-distribution.json", "intl-mod-curation.json", "oss-release-contract.md"],
    // promote-release 回写的 latest 指针镜像：cn/intl 各自可选，随拍板先后出现；
    // server-image/ 是服务器轨道的镜像配方（见 docs/server-deploy-plan.md §4）
    optional: [/^desktop-latest(?:-intl)?\.json$/, /^server-image$/],
  }],
]);

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const errors = [];
for (const relative of forbiddenEntries) {
  if (fs.existsSync(path.join(desktopRoot, relative))) {
    errors.push(`forbidden source entry exists: ${relative}`);
  }
}

for (const [relative, expected] of exactDirectories) {
  const directory = path.join(desktopRoot, relative);
  const actual = fs.readdirSync(directory).sort();
  if (Array.isArray(expected)) {
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      errors.push(`${relative} contents differ: expected ${wanted.join(", ")}; got ${actual.join(", ")}`);
    }
    continue;
  }
  const required = [...expected.required].sort();
  const missing = required.filter((name) => !actual.includes(name));
  const unexpected = actual.filter(
    (name) => !required.includes(name) && !expected.optional.some((pattern) => pattern.test(name)),
  );
  if (missing.length || unexpected.length) {
    errors.push(
      `${relative} contents differ: missing ${missing.join(", ") || "none"}; unexpected ${unexpected.join(", ") || "none"}`,
    );
  }
}

for (const file of walk(desktopRoot)) {
  const extension = file.endsWith(".d.ts") ? ".d.ts" : path.extname(file).toLowerCase();
  if (!textExtensions.has(extension)) continue;
  const relative = path.relative(desktopRoot, file).replaceAll(path.sep, "/");
  if (policyFiles.has(relative)) continue;
  const contents = fs.readFileSync(file, "utf8");
  for (const pattern of forbiddenText) {
    if (pattern.test(contents)) errors.push(`forbidden source reference in ${relative}: ${pattern}`);
  }
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Desktop source boundary verified.\n");
