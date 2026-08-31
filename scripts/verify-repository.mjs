#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { basename, extname, resolve, relative, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

const output = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
);

const files = output
  .split("\0")
  .filter((file) => file && existsSync(resolve(repositoryRoot, file)))
  .sort();
const errors = [];
const warnings = [];

const forbiddenFileNames = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
]);

const textExtensions = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sourcePatterns = [
  { pattern: /npm\s+--prefix\s+\.\.\/\.\./i, label: "parent repository npm dependency" },
  { pattern: /packages[\\/]arcane-fvtt-cli[\\/]dist[\\/]foundry-runtime/i, label: "legacy CLI runtime staging" },
  { pattern: /\.local-secrets/i, label: "private secret directory" },
];

for (const [value, label] of [
  [repositoryRoot, "current repository absolute path"],
  [process.env.USERPROFILE, "current user profile absolute path"],
]) {
  if (value) sourcePatterns.push({ pattern: new RegExp(escapeRegExp(value), "i"), label });
}

const sourcePatternExemptions = new Set([
  ".gitignore",
  "scripts/verify-repository.mjs",
]);

const likelySecretPatterns = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "private key material" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS-style access key" },
  { pattern: /\bLTAI[0-9A-Za-z]{12,}\b/, label: "Alibaba Cloud access key" },
  { pattern: /(?:api[_-]?key|secret|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i, label: "literal credential" },
];

for (const file of files) {
  const absolute = resolve(repositoryRoot, file);
  const normalized = relative(repositoryRoot, absolute);
  if (normalized.startsWith(`..${sep}`) || normalized === "..") {
    errors.push(`${file}: resolves outside the repository`);
    continue;
  }

  const stats = statSync(absolute);
  if (!stats.isFile()) continue;
  if (stats.size > 5 * 1024 * 1024) {
    errors.push(`${file}: file is larger than 5 MiB (${stats.size} bytes)`);
  }

  const lowerName = basename(file).toLowerCase();
  if (forbiddenFileNames.has(lowerName) || lowerName === "key" || lowerName.endsWith(".pem")) {
    errors.push(`${file}: forbidden credential-like filename`);
  }
  if (basename(file) === "package-lock.json" && file !== "package-lock.json") {
    errors.push(`${file}: nested package lock; the monorepo must use the root lockfile only`);
  }

  if (!textExtensions.has(extname(file).toLowerCase())) continue;
  const text = readFileSync(absolute, "utf8");
  if (!sourcePatternExemptions.has(file)) {
    for (const check of sourcePatterns) {
      if (check.pattern.test(text)) errors.push(`${file}: contains ${check.label}`);
    }
  }
  for (const check of likelySecretPatterns) {
    if (check.pattern.test(text)) errors.push(`${file}: contains possible ${check.label}`);
  }
}

for (const requiredFile of [
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
]) {
  if (!files.includes(requiredFile)) errors.push(`${requiredFile} is missing`);
}

// vendored 第三方包(如 skills bundle 内嵌的 node_modules)不是仓库自身的 package,
// 不参与 license/依赖清单校验——其许可证随包内文件原样携带。
const packageFiles = files.filter(
  (file) =>
    (file === "package.json" || file.endsWith("/package.json")) && !file.split("/").includes("node_modules"),
);
const packages = new Map();
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, file), "utf8"));
  if (!pkg.license) errors.push(`${file}: package license is missing`);
  if (file !== "package.json" && !pkg.version) errors.push(`${file}: package version is missing`);
  if (pkg.name) packages.set(pkg.name, { file, pkg });
}

const thirdPartyNotices = readFileSync(resolve(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
const directThirdPartyDependencies = new Set();
for (const { pkg } of packages.values()) {
  for (const dependency of [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]) {
    if (!packages.has(dependency)) directThirdPartyDependencies.add(dependency);
  }
}
for (const dependency of [...directThirdPartyDependencies].sort()) {
  if (!thirdPartyNotices.includes(`\`${dependency}\``)) {
    errors.push(`THIRD_PARTY_NOTICES.md is missing direct dependency: ${dependency}`);
  }
}

const rootPackage = packages.get("arcane-desk-monorepo")?.pkg;
const sdkPackage = packages.get("@arcanedesk/foundry-sdk")?.pkg;
const cliPackage = packages.get("@arcanedesk/fvtt-cli")?.pkg;
const desktopPackage = packages.get("arcane-desktop")?.pkg;

if (rootPackage?.private !== true) errors.push("root package must remain private");
if (JSON.stringify(rootPackage?.workspaces) !== JSON.stringify(["apps/*", "packages/*"])) {
  errors.push("root workspaces must be exactly apps/* and packages/*");
}
if (!sdkPackage) errors.push("@arcanedesk/foundry-sdk package is missing");
if (!cliPackage) errors.push("@arcanedesk/fvtt-cli package is missing");
if (!desktopPackage) errors.push("arcane-desktop package is missing");

if (sdkPackage) {
  if (Object.keys(sdkPackage.dependencies ?? {}).length) {
    errors.push("@arcanedesk/foundry-sdk must have no runtime dependencies");
  }
  for (const subpath of [".", "./client", "./contracts", "./runtime", "./runtime-helpers"]) {
    if (!sdkPackage.exports?.[subpath]) errors.push(`SDK export is missing: ${subpath}`);
  }
  if (sdkPackage.publishConfig?.access !== "public") {
    errors.push("SDK publishConfig.access must be public");
  }
}

for (const [name, consumer] of [
  ["@arcanedesk/fvtt-cli", cliPackage],
  ["arcane-desktop", desktopPackage],
]) {
  if (consumer && consumer.dependencies?.["@arcanedesk/foundry-sdk"] !== sdkPackage?.version) {
    errors.push(`${name} must depend on the current exact SDK version`);
  }
}
if (cliPackage?.publishConfig?.access !== "public") {
  errors.push("CLI publishConfig.access must be public");
}
if (JSON.stringify(cliPackage?.exports) !== JSON.stringify({ "./package.json": "./package.json" })) {
  errors.push("CLI must remain bin-only and export only ./package.json");
}
if (desktopPackage?.private !== true) errors.push("Desktop package must remain npm-private");

const result = {
  ok: errors.length === 0,
  filesInspected: files.length,
  packageFiles: packageFiles.length,
  directThirdPartyDependencies: directThirdPartyDependencies.size,
  errors,
  warnings,
};

const stream = result.ok ? process.stdout : process.stderr;
stream.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
