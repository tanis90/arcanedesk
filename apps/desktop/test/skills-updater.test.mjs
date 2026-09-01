// skills-updater 安全语义回归网:整条链路只认固定 baseUrl + manifest SHA256,
// 任何一环损坏都必须 fail closed 回退包内基线,绝不带伤上阵。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

import { SkillsUpdater, bundleRevision, compareSemver } from "../src/main/skills-updater.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILLS = path.join(desktopRoot, "skills", "prep");
const BASE = "https://arcane-package.test/skills";

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-skills-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个待发布的 skill 树:bundle.json + 调用方给的文件。 */
async function writeSkillsTree(dir, revision, files) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "bundle.json"),
    `${JSON.stringify({ schemaVersion: 1, revision }, null, 2)}\n`,
    "utf8",
  );
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
  }
}

/** 模拟发布侧:打包 + 生成 manifest,返回挂到假 OSS 上的三个对象。 */
async function stagePublishedBundle(workDir, revision, { files, minAppVersion, tamperBundle }) {
  const tree = path.join(workDir, `tree-r${revision}`);
  await writeSkillsTree(tree, revision, files);
  const bundleFile = path.join(workDir, `bundle-r${revision}.tar.gz`);
  const entries = ["bundle.json", ...Object.keys(files).sort()];
  await tar.c({ file: bundleFile, cwd: tree, gzip: true, portable: true }, entries);
  let bundle = await fsp.readFile(bundleFile);
  const manifest = {
    schemaVersion: 1,
    revision,
    ...(minAppVersion ? { minAppVersion } : {}),
    publishedAt: "2026-08-31T00:00:00Z",
    bundle: { file: "bundle.tar.gz", bytes: bundle.length, sha256: sha256Hex(bundle) },
    files: Object.fromEntries(
      ["bundle.json", ...Object.keys(files).sort()].map((name) => {
        const content = Buffer.from(
          name === "bundle.json"
            ? `${JSON.stringify({ schemaVersion: 1, revision }, null, 2)}\n`
            : files[name],
          "utf8",
        );
        return [name, { bytes: content.length, sha256: sha256Hex(content) }];
      }),
    ),
  };
  if (tamperBundle) bundle = Buffer.concat([bundle, Buffer.from("tampered")]);
  return { bundle, manifest, pointer: { schemaVersion: 1, revision, publishedAt: manifest.publishedAt } };
}

/** 假 OSS:按 URL 出对象,记录每个 URL 的 GET 次数。 */
function mockOss(objects, calls) {
  return async (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const body = objects.get(url);
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

function objectsFor({ bundle, manifest, pointer }) {
  return new Map([
    [`${BASE}/latest.json`, Buffer.from(JSON.stringify(pointer), "utf8")],
    [`${BASE}/${pointer.revision}/manifest.json`, Buffer.from(JSON.stringify(manifest), "utf8")],
    [`${BASE}/${pointer.revision}/bundle.tar.gz`, bundle],
  ]);
}

function makeUpdater({ stateDir, calls, objects, appVersion = "0.1.7", onActivated, onRefreshResult, log }) {
  return new SkillsUpdater({
    bundledSkillsDir: BUNDLED_SKILLS,
    stateDir,
    appVersion,
    baseUrl: BASE,
    fetchImpl: mockOss(objects, calls),
    onActivated,
    onRefreshResult,
    log: log ?? (() => {}),
  });
}

test("compareSemver orders three-part versions and rejects junk", () => {
  assert.equal(compareSemver("0.1.7", "0.1.7"), 0);
  assert.ok(compareSemver("0.1.8", "0.1.7") > 0);
  assert.ok(compareSemver("0.1.7", "0.10.0") < 0);
  assert.throws(() => compareSemver("0.1", "0.1.7"), /three-part/);
  assert.throws(() => compareSemver("0.1.7", ""), /three-part/);
});

test("bundleRevision reads the monotonic revision and tolerates missing metadata", () => {
  assert.ok(bundleRevision(BUNDLED_SKILLS) >= 1);
  assert.equal(bundleRevision(path.join(BUNDLED_SKILLS, "does-not-exist")), 0);
});

test("update base URL must be HTTPS, with HTTP allowed only on exact loopback", async (t) => {
  const stateDir = path.join(await makeTempDir(t), "skills");
  const make = (baseUrl) => new SkillsUpdater({
    bundledSkillsDir: BUNDLED_SKILLS,
    stateDir,
    appVersion: "0.1.7",
    baseUrl,
    fetchImpl: async () => new Response("x", { status: 404 }),
    log: () => {},
  });
  assert.equal(make("http://127.0.0.1:8765/skills").baseUrl, "http://127.0.0.1:8765/skills");
  assert.equal(make("https://example.com/skills/").baseUrl, "https://example.com/skills");
  assert.throws(() => make("http://oss.example.com/skills"), /HTTPS/);
  assert.throws(() => make("http://127.0.0.1.evil.com/skills"), /HTTPS/);
  assert.throws(() => make("not a url"), /not a valid URL/);
});

test("fresh install without an activated copy resolves to the bundled baseline", async (t) => {
  const stateDir = path.join(await makeTempDir(t), "skills");
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: new Map() });
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
});

