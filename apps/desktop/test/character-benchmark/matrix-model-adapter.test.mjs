// matrix-model-adapter judgeState 纯函数单测：终态快照 × probe 期望的选择无关判定。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { judgeState, MATRIX_CASES } = require("./matrix-model-adapter.cjs");

const A5 = MATRIX_CASES.find(c => c.id === "A5");
const A12 = MATRIX_CASES.find(c => c.id === "A12");
const C1 = MATRIX_CASES.find(c => c.id === "C1");

const FIGHTER_SKILLS = ["acr", "ani", "ath", "his", "ins", "itm", "prc", "sur"];
const a5Expect = {
  classUuid: "Compendium.packs.rules.Item.fighter", subclassUuid: "Compendium.packs.rules.Item.battle-master",
  raceUuid: "Compendium.packs.rules.Item.high-elf", spellBudget: null, maxSpellLevel: 0,
  skillPickCount: 2, skillPool: FIGHTER_SKILLS, asiPoints: 2, hitDie: 10, racialSum: 3, racialCantrips: 1,
  fixedSkills: ["prc"], // 高等精灵 keen senses：种族固定熟练，不占职业选择数
};
// str15+2asi=17 dex13+2race=15 con14 int12+1race=13 wis10 cha8 → 77；conMod+2 → hp 10+2+4×(6+2)=44
const a5Snap = {
  type: "character",
  abilities: { str: 17, dex: 15, con: 14, int: 13, wis: 10, cha: 8 },
  hp: { value: 44, max: 44 },
  skills: { ath: 1, sur: 1, prc: 1 }, // 2 职业自选 + 1 种族固定
  items: [
    { type: "class", name: "战士 Fighter", identifier: "fighter", levels: 5, sourceId: "Compendium.packs.rules.Item.fighter" },
    { type: "subclass", name: "战斗大师 Battle Master", sourceId: "Compendium.packs.rules.Item.battle-master" },
    { type: "race", name: "高等精灵 High Elf", sourceId: "Compendium.packs.rules.Item.high-elf" },
  ],
};

test("A5 合格快照全过", () => {
  const r = judgeState(A5, a5Expect, a5Snap, null);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
});

test("A5 逐项抓错：等级/子职业/HP/技能池/属性总和", () => {
  const bad = (mutate, id) => {
    const s = structuredClone(a5Snap);
    mutate(s);
    const r = judgeState(A5, a5Expect, s, null);
    assert.equal(r.ok, false);
    const c = r.checks.find(x => x.id === id);
    assert.ok(c && !c.ok, `${id} 应失败: ${JSON.stringify(r.checks)}`);
  };
  bad(s => { s.items.find(i => i.type === "class").levels = 4; }, "class.levels");
  bad(s => { s.items.find(i => i.type === "subclass").sourceId = "Compendium.packs.rules.Item.champion"; }, "subclass.item");
  bad(s => { s.hp.max = 40; }, "hp.max");
  bad(s => { s.hp.value = 30; }, "hp.full");
  bad(s => { s.skills = { ath: 1, med: 1 }; }, "skills.pool");
  bad(s => { s.abilities.cha = 10; }, "abilities.sum"); // 总和 79 ≠ 77
});

