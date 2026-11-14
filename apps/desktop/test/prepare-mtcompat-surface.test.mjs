// A2 离线蒸馏生成器单测：fixture 声明面 JSON → 产物形状 / 排序 / 三规则逐字 / revision 钉住，
// 以及拉取失败时的离线兜底（有旧产物沿用、无旧产物才失败）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PITFALL_LIMIT,
  DEFAULT_SURFACE_URL,
  SURFACE_ALLOW_MISSING_ENV,
  SURFACE_RULES,
  distillSurface,
  fetchSurface,
  main,
  parseArgs,
  preferredExtensions,
  rankPitfalls,
  renderEntryLine,
} from "../scripts/prepare-mtcompat-surface.mjs";

// §2.5 三规则逐字（PRD agent-api §2.5 原文）——测试里独立抄一遍才算数：
// 蒸馏段的这一节是 agent 侧纪律的唯一成文出口，不许被顺稿。
const PRD_RULES = [
  "优先用 typed action，eval 是兜底。",
  "要写 eval 碰某个域之前，先调 `apiSurface({prefix:\"<域>\"})` 看一眼。",
  "eval 返回里的 `touched`/`missing` 必须读；报了你踩桩，就按 note 绕开重写。",
];

const FIXTURE = {
  revision: 7,
  defaultPolicy: "unverified",
  domains: [
    { prefix: "canvas", status: "partial", note: "自绘画布" },
    { prefix: "game", status: "partial", note: "核心面" },
  ],
  entries: [
    { path: "Hooks", status: "full", note: "钩子总线真" },
    { path: "canvas.ping", status: "stub-noop", note: "空操作（canvas-semantics.mjs:1531）" },
    { path: "canvas.pan", status: "stub-noop", note: "空操作", delta: "无取景变换语义" },
    { path: "mt.viewScene", status: "extension", agent: "prefer", note: "场景切换唯一入口", use: "__MT_CANVAS_SEMANTICS__.viewScene(scene)" },
    { path: "mt.playersShare", status: "extension", note: "手机卡链接面（未标 prefer）" },
    { path: "Scene#activate", status: "absent", note: "shim 无此方法", use: "__MT_CANVAS_SEMANTICS__.viewScene(scene)" },
    { path: "Dialog.confirm", status: "stub-fixed", note: "恒 resolve null" },
    { path: "Application", status: "partial", note: "V1 应用桩" },
    { path: "game.i18n", status: "full", note: "核心面", delta: "localize 宽容收 data" },
    { path: "brand.new", status: "some-future-status", note: "词汇表外状态" },
    { path: "", status: "absent", note: "坏条目：没有 path" },
  ],
};

function scratchDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcane-surface-distill-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeFetch(body, { status = 200, headers = new Map() } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

test("坑位按严重度排序：absent > stub-noop > stub-fixed > partial；full 只在带 delta 时入榜", () => {
  assert.deepEqual(rankPitfalls(FIXTURE.entries).map((entry) => entry.path), [
    "Scene#activate",
    "canvas.pan", // 同档内语义差优先，尽管在输入里排在 canvas.ping 之后
    "canvas.ping",
    "Dialog.confirm",
    "Application",
    "game.i18n", // full + delta（URL 地址空间这类“能用但语义差”）
  ]);
  const artifact = distillSurface(FIXTURE);
  assert.deepEqual(artifact.pitfalls.map((entry) => entry.path), [
    "Scene#activate", "canvas.pan", "canvas.ping", "Dialog.confirm", "Application", "game.i18n",
  ]);
  assert.equal(artifact.pitfalls.some((entry) => entry.path === "Hooks"), false, "full 且无语义差 = 真面，不进坑位榜");
  assert.equal(artifact.pitfalls.some((entry) => entry.path === "brand.new"), false, "词汇表外状态跳过");
});

test("Top-N 截断：条数与上限写进产物 meta，段落标题跟着走", () => {
  const artifact = distillSurface(FIXTURE, { top: 2 });
  assert.deepEqual(artifact.pitfalls.map((entry) => entry.path), ["Scene#activate", "canvas.pan"]);
  assert.equal(artifact.pitfallLimit, 2);
  assert.equal(artifact.counts.pitfalls, 2);
  assert.equal(artifact.counts.entries, 10); // 坏条目（无 path）不计
  assert.equal(artifact.counts.domains, 2);
  assert.equal(artifact.counts.extensions, 1);
  assert.deepEqual(artifact.counts.byStatus, {
    full: 2, "stub-noop": 2, extension: 2, absent: 1, "stub-fixed": 1, partial: 1, "some-future-status": 1,
  });
  assert.match(artifact.segment, /坑位 Top 2（严重度 absent > stub-noop > stub-fixed > partial）：/);
  assert.equal(distillSurface(FIXTURE).pitfallLimit, DEFAULT_PITFALL_LIMIT);
});

test("行形状：`path`：status——note，带 delta/use 续在同行", () => {
  assert.equal(
    renderEntryLine({ path: "canvas.pan", status: "stub-noop", note: "空操作", delta: "无取景变换语义" }),
    "- `canvas.pan`：stub-noop——空操作；delta: 无取景变换语义",
  );
  assert.equal(
    renderEntryLine({ path: "Scene#activate", status: "absent", note: "shim 无此方法", use: "mt.viewScene(scene)" }),
    "- `Scene#activate`：absent——shim 无此方法；use: mt.viewScene(scene)",
  );
  assert.equal(renderEntryLine({ path: "game.audio", status: "absent" }), "- `game.audio`：absent");
  const segment = distillSurface(FIXTURE).segment;
  assert.ok(segment.includes("- `canvas.pan`：stub-noop——空操作；delta: 无取景变换语义"));
  assert.ok(segment.includes("；use: __MT_CANVAS_SEMANTICS__.viewScene(scene)"));
});

test("§2.5 三规则逐字进段落（编号独立成行）", () => {
  assert.deepEqual([...SURFACE_RULES], PRD_RULES);
  const { segment } = distillSurface(FIXTURE);
  const lines = segment.split("\n");
  for (const [index, rule] of PRD_RULES.entries()) {
    assert.ok(lines.includes(`${index + 1}. ${rule}`), `第 ${index + 1} 条规则必须逐字在段落里`);
  }
  assert.ok(lines.includes("纪律（逐字，PRD §2.5）："));
});

test("revision 钉进产物与段落；扩展动词只收 agent=prefer", () => {
  const artifact = distillSurface(FIXTURE, { sourceUrl: "https://example.test/api-surface.json", generatedAt: "2026-10-16T00:00:00.000Z" });
  assert.equal(artifact.revision, 7);
  assert.equal(artifact.sourceUrl, "https://example.test/api-surface.json");
  assert.equal(artifact.generatedAt, "2026-10-16T00:00:00.000Z");
  assert.equal(artifact.defaultPolicy, "unverified");
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.kind, "mtcompat-surface-distill");
  assert.ok(artifact.segment.startsWith("【arcaneVTT 支持面 · 离线蒸馏 rev 7】（声明 10 条 / 2 域；defaultPolicy=unverified：清单没提的面按不存在对待）"));
  assert.deepEqual(preferredExtensions(FIXTURE.entries).map((entry) => entry.path), ["mt.viewScene"]);
  assert.equal(artifact.segment.includes("mt.playersShare"), false, "没标 agent=prefer 的扩展面不进蒸馏段");
  assert.ok(artifact.segment.includes("扩展动词（status=extension 且 agent=prefer；优先于 FVTT 同名面）："));
});