test("refresh downloads, verifies, and atomically activates a newer bundle", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const published = await stagePublishedBundle(workDir, bundleRevision(BUNDLED_SKILLS) + 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# updated ops skill\n" },
  });
  const calls = new Map();
  const activations = [];
  const updater = makeUpdater({
    stateDir,
    calls,
    objects: objectsFor(published),
    onActivated: (dir, revision) => activations.push({ dir, revision }),
  });

  const result = await updater.refresh();
  assert.equal(result.updated, true);
  assert.equal(result.revision, bundleRevision(BUNDLED_SKILLS) + 1);
  assert.equal(updater.resolveSkillsDir(), path.join(stateDir, "active"));
  assert.deepEqual(activations, [{ dir: path.join(stateDir, "active"), revision: result.revision }]);
  const state = JSON.parse(await fsp.readFile(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.revision, result.revision);
  const skill = await fsp.readFile(path.join(stateDir, "active", "arcane-fvtt-ops", "SKILL.md"), "utf8");
  assert.equal(skill, "# updated ops skill\n");

  // 第二次刷新:指针没有更新,不得重复下载 bundle。
  const again = await updater.refresh();
  assert.equal(again.updated, false);
  assert.equal(again.reason, "up-to-date");
  assert.equal(calls.get(`${BASE}/${result.revision}/bundle.tar.gz`), 1);
});

test("refresh keeps the bundled baseline when the app is older than minAppVersion", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const published = await stagePublishedBundle(workDir, bundleRevision(BUNDLED_SKILLS) + 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# needs a newer app\n" },
    minAppVersion: "9.9.9",
  });
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: objectsFor(published) });
  const result = await updater.refresh();
  assert.deepEqual(result, { updated: false, reason: "min-app-version", revision: bundleRevision(BUNDLED_SKILLS) });
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
});

test("refresh rejects a tampered bundle and keeps the current skills", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const published = await stagePublishedBundle(workDir, bundleRevision(BUNDLED_SKILLS) + 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# tampered\n" },
    tamperBundle: true,
  });
  const logs = [];
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: objectsFor(published), log: (m) => logs.push(m) });
  const result = await updater.refresh();
  assert.equal(result.updated, false);
  assert.equal(result.reason, "error");
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
  assert.ok(logs.some((m) => m.includes("refresh failed")));
});

test("refresh rejects a bundle whose extracted tree has unlisted files", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const revision = bundleRevision(BUNDLED_SKILLS) + 1;
  const published = await stagePublishedBundle(workDir, revision, {
    files: { "arcane-fvtt-ops/SKILL.md": "# listed\n", "evil/extra.md": "unlisted\n" },
  });
  // manifest 只申报一个文件,tarball 里却多出一个 → 必须拒绝。
  delete published.manifest.files["evil/extra.md"];
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: objectsFor(published) });
  const result = await updater.refresh();
  assert.equal(result.updated, false);
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
});