test("A12 法术口径：戏法=职业预算+种族 1，book 精确计数，环级上限", () => {
  const a12Expect = {
    classUuid: "Compendium.packs.rules.Item.wizard", subclassUuid: "Compendium.packs.rules.Item.evocation",
    raceUuid: "Compendium.packs.rules.Item.high-elf",
    spellBudget: { ability: "int", progression: "full", cantrips: 4, book: 14 }, maxSpellLevel: 3,
    skillPickCount: 2, skillPool: ["arc", "his", "ins", "inv", "med", "rel"], asiPoints: 2, hitDie: 6, racialSum: 3, racialCantrips: 1,
    fixedSkills: ["prc"],
  };
  const spell = (name, level) => ({ type: "spell", name, level, sourceId: null });
  const snap = {
    type: "character",
    abilities: { str: 8, dex: 15, con: 14, int: 18, wis: 12, cha: 10 }, // 77
    hp: { value: 32, max: 32 }, // 6+2+4×(4+2)=32
    skills: { arc: 1, inv: 1, prc: 1 }, // 2 职业自选 + 1 种族固定
    items: [
      { type: "class", name: "法师 Wizard", identifier: "wizard", levels: 5, sourceId: "Compendium.packs.rules.Item.wizard" },
      { type: "subclass", name: "塑能学派 School of Evocation", sourceId: "Compendium.packs.rules.Item.evocation" },
      { type: "race", name: "高等精灵 High Elf", sourceId: "Compendium.packs.rules.Item.high-elf" },
      ...["fire-bolt", "mage-hand", "prestidigitation", "ray-of-frost"].map(n => spell(n, 0)),
      spell("fire bolt（种族）", 0), // 种族戏法第 5 个
      ...Array.from({ length: 14 }, (_, i) => spell(`s${i + 1}`, (i % 3) + 1)),
    ],
  };
  const r = judgeState(A12, a12Expect, snap, null);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
  // 少一个戏法 → 挂；四环法术 → 挂
  const short = structuredClone(snap); short.items = short.items.filter(i => i.name !== "fire bolt（种族）");
  assert.equal(judgeState(A12, a12Expect, short, null).checks.find(c => c.id === "spells.cantrips")?.ok, false);
  const over = structuredClone(snap); over.items.push(spell("level4-spell", 4));
  const overR = judgeState(A12, a12Expect, over, null);
  assert.equal(overR.checks.find(c => c.id === "spells.levelCap")?.ok, false);
  assert.equal(overR.checks.find(c => c.id === "spells.book")?.ok, false);
});

test("C1 NPC：体型骰 HP、来源保留、属性仅 ASI 增量", () => {
  const c1Expect = {
    classUuid: "Compendium.packs.rules.Item.fighter", subclassUuid: "Compendium.packs.rules.Item.champion",
    raceUuid: null, spellBudget: null, maxSpellLevel: 0,
    skillPickCount: 2, skillPool: FIGHTER_SKILLS, asiPoints: 2, hitDie: 8, racialSum: 0, racialCantrips: 0,
  };
  const sourceBefore = {
    hpMax: 58,
    abilities: { str: 17, dex: 13, con: 14, int: 10, wis: 11, cha: 10 },
    skills: ["prc", "ste"],
    items: [{ type: "feat", name: "Multiattack" }, { type: "weapon", name: "Bite" }, { type: "weapon", name: "Claws" }],
  };
  const snap = {
    type: "npc",
    abilities: { str: 19, dex: 13, con: 14, int: 10, wis: 11, cha: 10 }, // ASI +2 str
    hp: { value: 93, max: 93 }, // 58 + 5×(5+2)
    skills: { prc: 1, ste: 1, ath: 1, acr: 1 },
    items: [
      { type: "feat", name: "Multiattack" }, { type: "weapon", name: "Bite" }, { type: "weapon", name: "Claws" },
      { type: "class", name: "战士 Fighter", identifier: "fighter", levels: 5, sourceId: "Compendium.packs.rules.Item.fighter" },
      { type: "subclass", name: "勇士 Champion", sourceId: "Compendium.packs.rules.Item.champion" },
    ],
  };
  const r = judgeState(C1, c1Expect, snap, sourceBefore);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
  // HP 偷用职业骰（d10 均值 6）会多 5 点 → 挂
  const d10 = structuredClone(snap); d10.hp = { value: 98, max: 98 };
  assert.equal(judgeState(C1, c1Expect, d10, sourceBefore).checks.find(c => c.id === "hp.max")?.ok, false);
  // 来源条目被删 → 挂
  const stripped = structuredClone(snap); stripped.items = stripped.items.filter(i => i.name !== "Bite");
  assert.equal(judgeState(C1, c1Expect, stripped, sourceBefore).checks.find(c => c.id === "preservation.items")?.ok, false);
  // 属性重排（非仅 ASI）：str 降 2、dex 升 4，违反单项 ≥0 且 ≤2 / 总和 +2
  const rerolled = structuredClone(snap); rerolled.abilities.str = 15; rerolled.abilities.dex = 17;
  assert.equal(judgeState(C1, c1Expect, rerolled, sourceBefore).checks.find(c => c.id === "abilities.preserved")?.ok, false);
});

test("无卡/重名", () => {
  assert.equal(judgeState(A5, a5Expect, null, null).ok, false);
});
