// pack-world + prepare-world-profile 内容闸口回归网:0.1.3 半截凭证形态拒打包、
// 显式脱敏(--clear-messages/--set-empty-password)、确定性 zip、源目录只读、
// 以及索引合并前的下载侧兜底闸口。
import assert from "node:assert/strict";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClassicLevel } from "classic-level";

import { extractZip, listZipEntries } from "../scripts/archive-zip.mjs";
import { buildWorldRelease } from "../scripts/pack-world.mjs";
import { prepareWorldProfile } from "../scripts/prepare-world-profile.mjs";
import { writeWorldArchive } from "../scripts/publish-intl-world.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function passwordPair(plaintext = "") {
  const salt = randomBytes(32).toString("hex");
  const hash = pbkdf2Sync(plaintext, salt, 1000, 64, "sha512").toString("hex");
  return { password: hash, passwordSalt: salt };
}

function foundryTestPassword(plaintext, hash, salt) {
  const derived = pbkdf2Sync(plaintext, salt, 1000, 64, "sha512");
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

async function writePack(packDir, records) {
  await mkdir(packDir, { recursive: true });
  const db = new ClassicLevel(packDir, { valueEncoding: "utf8" });
  await db.open();
  try {
    for (const [key, value] of records) await db.put(key, JSON.stringify(value));
  } finally {
    await db.close();
  }
}

async function makeSourceWorld(t, { users = null, messages = null, files = {}, manifest = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pack-world-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "world.json"),
    `${JSON.stringify({ id: "src-world", title: "源世界", version: "0.0.1", system: "dnd5e", lastPlayed: "2026-09-27", playtime: 42, ...manifest }, null, 2)}\n`,
  );
  if (users) await writePack(path.join(dir, "data", "users"), users.map((doc) => [`!users!${doc._id}`, doc]));
  if (messages) await writePack(path.join(dir, "data", "messages"), messages.map((doc) => [`!messages!${doc._id}`, doc]));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

const goodUser = { _id: "gm0001", name: "Gamemaster", role: 4, ...passwordPair("") };
const brokenUser = { _id: "gm0001", name: "Gamemaster", role: 4, password: "" };

const PACK_ARGS = { worldId: "test-world", title: "测试世界", version: "0.1.0" };

test("半截凭证世界拒绝打包(0.1.3 事故形态)", async (t) => {
  const dir = await makeSourceWorld(t, { users: [brokenUser] });
  await assert.rejects(
    buildWorldRelease({ sourceDir: dir, outputDir: path.join(dir, "..", "out"), ...PACK_ARGS }),
    /content audit rejected/,
  );
});

test("脱敏打包:--set-empty-password + --clear-messages,zip 内容全绿", async (t) => {
  const dir = await makeSourceWorld(t, {
    users: [brokenUser],
    messages: [{ _id: "m1", content: "跑团记录" }],
    files: { "assets/map.png": Buffer.from([1, 2, 3]) },
  });
  const outDir = await mkdtemp(path.join(os.tmpdir(), "pack-world-out-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const receipt = await buildWorldRelease({
    sourceDir: dir, outputDir: outDir, ...PACK_ARGS, clearMessages: true, setEmptyPassword: true,
  });
  assert.equal(receipt.id, "test-world");
  assert.equal(receipt.version, "0.1.0");
  assert.deepEqual(receipt.sanitized, { messages: "cleared", users: "1 users set to empty password" });

  const zipPath = path.join(outDir, "test-world-0.1.0.zip");
  const names = (await listZipEntries(zipPath)).map((entry) => entry.name);
  assert.ok(!names.some((name) => name.startsWith("data/messages/")), "messages pack 不应进包");
  assert.ok(!names.some((name) => /(?:^|\/)(?:LOCK|LOG|LOG\.old)$/.test(name)), "LOCK/LOG 不应进包");
  assert.ok(names.includes("world.json"));

  const extracted = path.join(outDir, "extracted");
  await extractZip(zipPath, extracted);
  const manifest = JSON.parse(await readFile(path.join(extracted, "world.json"), "utf8"));
  assert.equal(manifest.id, "test-world");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.system, "dnd5e");
  assert.equal(manifest.manifest, "https://arcane-package.oss-cn-beijing.aliyuncs.com/worlds/test-world/0.1.0/world.json");
  assert.equal(manifest.download, "https://arcane-package.oss-cn-beijing.aliyuncs.com/worlds/test-world/0.1.0/test-world-0.1.0.zip");
  assert.ok(!("lastPlayed" in manifest) && !("playtime" in manifest));

  const db = new ClassicLevel(path.join(extracted, "data", "users"), { valueEncoding: "utf8", createIfMissing: false });
  await db.open();
  try {
    const users = [];
    for await (const [, value] of db.iterator()) users.push(JSON.parse(value));
    assert.equal(users.length, 1);
    const [user] = users;
    assert.match(user.password, /^[a-f0-9]{128}$/);
    assert.match(user.passwordSalt, /^[a-f0-9]{64}$/);
    assert.ok(foundryTestPassword("", user.password, user.passwordSalt), "密码框留空应可登录");
    assert.ok(!foundryTestPassword("wrong", user.password, user.passwordSalt), "错密码应被拒绝");
  } finally {
    await db.close();
  }
});

