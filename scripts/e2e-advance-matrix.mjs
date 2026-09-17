#!/usr/bin/env node
// e2e-advance-matrix.mjs — 备团写路径 e2e 矩阵（spec: apps/desktop/docs/foundry-prep-e2e-matrix-spec.md）
//
// 对矩阵每案跑 create → plan → browse(法术) → read → advance 正路，oracle 验收回执。
// 无大模型参与；填值器确定性（池取前 N、ASI 按职业主属性表）。
//
// 用法：node scripts/e2e-advance-matrix.mjs [--port 9230] [--host 127.0.0.1]
//        [--world http://127.0.0.1:30002,COS] [--filter ^A] [--extended] [--keep]
//        [--subclasses-of fighter]   ← 扩展层（spec §2.1b）：枚举该职业子职业池，每子职业一案
// 依赖：活着的 Foundry /game 标签页（GM 登录、dnd5e + arcane 模块启用），
// packages/fvtt-cli 已构建（dist/cli.js）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "packages", "fvtt-cli", "dist", "cli.js");
const OUT_DIR = path.join(repoRoot, "tmp-e2e");

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const PORT = argValue("--port", "9222");
const HOST = argValue("--host", "127.0.0.1");
const [WORLD_ORIGIN, WORLD_ID] = argValue("--world", "http://127.0.0.1:30002,COS").split(",");
const FILTER = new RegExp(argValue("--filter", "."));
const KEEP = argv.includes("--keep");
const EXTENDED = argv.includes("--extended");
const SWEEP_CLASS = argValue("--subclasses-of", null); // 扩展层：逐职业全子职业扫描（如 fighter）

