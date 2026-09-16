#!/usr/bin/env node
// dist.mjs — electron-builder 包装器（国际化方案 D5 发布双轨）。
//
// package.json 的 artifactName 含 ${env.ARCANE_ARTIFACT_SUFFIX} 宏，而
// electron-builder 对该宏未定义会直接报错，所以 electron-builder 必须经本脚本启动。
// 后缀规则：generated/region.json（prepare:desktop-release 按 ARCANE_BUILD_REGION
// 生成）为 intl → "-intl"，否则 → ""（cn 保留历史文件名）。也可用
// ARCANE_ARTIFACT_SUFFIX 显式覆盖。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.ARCANE_ARTIFACT_SUFFIX === undefined) {
  let suffix = "";
  try {
    const regionFile = path.join(desktopRoot, "generated", "region.json");
    const region = JSON.parse(fs.readFileSync(regionFile, "utf8"))?.region;
    suffix = region === "intl" ? "-intl" : "";
  } catch {
    // dev 环境可能还没跑过 prepare（无 region.json）：保持 cn 命名。
  }
  process.env.ARCANE_ARTIFACT_SUFFIX = suffix;
}

const require = createRequire(import.meta.url);
const cli = require.resolve("electron-builder/cli.js");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