test("确定性:同一源目录两次打包 zip/manifest 哈希一致", async (t) => {
  const dir = await makeSourceWorld(t, { users: [goodUser] });
  const out1 = await mkdtemp(path.join(os.tmpdir(), "pack-world-d1-"));
  const out2 = await mkdtemp(path.join(os.tmpdir(), "pack-world-d2-"));
  t.after(() => Promise.all([rm(out1, { recursive: true, force: true }), rm(out2, { recursive: true, force: true })]));
  const r1 = await buildWorldRelease({ sourceDir: dir, outputDir: out1, ...PACK_ARGS });
  await new Promise((resolve) => setTimeout(resolve, 2100)); // 跨过 DOS 时间戳 2 秒粒度
  const r2 = await buildWorldRelease({ sourceDir: dir, outputDir: out2, ...PACK_ARGS });
  assert.equal(r1.zip.sha256, r2.zip.sha256);
  assert.equal(r1.manifest.sha256, r2.manifest.sha256);
});

test("源目录只读:打包后源 world.json 与 users 记录不变", async (t) => {
  const dir = await makeSourceWorld(t, { users: [brokenUser], messages: [{ _id: "m1", content: "x" }] });
  const before = await readFile(path.join(dir, "world.json"), "utf8");
  const outDir = await mkdtemp(path.join(os.tmpdir(), "pack-world-out-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildWorldRelease({ sourceDir: dir, outputDir: outDir, ...PACK_ARGS, clearMessages: true, setEmptyPassword: true });
  assert.equal(await readFile(path.join(dir, "world.json"), "utf8"), before);
  const db = new ClassicLevel(path.join(dir, "data", "users"), { valueEncoding: "utf8", createIfMissing: false });
  await db.open();
  try {
    const [, value] = await db.get("!users!gm0001").then((v) => [null, v]);
    assert.equal(JSON.parse(value).password, "", "源目录的半截记录不应被改写");
  } finally {
    await db.close();
  }
});

test("--clear-messages 与 --allow-messages 互斥", async (t) => {
  const dir = await makeSourceWorld(t, { users: [goodUser] });
  await assert.rejects(
    buildWorldRelease({ sourceDir: dir, outputDir: path.join(dir, "..", "out"), ...PACK_ARGS, clearMessages: true, allowMessages: true }),
    /mutually exclusive/,
  );
});

test("symlink 拒绝打包", async (t) => {
  const dir = await makeSourceWorld(t, { users: [goodUser], files: { "assets/real.png": Buffer.from([1]) } });
  try {
    await symlink(path.join(dir, "assets", "real.png"), path.join(dir, "assets", "link.png"));
  } catch {
    t.skip("本机无创建 symlink 权限(Windows 非提权会话)");
    return;
  }
  await assert.rejects(
    buildWorldRelease({ sourceDir: dir, outputDir: path.join(dir, "..", "out"), ...PACK_ARGS }),
    /symlink is not allowed/,
  );
});

// ---- prepare-world-profile 索引合并闸口 ----

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

function jsonEntry(value) {
  return { buffer: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8") };
}

async function profileFixture(t, users) {
  const root = await mkdtemp(path.join(os.tmpdir(), "world-profile-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worldDir = await makeSourceWorld(t, { users, manifest: { id: "test-world", version: "0.1.0", manifest: "https://mirror.test/worlds/test-world/0.1.0/world.json", download: "https://mirror.test/worlds/test-world/0.1.0/test-world-0.1.0.zip" } });
  const zipPath = path.join(root, "test-world-0.1.0.zip");
  await writeWorldArchive({ directory: worldDir, archive: zipPath });
  const zipBuffer = await readFile(zipPath);
  const manifestBuffer = Buffer.from(await readFile(path.join(worldDir, "world.json"), "utf8"), "utf8");

  const distributionFile = path.join(root, "distribution.json");
  await writeFile(distributionFile, `${JSON.stringify({
    schemaVersion: 1,
    worlds: [{
      id: "test-world",
      title: "测试世界",
      version: "0.1.0",
      system: "dnd5e",
      manifest: "https://mirror.test/worlds/test-world/0.1.0/world.json",
      download: "https://mirror.test/worlds/test-world/0.1.0/test-world-0.1.0.zip",
      manifestBytes: manifestBuffer.length,
      manifestSha256: sha256(manifestBuffer),
      bytes: zipBuffer.length,
      sha256: sha256(zipBuffer),
      defaultProfile: "test-profile",
    }],
    modules: [],
  }, null, 2)}\n`);

  const entries = {
    "https://mirror.test/index.json": jsonEntry({
      generated: "2026-09-28T00:00:00+00:00",
      packages: [{
        id: "dnd5e", group: "system", version: "5.3.3",
        manifestUrl: "https://mirror.test/dnd5e/5.3.3/system.json",
        zipUrl: "https://mirror.test/dnd5e/5.3.3/dnd5e.zip",
        bytes: 10, sha256: "0".repeat(64),
      }],
      worlds: [],
      profiles: [],
    }),
    "https://mirror.test/dnd5e/5.3.3/system.json": jsonEntry({ id: "dnd5e", version: "5.3.3" }),
    "https://mirror.test/worlds/test-world/0.1.0/world.json": { buffer: manifestBuffer },
    "https://mirror.test/worlds/test-world/0.1.0/test-world-0.1.0.zip": { buffer: zipBuffer },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMap(entries);
  t.after(() => { globalThis.fetch = originalFetch; });
  return { root, distributionFile };
}

const PROFILE_ARGS = {
  worldId: "test-world",
  profileId: "test-profile",
  profileTitle: "Test Profile",
  profileRevision: 1,
  expectedCurrentWorldVersion: "none",
  expectedCurrentProfileRevision: "none",
  baseUrl: "https://mirror.test",
};

test("索引合并闸口:半截凭证世界被拒", async (t) => {
  const { root, distributionFile } = await profileFixture(t, [brokenUser]);
  await assert.rejects(
    prepareWorldProfile({ distributionFile, outputDir: path.join(root, "out"), ...PROFILE_ARGS }),
    /failed content gate/,
  );
});

test("索引合并闸口:干净世界通过并产出 index/profile", async (t) => {
  const { root, distributionFile } = await profileFixture(t, [goodUser]);
  const outputDir = path.join(root, "out");
  const { plan } = await prepareWorldProfile({ distributionFile, outputDir, ...PROFILE_ARGS });
  assert.equal(plan.world.id, "test-world");
  const index = JSON.parse(await readFile(path.join(outputDir, "index.json"), "utf8"));
  assert.equal(index.worlds.length, 1);
  assert.equal(index.worlds[0].defaultProfile, "test-profile");
  assert.equal(index.profiles.length, 1);
  // index 里不得混入内容缓冲字段
  assert.ok(!("archiveBuffer" in index.worlds[0]));
});

test("索引合并闸口:--skip-content-gate 紧急豁免可绕过", async (t) => {
  const { root, distributionFile } = await profileFixture(t, [brokenUser]);
  const { plan } = await prepareWorldProfile({
    distributionFile, outputDir: path.join(root, "out"), ...PROFILE_ARGS, skipContentGate: true,
  });
  assert.equal(plan.world.id, "test-world");
});