test("refresh rejects a manifest that does not match the latest pointer", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const revision = bundleRevision(BUNDLED_SKILLS) + 1;
  const published = await stagePublishedBundle(workDir, revision, {
    files: { "arcane-fvtt-ops/SKILL.md": "# mismatched\n" },
  });
  published.manifest.revision = revision + 100;
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: objectsFor(published) });
  const result = await updater.refresh();
  assert.equal(result.updated, false);
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
});

test("a stale pointer never downgrades an activated newer bundle", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const revision = bundleRevision(BUNDLED_SKILLS) + 1;
  const published = await stagePublishedBundle(workDir, revision, {
    files: { "arcane-fvtt-ops/SKILL.md": "# current\n" },
  });
  const calls = new Map();
  const updater = makeUpdater({ stateDir, calls, objects: objectsFor(published) });
  assert.equal((await updater.refresh()).updated, true);

  // 远端指针回退到旧 revision(例如运维误操作):不得触发任何下载或换目录。
  const stale = await stagePublishedBundle(workDir, revision - 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# stale\n" },
  });
  const callsAfter = new Map();
  const relisting = makeUpdater({ stateDir, calls: callsAfter, objects: objectsFor(stale) });
  const result = await relisting.refresh();
  assert.equal(result.updated, false);
  assert.equal(result.reason, "up-to-date");
  assert.equal(callsAfter.get(`${BASE}/${revision - 1}/bundle.tar.gz`) ?? 0, 0);
  assert.equal(relisting.resolveSkillsDir(), path.join(stateDir, "active"));
});

test("a corrupted activated copy is discarded and the bundled baseline takes over", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const revision = bundleRevision(BUNDLED_SKILLS) + 1;
  const published = await stagePublishedBundle(workDir, revision, {
    files: { "arcane-fvtt-ops/SKILL.md": "# will be corrupted\n" },
  });
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: objectsFor(published) });
  assert.equal((await updater.refresh()).updated, true);
  assert.equal(updater.resolveSkillsDir(), path.join(stateDir, "active"));

  // 激活副本在两次运行之间被改坏 → 下一次启动解析必须 fail closed。
  await fsp.writeFile(path.join(stateDir, "active", "arcane-fvtt-ops", "SKILL.md"), "corrupted\n", "utf8");
  const logs = [];
  const restarted = makeUpdater({ stateDir, calls: new Map(), objects: new Map(), log: (m) => logs.push(m) });
  assert.equal(restarted.resolveSkillsDir(), BUNDLED_SKILLS);
  assert.ok(logs.some((m) => m.includes("discarded the activated skills copy")));
  const stateExists = await fsp.stat(path.join(stateDir, "state.json")).then(() => true, () => false);
  assert.equal(stateExists, false);
});

test("an activated copy older than a newer bundled baseline is discarded", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const revision = bundleRevision(BUNDLED_SKILLS) + 1;
  const published = await stagePublishedBundle(workDir, revision, {
    files: { "arcane-fvtt-ops/SKILL.md": "# from r-old\n" },
  });
  const updater = makeUpdater({ stateDir, calls: new Map(), objects: objectsFor(published) });
  assert.equal((await updater.refresh()).updated, true);

  // 模拟 app 升级:包内基线 revision 比激活副本还新 → 激活副本作废。
  const bundledNewer = path.join(workDir, "bundled-newer");
  await writeSkillsTree(bundledNewer, revision + 1, { "arcane-fvtt-ops/SKILL.md": "# shipped in app\n" });
  const restarted = new SkillsUpdater({
    bundledSkillsDir: bundledNewer,
    stateDir,
    appVersion: "0.1.7",
    baseUrl: BASE,
    fetchImpl: mockOss(new Map(), new Map()),
    log: () => {},
  });
  assert.equal(restarted.resolveSkillsDir(), bundledNewer);
});

test("a malformed latest pointer fails closed without touching local state", async (t) => {
  const stateDir = path.join(await makeTempDir(t), "skills");
  const objects = new Map([[`${BASE}/latest.json`, Buffer.from('{"schemaVersion":1,"revision":"two"}', "utf8")]]);
  const updater = makeUpdater({ stateDir, calls: new Map(), objects });
  const result = await updater.refresh();
  assert.equal(result.updated, false);
  assert.equal(result.reason, "error");
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
});

