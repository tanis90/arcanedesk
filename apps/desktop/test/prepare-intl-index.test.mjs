import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareIntlIndex, publishMirrors } from "../scripts/prepare-intl-index.mjs";

const PREVIOUS_URL = "https://dl.test/mods/index-en.json";

const DND5E_CURATED = "https://up.test/dnd5e/releases/latest/download/system.json";
const DND5E_FINAL = "https://up.test/dnd5e/releases/download/release-6.0.0/system.json";
const DND5E_SELF = "https://raw.up.test/dnd5e/master/system.json";
const DND5E_ZIP = "https://up.test/dnd5e/releases/download/release-6.0.0/dnd5e.zip";

const MIDI_URL = "https://up.test/midi/module.json";
const MIDI_ZIP = "https://up.test/midi/midi-qol.zip";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function dnd5eManifest(overrides = {}) {
  return { id: "dnd5e", version: "6.0.0", download: DND5E_ZIP, manifest: DND5E_SELF, ...overrides };
}

function midiManifest(overrides = {}) {
  return { id: "midi-qol", version: "14.0.12", download: MIDI_ZIP, ...overrides };
}

function jsonResponder(value, { finalUrl } = {}) {
  return async () => ({ body: Buffer.from(JSON.stringify(value)), finalUrl });
}

function baseRoutes({ dnd5eSelf = dnd5eManifest(), midi = midiManifest() } = {}) {
  return new Map([
    [DND5E_CURATED, jsonResponder(dnd5eManifest(), { finalUrl: DND5E_FINAL })],
    [DND5E_SELF, jsonResponder(dnd5eSelf)],
    [DND5E_ZIP, async () => ({ body: Buffer.from("dnd5e-zip-bytes") })],
    [MIDI_URL, jsonResponder(midi)],
    [MIDI_ZIP, async () => ({ body: Buffer.from("midi-zip-bytes") })],
  ]);
}

