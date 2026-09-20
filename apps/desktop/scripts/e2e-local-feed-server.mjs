#!/usr/bin/env node
// e2e-local-feed-server.mjs — 本地 E2E loopback feed server（auto-update-design §7）。
// 把打包好的旧版应用指向本服务器，验证「检查 → 下载 → 重启安装 → 版本变更」全流程，
// 生产通道零接触。
//
// 目录约定（--root，默认 generated/e2e-feed）：
//   update/<channel>/latest.yml        ← 当前生效的 windows feed
//   update/<channel>/latest-mac.yml    ← 当前生效的 mac feed
//   files/<artifact>                   ← feed files[].url 直接指向 /files/<artifact>
//
// feed 里的 files[].url 用绝对路径形式 /files/xxx（同源绝对 URL，客户端 new URL()
// 解析后仍落在本服务器——feed 相对路径规则已由 verify-update-feed.mjs 对真桶验证）。
// 切版本 = 换掉 update/<channel>/ 下的 yml（本服务器每次请求现读磁盘，无需重启）。
//
// 用法：
//   node scripts/e2e-local-feed-server.mjs [--port 8788] [--root <dir>]
//   启动后用 ARCANE_UPDATE_FEED_BASE_URL=http://127.0.0.1:8788/update 启动应用。
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { port: 8788, root: path.join(desktopRoot, "generated", "e2e-feed") };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--root") args.root = path.resolve(argv[++i]);
    else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(args.port) || args.port <= 0) throw new Error(`unsafe --port: ${args.port}`);
  return args;
}

const MIME = {
  ".yml": "application/yaml; charset=utf-8",
  ".exe": "application/x-msdownload",
  ".zip": "application/zip",
  ".dmg": "application/x-apple-diskimage",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fsp.mkdir(args.root, { recursive: true });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // 只暴露两个前缀；路径穿越直接 404。
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!/^(update|files)\//.test(rel)) {
      res.writeHead(404).end("not found");
      return;
    }
    const file = path.join(args.root, rel);
    if (!file.startsWith(args.root + path.sep)) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, "127.0.0.1", resolve);
  });
  console.log(`e2e feed server listening on http://127.0.0.1:${args.port}`);
  console.log(`  feed : http://127.0.0.1:${args.port}/update/<channel>/latest*.yml`);
  console.log(`  files: ${args.root}/files/<artifact>`);
  console.log(`  launch app with ARCANE_UPDATE_FEED_BASE_URL=http://127.0.0.1:${args.port}/update`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