test("缺 revision / 空声明 / 非法 top 一律抛错（调用方据此走离线兜底）", () => {
  assert.throws(() => distillSurface({ ...FIXTURE, revision: undefined }), /missing the revision pin/);
  assert.throws(() => distillSurface({ revision: 1, defaultPolicy: "unverified", domains: [], entries: [] }), /no domains and no entries/);
  assert.throws(() => distillSurface({ revision: 1, entries: [{ path: "a" }] }), /no domains and no entries/);
  assert.throws(() => distillSurface(FIXTURE, { top: -1 }), /non-negative integer/);
  assert.throws(() => distillSurface(null), /must be a JSON object/);
});

test("fetchSurface：HTTP 状态/JSON 形状/协议与体积护栏", async (t) => {
  const surface = await fetchSurface("https://example.test/api-surface.json", { fetchImpl: fakeFetch(FIXTURE) });
  assert.equal(surface.revision, 7);
  await assert.rejects(
    fetchSurface("https://example.test/api-surface.json", { fetchImpl: fakeFetch("nope", { status: 503 }) }),
    /HTTP 503/,
  );
  await assert.rejects(
    fetchSurface("https://example.test/api-surface.json", { fetchImpl: fakeFetch("<html>") }),
    /not valid JSON/,
  );
  await assert.rejects(fetchSurface("file:///tmp/api-surface.json", { fetchImpl: fakeFetch(FIXTURE) }), /must be http\(s\)/);
  await assert.rejects(fetchSurface("not a url", { fetchImpl: fakeFetch(FIXTURE) }), /URL is invalid/);
  await assert.rejects(
    fetchSurface("https://example.test/api-surface.json", { fetchImpl: fakeFetch(FIXTURE, { headers: new Map([["content-length", String(9 * 1024 * 1024)]]) }) }),
    /declared \d+ bytes/,
  );
  const big = `{"revision":1,"pad":"${"x".repeat(2 * 1024 * 1024)}"}`;
  await assert.rejects(
    fetchSurface("https://example.test/api-surface.json", { fetchImpl: fakeFetch(big) }),
    /more than \d+ bytes/,
  );
  assert.match(DEFAULT_SURFACE_URL, /^https:\/\/[^/]+\/user-files\/compat\/api-surface\.json$/);
  assert.ok(t.name.length > 0);
});

test("parseArgs：--url/--top 取参数，--insecure 为布尔位", () => {
  assert.deepEqual(parseArgs(["--url", "https://x.test/a.json", "--top", "3", "--insecure"]), {
    booleans: new Set(["insecure"]), url: "https://x.test/a.json", top: "3",
  });
  assert.throws(() => parseArgs(["--top"]), /missing value/);
  assert.throws(() => parseArgs(["stray"]), /invalid argument/);
});