// 仿全局 fetch 调用形态：未注册路由一律 404（线上索引基线即靠 404 表达"首次发布"）。
function makeFetch(routes) {
  return async (url) => {
    const href = String(url);
    const responder = routes.get(href);
    if (!responder) {
      return { ok: false, status: 404, url: href, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const { status = 200, body, finalUrl } = await responder(href);
    return {
      ok: status >= 200 && status < 300,
      status,
      url: finalUrl ?? href,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function writeCuration(directory, packages) {
  const file = path.join(directory, "curation.json");
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, packages }));
  return file;
}

function curatedPackages() {
  return [
    { id: "dnd5e", kind: "system", group: "system", manifestUrl: DND5E_CURATED },
    { id: "midi-qol", kind: "module", group: "automation", manifestUrl: MIDI_URL },
  ];
}

async function prepare(t, { routes, packages = curatedPackages(), compatibility = { foundry: "13.351" } }) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "intl-index-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const curationFile = await writeCuration(directory, packages);
  return prepareIntlIndex({
    curationFile,
    outputDir: path.join(directory, "out"),
    previousIndexUrl: PREVIOUS_URL,
    compatibility,
    fetchImpl: makeFetch(routes),
  });
}

test("intl index: measures curated upstreams, resolves self URLs, first publish has empty baseline", async (t) => {
  const { plan, index, indexBuffer } = await prepare(t, { routes: baseRoutes() });

  assert.equal(index.foundry, "13.351");
  assert.equal(index.dnd5e, "6.0.0");
  assert.deepEqual(index.worlds, []);
  assert.deepEqual(index.profiles, []);
  assert.deepEqual(index.packages.map((entry) => entry.id), ["dnd5e", "midi-qol"]);

  const dnd5e = index.packages[0];
  assert.equal(dnd5e.group, "system");
  assert.equal(dnd5e.version, "6.0.0");
  assert.equal(dnd5e.manifestUrl, DND5E_SELF);
  assert.equal(dnd5e.zipUrl, DND5E_ZIP);
  assert.equal(dnd5e.bytes, Buffer.byteLength("dnd5e-zip-bytes"));
  assert.equal(dnd5e.sha256, sha256(Buffer.from("dnd5e-zip-bytes")));

  const midi = index.packages[1];
  assert.equal(midi.manifestUrl, MIDI_URL);
  assert.equal(midi.zipUrl, MIDI_ZIP);
  assert.equal(midi.sha256, sha256(Buffer.from("midi-zip-bytes")));

  assert.equal(plan.previousIndex.baselineError, "published intl index returned HTTP 404");
  assert.equal(plan.nextIndex.key, "mods/index-en.json");
  assert.equal(plan.nextIndex.sha256, sha256(indexBuffer));

  const onDisk = await fsp.readFile(path.join(plan.outputDir, "index-en.json"));
  assert.deepEqual(onDisk, indexBuffer);
  assert.ok(onDisk.includes("\r\n"), "index must use CRLF serialization like the cn index");
});

test("intl index: same-version hash drift is a supply-chain failure", async (t) => {
  const routes = baseRoutes();
  routes.set(PREVIOUS_URL, jsonResponder({
    packages: [{
      id: "midi-qol",
      version: "14.0.12",
      group: "automation",
      bytes: 999,
      sha256: "0".repeat(64),
      zipUrl: MIDI_ZIP,
      manifestUrl: MIDI_URL,
    }],
  }));
  await assert.rejects(
    prepare(t, { routes }),
    /hash drift detected[\s\S]*midi-qol@14\.0\.12: hash drift/,
  );
});

test("intl index: same-version upstream URL change fails", async (t) => {
  const routes = baseRoutes();
  routes.set(PREVIOUS_URL, jsonResponder({
    packages: [{
      id: "midi-qol",
      version: "14.0.12",
      group: "automation",
      bytes: Buffer.byteLength("midi-zip-bytes"),
      sha256: sha256(Buffer.from("midi-zip-bytes")),
      zipUrl: "https://up.test/midi/moved.zip",
      manifestUrl: MIDI_URL,
    }],
  }));
  await assert.rejects(
    prepare(t, { routes }),
    /midi-qol@14\.0\.12: upstream URL changed/,
  );
});

test("intl index: upstream version upgrade passes drift check", async (t) => {
  const routes = baseRoutes();
  routes.set(PREVIOUS_URL, jsonResponder({
    packages: [{
      id: "midi-qol",
      version: "13.0.0",
      group: "automation",
      bytes: 1,
      sha256: "f".repeat(64),
      zipUrl: "https://up.test/midi/old.zip",
      manifestUrl: MIDI_URL,
    }],
  }));
  const { index } = await prepare(t, { routes });
  assert.equal(index.packages.find((entry) => entry.id === "midi-qol").version, "14.0.12");
});

test("intl index: missing dependency closure names every absent requirement", async (t) => {
  const routes = baseRoutes({
    midi: midiManifest({
      relationships: {
        requires: [
          { id: "socketlib", type: "module" },
          { id: "lib-wrapper", type: "module" },
        ],
      },
    }),
  });
  await assert.rejects(
    prepare(t, { routes }),
    /not dependency-closed[\s\S]*midi-qol requires module socketlib[\s\S]*midi-qol requires module lib-wrapper/,
  );
});

test("intl index: self URL on a different origin must agree on install-critical fields", async (t) => {
  const routes = baseRoutes({ dnd5eSelf: dnd5eManifest({ version: "6.0.1" }) });
  await assert.rejects(
    prepare(t, { routes }),
    /system dnd5e self URL document version mismatch: 6\.0\.1/,
  );
});

test("intl index: curation validation enforces kind/group/URL shape", async (t) => {
  const routes = baseRoutes();
  await assert.rejects(
    prepare(t, { routes, packages: [{ id: "dnd5e", kind: "system", group: "automation", manifestUrl: DND5E_CURATED }] }),
    /system dnd5e must use group "system"/,
  );
  await assert.rejects(
    prepare(t, { routes, packages: [{ id: "midi-qol", kind: "module", group: "system", manifestUrl: MIDI_URL }] }),
    /module midi-qol must not use group "system"/,
  );
  await assert.rejects(
    prepare(t, { routes, packages: [{ id: "dnd5e", kind: "system", group: "system", manifestUrl: MIDI_URL }] }),
    /must point to system\.json/,
  );
  await assert.rejects(
    prepare(t, { routes, packages: [{ id: "midi-qol", kind: "module", group: "automation", manifestUrl: "http://up.test/module.json" }] }),
    /credential-free HTTPS URL/,
  );
  await assert.rejects(
    prepare(t, {
      routes,
      packages: [
        { id: "midi-qol", kind: "module", group: "automation", manifestUrl: MIDI_URL },
        { id: "midi-qol", kind: "module", group: "library", manifestUrl: MIDI_URL },
      ],
    }),
    /curation repeats module:midi-qol/,
  );
});

// ---- 镜像模式（mirror: true） ----------------------------------------------

function makeHeadFetch(responses) {
  // HEAD 专用 fake：按 URL 返回 status 与 content-length。
  return async (url) => {
    const hit = responses.get(String(url)) ?? { status: 404, length: 0 };
    return {
      status: hit.status,
      headers: {
        get: (name) => (String(name).toLowerCase() === "content-length" ? String(hit.length) : null),
      },
    };
  };
}

function fakeR2Client() {
  const puts = [];
  return {
    puts,
    kind: "r2",
    async put(key, data, { headers = {} } = {}) {
      puts.push({ key, data, headers });
    },
    async multipartUpload(key, file, { headers = {} } = {}) {
      puts.push({ key, data: file, headers, multipart: true });
    },
  };
}

test("intl index: mirror entries rewrite self/download URLs to R2 and stage artifacts", async (t) => {
  const manifestUrl = "https://dl.arcanedesk.app/mods/packages/dnd5e/6.0.0/system.json";
  const zipUrl = "https://dl.arcanedesk.app/mods/packages/dnd5e/6.0.0/dnd5e-6.0.0.zip";
  const { plan, index } = await prepare(t, {
    routes: new Map([
      [DND5E_CURATED, jsonResponder(dnd5eManifest())],
      [DND5E_ZIP, async () => ({ body: Buffer.from("dnd5e-zip-bytes") })],
    ]),
    packages: [{ id: "dnd5e", kind: "system", group: "system", manifestUrl: DND5E_CURATED, mirror: true }],
  });

  const entry = index.packages[0];
  assert.equal(entry.manifestUrl, manifestUrl);
  assert.equal(entry.zipUrl, zipUrl);
  assert.equal(entry.bytes, Buffer.byteLength("dnd5e-zip-bytes"));
  assert.equal(entry.sha256, sha256(Buffer.from("dnd5e-zip-bytes")));
  assert.equal(index.dnd5e, "6.0.0");

  // 盘上 manifest 已把自指 URL 与下载地址改写为 R2 版本化 URL（mod-manager 安装断言这两个字段）。
  const stagedManifestRaw = await fsp.readFile(
    path.join(plan.outputDir, "mirror", "mods/packages/dnd5e/6.0.0/system.json"), "utf8");
  const stagedManifest = JSON.parse(stagedManifestRaw);
  assert.equal(stagedManifest.manifest, manifestUrl);
  assert.equal(stagedManifest.download, zipUrl);
  assert.equal(stagedManifest.version, "6.0.0");
  const stagedZip = await fsp.readFile(path.join(plan.outputDir, "mirror", "mods/packages/dnd5e/6.0.0/dnd5e-6.0.0.zip"));
  assert.deepEqual(stagedZip, Buffer.from("dnd5e-zip-bytes"));

  assert.equal(plan.mirrors.length, 1);
  assert.deepEqual(plan.mirrors[0], {
    manifestKey: "mods/packages/dnd5e/6.0.0/system.json",
    manifestUrl,
    manifestBytes: Buffer.byteLength(stagedManifestRaw),
    zipKey: "mods/packages/dnd5e/6.0.0/dnd5e-6.0.0.zip",
    zipUrl,
    zipBytes: Buffer.byteLength("dnd5e-zip-bytes"),
    zipSha256: sha256(Buffer.from("dnd5e-zip-bytes")),
  });
});

test("intl index: mirror entries ignore unstable upstream self URLs", async (t) => {
  // dnd5e 的真实情况：5.3.3 的 manifest 自指 master 分支（已推进到 6.x）。
  // 直连模式会因此失败，镜像模式必须能正常生成。
  const { index } = await prepare(t, {
    routes: new Map([
      [DND5E_CURATED, jsonResponder(dnd5eManifest({ version: "5.3.3" }))],
      [DND5E_ZIP, async () => ({ body: Buffer.from("dnd5e-5.3.3-zip") })],
      // 注意：不提供 DND5E_SELF 路由——镜像模式不应访问上游自指 URL。
    ]),
    packages: [{ id: "dnd5e", kind: "system", group: "system", manifestUrl: DND5E_CURATED, mirror: true }],
  });
  assert.equal(index.packages[0].version, "5.3.3");
  assert.equal(index.packages[0].manifestUrl, "https://dl.arcanedesk.app/mods/packages/dnd5e/5.3.3/system.json");
});

test("intl index: publishMirrors uploads missing objects, skips current, alarms on immutable drift", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "intl-mirror-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));

  const mirrorPlan = {
    manifestKey: "mods/packages/dnd5e/6.0.0/system.json",
    manifestUrl: "https://dl.arcanedesk.app/mods/packages/dnd5e/6.0.0/system.json",
    zipKey: "mods/packages/dnd5e/6.0.0/dnd5e-6.0.0.zip",
    zipUrl: "https://dl.arcanedesk.app/mods/packages/dnd5e/6.0.0/dnd5e-6.0.0.zip",
    zipBytes: Buffer.byteLength("dnd5e-zip-bytes"),
    zipSha256: sha256(Buffer.from("dnd5e-zip-bytes")),
  };
  const manifestBody = '{"id":"dnd5e"}\n';
  mirrorPlan.manifestBytes = Buffer.byteLength(manifestBody);
  await fsp.mkdir(path.dirname(path.join(directory, "mirror", mirrorPlan.manifestKey)), { recursive: true });
  await fsp.mkdir(path.dirname(path.join(directory, "mirror", mirrorPlan.zipKey)), { recursive: true });
  await fsp.writeFile(path.join(directory, "mirror", mirrorPlan.manifestKey), manifestBody);
  await fsp.writeFile(path.join(directory, "mirror", mirrorPlan.zipKey), Buffer.from("dnd5e-zip-bytes"));

  const verifyTrue = async () => true;

  // 对象不存在（HEAD 404）→ 上传 zip 与 manifest，Cache-Control 不可变。
  {
    const client = fakeR2Client();
    await publishMirrors(client, [mirrorPlan], {
      outputDir: directory,
      fetchImpl: makeHeadFetch(new Map()),
      verifyImpl: verifyTrue,
    });
    assert.deepEqual(client.puts.map((put) => put.key), [mirrorPlan.zipKey, mirrorPlan.manifestKey]);
    assert.equal(client.puts[0].headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(client.puts[0].headers["Content-Type"], "application/zip");
    assert.equal(client.puts[1].headers["Content-Type"], "application/json; charset=utf-8");
    assert.deepEqual(client.puts[1].data, Buffer.from(manifestBody, "utf8"));
  }

  // 已存在且长度一致 → 跳过（周更幂等，不重传 100MB）。
  {
    const client = fakeR2Client();
    await publishMirrors(client, [mirrorPlan], {
      outputDir: directory,
      fetchImpl: makeHeadFetch(new Map([
        [mirrorPlan.zipUrl, { status: 200, length: mirrorPlan.zipBytes }],
        [mirrorPlan.manifestUrl, { status: 200, length: mirrorPlan.manifestBytes }],
      ])),
      verifyImpl: verifyTrue,
    });
    assert.equal(client.puts.length, 0);
  }

  // 已存在但长度不同 → 不可变纪律被破坏，报警且不上传。
  {
    const client = fakeR2Client();
    await assert.rejects(
      publishMirrors(client, [mirrorPlan], {
        outputDir: directory,
        fetchImpl: makeHeadFetch(new Map([
          [mirrorPlan.zipUrl, { status: 200, length: mirrorPlan.zipBytes + 1 }],
        ])),
        verifyImpl: verifyTrue,
      }),
      /immutable mirror object differs/,
    );
    assert.equal(client.puts.length, 0);
  }
});
