import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapFvttOpsRuntime,
  fvttNodePlatformKey,
} from "../src/main/fvtt-ops-runtime.mjs";

const version = "22.23.2";
const targetPlatform = process.platform === "win32" ? "win32" : "darwin";
const targetArch = process.platform === "darwin" && process.arch === "arm64" ? "arm64" : "x64";
const platformKey = fvttNodePlatformKey(targetPlatform, targetArch);
const artifactFile = targetPlatform === "win32"
  ? `node-v${version}-win-x64.zip`
  : `node-v${version}-darwin-${targetArch}.tar.gz`;

async function prepareBundle(root, archiveBody = Buffer.from("trusted-node-archive")) {
  const bundledNodeRoot = path.join(root, "bundle");
  const distributionFile = path.join(root, "distribution.json");
  const archive = path.join(bundledNodeRoot, artifactFile);
  const sha256 = createHash("sha256").update(archiveBody).digest("hex");
  await mkdir(bundledNodeRoot, { recursive: true });
  await writeFile(archive, archiveBody);
  await writeFile(distributionFile, JSON.stringify({
    core: {
      node: version,
      nodeArtifacts: {
        [platformKey]: { file: artifactFile, sha256 },
      },
    },
  }));
  await writeFile(path.join(bundledNodeRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    version,
    platform: platformKey,
    file: artifactFile,
    sha256,
  }));
  return { archive, bundledNodeRoot, distributionFile, sha256 };
}

function fakeArchiveExtractor(_archive, destination) {
  const packageRoot = path.join(destination, `node-v${version}-${platformKey}`);
  const binary = targetPlatform === "win32"
    ? path.join(packageRoot, "node.exe")
    : path.join(packageRoot, "bin", "node");
  return mkdir(path.dirname(binary), { recursive: true }).then(() => writeFile(binary, "node-placeholder"));
}

function fakeVersionProbe(binary) {
  return Promise.resolve(fs.existsSync(binary) ? `v${version}` : null);
}

test("App-private bootstrap extracts, activates, and reuses the bundled Foundry Node", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-fvtt-node-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const bundle = await prepareBundle(root);
  const env = targetPlatform === "win32" ? { Path: "C:\\Windows\\System32" } : { PATH: "/usr/bin" };

  const installed = await bootstrapFvttOpsRuntime({
    runtimeRoot,
    bundledNodeRoot: bundle.bundledNodeRoot,
    distributionFile: bundle.distributionFile,
    env,
    platform: targetPlatform,
    arch: targetArch,
    versionProbe: fakeVersionProbe,
    archiveExtractor: fakeArchiveExtractor,
  });

  assert.equal(installed.version, version);
  assert.equal(installed.reused, false);
  assert.equal(installed.source, "bundled");
  assert.equal(fs.existsSync(installed.nodeBinary), true);
  assert.equal(env.ARCANE_FVTT_NODE, installed.nodeBinary);

  await unlink(bundle.archive);
  const reused = await bootstrapFvttOpsRuntime({
    runtimeRoot,
    bundledNodeRoot: bundle.bundledNodeRoot,
    distributionFile: bundle.distributionFile,
    env,
    platform: targetPlatform,
    arch: targetArch,
    versionProbe: fakeVersionProbe,
    archiveExtractor: async () => assert.fail("reused runtime must not extract the bundle"),
  });
  assert.deepEqual(reused, {
    nodeBinary: installed.nodeBinary,
    version,
    reused: true,
    source: null,
  });
});

test("App-private bootstrap fails closed on a corrupt bundle or wrong staged Node", async (t) => {
  const corruptRoot = await mkdtemp(path.join(os.tmpdir(), "arcane-fvtt-node-corrupt-"));
  const wrongRoot = await mkdtemp(path.join(os.tmpdir(), "arcane-fvtt-node-wrong-"));
  t.after(() => Promise.all([
    rm(corruptRoot, { recursive: true, force: true }),
    rm(wrongRoot, { recursive: true, force: true }),
  ]));

  const corruptBundle = await prepareBundle(corruptRoot);
  await writeFile(corruptBundle.archive, "tampered");
  await assert.rejects(
    bootstrapFvttOpsRuntime({
      runtimeRoot: path.join(corruptRoot, "runtime"),
      bundledNodeRoot: corruptBundle.bundledNodeRoot,
      distributionFile: corruptBundle.distributionFile,
      env: {},
      platform: targetPlatform,
      arch: targetArch,
      versionProbe: fakeVersionProbe,
      archiveExtractor: fakeArchiveExtractor,
    }),
    /SHA256 mismatch/,
  );

  const wrongBundle = await prepareBundle(wrongRoot);
  await assert.rejects(
    bootstrapFvttOpsRuntime({
      runtimeRoot: path.join(wrongRoot, "runtime"),
      bundledNodeRoot: wrongBundle.bundledNodeRoot,
      distributionFile: wrongBundle.distributionFile,
      env: {},
      platform: targetPlatform,
      arch: targetArch,
      versionProbe: async (binary) => fs.existsSync(binary) ? "v24.0.0" : null,
      archiveExtractor: fakeArchiveExtractor,
    }),
    /version mismatch/,
  );
});

test("bundled Foundry Node targets stay limited to packaged desktop platforms", () => {
  assert.equal(fvttNodePlatformKey("win32", "x64"), "win-x64");
  assert.equal(fvttNodePlatformKey("darwin", "x64"), "darwin-x64");
  assert.equal(fvttNodePlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.throws(() => fvttNodePlatformKey("linux", "x64"), /unsupported/);
  assert.throws(() => fvttNodePlatformKey("win32", "arm64"), /unsupported/);
});