test("main：成功拉取写产物；同 revision 同段落重跑不刷新产物", async (t) => {
  const outputFile = path.join(scratchDir(t), "generated", "mtcompat-surface.json");
  const logs = [];
  await main(["--url", "https://example.test/api-surface.json"], { log: (message) => logs.push(message), outputFile, fetchImpl: fakeFetch(FIXTURE) });
  const first = fs.readFileSync(outputFile, "utf8");
  const written = JSON.parse(first);
  assert.equal(written.revision, 7);
  assert.equal(written.pitfalls.length, DEFAULT_PITFALL_LIMIT - 4); // fixture 只有 6 条可上榜
  assert.equal(written.pitfalls.length, 6);
  assert.equal(written.sourceUrl, "https://example.test/api-surface.json");
  assert.ok(logs.join("").includes("坑位 6 条（限 10）"));

  const stamp = fs.statSync(outputFile).mtimeMs;
  const rerunLogs = [];
  await main(["--url", "https://example.test/api-surface.json"], { log: (message) => rerunLogs.push(message), outputFile, fetchImpl: fakeFetch(FIXTURE) });
  assert.equal(fs.readFileSync(outputFile, "utf8"), first, "同 revision 同段落不得重写产物");
  assert.ok(rerunLogs.join("").includes("声明面未变（rev 7）"));
  assert.ok(fs.statSync(outputFile).mtimeMs >= stamp);
});

test("main：--top 透传，Top-N 只影响产物条数", async (t) => {
  const outputFile = path.join(scratchDir(t), "mtcompat-surface.json");
  await main(["--url", "https://example.test/api-surface.json", "--top", "2"], { log: () => {}, outputFile, fetchImpl: fakeFetch(FIXTURE) });
  const written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(written.pitfallLimit, 2);
  assert.deepEqual(written.pitfalls.map((entry) => entry.path), ["Scene#activate", "canvas.pan"]);
});

test("main：拉取失败但旧产物在位 → 沿用并警告（离线构建不炸）；没有旧产物才失败", async (t) => {
  const directory = scratchDir(t);
  const outputFile = path.join(directory, "mtcompat-surface.json");
  const failing = async () => { throw new Error("getaddrinfo ENOTFOUND vtt.arcanedesk.bitterbebop.cn"); };

  await assert.rejects(
    main(["--url", "https://example.test/api-surface.json"], { log: () => {}, outputFile, fetchImpl: failing }),
    /ENOTFOUND .*；且没有可沿用的旧产物.*逃生舱/s,
  );
  assert.equal(fs.existsSync(outputFile), false);

  await main(["--url", "https://example.test/api-surface.json"], { log: () => {}, outputFile, fetchImpl: fakeFetch(FIXTURE) });
  const before = fs.readFileSync(outputFile, "utf8");
  const logs = [];
  await main(["--url", "https://example.test/api-surface.json"], { log: (message) => logs.push(message), outputFile, fetchImpl: failing });
  assert.equal(fs.readFileSync(outputFile, "utf8"), before, "沿用旧产物：不重写、不炸");
  assert.ok(logs.join("").includes("离线沿用"));

  // 声明面在但内容坏（缺 revision）同样落离线兜底，而不是写一份空段产物。
  const broken = path.join(directory, "broken.json");
  await main(["--url", "https://example.test/api-surface.json"], { log: () => {}, outputFile: broken, fetchImpl: fakeFetch({ entries: [{ path: "a", status: "absent" }] }) })
    .then(() => assert.fail("缺 revision 的声明面不该产出产物"), (error) => assert.match(error.message, /missing the revision pin/));
  assert.equal(fs.existsSync(broken), false);
});

test("逃生舱：--allow-missing / ARCANE_API_SURFACE_ALLOW_MISSING=1 时无产物继续（端点未部署）", async (t) => {
  const directory = scratchDir(t);
  const failing = async () => { throw new Error("GET https://vtt.arcanedesk.bitterbebop.cn:30002/... failed: HTTP 404"); };

  const viaFlag = path.join(directory, "flag.json");
  await main(["--url", "https://example.test/api-surface.json", "--allow-missing"], { log: () => {}, outputFile: viaFlag, fetchImpl: failing });
  assert.equal(fs.existsSync(viaFlag), false, "无产物可沿用时不写空段产物");

  const viaEnv = path.join(directory, "env.json");
  const previous = process.env[SURFACE_ALLOW_MISSING_ENV];
  process.env[SURFACE_ALLOW_MISSING_ENV] = "1";
  t.after(() => {
    if (previous === undefined) delete process.env[SURFACE_ALLOW_MISSING_ENV];
    else process.env[SURFACE_ALLOW_MISSING_ENV] = previous;
  });
  await main(["--url", "https://example.test/api-surface.json"], { log: () => {}, outputFile: viaEnv, fetchImpl: failing });
  assert.equal(fs.existsSync(viaEnv), false);
  assert.equal(parseArgs(["--allow-missing"]).booleans.has("allow-missing"), true);
});