// ── CLI 调用封装 ─────────────────────────────────────────────────────────────
let tmpSeq = 0;
function cli(command, payload, { timeoutMs = 120000, debugEval = false } = {}) {
  const tmp = path.join(OUT_DIR, `call-${process.pid}-${tmpSeq++}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  const args = [CLI, "--port", PORT, "--host", HOST, command, "--json", `@${tmp}`];
  if (command === "actor-advance") args.push("--timeout", String(timeoutMs));
  const env = { ...process.env };
  if (debugEval) env.ARCANE_FVTT_DEBUG_EVAL = "1";
  const res = spawnSync(process.execPath, args, { encoding: "utf8", timeout: timeoutMs + 30000, env, maxBuffer: 64 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  if (res.error) throw new Error(`${command} spawn failed: ${res.error.message}`);
  let out;
  try { out = JSON.parse(res.stdout); } catch { throw new Error(`${command} non-JSON output: ${res.stdout?.slice(0, 400)} ${res.stderr?.slice(0, 400)}`); }
  if (!out.ok) throw new Error(`${command} CLI error: ${JSON.stringify(out.error ?? out).slice(0, 400)}`);
  return out.data;
}
const world = { origin: WORLD_ORIGIN, id: WORLD_ID };
let reqSeq = 0;
const reqId = () => `e2e-matrix-${process.pid}-${reqSeq++}`;

// ── 矩阵配置：一案一行。轴 A = 高等精灵 × 全职业（spec §2.1）──────────────────
// primary: 职业主属性顺序（ASI/标准数组分配用）；maxSpellLevel: 5 级时法术环位上限；
// spells: known=选已知法术 / book=法术书 / fullList=传 fullSpellList / null=不施法。
const HIGH_ELF = "high-elf";
const AXIS_A = [
  { id: "A1",  cls: "barbarian", subclass: "狂战士",   primary: ["str", "con", "dex"], maxSpellLevel: 0, spells: null },       // 无施法基线
  { id: "A2",  cls: "bard",      subclass: "勇气学院", primary: ["cha", "dex", "con"], maxSpellLevel: 3, spells: "known" },     // known 施法
  { id: "A3",  cls: "cleric",    subclass: "生命领域", primary: ["wis", "str", "con"], maxSpellLevel: 3, spells: "fullList" },  // fullSpellList + 领域
  { id: "A4",  cls: "druid",     subclass: "大地",     primary: ["wis", "con", "dex"], maxSpellLevel: 3, spells: "fullList" },  // fullSpellList
  { id: "A5",  cls: "fighter",   subclass: "战斗大师", primary: ["str", "con", "dex"], maxSpellLevel: 0, spells: null },       // 子职业侧选择槽（战技）
  { id: "A6",  cls: "monk",      subclass: "散打",     primary: ["dex", "wis", "con"], maxSpellLevel: 0, spells: null },       // 无施法 + 资源
  { id: "A7",  cls: "paladin",   subclass: "奉献",     primary: ["str", "cha", "con"], maxSpellLevel: 2, spells: "fullList" },  // fullSpellList 半施法者
  { id: "A8",  cls: "ranger",    subclass: "猎人",     primary: ["dex", "wis", "con"], maxSpellLevel: 2, spells: "known" },     // known 半施法者（2014）
  { id: "A9",  cls: "rogue",     subclass: "盗贼",     primary: ["dex", "int", "cha"], maxSpellLevel: 0, spells: null },       // 专精槽 expertise（池里叫「盗贼 Thief」）
  { id: "A10", cls: "sorcerer",  subclass: "龙族血脉", primary: ["cha", "con", "dex"], maxSpellLevel: 3, spells: "known" },     // known（已验证案回归）
  { id: "A11", cls: "warlock",   subclass: "邪魔",     primary: ["cha", "con", "dex"], maxSpellLevel: 3, spells: "known" },     // pact 法术位 + known
  { id: "A12", cls: "wizard",    subclass: "塑能",     primary: ["int", "dex", "con"], maxSpellLevel: 3, spells: "book" },      // 法术书路径
  { id: "A13", cls: "artificer", subclass: "炼金师",   primary: ["int", "con", "dex"], maxSpellLevel: 2, spells: "fullList" },  // fullSpellList + 工具（池里叫「炼金师 Alchemist」）
];

// 轴 B（spec §2.2）：冠军勇士 × 全 2014 种族（18 行，以种族目录 rules=2014 为准）。
// 考点是种族侧 advancement 全形态：变体人类的专长池、半精灵混合 ASI、提夫林/卓尔的
// 种族法术、矮人/侏儒的固定 Trait。引擎通用，无需分支。
const FIGHTER = { cls: "fighter", subclass: "勇士", primary: ["str", "con", "dex"], maxSpellLevel: 0, spells: null }; // 池里叫「勇士 Champion」
const AXIS_B_RACES = [
  "human", "variant-human", "hill-dwarf", "mountain-dwarf", "high-elf", "wood-elf", "drow",
  "lightfoot-halfling", "stout-halfling", "forest-gnome", "rock-gnome", "half-elf", "half-orc",
  "dragonborn", "tiefling", "tiefling-levistus", "aasimar-mpmm", "kender-dsotdq",
];
const AXIS_B = AXIS_B_RACES.map((race, i) => ({ ...FIGHTER, id: `B${i + 1}`, race }));

// NPC 回归（spec §2.3）：狼人 Werewolf + 战士 5 级（冠军勇士）。怪物来源由
// resolveMonster 运行时解析：优先 arcane 怪物包，无则回退 dnd5e.monsters（2014 SRD）
// 并在报告记录——2026-09-17 实测本世界无 arcane 怪物包，走 dnd5e.monsters 回退。
// 考点：怪物体型骰 HP（无首级满骰、无 hpFill）、preservation.changed 为空、
// 护甲/武器熟练的 TRAIT_GRANT_NOT_LANDED 警告预期出现（oracle 方向与 character 轴相反）。
const NPC_CASES = [
  { id: "C1", npc: true, monsterName: "werewolf", cls: "fighter", subclass: "勇士",
    primary: ["str", "con", "dex"], maxSpellLevel: 0, spells: null },
];

const CASES = [
  ...AXIS_A.map(c => ({ ...c, race: HIGH_ELF, targetLevel: 5 })),
  ...AXIS_B.map(c => ({ ...c, targetLevel: 5 })),
  ...NPC_CASES.map(c => ({ ...c, targetLevel: 5 })),
];

// ── 目录解析（一次运行缓存一次）─────────────────────────────────────────────
const catalogCache = new Map();
function catalog(type) {
  if (!catalogCache.has(type)) {
    const data = cli("compendium-browse", { scope: "compendium", type });
    catalogCache.set(type, data.candidates ?? []);
  }
  return catalogCache.get(type);
}
function catalogEntry(type, identifier) {
  const hit = catalog(type).find(e => e.identifier === identifier && e.rules === "2014");
  if (!hit) throw new Error(`catalog ${type} 无 2014 identifier=${identifier}（目录共 ${catalog(type).length} 条）`);
  return hit.uuid;
}

// ── 填值器（spec §3.3，全确定性）────────────────────────────────────────────
function buildAbilities(primary) {
  const array = [15, 14, 13, 12, 10, 8];
  const abilities = {};
  primary.forEach((ab, i) => { abilities[ab] = array[i]; });
  let i = primary.length;
  for (const ab of ["str", "dex", "con", "int", "wis", "cha"]) if (!(ab in abilities)) abilities[ab] = array[i++];
  return abilities;
}
function distributeAsi(count, cap, primary) {
  const out = {};
  let left = count;
  for (const ab of primary.concat(["str", "dex", "con", "int", "wis", "cha"])) {
    if (!left) break;
    const add = Math.min(cap, left);
    if (add > 0) { out[ab] = (out[ab] ?? 0) + add; left -= add; }
  }
  if (left) throw new Error(`ASI 分配不完：剩 ${left} 点（count=${count} cap=${cap}）`);
  return out;
}
// pickedTraits：本次调用前面槽位已选的 trait key（专精槽只能从这里面挑）。
// takenUuids：additionalItems 已占用的条目 uuid——池槽填值要避开（种族戏法和职业自选
// 撞重会被 grant dedup 吞掉一个，职业侧就少一张：首轮复跑 A10/A12 实测）。
// 空池槽位（candidates 为空）= plan 未枚举的不可枚举形状（如 level:"available"），
// 属工具缺口，直接炸出来当信号，不做 browse 绕过。
function fillChoices(caseCfg, plan, primary, takenUuids = new Set()) {
  const bySlot = {};
  const pickedTraits = [];
  for (const req of plan.choiceRequirements ?? []) {
    if (req.valueFormat === "subclass-uuid") continue; // 顶层入参，不进 bySlot
    if (req.valueFormat === "asi-assignment" || req.valueFormat === "asi-or-feat") {
      bySlot[req.key] = { abilityScore: distributeAsi(req.count, req.cap ?? 2, primary) };
    } else if (req.mode === "expertise") {
      const legal = (req.candidates ?? []).filter(c => pickedTraits.includes(c));
      if (legal.length < req.count) throw new Error(`专精槽 ${req.key} 合法候选不足：需 ${req.count}，前面槽位只落了 ${JSON.stringify(legal)}`);
      bySlot[req.key] = legal.slice(0, req.count);
    } else if (!(req.candidates ?? []).length) {
      throw new Error(`槽 ${req.key}(${req.label}) 无候选——plan 未枚举，工具缺口`);
    } else { // trait-key / pool-uuid：取池内前 count 个（避开已被 additionalItems 占用的；
      // trait-key 还要避开本 call 前序槽已选的——default 模式重选会把专精踩回熟练，
      // runtime 现在也写入前拒绝，见逸闻学院案）
      const pool = (req.candidates ?? []).filter(c => !takenUuids.has(c)
        && !(req.valueFormat === "trait-key" && pickedTraits.includes(c)));
      if (pool.length < req.count) throw new Error(`槽 ${req.key} 候选不足：需 ${req.count}，池 ${pool.length}（已排除占用）`);
      bySlot[req.key] = pool.slice(0, req.count);
      if (req.valueFormat === "trait-key") pickedTraits.push(...bySlot[req.key]);
    }
  }
  return bySlot;
}

// ── 法术选取（spec §3.2.4）：不背名单，browse 分页取 eligibility:"legal" ─────
// 子职业施法者（三环）列表不在本职职业上：budget.spellListClassUuid 指法师列表（runtime 下发）。
function pickSpells(caseCfg, classUuid, budget) {
  const grants = [];
  const listUuid = budget.spellListClassUuid ?? classUuid;
  const take = (maxLevel, count) => {
    if (!count) return;
    let got = 0;
    for (let page = 1; got < count; page++) {
      const data = cli("compendium-browse", { scope: "compendium", type: "spell", classUuid: listUuid, maxLevel, page, pageSize: 50 });
      const entries = (data.candidates ?? []).filter(c => c.eligibility === "legal" && (maxLevel === 0 ? c.level === 0 : (c.level ?? 0) >= 1));
      for (const c of entries) {
        if (got >= count) break;
        grants.push({ uuid: c.uuid, expectedName: c.name, expectedType: "spell" });
        got++;
      }
      if (page * 50 >= (data.total ?? 0)) break; // 末页
      if (page > 20) throw new Error(`法术分页超过 20 页仍未取满（maxLevel=${maxLevel} 需 ${count}）`);
    }
  };
  take(0, budget.cantrips ?? 0);
  take(caseCfg.maxSpellLevel, caseCfg.spells === "book" ? budget.book : budget.known);
  return grants;
}

// ── oracle（spec §3.4）───────────────────────────────────────────────────────
function assertCase(caseCfg, plan, result, problems) {
  const fail = msg => problems.push(msg);
  if (result.status !== "completed") { fail(`advance ${result.status}: ${result.code ?? ""} ${result.message ?? ""}`); return; }
  const v = result.verification ?? {};
  // 1. warnings 为空（character 轴）
  if ((result.warnings ?? []).length) fail(`warnings 非空: ${JSON.stringify(result.warnings).slice(0, 300)}`);
  // 2. 属性守恒 after === before + race + asi
  for (const [ab, rec] of Object.entries(v.abilities ?? {})) {
    if (rec.after !== rec.before + rec.race + rec.asi) fail(`abilities.${ab} 不守恒: ${JSON.stringify(rec)}`);
  }
  // 3. 施法契约（职业侧口径：budget 只管 class+granted 两桶；种族/子职业白送的戏法
  // 和环法经 advancementOrigin 落进 race/subclass 桶，不参与对账——2026-09-17 首轮
  // 全案差 1 就是拿卡面总数对职业配额）
  const budget = plan.spellBudget;
  if (budget && caseCfg.spells) {
    const sc = v.spellcasting ?? {};
    const classSide = src => (src?.class ?? 0) + (src?.granted ?? 0);
    if (budget.cantrips !== undefined && classSide(sc.cantripsBySource) !== budget.cantrips)
      fail(`cantrips 职业侧 ${JSON.stringify(sc.cantripsBySource)} !== budget ${budget.cantrips}（卡面总数 ${sc.cantrips}）`);
    if (caseCfg.spells === "known" && budget.known !== undefined && classSide(sc.spellsBySource) !== budget.known)
      fail(`known 职业侧 ${JSON.stringify(sc.spellsBySource)} !== budget ${budget.known}（卡面总数 ${sc.spells}）`);
    if (caseCfg.spells === "book" && budget.book !== undefined && classSide(sc.spellsBySource) !== budget.book)
      fail(`book 职业侧 ${JSON.stringify(sc.spellsBySource)} !== budget ${budget.book}（卡面总数 ${sc.spells}）`);
    if (caseCfg.spells === "fullList") {
      const expect = budget.fullList?.count;
      if (expect !== undefined && v.spellFill?.count !== expect) fail(`spellFill.count ${v.spellFill?.count} !== fullList.count ${expect}`);
    }
  }
  // 4. creation 收尾：满血即可（hpFill 只在发生拉满时出现，无漂移时本就没有，不当必填）
  if (v.hp && v.hp.value !== v.hp.max) fail(`hp ${v.hp.value} !== max ${v.hp.max}`);
  if (budget && !v.slotFill) fail("施法职业缺 slotFill");
  // 4b. 施法能力对账兜底：卡面带环位但 plan 无预算且环级法术为 0 = 未对账的施法能力
  // （子职业施法不走 advancement 的静默缺口——2026-09-17 奥法骑士假绿：3 环位 0 环法照绿）
  const slotCount = Object.values(v.spellcasting?.slots ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  if (slotCount > 0 && !budget && !(v.spellcasting?.spells > 0))
    fail(`环位非空（${JSON.stringify(v.spellcasting.slots)}）但无 spellBudget 且环级法术为 0——未对账的施法能力`);
  // 5. grantedItems 三来源
  const granted = (v.grantedItems ?? []).map(g => g.type ?? "");
  for (const t of ["class", "race", "subclass"]) if (!granted.includes(t)) fail(`grantedItems 缺 ${t} 来源条目`);
  // 6. plan 无未覆盖必选步骤
  if ((plan.coverage?.uncoveredRequiredSteps ?? []).length) fail(`uncoveredRequiredSteps: ${plan.coverage.uncoveredRequiredSteps.join("; ")}`);
}

// ── NPC oracle（spec §3.4，方向与 character 轴相反的几条）─────────────────────
function assertNpcCase(caseCfg, plan, result, note, problems) {
  const fail = msg => problems.push(msg);
  if (result.status !== "completed") { fail(`advance ${result.status}: ${result.code ?? ""} ${result.message ?? ""}`); return; }
  const v = result.verification ?? {};
  // warnings 必须出现且只允许 TRAIT_GRANT_NOT_LANDED（护甲/武器熟练在 NPCData 无字段、
  // 原生静默丢弃的显性化）
  const warnings = result.warnings ?? [];
  if (!warnings.length) fail("NPC 案应有 TRAIT_GRANT_NOT_LANDED 警告，实际为空");
  for (const w of warnings) if (w.code !== "TRAIT_GRANT_NOT_LANDED") fail(`非预期 warning: ${JSON.stringify(w).slice(0, 200)}`);
  // 无 hpFill（NPC 无 0 级建档拉满）；preservation.changed 为空（原怪物分毫未动）
  if (v.hpFill) fail(`NPC 不应有 hpFill: ${JSON.stringify(v.hpFill)}`);
  if ((v.preservation?.changed ?? []).length) fail(`preservation.changed 非空: ${JSON.stringify(v.preservation.changed).slice(0, 300)}`);
  // HP：每级怪物体型骰均值 + con 调整值，无首级满骰
  const denom = v.hp?.hd?.denomination, conAfter = v.abilities?.con?.after;
  if (Number.isFinite(denom) && Number.isFinite(conAfter) && Number.isFinite(note.hpBefore)) {
    const perLevel = Math.floor(denom / 2) + 1 + Math.floor((conAfter - 10) / 2);
    const expect = note.hpBefore + caseCfg.targetLevel * perLevel;
    if (v.hp.max !== expect) fail(`hp.max ${v.hp.max} !== 体型骰均值期望 ${expect}（${caseCfg.targetLevel} 级 × 每级 ${perLevel} = d${denom} 均值 + con mod）`);
  } else fail(`HP 对账缺字段: denom=${denom} conAfter=${conAfter} before=${note.hpBefore}`);
  if (v.hp.value !== v.hp.max) fail(`hp ${v.hp.value} !== max ${v.hp.max}`);
  // 属性守恒（NPC 无种族加成，race 恒 0）
  for (const [ab, rec] of Object.entries(v.abilities ?? {})) {
    if (rec.after !== rec.before + (rec.race ?? 0) + (rec.asi ?? 0)) fail(`abilities.${ab} 不守恒: ${JSON.stringify(rec)}`);
  }
  // grantedItems 有职业与子职业来源；NPC 无种族条目
  const granted = (v.grantedItems ?? []).map(g => g.type ?? "");
  for (const t of ["class", "subclass"]) if (!granted.includes(t)) fail(`grantedItems 缺 ${t} 来源条目`);
  if (granted.includes("race")) fail("NPC 案不应有种族来源条目");
  if ((plan.coverage?.uncoveredRequiredSteps ?? []).length) fail(`uncoveredRequiredSteps: ${plan.coverage.uncoveredRequiredSteps.join("; ")}`);
}
// ── 清理：gated debug-eval 删除 harness 自建 actor（spec §3.2.8）─────────────
function debugEval(script) {
  const res = spawnSync(process.execPath, [CLI, "--port", PORT, "--host", HOST, "debug-eval", "--expr", "--script", script],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, ARCANE_FVTT_DEBUG_EVAL: "1" } });
  if (res.error) throw new Error(`debug-eval spawn failed: ${res.error.message}`);
  const out = JSON.parse(res.stdout);
  if (!out.ok) throw new Error(`debug-eval 失败: ${JSON.stringify(out.error ?? out).slice(0, 200)}`);
  return out.data;
}
function deleteActor(actorUuid) {
  const id = actorUuid.split(".")[1];
  return debugEval(`(async()=>{const a=game.actors.get(${JSON.stringify(id)}); if(!a) return "missing"; await a.delete(); return "deleted"})()`);
}
// create 前清掉同名残卡：失败案会留卡供检查，重跑不清就撞 NAME_COLLISION
function preCleanByName(name) {
  return debugEval(`(async()=>{const xs=game.actors.filter(a=>a.name===${JSON.stringify(name)}); for (const a of xs) await a.delete(); return xs.length})()`);
}
// NPC 案怪物来源解析（spec §2.3）：扫全部 Actor 包按名字命中，优先 arcane 怪物包，
// 回退 dnd5e.monsters（2014 SRD）并把实际来源写进报告 note。一次运行缓存一次。
const monsterCache = new Map();
function resolveMonster(name, note) {
  if (!monsterCache.has(name)) {
    const hits = debugEval(`(async()=>{const out=[]; for (const pack of game.packs) { if (pack.metadata.type!=="Actor") continue; const idx=await pack.getIndex(); const h=idx.find(e=>String(e.name).toLowerCase().includes(${JSON.stringify(name.toLowerCase())})); if (h) out.push({packId:pack.metadata.id, entryId:h._id, name:h.name}); } return out})()`);
    const pick = hits.find(h => h.packId.includes("arcane")) ?? hits.find(h => h.packId === "dnd5e.monsters") ?? null;
    if (!pick) throw new Error(`怪物「${name}」无 arcane/dnd5e.monsters 来源: ${JSON.stringify(hits)}`);
    monsterCache.set(name, pick);
  }
  const pick = monsterCache.get(name);
  note.monsterSource = `${pick.packId}/${pick.entryId}「${pick.name}」${pick.packId.includes("arcane") ? "" : "（回退非 arcane 包）"}`;
  return { packId: pick.packId, entryId: pick.entryId };
}

// ── 扩展层（spec §2.1b）：枚举某职业的子职业池，每子职业一案 ───────────────────
// 池来源 = advancement-plan 的 subclass-uuid 槽（advance 实际接受的权威池，且会自动按
// 职业 rules 排除跨规则条目）；browse 目录只用于把 uuid 反查成 identifier 做案 id。
// spells: "auto" —— 子职业可能引入施法（奥法骑士类），由 runCase 按 plan.spellBudget 自适应。
function buildSweepCases(cls) {
  const base = AXIS_A.find(c => c.cls === cls);
  if (!base) throw new Error(`--subclasses-of ${cls} 无轴 A 基线（可选: ${AXIS_A.map(c => c.cls).join("/")}）`);
  const probeName = `e2e·sweep-probe·${cls}`;
  let probeUuid = null;
  try {
    preCleanByName(probeName);
    const created = cli("actor-create", { world, requestId: reqId(),
      source: { kind: "blank", actorType: "character" }, name: probeName,
      dnd5e: { abilities: buildAbilities(base.primary) } });
    if (created.status !== "completed") throw new Error(`probe create ${created.status}: ${created.message ?? ""}`);
    probeUuid = created.steps[0].targets[0];
    const classUuid = catalogEntry("class", cls);
    const poolPlan = cli("advancement-plan", { actorUuid: probeUuid, classUuid, characterLevel: base.targetLevel ?? 5 });
    const subReq = (poolPlan.choiceRequirements ?? []).find(r => r.valueFormat === "subclass-uuid");
    const pool = subReq?.candidates ?? [];
    if (!pool.length) throw new Error(`${cls} 子职业池为空（subclass-uuid 槽 candidates 缺失）`);
    // browse 反查 identifier（仅命名用；browse 不过滤池本身——规则不对称见 2026-09-17 记录：
    // browse 不给 rules 时不按职业 rules 排除跨规则条目，这里显式传 "2014" 对齐轴 A 口径）
    const browse = cli("compendium-browse", { scope: "compendium", type: "subclass", classUuid, rules: "2014" });
    const identByUuid = new Map((browse.candidates ?? []).map(c => [c.uuid, c.identifier]));
    console.log(`sweep ${cls}: 子职业池 ${pool.length} 个（plan 池权威；browse 反查到 ${identByUuid.size} 个 identifier）`);
    return pool.map((uuid, i) => {
      const name = subReq.candidateNames?.[uuid] ?? uuid;
      const identifier = identByUuid.get(uuid) ?? `sub${i + 1}`;
      return { ...base, id: `${base.id}s-${identifier}`, subclass: name, subclassUuid: uuid,
        spells: "auto", maxSpellLevel: "auto", race: HIGH_ELF, targetLevel: base.targetLevel ?? 5 };
    });
  } finally {
    if (probeUuid) { try { deleteActor(probeUuid); } catch { /* probe 清理失败不挡扫描 */ } }
  }
}

// ── 单案流程（spec §3.2）─────────────────────────────────────────────────────
async function runCase(caseCfg) {
  const t0 = Date.now();
  const problems = [];
  const name = caseCfg.npc
    ? `e2e·${caseCfg.id}·${caseCfg.monsterName}·${caseCfg.cls}`
    : `e2e·${caseCfg.id}·${caseCfg.cls}·${caseCfg.race}`;
  let actorUuid = null;
  const note = { id: caseCfg.id, name, problems };
  try {
    // 0. pre-clean 同名残卡（上一轮失败案留下的）
    preCleanByName(name);
    // 1. 建档（character 空白卡 + 基础属性；NPC 案为 compendium 怪物复制）
    const created = cli("actor-create", { world, requestId: reqId(),
      source: caseCfg.npc ? { kind: "compendium", ...resolveMonster(caseCfg.monsterName, note) } : { kind: "blank", actorType: "character" },
      name,
      ...(caseCfg.npc ? {} : { dnd5e: { abilities: buildAbilities(caseCfg.primary) } }) });
    if (created.status !== "completed") throw new Error(`create ${created.status}: ${created.message ?? ""}`);
    actorUuid = created.steps[0].targets[0];
    note.actorUuid = actorUuid;
    // 2-3. plan：sweep 案已带 subclassUuid 直出终 plan；否则先拿子职业池按名称解析再出终 plan
    const classUuid = catalogEntry("class", caseCfg.cls);
    const raceUuid = caseCfg.npc ? null : catalogEntry("race", caseCfg.race);
    let subUuid = caseCfg.subclassUuid ?? null;
    if (!subUuid) {
      const poolPlan = cli("advancement-plan", { actorUuid, classUuid, ...(raceUuid ? { raceUuid } : {}), characterLevel: caseCfg.targetLevel });
      const subReq = (poolPlan.choiceRequirements ?? []).find(r => r.valueFormat === "subclass-uuid");
      subUuid = (subReq?.candidates ?? []).find(u => (subReq.candidateNames?.[u] ?? "").includes(caseCfg.subclass));
      if (!subUuid) throw new Error(`子职业「${caseCfg.subclass}」不在池中: ${JSON.stringify(subReq?.candidateNames ?? {})}`);
    }
    const plan = cli("advancement-plan", { actorUuid, classUuid, subclassUuid: subUuid, ...(raceUuid ? { raceUuid } : {}), characterLevel: caseCfg.targetLevel });
    if (plan.status !== "completed") throw new Error(`plan ${plan.status}: ${plan.message ?? ""}`);
    note.planKeys = (plan.choiceRequirements ?? []).map(r => r.key);
    // 3b. sweep 案的施法自适应：子职业可能引入 spellBudget（奥法骑士类）。按 budget 形状推断
    // known/book/fullList；maxSpellLevel 优先取 budget 下发值（三环表），缺省 1。
    // budget 缺失/形状不识别的案不选法术——若 advance 仍要求法术槽，会炸出来当工具缺口信号。
    const effCfg = { ...caseCfg };
    if (caseCfg.spells === "auto") {
      const b = plan.spellBudget;
      note.spellBudget = b ?? null;
      if (!b) effCfg.spells = null;
      else if (b.book !== undefined) effCfg.spells = "book";
      else if (b.known !== undefined) effCfg.spells = "known";
      else if (b.fullList) effCfg.spells = "fullList";
      else if ((b.cantrips ?? 0) > 0) effCfg.spells = "known"; // 仅戏法
      else effCfg.spells = null;
      if (effCfg.spells && effCfg.spells !== "fullList") effCfg.maxSpellLevel = b?.maxSpellLevel ?? 1;
      note.autoSpells = effCfg.spells ? { mode: effCfg.spells, maxSpellLevel: effCfg.maxSpellLevel } : null;
    }
    // 4. 法术（known/book 职业）；fullList 职业不选
    const additionalItems = [];
    if (effCfg.spells === "known" || effCfg.spells === "book") additionalItems.push(...pickSpells(effCfg, classUuid, plan.spellBudget ?? {}));
    // 5. readRef（NPC 案同时留档 HP 基数供 oracle 对账）
    const read = cli("actor-read", { actorUuid, include: ["items"] });
    if (caseCfg.npc) note.hpBefore = read.hp?.max ?? null;
    // 6. advance 一次写入
    const bySlot = fillChoices(effCfg, plan, caseCfg.primary, new Set(additionalItems.map(g => g.uuid)));
    note.bySlotKeys = Object.keys(bySlot);
    const result = cli("actor-advance", { world, requestId: reqId(), actorUuid, readState: read.readState,
      ...plan.actorAdvanceArgs, choices: { bySlot }, additionalItems,
      ...(effCfg.spells === "fullList" ? { fullSpellList: true } : {}) }, { timeoutMs: 180000 });
    note.receipt = { status: result.status, code: result.code, warnings: result.warnings, verification: result.verification };
    // 7. oracle（NPC 案走方向相反的独立 oracle）
    if (caseCfg.npc) assertNpcCase(caseCfg, plan, result, note, problems);
    else assertCase(effCfg, plan, result, problems);
  } catch (error) {
    problems.push(`异常: ${error.message}`);
  }
  // 8. 清理：通过案默认删除自建 actor；失败案与 --keep 保留
  if (actorUuid && !KEEP && !problems.length) {
    try { deleteActor(actorUuid); } catch (error) { problems.push(`清理失败（案本身已通过）: ${error.message}`); }
  }
  note.ms = Date.now() - t0;
  note.ok = !problems.length;
  return note;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const all = SWEEP_CLASS ? buildSweepCases(SWEEP_CLASS) : CASES;
  const cases = all.filter(c => FILTER.test(c.id) || FILTER.test(c.cls));
  console.log(`e2e advance matrix: ${cases.length} 案（world=${WORLD_ID} port=${PORT} extended=${EXTENDED} sweep=${SWEEP_CLASS ?? "off"}）`);
  const notes = [];
  for (const c of cases) {
    const note = await runCase(c);
    notes.push(note);
    console.log(`${note.ok ? "✅" : "❌"} ${note.id} ${c.cls}×${c.npc ? c.monsterName : c.race}${c.subclassUuid ? `（${c.subclass}）` : ""} ${(note.ms / 1000).toFixed(1)}s${note.ok ? "" : " — " + note.problems.join(" | ").slice(0, 300)}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = path.join(OUT_DIR, `advance-matrix-${stamp}.json`);
  fs.writeFileSync(report, JSON.stringify({ world, port: PORT, extended: EXTENDED, sweep: SWEEP_CLASS, cases: notes }, null, 2));
  const failed = notes.filter(n => !n.ok);
  console.log(`报告: ${report}`);
  console.log(failed.length ? `❌ ${failed.length}/${notes.length} 案失败` : `✅ 全绿 ${notes.length}/${notes.length}`);
  process.exit(failed.length ? 1 : 0);
}
main();
