// intl demo world 工具链回归网:内容门禁(词表/CJK)、生成器的 worlds/profiles
// 声明式接入(闭包/身份/gate 记录/漂移/确定性 profile 字节)。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareIntlIndex } from "../scripts/prepare-intl-index.mjs";
import { writeWorldArchive } from "../scripts/publish-intl-world.mjs";
import { scanText } from "../scripts/intl-world-policy.mjs";
import { scanWorldZip } from "../scripts/intl-world-gate.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const DND5E_MANIFEST = "https://up.test/dnd5e/5.3.3/system.json";
const DND5E_ZIP = "https://up.test/dnd5e/5.3.3/dnd5e.zip";
const MIDI_MANIFEST = "https://up.test/midi/13.0.65/module.json";
const MIDI_ZIP = "https://up.test/midi/13.0.65/midi.zip";
const WORLD_MANIFEST = "https://dl.test/mods/worlds/arcane-demo/0.1.0/world.json";
const WORLD_ZIP = "https://dl.test/mods/worlds/arcane-demo/0.1.0/arcane-demo-0.1.0.zip";

const WORLD_ZIP_BYTES = "world-zip-bytes";

function jsonResponse(value) {
  return { buffer: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") };
}

function fetchMap(entries) {
  return async (url) => {
    const hit = entries[url];
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: true,
      status: 200,
      url,
      arrayBuffer: async () => hit.buffer.buffer.slice(hit.buffer.byteOffset, hit.buffer.byteOffset + hit.buffer.byteLength),
    };
  };
}

