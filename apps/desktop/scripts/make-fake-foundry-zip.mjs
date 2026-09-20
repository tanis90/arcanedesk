#!/usr/bin/env node
// make-fake-foundry-zip.mjs — 生成结构等价的假 Foundry zip（CI 冒烟/本地测试用）。
//
// Foundry 是付费软件,CI 拿不到真本体;入口脚本的校验/断言逻辑必须跑真路径,
// 所以 fixture 复刻 Node.JS 构建 zip 的最小结构:
//   main.js      — 假服务器:解析 --dataPath,读 Config/options.json 的端口,
//                  在 /api/status 上报 fixture 生成时钉入的版本号,打出的就绪
//                  日志行与 ops skill 的健康判据一致("Server started and listening")
//   package.json — { version: <钉版> },供入口脚本的版本预检消费
//
// zip 用 STORED(无压缩)逐条手写:确定性字节输出 + 零第三方依赖;容器内的
// yauzl 读取 STORED 条目没有障碍。CRC32 用 node 内建 zlib.crc32(Node 20+)。

import fsp from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/** 把 {name -> Buffer} 写成 STORED zip;条目按名字排序,输出确定性字节。 */
export function buildStoredZip(entries) {
  const names = Object.keys(entries).sort();
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date(2026, 0, 1, 0, 0, 0));
  for (const name of names) {
    const data = entries[name];
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10); // stored
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBytes, end]);
}

/** 假 main.js:被入口脚本以 `node main.js --dataPath=<dir>` 拉起。 */
function fakeMainJs(version) {
  return [
    "// fake foundry main.js — generated fixture, structure-compatible only",
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "const dataPath = args[args.indexOf('--dataPath') + 1] ?? '/arcane/data';",
    "let port = 30000;",
    "try { port = JSON.parse(fs.readFileSync(path.join(dataPath, 'Config', 'options.json'), 'utf8')).port ?? 30000; } catch {}",
    `const VERSION = ${JSON.stringify(version)};`,
    "http.createServer((req, res) => {",
    "  if (req.url === '/api/status') {",
    "    res.setHeader('content-type', 'application/json');",
    "    res.end(JSON.stringify({ version: VERSION, world: null, systemVersion: null }));",
    "    return;",
    "  }",
    "  res.statusCode = 404; res.end('fake foundry');",
    "}).listen(port, '0.0.0.0', () => {",
    "  console.log(`Server started and listening on port ${port}`);",
    "});",
    "",
  ].join("\n");
}

export async function makeFakeFoundryZip({ outFile, version }) {
  const zip = buildStoredZip({
    "main.js": Buffer.from(fakeMainJs(version), "utf8"),
    "package.json": Buffer.from(`${JSON.stringify({ name: "foundryvtt-fake", version }, null, 2)}\n`, "utf8"),
  });
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, zip, { flag: "wx" });
  return { outFile, bytes: zip.length, version };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const a = argv[index];
    if (a === "--out") { args.out = argv[index + 1]; index += 1; }
    else if (a === "--version") { args.version = argv[index + 1]; index += 1; }
    else throw new Error(`unknown option: ${a}`);
  }
  if (!args.out) throw new Error("usage: node scripts/make-fake-foundry-zip.mjs --out <file.zip> [--version <ver>]");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const community = JSON.parse(await fsp.readFile(path.join(desktopRoot, "distribution", "community-distribution.json"), "utf8"));
  const version = args.version ?? community?.core?.foundry;
  if (!version) throw new Error("community-distribution.json has no core.foundry pin");
  const result = await makeFakeFoundryZip({ outFile: path.resolve(args.out), version });
  console.log(`fake foundry zip: ${result.outFile} (${result.bytes} bytes, version ${result.version})`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}
