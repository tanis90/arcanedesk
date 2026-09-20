#!/usr/bin/env node
// e2e-make-feed.mjs — 为 loopback E2E 合成单版本 feed（auto-update-design §7 配套
// e2e-local-feed-server.mjs 使用）。生产 feed 永远由 publish-release.mjs 生成，
// 本脚本只服务本地双版本 E2E 的「新版」侧。
//
// 用法：
//   node scripts/e2e-make-feed.mjs --exe dist/Arcane-Desk-0.4.91-win-x64.exe \
//     --root generated/e2e-feed --channel private-beta --version 0.4.91
// 之后把 exe 复制到 <root>/files/ 下（feed files[].url 指向 /files/<name>）。
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--exe") args.exe = path.resolve(argv[++i]);
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else if (a === "--channel") args.channel = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else throw new Error(`unknown option: ${a}`);
  }
  if (!args.exe || !args.root || !args.channel || !args.version) {
    throw new Error("usage: e2e-make-feed.mjs --exe <installer> --root <feedRoot> --channel <ch> --version <v>");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(args.channel)) throw new Error(`unsafe channel: ${args.channel}`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(args.version)) throw new Error(`unsafe version: ${args.version}`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stat = await fsp.stat(args.exe);
  const sha512 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    fs.createReadStream(args.exe).on("error", reject).pipe(hash).on("error", reject);
    hash.on("finish", () => resolve(hash.digest("base64")));
  });
  const name = path.basename(args.exe);
  const isMacZip = /\.zip$/i.test(name);
  const channelFile = isMacZip ? "latest-mac.yml" : "latest.yml";
  const entry = { url: `/files/${name}`, sha512, size: stat.size };
  const body = [
    `version: ${JSON.stringify(args.version)}`,
    `path: ${JSON.stringify(entry.url)}`,
    `sha512: ${JSON.stringify(sha512)}`,
    `releaseDate: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`,
    "files:",
    `  - url: ${JSON.stringify(entry.url)}`,
    `    sha512: ${JSON.stringify(sha512)}`,
    `    size: ${entry.size}`,
    "",
  ].join("\n");
  const out = path.join(args.root, "update", args.channel, channelFile);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, body, "utf8");
  console.log(`wrote ${out}`);
  console.log(`now copy the installer to ${path.join(args.root, "files", name)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
