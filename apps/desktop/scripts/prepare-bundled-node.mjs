#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { bundledNodePlatformKey, readJson } from "./desktop-release-metadata.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distribution = readJson(path.join(desktopRoot, "distribution", "community-distribution.json"));
const outputRoot = path.join(desktopRoot, "generated", "bundled-node");
// Cross-builds run this script on the host Node, so process.arch alone describes
// the runner rather than the package target. CI must provide the matrix target.
const platformKey = bundledNodePlatformKey(
  process.platform,
  process.arch,
  process.env.ARCANE_BUNDLED_NODE_PLATFORM,
);
const artifact = distribution.core.nodeArtifacts?.[platformKey];
if (!artifact?.file || !/^[0-9a-f]{64}$/i.test(artifact.sha256 ?? "")) {
  throw new Error(`distribution is missing a trusted Node artifact for ${platformKey}`);
}

const sourceUrl = `https://nodejs.org/dist/v${distribution.core.node}/${artifact.file}`;
const target = path.join(outputRoot, artifact.file);

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

await fsp.mkdir(outputRoot, { recursive: true });
for (const entry of await fsp.readdir(outputRoot)) {
  if (entry !== artifact.file && /\.(?:zip|tar\.gz)$/.test(entry)) {
    await fsp.rm(path.join(outputRoot, entry), { force: true });
  }
}
let actual = fs.existsSync(target) ? await sha256File(target) : null;
if (actual !== artifact.sha256) {
  const temporary = `${target}.download`;
  await fsp.rm(temporary, { force: true });
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
  const body = /** @type {import("node:stream/web").ReadableStream<Uint8Array>} */ (
    /** @type {unknown} */ (response.body)
  );
  await pipeline(Readable.fromWeb(body), fs.createWriteStream(temporary));
  actual = await sha256File(temporary);
  if (actual !== artifact.sha256) {
    await fsp.rm(temporary, { force: true });
    throw new Error(`Node artifact SHA256 mismatch: expected ${artifact.sha256}; got ${actual}`);
  }
  await fsp.rm(target, { force: true });
  await fsp.rename(temporary, target);
}

const manifest = {
  schemaVersion: 1,
  version: distribution.core.node,
  platform: platformKey,
  file: artifact.file,
  sha256: artifact.sha256,
  source: sourceUrl,
  license: "Node.js is distributed under the terms in the LICENSE file included in the official archive.",
};
await fsp.writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`Prepared bundled Node ${manifest.version} ${platformKey} (${actual})\n`);