async function writeCuration(root) {
  const file = path.join(root, "curation.json");
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1,
    packages: [
      { id: "dnd5e", kind: "system", group: "system", manifestUrl: DND5E_MANIFEST },
      { id: "midi-qol", kind: "module", group: "automation", manifestUrl: MIDI_MANIFEST },
    ],
  })}\n`);
  return file;
}

function worldDistribution({ gateSha256 = sha256(WORLD_ZIP_BYTES), modules = ["midi-qol"], manifestOverrides = {} } = {}) {
  const manifest = {
    id: "arcane-demo",
    title: "Arcane Demo",
    version: "0.1.0",
    system: "dnd5e",
    manifest: WORLD_MANIFEST,
    download: WORLD_ZIP,
    ...manifestOverrides,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    world: {
      id: "arcane-demo",
      title: "Arcane Demo",
      version: "0.1.0",
      system: "dnd5e",
      manifestUrl: WORLD_MANIFEST,
      downloadUrl: WORLD_ZIP,
      manifestBytes: Buffer.byteLength(manifestText),
      manifestSha256: sha256(manifestText),
      bytes: Buffer.byteLength(WORLD_ZIP_BYTES),
      sha256: sha256(WORLD_ZIP_BYTES),
      gate: { sha256: gateSha256, violations: 0, checkedAt: "2026-09-21T00:00:00Z" },
    },
    profile: { id: "arcane-demo-full", title: "Arcane Demo Full", revision: 1, modules },
  };
}

function baseEntries({ manifest = {} } = {}) {
  return {
    [DND5E_MANIFEST]: jsonResponse({ id: "dnd5e", version: "5.3.3", download: DND5E_ZIP }),
    [DND5E_ZIP]: { buffer: Buffer.from("dnd5e-zip") },
    [MIDI_MANIFEST]: jsonResponse({ id: "midi-qol", version: "13.0.65", download: MIDI_ZIP }),
    [MIDI_ZIP]: { buffer: Buffer.from("midi-zip") },
    [WORLD_MANIFEST]: jsonResponse({
      id: "arcane-demo",
      title: "Arcane Demo",
      version: "0.1.0",
      system: "dnd5e",
      manifest: WORLD_MANIFEST,
      download: WORLD_ZIP,
      ...manifest,
    }),
    [WORLD_ZIP]: { buffer: Buffer.from(WORLD_ZIP_BYTES) },
  };
}

async function runGenerator(root, entries, distribution, extra = {}) {
  const output = path.join(root, "out");
  const file = path.join(root, "world-distribution.json");
  await writeFile(file, `${JSON.stringify(distribution)}\n`);
  return prepareIntlIndex({
    curationFile: await writeCuration(root),
    outputDir: output,
    previousIndexUrl: "https://dl.test/missing-index.json",
    worldDistributionFile: file,
    fetchImpl: fetchMap(entries),
    ...extra,
  });
}

test("scanText: CoS 词、cn 专属模块与 CJK 各自命中；非 SRD 法术名按口径放行；干净文本零违规", () => {
  assert.deepEqual(scanText("Count Strahd von Zarovich"), [{ kind: "cos-term", term: "strahd" }]);
  assert.deepEqual(
    scanText("depends on arcane-dnd5e-2014-automation"),
    [{ kind: "forbidden-module", term: "arcane-dnd5e-2014-automation" }],
  );
  assert.deepEqual(scanText("火球术"), [{ kind: "cjk", term: "CJK character" }]);
  // 2026-09-21 口径:法术名字+机制可分发、描述文本不分发(模块 contentRef 架构天然满足),
  // 非 SRD 法术名不再是违规项。
  assert.deepEqual(scanText("casts Vicious Mockery and Misty Step"), []);
  assert.deepEqual(scanText("Fireball hits the goblin for 8d6"), []);
});

test("gate: 真实 zip 解包扫描命中 CoS 内容，干净世界零违规", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-world-gate-test-"));
  const worldDir = path.join(root, "world");
  try {
    await mkdir(worldDir);
    await writeFile(path.join(worldDir, "world.json"), `${JSON.stringify({ id: "w", version: "1", system: "dnd5e" })}\n`);
    await mkdir(path.join(worldDir, "data"));
    await writeFile(path.join(worldDir, "data", "actors.json"), `${JSON.stringify({ name: "Strahd" })}\n`);
    const blockedZip = path.join(root, "blocked.zip");
    await writeWorldArchive({ directory: worldDir, archive: blockedZip });
    const blocked = await scanWorldZip(blockedZip, root);
    assert.equal(blocked.violations.some((v) => v.kind === "cos-term"), true);

    await writeFile(path.join(worldDir, "data", "actors.json"), `${JSON.stringify({ name: "Aldercapt" })}\n`);
    const cleanZip = path.join(root, "clean.zip");
    await writeWorldArchive({ directory: worldDir, archive: cleanZip });
    const clean = await scanWorldZip(cleanZip, root);
    assert.deepEqual(clean.violations, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成器:声明文件缺省时 worlds/profiles 保持为空(历史行为)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-intl-world-idx-"));
  try {
    const { index } = await prepareIntlIndex({
      curationFile: await writeCuration(root),
      outputDir: path.join(root, "out"),
      previousIndexUrl: "https://dl.test/missing-index.json",
      fetchImpl: fetchMap(baseEntries()),
    });
    assert.deepEqual(index.worlds, []);
    assert.deepEqual(index.profiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成器:声明就位时 worlds/profiles 并入索引且 profile 字节确定", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-intl-world-idx-"));
  try {
    const first = await runGenerator(root, baseEntries(), worldDistribution());
    assert.equal(first.index.worlds.length, 1);
    const world = first.index.worlds[0];
    assert.equal(world.id, "arcane-demo");
    assert.equal(world.version, "0.1.0");
    assert.equal(world.defaultProfile, "arcane-demo-full");
    assert.equal(world.sha256, sha256(WORLD_ZIP_BYTES));
    const profile = first.index.profiles[0];
    assert.equal(profile.revision, 1);
    assert.equal(profile.profileSha256, sha256(first.plan.profile.body));
    const written = await readFile(path.join(root, "out", "profile.json"), "utf8");
    assert.equal(written, first.plan.profile.body);
    assert.deepEqual(JSON.parse(written).modules, ["midi-qol"]);

    const second = await runGenerator(root, baseEntries(), worldDistribution());
    assert.equal(second.index.profiles[0].profileSha256, profile.profileSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成器:profile 模块不在策展闭包内即失败", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-intl-world-idx-"));
  try {
    await assert.rejects(
      runGenerator(root, baseEntries(), worldDistribution({ modules: ["midi-qol", "tidy5e-sheet"] })),
      /not dependency-closed[\s\S]*tidy5e-sheet/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成器:线上 world manifest 身份与声明不符即失败", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-intl-world-idx-"));
  try {
    await assert.rejects(
      runGenerator(root, baseEntries({ manifest: { version: "0.2.0" } }), worldDistribution()),
      /world manifest version mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成器:gate 记录与 zip 哈希不一致即失败", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-intl-world-idx-"));
  try {
    await assert.rejects(
      runGenerator(root, baseEntries(), worldDistribution({ gateSha256: "0".repeat(64) })),
      /gate record does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成器:同版本世界工件哈希漂移即失败(不可变纪律)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-intl-world-idx-"));
  try {
    const previous = {
      packages: [],
      worlds: [{ id: "arcane-demo", version: "0.1.0", manifestUrl: WORLD_MANIFEST, sha256: "f".repeat(64) }],
      profiles: [],
    };
    const entries = { ...baseEntries(), "https://dl.test/prev.json": jsonResponse(previous) };
    const file = path.join(root, "world-distribution.json");
    await writeFile(file, `${JSON.stringify(worldDistribution())}\n`);
    await assert.rejects(
      prepareIntlIndex({
        curationFile: await writeCuration(root),
        outputDir: path.join(root, "out"),
        previousIndexUrl: "https://dl.test/prev.json",
        worldDistributionFile: file,
        fetchImpl: fetchMap(entries),
      }),
      /differs; publish a new world version/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
