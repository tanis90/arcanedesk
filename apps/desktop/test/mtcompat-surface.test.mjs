// A2 蒸馏段的运行期读法与挂载点测试：档位过滤（mtcompat 有、foundry 无）、产物缺席/损坏
// 的三种结局、以及工具描述/prompt 两处挂载。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentHost } from "../src/main/agent-host.js";
import { activeToolNamesForProfile } from "../src/main/foundry-tool-policy.js";
import {
  mtcompatSurfaceFile,
  mtcompatSurfaceSegment,
  readMtcompatSurfaceDistill,
  withMtcompatSurfaceSegment,
} from "../src/main/mtcompat-surface.mjs";
import { distillSurface } from "../scripts/prepare-mtcompat-surface.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEGMENT = "【arcaneVTT 支持面 · 离线蒸馏 rev 9】\n坑位 Top 1：\n- `Scene#activate`：absent——shim 无此方法";

function temporaryArtifact(t, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcane-mtcompat-surface-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "mtcompat-surface.json");
  fs.writeFileSync(file, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

const ARTIFACT = { schemaVersion: 1, kind: "mtcompat-surface-distill", revision: 9, segment: SEGMENT, pitfalls: [] };

function prepHost(extra = {}) {
  return new AgentHost({ profile: { mode: "prep" }, log() {}, ...extra });
}

function browserEvaluate(host) {
  return host.buildTools().find((tool) => tool.name === "browser_evaluate");
}

test("读法：产物缺席返回 null，在位读到产物，损坏则抛错（不静默降级成“没声明”）", (t) => {
  const missing = path.join(os.tmpdir(), `arcane-mtcompat-absent-${process.pid}.json`);
  fs.rmSync(missing, { force: true });
  assert.equal(readMtcompatSurfaceDistill(missing), null);
  assert.equal(mtcompatSurfaceSegment("mtcompat", missing), null);

  const file = temporaryArtifact(t, ARTIFACT);
  assert.equal(readMtcompatSurfaceDistill(file).revision, 9);
  assert.equal(mtcompatSurfaceSegment("mtcompat", file), SEGMENT);

  assert.throws(() => readMtcompatSurfaceDistill(temporaryArtifact(t, "{ not json")), /not valid JSON/);
  assert.throws(() => readMtcompatSurfaceDistill(temporaryArtifact(t, { revision: 3 })), /no distilled segment/);
  assert.throws(() => readMtcompatSurfaceDistill(temporaryArtifact(t, { segment: SEGMENT })), /revision pin/);
});

test("档位过滤：只有 mtcompat 档拿到段落，foundry 与未知/无档一律 null", (t) => {
  const file = temporaryArtifact(t, ARTIFACT);
  assert.equal(mtcompatSurfaceSegment("mtcompat", file), SEGMENT);
  assert.equal(mtcompatSurfaceSegment("foundry", file), null);
  assert.equal(mtcompatSurfaceSegment(null, file), null);
  assert.equal(mtcompatSurfaceSegment(undefined, file), null);
  assert.equal(mtcompatSurfaceSegment("mtcompat-branch", file), null, "笔误的档位 id 落开放默认档，不误解锁");
});

test("withMtcompatSurfaceSegment：追加在基底之后，任一侧缺席原样返回", () => {
  assert.equal(withMtcompatSurfaceSegment("BASE", SEGMENT), `BASE\n\n${SEGMENT}`);
  assert.equal(withMtcompatSurfaceSegment("BASE", null), "BASE");
  assert.equal(withMtcompatSurfaceSegment("BASE", ""), "BASE");
  assert.equal(withMtcompatSurfaceSegment(null, SEGMENT), null);
  assert.equal(withMtcompatSurfaceSegment(undefined, SEGMENT), undefined);
});

test("挂载点：mtcompat 档 eval 工具描述带蒸馏段，foundry 档逐字节不变", (t) => {
  const file = temporaryArtifact(t, ARTIFACT);
  const foundryDescription = browserEvaluate(prepHost({ getPanelProfileId: () => "foundry", mtcompatSurfaceFile: file })).description;
  const noPanelDescription = browserEvaluate(prepHost({ mtcompatSurfaceFile: file })).description;
  assert.equal(foundryDescription, noPanelDescription, "无面板/未注入 = foundry 行为，逐字节一致");
  assert.equal(foundryDescription.includes("离线蒸馏"), false);

  const host = prepHost({ getPanelProfileId: () => "mtcompat", mtcompatSurfaceFile: file });
  assert.equal(host.surfaceSegment(), SEGMENT);
  const description = browserEvaluate(host).description;
  assert.equal(description, `${foundryDescription}\n\n${SEGMENT}`, "蒸馏段追加在 eval 工具描述尾部");
  assert.ok(description.includes("Scene#activate"), "坑位行随段落进描述");
});

test("挂载点（A3）：foundry_page_eval 的描述在 mtcompat 档同样带蒸馏段，foundry 档无段", (t) => {
  const file = temporaryArtifact(t, ARTIFACT);
  const pageEval = (host) => host.buildTools().find((tool) => tool.name === "foundry_page_eval");
  const foundryDescription = pageEval(prepHost({ getPanelProfileId: () => "foundry", mtcompatSurfaceFile: file })).description;
  assert.equal(foundryDescription.includes("离线蒸馏"), false);
  const mtcompatDescription = pageEval(prepHost({ getPanelProfileId: () => "mtcompat", mtcompatSurfaceFile: file })).description;
  assert.equal(mtcompatDescription, `${foundryDescription}\n\n${SEGMENT}`, "蒸馏段追加在新 eval 工具描述尾部");
});

test("挂载点：产物缺席/损坏时挂载降级为无段落，不影响工具构造与会话", (t) => {
  const logs = [];
  const absent = prepHost({ getPanelProfileId: () => "mtcompat", mtcompatSurfaceFile: path.join(os.tmpdir(), "arcane-no-surface.json"), log: (message) => logs.push(message) });
  assert.equal(absent.surfaceSegment(), null);
  assert.equal(browserEvaluate(absent).description.includes("离线蒸馏"), false);

  const brokenFile = temporaryArtifact(t, "{ not json");
  const broken = prepHost({ getPanelProfileId: () => "mtcompat", mtcompatSurfaceFile: brokenFile, log: (message) => logs.push(message) });
  assert.equal(broken.surfaceSegment(), null);
  assert.ok(logs.some((line) => line.includes("mtcompat surface segment unavailable")), "损坏要落日志，不静默");
});

test("战斗模式：mtcompat 档同样解析出段落（prompt 挂载面），激活名单不因此增删", (t) => {
  const file = temporaryArtifact(t, ARTIFACT);
  const host = new AgentHost({ profile: { mode: "combat" }, log() {}, getPanelProfileId: () => "mtcompat", mtcompatSurfaceFile: file });
  assert.equal(host.surfaceSegment(), SEGMENT);
  // 工具池构造与激活名单是两件事：池里照旧有 eval 工具，战斗档的激活名单不含它。
  assert.ok(browserEvaluate(host).description.endsWith(SEGMENT));
  assert.deepEqual(activeToolNamesForProfile("combat", "mtcompat"), activeToolNamesForProfile("combat", "foundry"));
  assert.equal(activeToolNamesForProfile("combat", "mtcompat").includes("browser_evaluate"), false);
});

test("生产方↔消费方契约：真蒸馏产物能被运行期读法直接挂载", (t) => {
  const artifact = distillSurface({
    revision: 42,
    defaultPolicy: "unverified",
    domains: [{ prefix: "canvas", status: "partial", note: "自绘画布" }],
    entries: [{ path: "Scene#activate", status: "absent", note: "shim 无此方法", use: "mt.viewScene(scene)" }],
  }, { sourceUrl: "https://example.test/api-surface.json", generatedAt: "2026-10-16T00:00:00.000Z" });
  const file = temporaryArtifact(t, artifact);
  assert.equal(mtcompatSurfaceSegment("mtcompat", file), artifact.segment);
  const host = prepHost({ getPanelProfileId: () => "mtcompat", mtcompatSurfaceFile: file });
  const description = browserEvaluate(host).description;
  assert.ok(description.endsWith(artifact.segment));
  assert.ok(description.includes("离线蒸馏 rev 42"), "revision 钉住后随段落进入工具描述");
  assert.ok(description.includes("优先用 typed action，eval 是兜底。"));
});

test("prompt 挂载点：模式 prompt 组合带上蒸馏段（foundry 档 base 原样）", () => {
  const agentHost = readFileSync(path.join(appRoot, "src/main/agent-host.js"), "utf8");
  // 与 i18n 门的 prompt 组合形状断言同一手法：数组字面量保持原样，段落并进 base。
  assert.match(agentHost, /const systemPrompt = withMtcompatSurfaceSegment\(loadCombatSystemPrompt\(this\.log\), this\.surfaceSegment\(\)\);/);
  assert.match(agentHost, /const prepPreamble = withMtcompatSurfaceSegment\(loadPrepPreamble\(this\.log\), this\.surfaceSegment\(\)\);/);
  assert.match(agentHost, /systemPromptOverride: \(\) => \[systemPrompt, languageDirective\]/);
  assert.match(agentHost, /appendSystemPromptOverride: \(\) => \[prepPreamble, languageDirective\]/);
  assert.match(agentHost, /activeToolNamesForPoolInProfile\(this\.profile\.mode, customTools, this\.panelProfileId\(\)\)/);
  const main = readFileSync(path.join(appRoot, "src/main/main.js"), "utf8");
  assert.equal((main.match(/getPanelProfileId: \(\) => activeProfileId/g) ?? []).length, 2, "两档 host 都要拿到面板档位");
});

test("产物路径默认落在 generated/（构建产物目录，随包分发）", () => {
  assert.equal(mtcompatSurfaceFile(), path.join(appRoot, "generated", "mtcompat-surface.json"));
});
