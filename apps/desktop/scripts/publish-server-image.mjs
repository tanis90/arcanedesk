#!/usr/bin/env node
// publish-server-image.mjs — 服务器镜像 tar.gz 发布入口(镜像 publish-skills 的
// 不可变+指针纪律,复用 publish-release 的存储客户端与 HEAD cache-bust 验收)。
//
//   1. 读 generated/server-image/server-release.json(build-server-image 的产物)
//   2. 拉远端 server/latest.json,要求 revision 严格更大(防回滚、防重传)
//   3. 上传不可变对象 server/<revision>/{tar.gz×架构, server-release.json,
//      docker-compose.yml, README.md}
//   4. HEAD 全量验收(cache-bust)通过后才切换 server/latest.json 指针
//
// region 路由与凭证与 publish-release/publish-skills 完全一致:
//   cn → OSS arcane-package desktop/arcane-desk/server/
//   intl → R2 arcane-desk-intl desktop/arcane-desk-intl/server/
// 注:runtime/ 前缀(docker 静态包/compose 二进制,安装第 3 层降级的弹药)
// 尚未实现钉版入桶,列 M3。

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStorageClient, resolveTarget, uploadObject, verifyUrl } from "./publish-release.mjs";
import { REGION_IDS } from "../src/main/region.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const CONTENT_TYPES = {
  ".gz": "application/gzip",
  ".yml": "text/yaml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": JSON_CONTENT_TYPE,
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const a = argv[index];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--skip-latest") args.skipLatest = true;
    else if (a === "--region") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--region requires a value");
      args.region = value;
      index += 1;
    } else if (a === "--build-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--build-dir requires a value");
      args.buildDir = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

async function remoteRevision({ baseUrl, latestKey, tolerateFailure }) {
  try {
    const response = await fetch(`${baseUrl}/${latestKey}`, {
      cache: "no-store",
      redirect: "error",
      headers: { "accept-encoding": "identity" },
    });
    if (response.status === 404) return 0;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pointer = await response.json();
    if (pointer?.schemaVersion !== 1 || !Number.isSafeInteger(pointer?.revision)) {
      throw new Error("remote server latest.json is malformed");
    }
    return pointer.revision;
  } catch (error) {
    if (!tolerateFailure) throw error;
    console.warn(`warning: cannot read remote server pointer (${error.message}); dry-run continues without the monotonic check`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const region = args.region ?? "cn";
  if (!REGION_IDS.includes(region)) {
    throw new Error(`--region must be one of ${REGION_IDS.join("/")}; got: ${region}`);
  }
  const target = resolveTarget(region);
  const serverRoot = target.serverRoot;
  const latestKey = `${serverRoot}/latest.json`;
  const buildDir = args.buildDir ?? path.join(desktopRoot, "generated", "server-image");

  const release = JSON.parse(await fsp.readFile(path.join(buildDir, "server-release.json"), "utf8"));
  if (release?.schemaVersion !== 1 || !Number.isSafeInteger(release?.revision)) {
    throw new Error("server-release.json is missing schemaVersion/revision; run build-server-image first");
  }
  const platforms = Object.keys(release.platforms ?? {});
  if (!platforms.length) throw new Error("server-release.json has no platforms; build at least one arch");

  const current = await remoteRevision({ baseUrl: target.baseUrl, latestKey, tolerateFailure: args.dryRun });
  if (current != null && release.revision <= current) {
    throw new Error(
      `server image revision ${release.revision} is not newer than the published r${current}; `
      + `bump distribution/server-image/image-revision.json`,
    );
  }

  const immutableObjects = [];
  for (const platform of platforms) {
    const entry = release.platforms[platform];
    const file = path.join(buildDir, entry.file);
    const bytes = (await fsp.stat(file)).size;
    if (bytes !== entry.bytes) throw new Error(`${entry.file} size drifted: manifest ${entry.bytes}, disk ${bytes}`);
    immutableObjects.push({
      key: `${serverRoot}/${release.revision}/${entry.file}`,
      file,
      bytes,
      cache: IMMUTABLE_CACHE,
      contentType: CONTENT_TYPES[path.extname(entry.file)] ?? "application/octet-stream",
    });
  }
  for (const name of ["server-release.json", "docker-compose.yml", "README.md"]) {
    const file = path.join(buildDir, name);
    const body = await fsp.readFile(file, "utf8");
    immutableObjects.push({
      key: `${serverRoot}/${release.revision}/${name}`,
      body,
      bytes: Buffer.byteLength(body),
      cache: IMMUTABLE_CACHE,
      contentType: CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream",
    });
  }

  const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const latestBody = `${JSON.stringify(
    { schemaVersion: 1, revision: release.revision, tag: release.tag, publishedAt },
    null,
    2,
  )}\n`;

  console.log(
    `server image r${release.revision} (${region}) — tag ${release.tag}, `
    + `${platforms.length} platform(s): ${platforms.join(", ")}`,
  );
  if (args.dryRun) {
    console.log("dry-run: skip upload & verify");
    return;
  }

  const client = await createStorageClient(target);
  for (const obj of immutableObjects) {
    let exists = false;
    try {
      await client.head(obj.key);
      exists = true;
    } catch (error) {
      if (Number(error?.status) !== 404) throw error;
    }
    if (exists) throw new Error(`immutable object already exists: ${obj.key} (bump image-revision.json)`);
  }
  for (const obj of immutableObjects) await uploadObject(client, obj);
  for (const obj of immutableObjects) {
    if (!(await verifyUrl(`${target.baseUrl}/${obj.key}`, obj.bytes, obj.key))) {
      throw new Error(`${obj.key} failed verification; server latest remains unchanged`);
    }
  }
  if (args.skipLatest) {
    console.log(`server image r${release.revision} uploaded and verified; latest unchanged (--skip-latest)`);
    return;
  }
  await uploadObject(client, {
    key: latestKey,
    body: latestBody,
    bytes: Buffer.byteLength(latestBody),
    cache: "no-cache",
    contentType: JSON_CONTENT_TYPE,
  });
  if (!(await verifyUrl(`${target.baseUrl}/${latestKey}`, Buffer.byteLength(latestBody), latestKey))) {
    throw new Error("server latest.json failed verification; do NOT announce this publish");
  }
  console.log(`server latest now points to verified image r${release.revision} (${region})`);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
