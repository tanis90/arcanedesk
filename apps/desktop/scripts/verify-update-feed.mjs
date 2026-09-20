#!/usr/bin/env node
// verify-update-feed.mjs — 客户端契约冒烟：按 electron-updater 6.x 的真实行为核对
// 线上 update feed（auto-update-design §7 E2E 必验清单的发布侧部分）。
//
// 逐 region 验证：
//   1. 以客户端方式请求 update/<channel>/latest.yml 与 latest-mac.yml
//      （带 ?noCache= 随机查询——electron-updater isAddNoCacheQuery 的默认行为）；
//   2. js-yaml 解析（与客户端同一解析器），校验 version / files[] / sha512(base64) 结构；
//   3. 按客户端规则把 files[].url 相对路径解析成绝对 URL（new URL(path, feedBase)），
//      断言不越出本桶前缀，且按 process.arch 匹配语义每架构都能选到正确的件
//      （findFile: 路径名包含 arch；x64 不得被 arm64 抢占，反之亦然）；
//   4. HEAD 每个解析后的文件 URL：200 且 content-length == size。
//
// 用法：node scripts/verify-update-feed.mjs [--region cn|intl] [--channel private-beta]
import { load as parseYaml } from "js-yaml";

const FEEDS = Object.freeze({
  cn: Object.freeze({
    baseUrl: "https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/update",
  }),
  intl: Object.freeze({
    baseUrl: "https://dl.arcanedesk.app/desktop/arcane-desk-intl/update",
  }),
});

function parseArgs(argv) {
  const args = { region: "cn", channel: "private-beta" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--region") args.region = argv[++i];
    else if (a === "--channel") args.channel = argv[++i];
    else throw new Error(`unknown option: ${a}`);
  }
  if (!FEEDS[args.region]) throw new Error(`--region must be one of ${Object.keys(FEEDS).join("/")}`);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(args.channel)) throw new Error(`unsafe channel: ${args.channel}`);
  return args;
}

// 与 electron-updater 的 findFile 选件语义一致：优先路径名包含 arch 的件。
function pickForArch(files, arch) {
  const hit = files.find((f) => f.absoluteUrl.pathname.includes(arch) || String(f.info?.url ?? "").includes(arch));
  return hit ?? files[0] ?? null;
}

async function fetchFeed(url) {
  // noCache 随机查询 + no-store：同客户端 isAddNoCacheQuery 语义，避开边缘负缓存。
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}noCache=${Date.now().toString(32)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status} ${url}`);
  return parseYaml(await res.text());
}

async function headBytes(url) {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}_cb=${Date.now().toString(36)}`, {
    method: "HEAD",
    cache: "no-store",
    headers: { "accept-encoding": "identity" },
  });
  return { status: res.status, length: Number(res.headers.get("content-length")) };
}

async function verifyFeed(feedBase, channelFile, channel) {
  const feedUrl = `${feedBase}/${channel}/${channelFile}`;
  const info = await fetchFeed(feedUrl);
  if (!info) return { channelFile, skipped: true };
  if (!info.version || !Array.isArray(info.files) || !info.files.length) {
    throw new Error(`${channelFile}: malformed feed (version/files missing)`);
  }
  const bucketPrefix = new URL(feedBase).origin + new URL(feedBase).pathname.replace(/\/update.*$/, "");
  const files = info.files.map((f) => {
    if (typeof f.sha512 !== "string" || !f.sha512 || !Number.isSafeInteger(f.size)) {
      throw new Error(`${channelFile}: entry missing sha512/size: ${JSON.stringify(f)}`);
    }
    // 客户端 resolveFiles：new URL(files[].url, feedBase)
    const absoluteUrl = new URL(f.url, feedUrl);
    if (!absoluteUrl.href.startsWith(bucketPrefix)) {
      throw new Error(`${channelFile}: entry escapes bucket prefix: ${absoluteUrl.href}`);
    }
    return { info: f, absoluteUrl, size: f.size };
  });
  const archChecks = [];
  for (const arch of ["x64", "arm64"]) {
    const picked = pickForArch(files, arch);
    if (!picked) throw new Error(`${channelFile}: no file selectable for ${arch}`);
    if (!picked.absoluteUrl.pathname.includes(arch)) {
      throw new Error(`${channelFile}: arch ${arch} would fall back to ${picked.absoluteUrl.pathname} (wrong-arch install risk)`);
    }
    archChecks.push(`${arch}→${picked.absoluteUrl.pathname.split("/").pop()}`);
  }
  for (const f of files) {
    const head = await headBytes(f.absoluteUrl.href);
    if (head.status !== 200 || head.length !== f.size) {
      throw new Error(`${channelFile}: ${f.absoluteUrl.pathname} HEAD ${head.status}, length ${head.length} != ${f.size}`);
    }
  }
  return { channelFile, version: info.version, files: files.length, archChecks };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const feedBase = FEEDS[args.region].baseUrl;
  const results = [];
  for (const channelFile of ["latest.yml", "latest-mac.yml"]) {
    results.push(await verifyFeed(feedBase, channelFile, args.channel));
  }
  console.log(`update feed contract OK (${args.region}/${args.channel})`);
  for (const r of results) {
    if (r.skipped) console.log(`  ${r.channelFile}: 404 (no feed for this platform/channel yet)`);
    else console.log(`  ${r.channelFile}: v${r.version}, ${r.files} files [${r.archChecks.join(", ")}]`);
  }
}

const invokedPath = process.argv[1] ? new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