test("a network failure during refresh keeps startup usable", async (t) => {
  const stateDir = path.join(await makeTempDir(t), "skills");
  const updater = new SkillsUpdater({
    bundledSkillsDir: BUNDLED_SKILLS,
    stateDir,
    appVersion: "0.1.7",
    baseUrl: BASE,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    log: () => {},
  });
  const result = await updater.refresh();
  assert.deepEqual(result, { updated: false, reason: "error" });
  assert.equal(updater.resolveSkillsDir(), BUNDLED_SKILLS);
});

// ---- onRefreshResult 运维遥测:每次 refresh 一条;回调失败绝不影响刷新语义 ----

/** durationMs 抖动不可断言,剥掉后比对其余字段。 */
function stripDuration({ durationMs, ...rest }) {
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
  return rest;
}

test("every refresh reports exactly one outcome with from/to revisions", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const published = await stagePublishedBundle(workDir, bundleRevision(BUNDLED_SKILLS) + 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# updated ops skill\n" },
  });
  const reports = [];
  const updater = makeUpdater({
    stateDir,
    calls: new Map(),
    objects: objectsFor(published),
    onRefreshResult: (report) => reports.push(report),
  });

  const first = await updater.refresh();
  assert.equal(first.updated, true);
  const second = await updater.refresh();
  assert.equal(second.reason, "up-to-date");

  assert.equal(reports.length, 2);
  assert.deepEqual(stripDuration(reports[0]), {
    outcome: "updated",
    fromRevision: bundleRevision(BUNDLED_SKILLS),
    toRevision: first.revision,
    error: null,
  });
  assert.deepEqual(stripDuration(reports[1]), {
    outcome: "up_to_date",
    fromRevision: first.revision,
    toRevision: first.revision,
    error: null,
  });
});

test("the minAppVersion gate reports the blocked target revision", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const published = await stagePublishedBundle(workDir, bundleRevision(BUNDLED_SKILLS) + 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# needs a newer app\n" },
    minAppVersion: "9.9.9",
  });
  const reports = [];
  const updater = makeUpdater({
    stateDir,
    calls: new Map(),
    objects: objectsFor(published),
    onRefreshResult: (report) => reports.push(report),
  });
  await updater.refresh();
  assert.deepEqual(stripDuration(reports[0]), {
    outcome: "min_app_version_blocked",
    fromRevision: bundleRevision(BUNDLED_SKILLS),
    toRevision: bundleRevision(BUNDLED_SKILLS) + 1,
    error: null,
  });
});

test("a failing refresh reports outcome=error with the error attached for classification", async (t) => {
  const stateDir = path.join(await makeTempDir(t), "skills");
  const reports = [];
  const updater = makeUpdater({
    stateDir,
    calls: new Map(),
    objects: new Map(), // latest.json 404
    onRefreshResult: (report) => reports.push(report),
  });
  const result = await updater.refresh();
  assert.deepEqual(result, { updated: false, reason: "error" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "error");
  assert.ok(reports[0].error instanceof Error);
  assert.match(reports[0].error.message, /HTTP 404/);
  assert.equal(reports[0].toRevision, 0); // 指针都没拿到,目标未知
});

test("a throwing onRefreshResult callback never changes refresh semantics", async (t) => {
  const workDir = await makeTempDir(t);
  const stateDir = path.join(workDir, "skills");
  const published = await stagePublishedBundle(workDir, bundleRevision(BUNDLED_SKILLS) + 1, {
    files: { "arcane-fvtt-ops/SKILL.md": "# telemetry must not break activation\n" },
  });
  const updater = makeUpdater({
    stateDir,
    calls: new Map(),
    objects: objectsFor(published),
    onRefreshResult: () => {
      throw new Error("telemetry blew up");
    },
  });
  const result = await updater.refresh();
  assert.equal(result.updated, true);
  assert.equal(updater.resolveSkillsDir(), path.join(stateDir, "active"));
});
