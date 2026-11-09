// world-content-audit 回归网:users 凭证成对(0.1.3 半截凭证事故形态)、
// messages 清空纪律、世界外路径引用,以及 scanWorldZip 两条 flavor 的接入。
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClassicLevel } from "classic-level";

import { scanWorldZip } from "../scripts/intl-world-gate.mjs";
import { writeWorldArchive } from "../scripts/publish-intl-world.mjs";
import { auditWorldDirectory } from "../scripts/world-content-audit.mjs";

function passwordPair(plaintext = "") {
  const salt = randomBytes(32).toString("hex");
  const hash = pbkdf2Sync(plaintext, salt, 1000, 64, "sha512").toString("hex");
  return { password: hash, passwordSalt: salt };
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

async function makeWorld(t, { users = null, messages = null, packs = {}, files = {}, manifest = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "world-audit-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "world.json"),
    `${JSON.stringify({ id: "test-world", title: "Test World", version: "0.0.1", system: "dnd5e", ...manifest }, null, 2)}\n`,
  );
  if (users) await writePack(path.join(dir, "data", "users"), users.map((doc) => [`!users!${doc._id}`, doc]));
  if (messages) await writePack(path.join(dir, "data", "messages"), messages.map((doc) => [`!messages!${doc._id}`, doc]));
  for (const [pack, records] of Object.entries(packs)) {
    await writePack(path.join(dir, "data", pack), records);
  }
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

async function zipWorld(t, dir) {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "world-audit-zip-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const zipPath = path.join(outDir, "test-world.zip");
  await writeWorldArchive({ directory: dir, archive: zipPath });
  return zipPath;
}

const pairedUser = { _id: "gm0001", name: "Gamemaster", role: 4, ...passwordPair("") };

test("成对凭证通过审计", async (t) => {
  const dir = await makeWorld(t, { users: [pairedUser] });
  assert.deepEqual(await auditWorldDirectory(dir), []);
});

test("0.1.3 事故形态:password 为空串且无 passwordSalt → user-credentials-unpaired", async (t) => {
  const dir = await makeWorld(t, { users: [{ _id: "gm0001", name: "Gamemaster", role: 4, password: "" }] });
  const violations = await auditWorldDirectory(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "user-credentials-unpaired");
  assert.equal(violations[0].file, "data/users");
});

test("有 passwordSalt 无 password → user-credentials-unpaired", async (t) => {
  const dir = await makeWorld(t, { users: [{ _id: "gm0001", name: "Gamemaster", role: 4, passwordSalt: "ab".repeat(32) }] });
  const violations = await auditWorldDirectory(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "user-credentials-unpaired");
});

test("password 非 64 字节 hex(即便有 salt)→ user-password-malformed", async (t) => {
  const dir = await makeWorld(t, { users: [{ _id: "gm0001", name: "Gamemaster", role: 4, password: "nothex", passwordSalt: "ab".repeat(32) }] });
  const violations = await auditWorldDirectory(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "user-password-malformed");
});

test("users pack 存在但零记录 → users-empty;requireUsers:false 豁免", async (t) => {
  const dir = await makeWorld(t, { users: [] });
  assert.equal((await auditWorldDirectory(dir))[0]?.kind, "users-empty");
  assert.deepEqual(await auditWorldDirectory(dir, { requireUsers: false }), []);
});

test("无 users pack 不强制(Foundry 首启自建)", async (t) => {
  const dir = await makeWorld(t);
  assert.deepEqual(await auditWorldDirectory(dir), []);
});

test("messages 未清空 → messages-not-empty;requireEmptyMessages:false 豁免(intl 形态)", async (t) => {
  const dir = await makeWorld(t, { users: [pairedUser], messages: [{ _id: "m1", content: "跑团记录" }] });
  assert.equal((await auditWorldDirectory(dir))[0]?.kind, "messages-not-empty");
  assert.deepEqual(await auditWorldDirectory(dir, { requireEmptyMessages: false }), []);
});

test("世界外路径引用:Data/arcanedesk、盘符、POSIX、Data/ 非本世界前缀全部命中", async (t) => {
  const dir = await makeWorld(t, {
    users: [pairedUser],
    packs: {
      journal: [["!journal!j1", {
        _id: "j1",
        name: "note",
        pages: [],
        img1: "Data/arcanedesk/assets/leak.png",
        img2: "C:\\Users\\dm\\secret.png",
        img3: "/Users/dm/secret.png",
        img4: "Data/systems/dnd5e/icons/x.svg",
      }]],
    },
  });
  const violations = await auditWorldDirectory(dir);
  const terms = violations.filter((v) => v.kind === "external-path").map((v) => v.term);
  assert.equal(terms.length, 4);
  assert.ok(terms.some((term) => term.includes("Data/arcanedesk")));
  assert.ok(terms.some((term) => term.includes("C:\\")));
  assert.ok(terms.some((term) => term.includes("/Users/")));
  assert.ok(terms.some((term) => term.includes("Data/systems/")));
});

test("本世界与 URL 引用不误报:worlds/<id>/、Data/worlds/<id>/、https://", async (t) => {
  const dir = await makeWorld(t, {
    users: [pairedUser],
    packs: {
      journal: [["!journal!j1", {
        _id: "j1",
        name: "note",
        pages: [],
        img1: "worlds/test-world/assets/map.png",
        img2: "Data/worlds/test-world/assets/map.png",
        img3: "https://example.com/map.png",
        img4: "systems/dnd5e/icons/x.svg",
        img5: "modules/midi-qol/x.svg",
      }]],
    },
    files: {
      "notes.md": "manifest 在 https://arcane-package.oss-cn-beijing.aliyuncs.com/worlds/test-world/0.0.1/world.json",
    },
  });
  assert.deepEqual(await auditWorldDirectory(dir), []);
});

test("scanWorldZip:坏世界 zip 被拦;intlPolicy:false 时 CJK 不报(CN 形态)", async (t) => {
  const dir = await makeWorld(t, {
    users: [{ _id: "gm0001", name: "Gamemaster", role: 4, password: "" }],
    files: { "notes.md": "中文内容在 CN 形态下合法" },
  });
  const zipPath = await zipWorld(t, dir);

  const cn = await scanWorldZip(zipPath, os.tmpdir(), { intlPolicy: false, requireEmptyMessages: true });
  assert.deepEqual(cn.violations.map((v) => v.kind), ["user-credentials-unpaired"]);

  const intl = await scanWorldZip(zipPath, os.tmpdir());
  assert.ok(intl.violations.some((v) => v.kind === "user-credentials-unpaired"));
  assert.ok(intl.violations.some((v) => v.kind === "cjk"));
});

test("scanWorldZip:干净世界两种 flavor 都通过", async (t) => {
  const dir = await makeWorld(t, { users: [pairedUser] });
  const zipPath = await zipWorld(t, dir);
  assert.deepEqual((await scanWorldZip(zipPath, os.tmpdir(), { intlPolicy: false })).violations, []);
  assert.deepEqual((await scanWorldZip(zipPath)).violations, []);
});

test("writeWorldArchive 确定性:同一目录两次打包逐字节一致", async (t) => {
  const dir = await makeWorld(t, { users: [pairedUser] });
  const first = await zipWorld(t, dir);
  await new Promise((resolve) => setTimeout(resolve, 2100)); // 跨过 DOS 时间戳 2 秒粒度
  const second = await zipWorld(t, dir);
  assert.ok((await readFile(first)).equals(await readFile(second)), "zip bytes differ across runs (fflate mtime regression)");
});
