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
    "archive.mjs",
    "audit-package-mirror.mjs",
    "desktop-release-metadata.mjs",
    "mac-adhoc-sign.mjs",
    "prepare-bundled-node.mjs",
    "prepare-desktop-release.mjs",
    "prepare-renderer-assets.mjs",
    "prepare-world-profile.mjs",
    "publish-release.mjs",
    "verify-package.mjs",
    "verify-source.mjs",
    "write-sha256sums.mjs",
  ]],
  ["distribution", ["community-distribution.json", "oss-release-contract.md"]],
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
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${relative} contents differ: expected ${wanted.join(", ")}; got ${actual.join(", ")}`);
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
