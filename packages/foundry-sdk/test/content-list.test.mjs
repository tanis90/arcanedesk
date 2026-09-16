import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

class BaseAdvancement {
  constructor(configuration = {}, title = "") {
    this.configuration = configuration;
    this.title = title;
    this.applied = [];
    this.autoValue = false;
  }
  async apply(level, data) { this.applied.push([level, data]); }
  async automaticApplicationValue() { return this.autoValue; }
}
class HitPointsAdvancement extends BaseAdvancement {}
class TraitAdvancement extends BaseAdvancement {}
class ItemChoiceAdvancement extends BaseAdvancement {}
class ItemGrantAdvancement extends BaseAdvancement {}
class SubclassAdvancement extends BaseAdvancement {}
class ScaleValueAdvancement extends BaseAdvancement {}
class AbilityScoreImprovementAdvancement extends BaseAdvancement {
  get allowFeat() { return this._allowFeat ?? false; }
}

function fixture({ classFlows = [], raceFlows = [], subclassFlows = [], spells = [], wizardList = [], classSystem = {}, subclassEntries = [], catalogPacks = [], traitLabels = {}, traitExpansion = {}, poolPacks = [], actorType = "character", actorHd = null } = {}) {
  let writes = 0;
  const preItems = [];
  const actor = { documentName: "Actor", id: "hero", uuid: "Actor.hero", name: "Hero", type: actorType,
    items: [], system: { attributes: { hp: { value: 10, max: 10 }, ...(actorHd ? { hd: actorHd } : {}) }, details: { level: 0 } },
    async update() { writes++; }, async createEmbeddedDocuments() { writes++; },
    async updateEmbeddedDocuments() { writes++; }, async deleteEmbeddedDocuments() { writes++; } };
  const source = (uuid, type, flows, system = {}) => ({ documentName: "Item", uuid, pack: "packs.rules", type, name: type,
    system, toObject: () => ({ uuid, type, name: type, system: { ...system }, __flows: flows }) });
  const docs = new Map();
  docs.set("Compendium.packs.rules.Item.class", source("Compendium.packs.rules.Item.class", "class", classFlows, { identifier: "wizard", ...classSystem }));
  docs.set("Compendium.packs.rules.Item.race", source("Compendium.packs.rules.Item.race", "race", raceFlows));
  docs.set("Compendium.packs.rules.Item.sub", source("Compendium.packs.rules.Item.sub", "subclass", subclassFlows));
  docs.set(actor.uuid, actor);
  const manager = {
    forNewItem: (_actor, data) => {
      const items = new Map(preItems.map(item => [item._id, item]));
      const clone = {
        items: { get: id => items.get(id), values: () => items.values() },
        updateSource: ({ items: added = [] } = {}) => { for (const item of added) items.set(item._id, item); },
        reset() {},
        toObject: () => ({ items: [] }),
      };
      return { steps: (data.__flows ?? []).map(({ level, advancement }) => ({ type: "forward", flow: { level, advancement } })), clone };
    },
    flowsForLevel: (item, level) => (item?.__flows ?? []).filter(flow => flow.level === level)
      .map(({ level: flowLevel, advancement }) => ({ level: flowLevel, advancement })),
  };
  const spellIndex = spells.map(([id, name, level, identifier, flags]) => ({ _id: id, name, type: "spell", system: { identifier, level }, ...(flags ? { flags } : {}) }));
  const spellPack = { metadata: { id: "dnd5e.spells", type: "Item" }, getIndex: async () => spellIndex };
  const subclassPack = { metadata: { id: "dnd5e.subclasses", type: "Item" }, getIndex: async () => subclassEntries };
  const extraPacks = catalogPacks.map(({ id, entries }) => ({ metadata: { id, type: "Item" }, getIndex: async () => entries }));
  const choicePools = poolPacks.map(({ id, index }) => ({ metadata: { id, type: "Item" }, index, getIndex: async () => [...index.values()] }));
  const allPacks = [spellPack, subclassPack, ...extraPacks, ...choicePools];
  const packs = Object.assign(allPacks, { get: id => allPacks.find(pack => pack.metadata.id === id) ?? null });
  const context = vm.createContext({
    game: { ready: true, user: { isGM: true }, world: { id: "w" }, packs },
    location: { origin: "https://foundry.test" },
    CONFIG: { DND5E: { abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, {}])) } },
    dnd5e: { applications: { advancement: { AdvancementManager: manager } },
      registry: { spellLists: { forType: key => (key === "class:wizard" ? { identifiers: new Set(wizardList) } : null) } },
      documents: { Trait: { keyLabel: key => traitLabels[key] ?? key, ...(traitExpansion ? { mixedChoices: async keys => {
        const out = new Set();
        for (const key of keys) {
          if (key.endsWith(":*")) for (const k of traitExpansion[key.slice(0, -2)] ?? []) out.add(k);
          else out.add(key);
        }
        return { asSet: () => out };
      } } : {}) } } },
    fromUuid: async uuid => docs.get(uuid) ?? null,
  });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  return { actor, docs, writes: () => writes,
    list: async (input = {}) => {
      const { type, ...rest } = input;
      const result = type === "classFeature"
        ? await run("advancementPlan", rest, {})
        : await run("compendiumBrowse", { scope: "compendium", type, ...rest }, {});
      return JSON.parse(JSON.stringify(result));
    } };
}

const applied = calls => JSON.parse(JSON.stringify(calls));
const hp = level => ({ level, advancement: new HitPointsAdvancement({}, "Hit Points") });
const asiConfig = (over = {}) => ({ fixed: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, points: 2, cap: 2, locked: [], ...over });

test("classFeature serializes the shared plan: requirements, automatics, coverage, advance args", async () => {
  const skills = new TraitAdvancement({ grants: [], choices: [{ count: 2, pool: ["skills:arc", "skills:his", "skills:med"] }] }, "技能");
  const asi = new AbilityScoreImprovementAdvancement(asiConfig(), "Ability Score Improvement");
  const subclass = new SubclassAdvancement({}, "Arcane Tradition");
  const grant = new ItemGrantAdvancement({ items: [{ uuid: "Compendium.packs.rules.Item.spellcasting" }] }, "Features");
  const weapons = new TraitAdvancement({ grants: ["weapons:sim:dag"], choices: [{ count: 1, pool: ["weapons:sim:dag", "weapons:sim:dart"] }] }, "武器熟练");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: skills }, { level: 1, advancement: weapons }, { level: 1, advancement: grant },
    { level: 2, advancement: subclass }, { level: 4, advancement: asi }] });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 5 });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.actorAdvanceArgs, { classUuid: "Compendium.packs.rules.Item.class", targetLevel: 5 });
  const skillReq = result.choiceRequirements.find(r => r.slot === "class:1:TraitAdvancement:0.pool0");
  assert.deepEqual({ count: skillReq.count, candidates: skillReq.candidates, required: skillReq.required, key: skillReq.key },
    { count: 2, candidates: ["skills:arc", "skills:his", "skills:med"], required: true, key: "class:1:TraitAdvancement:0.pool0" });
  const asiReq = result.choiceRequirements.find(r => r.kind === "AbilityScoreImprovementAdvancement");
  assert.equal(asiReq.cap, 2);
  assert.equal(asiReq.valueFormat, "asi-assignment");
  assert.equal(asiReq.key, asiReq.slot);
  assert.ok(result.choiceRequirements.some(r => r.valueFormat === "subclass-uuid"));
  assert.ok(!result.choiceRequirements.some(r => r.kind === "HitPointsAdvancement"));
  // choicesTemplate: one fill-in skeleton per bySlot key; subclass-uuid has none (top-level argument).
  assert.deepEqual(result.choicesTemplate["class:1:TraitAdvancement:0.pool0"], []);
  assert.deepEqual(result.choicesTemplate[asiReq.slot], { abilityScore: {} });
  assert.ok(!("subclassUuid" in result.choicesTemplate));
  assert.ok(result.automaticSteps.some(s => s.kind === "HitPointsAdvancement" && s.summary === "hp: automatic system default"));
  assert.ok(result.automaticSteps.some(s => s.kind === "ItemGrantAdvancement" && s.summary === "grant 1 items"));
  assert.equal(result.coverage.nativeStepCount, 6);
  assert.equal(result.coverage.uncoveredRequiredSteps.length, 1);
  assert.match(result.coverage.uncoveredRequiredSteps[0], /class:1:TraitAdvancement:1/);
  assert.equal(f.writes(), 0);
});

test("classFeature marks expertise requirements with mode/note under their own bySlot keys", async () => {
  const skills = new TraitAdvancement({ grants: [], choices: [{ count: 4, pool: ["skills:acr", "skills:ath", "skills:dec", "skills:ins", "skills:slt", "skills:ste"] }] }, "Skills");
  const expertise = new TraitAdvancement({ mode: "expertise", grants: [], choices: [{ count: 2, pool: ["skills:acr", "skills:ath", "skills:dec", "skills:ins", "skills:per", "skills:slt", "skills:ste"] }] }, "Expertise");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: skills }, { level: 1, advancement: expertise }] });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 1 });
  const skillReq = result.choiceRequirements.find(r => r.slot === "class:1:TraitAdvancement:0.pool0");
  assert.equal(skillReq.mode, undefined);
  assert.equal(skillReq.key, skillReq.slot);
  const expReq = result.choiceRequirements.find(r => r.slot === "class:1:TraitAdvancement:1.pool0");
  assert.equal(expReq.mode, "expertise");
  assert.equal(expReq.key, expReq.slot);
  assert.match(expReq.note, /already be proficient/);
  // Slot addressing makes shared-bucket aggregation unnecessary: every requirement owns its key.
  assert.equal(result.fillAllocation, undefined);
  assert.deepEqual(result.choicesTemplate[skillReq.slot], []);
  assert.deepEqual(result.choicesTemplate[expReq.slot], []);
});

test("classFeature reports hp as an automatic step with the hit-die derived summary", async () => {
  const die = new HitPointsAdvancement({}, "Hit Points");
  const f = fixture({ classFlows: [{ level: 1, advancement: die }, { level: 5, advancement: die }],
    classSystem: { hd: { denomination: "d6" } } });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 5 });
  assert.equal(result.status, "completed");
  assert.ok(!result.choiceRequirements.some(r => r.kind === "HitPointsAdvancement"));
  const summaries = result.automaticSteps.filter(s => s.kind === "HitPointsAdvancement").map(s => [s.level, s.summary]);
  assert.deepEqual(summaries, [[1, "hp: max hit die (6) + con mod"], [5, "hp: fixed 4 (d6 average) + con mod"]]);
  const legacy = await fixture({ classFlows: [hp(1)], classSystem: { hitDie: "d8" } })
    .list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 1 });
  assert.ok(legacy.automaticSteps.some(s => s.summary === "hp: max hit die (8) + con mod"));
});

test("classFeature hydrates candidateNames for pool-uuid and trait-key steps", async () => {
  const style = new ItemChoiceAdvancement({ type: "feat", choices: { 1: { count: 1 } },
    pool: [{ uuid: "Compendium.packs.rules.Item.fs-defense" }, { uuid: "Compendium.packs.rules.Item.fs-dueling" }] }, "Fighting Style");
  const skills = new TraitAdvancement({ grants: [], choices: [{ count: 1, pool: ["skills:arc", "skills:his"] }] }, "技能");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: style }, { level: 1, advancement: skills }],
    traitLabels: { "skills:arc": "奥秘", "skills:his": "历史" },
    poolPacks: [{ id: "packs.rules", index: new Map([["fs-defense", { _id: "fs-defense", name: "防御" }], ["fs-dueling", { _id: "fs-dueling", name: "决斗" }]]) }] });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const styleReq = result.choiceRequirements.find(r => r.valueFormat === "pool-uuid");
  assert.deepEqual(styleReq.candidateNames, { "Compendium.packs.rules.Item.fs-defense": "防御", "Compendium.packs.rules.Item.fs-dueling": "决斗" });
  const skillReq = result.choiceRequirements.find(r => r.valueFormat === "trait-key");
  assert.deepEqual(skillReq.candidateNames, { "skills:arc": "奥秘", "skills:his": "历史" });
  assert.equal(f.writes(), 0);
});

test("classFeature accepts NPC actors and summarizes hp with the monster size die", async () => {
  const f = fixture({ classFlows: [hp(1), hp(2)], actorType: "npc", actorHd: { max: 9, denomination: 8 } });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 2 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const summaries = result.automaticSteps.filter(s => s.kind === "HitPointsAdvancement").map(s => [s.level, s.summary]);
  assert.deepEqual(summaries, [[1, "hp: fixed 5 (d8 average) + con mod"], [2, "hp: fixed 5 (d8 average) + con mod"]]);
});

test("classFeature surfaces race language pools as slot-addressed requirements", async () => {
  const languages = new TraitAdvancement({ grants: ["languages:standard:common"],
    choices: [{ count: 1, pool: ["languages:standard:elvish", "languages:standard:dwarvish"] }] }, "语言");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: languages }],
    traitLabels: { "languages:standard:elvish": "精灵语", "languages:standard:dwarvish": "矮人语" } });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero",
    classUuid: "Compendium.packs.rules.Item.class", raceUuid: "Compendium.packs.rules.Item.race", characterLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const req = result.choiceRequirements.find(r => r.slot === "race:0:TraitAdvancement:0.pool0");
  assert.ok(req, JSON.stringify(result.choiceRequirements));
  assert.deepEqual({ count: req.count, key: req.key, candidates: req.candidates },
    { count: 1, key: "race:0:TraitAdvancement:0.pool0", candidates: ["languages:standard:elvish", "languages:standard:dwarvish"] });
  assert.deepEqual(req.candidateNames, { "languages:standard:elvish": "精灵语", "languages:standard:dwarvish": "矮人语" });
  assert.ok(!result.coverage.uncoveredRequiredSteps.some(s => s.startsWith("race:")));
});

test("classFeature shows mixed race ASI as a fixed-bonus automatic step plus a floating asi-assignment", async () => {
  const racial = new AbilityScoreImprovementAdvancement(asiConfig({ fixed: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 2 } }), "Ability Score Increase");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: racial }] });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero",
    classUuid: "Compendium.packs.rules.Item.class", raceUuid: "Compendium.packs.rules.Item.race", characterLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  // Half-elf style mixed ASI: cha+2 rides in automatically, the plan only asks for the 2 floating points.
  assert.ok(result.automaticSteps.some(s => s.slot === "race:0:AbilityScoreImprovementAdvancement:0" && s.summary === "fixed ability bonuses: cha+2"),
    JSON.stringify(result.automaticSteps));
  const req = result.choiceRequirements.find(r => r.slot === "race:0:AbilityScoreImprovementAdvancement:0");
  assert.ok(req, JSON.stringify(result.choiceRequirements));
  assert.deepEqual({ valueFormat: req.valueFormat, count: req.count, cap: req.cap, key: req.key },
    { valueFormat: "asi-assignment", count: 2, cap: 2, key: "race:0:AbilityScoreImprovementAdvancement:0" });
  assert.deepEqual(result.choicesTemplate[req.slot], { abilityScore: {} });
});

test("classFeature expands wildcard trait pools into concrete candidates", async () => {
  const languages = new TraitAdvancement({ grants: ["languages:standard:common"], choices: [{ count: 1, pool: ["languages:*"] }] }, "语言");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: languages }],
    traitExpansion: { languages: ["languages:standard:common", "languages:standard:elvish", "languages:exotic:deep"] },
    traitLabels: { "languages:standard:elvish": "精灵语", "languages:exotic:deep": "深潜语" } });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero",
    classUuid: "Compendium.packs.rules.Item.class", raceUuid: "Compendium.packs.rules.Item.race", characterLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const req = result.choiceRequirements.find(r => r.slot === "race:0:TraitAdvancement:0.pool0");
  assert.ok(req, JSON.stringify(result.choiceRequirements));
  assert.deepEqual(req.candidates, ["languages:standard:common", "languages:standard:elvish", "languages:exotic:deep"]);
  assert.deepEqual(req.candidateNames, { "languages:standard:elvish": "精灵语", "languages:exotic:deep": "深潜语" });
});

test("classFeature omits candidateNames when nothing resolves", async () => {
  const skills = new TraitAdvancement({ grants: [], choices: [{ count: 1, pool: ["skills:arc"] }] }, "技能");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: skills }] });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const skillReq = result.choiceRequirements.find(r => r.valueFormat === "trait-key");
  assert.deepEqual(skillReq.candidates, ["skills:arc"]);
  assert.equal(skillReq.candidateNames, undefined);
});

test("classFeature with subclass enumerates the subclass item's own grants", async () => {
  const subclass = new SubclassAdvancement({}, "Arcane Tradition");
  const grant = new ItemGrantAdvancement({ items: [{ uuid: "Compendium.packs.rules.Item.sculpt" }] }, "Tradition Features");
  const f = fixture({ classFlows: [hp(1), { level: 2, advancement: subclass }], subclassFlows: [{ level: 2, advancement: grant }] });
  const result = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class",
    subclassUuid: "Compendium.packs.rules.Item.sub", characterLevel: 2 });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.actorAdvanceArgs, { classUuid: "Compendium.packs.rules.Item.class", subclassUuid: "Compendium.packs.rules.Item.sub", targetLevel: 2 });
  const subStep = result.automaticSteps.find(s => s.slot.startsWith("subclass:"));
  assert.equal(subStep.kind, "ItemGrantAdvancement");
  assert.equal(subStep.level, 2);
  assert.equal(f.writes(), 0);
});

test("spell candidates filter by query, rules, maxLevel and mark class-list eligibility", async () => {
  const f = fixture({ spells: [["fb", "火球术", 3, "fireball"], ["ble", "祝福术", 1, "bless"], ["mm", "魔法飞弹", 1, "magic-missile"]], wizardList: ["fireball"] });
  const byQuery = await f.list({ type: "spell", query: "火球" });
  assert.deepEqual(byQuery.candidates.map(c => c.uuid), ["Compendium.dnd5e.spells.Item.fb"]);
  assert.equal(byQuery.candidates[0].eligibility, undefined);
  const byIdentifier = await f.list({ type: "spell", query: "magic missile" });
  assert.deepEqual(byIdentifier.candidates.map(c => c.entryId), ["mm"]);
  const capped = await f.list({ type: "spell", maxLevel: 1 });
  assert.equal(capped.total, 2);
  assert.ok(capped.candidates.every(c => c.level <= 1));
  const legal = await f.list({ type: "spell", classUuid: "Compendium.packs.rules.Item.class" });
  assert.equal(legal.candidates.find(c => c.entryId === "fb").eligibility, "legal");
  assert.equal(legal.candidates.find(c => c.entryId === "ble").eligibility, "name-match");
  const page1 = await f.list({ type: "spell", pageSize: 2 });
  assert.equal(page1.candidates.length, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.nextPage, 2);
  const page2 = await f.list({ type: "spell", pageSize: 2, page: 2 });
  assert.equal(page2.candidates.length, 1);
  assert.equal(page2.nextPage, null);
});

test("browse names mode batch-resolves each name with unique/ambiguous/miss status", async () => {
  const spells = [
    ["fb", "火球术", 3, "fireball"],
    ["fb2", "火焰箭", 0, "fire-bolt"],
    ["mm", "魔法飞弹", 1, "magic-missile"],
    ["cs", "法术反制 Counterspell", 3, "counterspell"],
  ];
  const f = fixture({ spells, wizardList: ["fireball", "magic-missile", "counterspell"],
    catalogPacks: [{ id: "dnd5e.spells24", entries: [
      { _id: "fb24", name: "火球术 Fireball", type: "spell", system: { identifier: "fireball", level: 3, source: { rules: "2024" } } },
    ] }] });
  const r = await f.list({ type: "spell", classUuid: "Compendium.packs.rules.Item.class", rules: "2014",
    names: ["火球术", "counterspell", "不存在的法术", "火"] });
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.total, 4);
  const at = query => r.resolutions.find(x => x.query === query);
  assert.equal(at("火球术").status, "unique");
  assert.equal(at("火球术").candidates[0].uuid, "Compendium.dnd5e.spells.Item.fb");
  assert.equal(at("火球术").candidates[0].identifier, "fireball");
  assert.equal(at("火球术").candidates[0].eligibility, "legal");
  assert.equal(at("counterspell").status, "unique");
  assert.equal(at("counterspell").candidates[0].entryId, "cs");
  assert.equal(at("不存在的法术").status, "miss");
  assert.equal(at("不存在的法术").total, 0);
  assert.deepEqual(at("不存在的法术").candidates, []);
  assert.equal(at("火").status, "ambiguous");
  assert.equal(at("火").total, 2);
  // Without the rules filter the cross-version duplicate makes 火球术 ambiguous, exact hit first.
  const both = await f.list({ type: "spell", names: ["火球术"] });
  assert.equal(both.resolutions[0].status, "ambiguous");
  assert.equal(both.resolutions[0].total, 2);
  assert.equal(both.resolutions[0].candidates[0].entryId, "fb");
  const conflict = await f.list({ type: "spell", query: "火球", names: ["火球术"] });
  assert.equal(conflict.status, "rejected");
  assert.equal(conflict.code, "INPUT_INVALID");
  const catalogNames = await f.list({ type: "class", names: ["法师"] });
  assert.equal(catalogNames.status, "rejected");
  assert.equal(catalogNames.code, "INPUT_INVALID");
});

test("spell eligibility judges at the identifier layer: module annotation authoritative, registry identifiers the fallback", async () => {
  const mod = "arcane-dnd5e-2014-automation";
  const spells = [
    ["ann-yes", "翠炎剑", 0, "green-flame-blade", { [mod]: { spellClasses: ["wizard"] } }],
    ["ann-no", "注解火球", 3, "fireball", { [mod]: { spellClasses: ["cleric"] } }],
    ["reg-yes", "魔法飞弹", 1, "magic-missile"],
    ["reg-no", "祝福术", 1, "bless"],
  ];
  const f = fixture({ spells, wizardList: ["fireball", "magic-missile"] });
  const r = await f.list({ type: "spell", classUuid: "Compendium.packs.rules.Item.class" });
  const at = id => r.candidates.find(c => c.entryId === id).eligibility;
  assert.equal(at("ann-yes"), "legal");
  assert.equal(at("ann-no"), "name-match");
  assert.equal(at("reg-yes"), "legal");
  assert.equal(at("reg-no"), "name-match");
  const plain = await f.list({ type: "spell" });
  assert.ok(plain.candidates.every(c => c.eligibility === undefined));
});

test("classFeature rejects bad targets and sources before any work", async () => {
  const f = fixture({ classFlows: [hp(1)] });
  const noLevel = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class" });
  assert.equal(noLevel.status, "rejected");
  assert.match(noLevel.code, /INPUT_INVALID/);
  const wrongType = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.race", characterLevel: 5 });
  assert.equal(wrongType.status, "rejected");
  assert.match(wrongType.code, /SOURCE_MISMATCH/);
  const missing = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.nope", characterLevel: 5 });
  assert.equal(missing.status, "rejected");
  assert.match(missing.code, /SOURCE_NOT_FOUND/);
  const badScope = await f.list({ type: "spell", scope: "world" });
  assert.equal(badScope.status, "rejected");
  assert.equal(f.writes(), 0);
});

test("classFeature projects the hardcoded spellcasting budget for the class, rules and level", async () => {
  const casting = (progression, ability = "int", rules = "2014") => ({ spellcasting: { progression, ability }, source: { rules } });
  const list5 = f => f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 5 });
  const wizard = await list5(fixture({ classFlows: [hp(1)], classSystem: casting("full") }));
  assert.deepEqual(wizard.spellBudget, { ability: "int", progression: "full", cantrips: 4, book: 14 });
  const sorcerer = await list5(fixture({ classFlows: [hp(1)], classSystem: { ...casting("full", "cha"), identifier: "sorcerer" } }));
  assert.deepEqual(sorcerer.spellBudget, { ability: "cha", progression: "full", cantrips: 5, known: 6 });
  const wizard24 = await list5(fixture({ classFlows: [hp(1)], classSystem: casting("full", "int", "2024") }));
  assert.deepEqual(wizard24.spellBudget, { ability: "int", progression: "full", cantrips: 4, book: 14 });
  const paladin = await list5(fixture({ classFlows: [hp(1)], classSystem: { ...casting("half", "cha"), identifier: "paladin" } }));
  assert.deepEqual(paladin.spellBudget, { ability: "cha", progression: "half", fullList: { maxLevel: 2, count: 0, candidates: [] } });
  const artificer = await list5(fixture({ classFlows: [hp(1)], classSystem: { ...casting("artificer"), identifier: "artificer" } }));
  assert.deepEqual(artificer.spellBudget, { ability: "int", progression: "artificer", cantrips: 2, fullList: { maxLevel: 2, count: 0, candidates: [] } });
  const fighter = await list5(fixture({ classFlows: [hp(1)], classSystem: { identifier: "fighter" } }));
  assert.equal(fighter.spellBudget, null);
});

test("classFeature fills prepared-list casters with module-annotated class spells", async () => {
  const mod = "arcane-dnd5e-2014-automation";
  const spells = [
    ["ble", "Bless", 1, "bless", { [mod]: { spellClasses: ["cleric", "paladin"] } }],
    ["cure", "Cure Wounds", 1, "cure-wounds", { [mod]: { spellClasses: ["cleric"] } }],
    ["sw", "Spiritual Weapon", 2, "spiritual-weapon", { [mod]: { spellClasses: ["cleric"] } }],
    ["guard", "Spirit Guardians", 3, "spirit-guardians", { [mod]: { spellClasses: ["cleric"] } }],
    ["fb", "Fireball", 3, "fireball"],
    ["sorc", "Chaos Bolt", 1, "chaos-bolt", { [mod]: { spellClasses: ["sorcerer"] } }],
  ];
  const cleric = fixture({ classFlows: [hp(1)], spells,
    classSystem: { spellcasting: { progression: "full", ability: "wis" }, source: { rules: "2014" }, identifier: "cleric" } });
  const at = level => cleric.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: level });
  const l3 = await at(3);
  assert.equal(l3.spellBudget.fullList.maxLevel, 2);
  assert.equal(l3.spellBudget.fullList.count, 3);
  assert.deepEqual(l3.spellBudget.fullList.candidates, [
    { uuid: "Compendium.dnd5e.spells.Item.ble", name: "Bless", level: 1 },
    { uuid: "Compendium.dnd5e.spells.Item.cure", name: "Cure Wounds", level: 1 },
    { uuid: "Compendium.dnd5e.spells.Item.sw", name: "Spiritual Weapon", level: 2 }]);
  const l5 = await at(5);
  assert.equal(l5.spellBudget.fullList.maxLevel, 3);
  assert.equal(l5.spellBudget.fullList.count, 4);
  const p1 = await fixture({ classFlows: [hp(1)], spells,
    classSystem: { spellcasting: { progression: "half", ability: "cha" }, source: { rules: "2014" }, identifier: "paladin" } })
    .list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 1 });
  assert.equal(p1.spellBudget.fullList, undefined);
});

test("classFeature omits zero budget entries (ranger level 1 has no spells known)", async () => {
  const f = fixture({ classFlows: [hp(1)], classSystem: { spellcasting: { progression: "half", ability: "wis" }, source: { rules: "2014" }, identifier: "ranger" } });
  const l1 = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 1 });
  assert.deepEqual(l1.spellBudget, { ability: "wis", progression: "half" });
  const l2 = await f.list({ type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 2 });
  assert.deepEqual(l2.spellBudget, { ability: "wis", progression: "half", known: 2 });
});

test("classFeature attaches the subclass candidate pool filtered by class identifier and rules version", async () => {
  const subs = [
    { _id: "wiz14", name: "塑能学派", type: "subclass", system: { classIdentifier: "wizard", source: { rules: "2014" } } },
    { _id: "sor14", name: "龙族血脉", type: "subclass", system: { classIdentifier: "sorcerer", source: { rules: "2014" } } },
    { _id: "wiz24", name: "Evoker", type: "subclass", system: { classIdentifier: "wizard", source: { rules: "2024" } } },
  ];
  const flows = () => [hp(1), { level: 2, advancement: new SubclassAdvancement({}, "Arcane Tradition") }];
  const args = { type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 2 };
  const req14 = (await fixture({ classFlows: flows(), subclassEntries: subs }).list(args)).choiceRequirements.find(r => r.valueFormat === "subclass-uuid");
  assert.deepEqual(req14.candidates, ["Compendium.dnd5e.subclasses.Item.wiz14"]);
  assert.deepEqual(req14.candidateNames, { "Compendium.dnd5e.subclasses.Item.wiz14": "塑能学派" });
  const req24 = (await fixture({ classFlows: flows(), classSystem: { source: { rules: "2024" } }, subclassEntries: subs }).list(args)).choiceRequirements.find(r => r.valueFormat === "subclass-uuid");
  assert.deepEqual(req24.candidates, ["Compendium.dnd5e.subclasses.Item.wiz24"]);
  const empty = (await fixture({ classFlows: flows() }).list(args)).choiceRequirements.find(r => r.valueFormat === "subclass-uuid");
  assert.equal(empty.candidates, undefined);
});

test("classFeature subclass pool dedupes SRD and module copies by identifier, arcane preferred", async () => {
  const subs = [
    { _id: "evo-srd", name: "塑能学派", type: "subclass", system: { identifier: "school-of-evocation", classIdentifier: "wizard", source: { rules: "2014" } } },
    { _id: "evo-mod", name: "塑能学派 School of Evocation", type: "subclass", system: { identifier: "school-of-evocation", classIdentifier: "wizard", source: { rules: "2014" } } },
    { _id: "illusion", name: "幻术学派", type: "subclass", system: { identifier: "school-of-illusion", classIdentifier: "wizard", source: { rules: "2014" } } },
  ];
  const flows = () => [hp(1), { level: 2, advancement: new SubclassAdvancement({}, "Arcane Tradition") }];
  const args = { type: "classFeature", actorUuid: "Actor.hero", classUuid: "Compendium.packs.rules.Item.class", characterLevel: 2 };
  const f = fixture({ classFlows: flows(), subclassEntries: [subs[0], subs[2]],
    catalogPacks: [{ id: "arcane-dnd5e-2014-automation.subclasses", entries: [subs[1]] }] });
  const req = (await f.list(args)).choiceRequirements.find(r => r.valueFormat === "subclass-uuid");
  assert.deepEqual(req.candidates, ["Compendium.dnd5e.subclasses.Item.illusion", "Compendium.arcane-dnd5e-2014-automation.subclasses.Item.evo-mod"]);
  assert.equal(req.candidateNames["Compendium.arcane-dnd5e-2014-automation.subclasses.Item.evo-mod"], "塑能学派 School of Evocation");
});

test("catalog enumerates classes: arcane-preferred dedupe within a rules version, separate rows across versions", async () => {
  const classes = [
    { _id: "a", name: "法师", type: "class", system: { identifier: "wizard", source: { rules: "2014" } } },
    { _id: "b", name: "Wizard", type: "class", system: { identifier: "wizard", source: { rules: "2014" } } },
    { _id: "c", name: "Wizard 2024", type: "class", system: { identifier: "wizard", source: { rules: "2024" } } },
    { _id: "d", name: "牧师", type: "class", system: { identifier: "cleric", source: { rules: "2014" } } },
  ];
  const f = fixture({ catalogPacks: [
    { id: "dnd5e.classes", entries: [classes[1], classes[3]] },
    { id: "arcane-dnd5e-2014-automation.classes", entries: [classes[0]] },
    { id: "dnd5e.classes24", entries: [classes[2]] },
  ] });
  const both = await f.list({ type: "class" });
  assert.equal(both.total, 3);
  const wizard14 = both.candidates.find(c => c.identifier === "wizard" && c.rules === "2014");
  assert.equal(wizard14.uuid, "Compendium.arcane-dnd5e-2014-automation.classes.Item.a");
  assert.ok(both.candidates.some(c => c.identifier === "wizard" && c.rules === "2024" && c.uuid === "Compendium.dnd5e.classes24.Item.c"));
  const only14 = await f.list({ type: "class", rules: "2014" });
  assert.equal(only14.total, 2);
  assert.ok(only14.candidates.every(c => c.rules === "2014"));
});

test("catalog subclass filters by classUuid and race enumerates with inferred pack rules", async () => {
  const subs = [
    { _id: "evo", name: "塑能学派", type: "subclass", system: { identifier: "school-of-evocation", classIdentifier: "wizard", source: { rules: "2014" } } },
    { _id: "life", name: "生命领域", type: "subclass", system: { identifier: "life-domain", classIdentifier: "cleric", source: { rules: "2014" } } },
  ];
  const races = [
    { _id: "hu", name: "人类", type: "race", system: { identifier: "human" } },
    { _id: "hu24", name: "Human", type: "race", system: { identifier: "human", source: { rules: "2024" } } },
  ];
  const f = fixture({ catalogPacks: [
    { id: "arcane-dnd5e-2014-automation.subclasses", entries: subs },
    { id: "dnd5e.races", entries: [races[0]] },
    { id: "dnd5e.origins24", entries: [races[1]] },
  ] });
  const filtered = await f.list({ type: "subclass", classUuid: "Compendium.packs.rules.Item.class" });
  assert.deepEqual(filtered.candidates.map(c => c.uuid), ["Compendium.arcane-dnd5e-2014-automation.subclasses.Item.evo"]);
  const all = await f.list({ type: "subclass" });
  assert.equal(all.total, 2);
  const raceRows = await f.list({ type: "race" });
  assert.equal(raceRows.total, 2);
  assert.deepEqual(raceRows.candidates.map(c => c.rules).sort(), ["2014", "2024"]);
});

test("browse item supports itemType and rejects the retired weapon type", async () => {
  const items = [
    { _id: "ls", name: "长剑", type: "weapon", system: { identifier: "longsword" } },
    { _id: "cm", name: "链甲", type: "equipment", system: { identifier: "chain-mail" } },
  ];
  const f = fixture({ catalogPacks: [{ id: "arcane-dnd5e-2014-automation.basicweapons", entries: items }] });
  const weapons = await f.list({ type: "item", itemType: "weapon" });
  assert.deepEqual(weapons.candidates.map(c => c.uuid), ["Compendium.arcane-dnd5e-2014-automation.basicweapons.Item.ls"]);
  const retired = await f.list({ type: "weapon" });
  assert.equal(retired.status, "rejected");
  assert.equal(retired.code, "INPUT_INVALID");
});

test("browse uuids mode returns full documents and rejects non-compendium references", async () => {
  const f = fixture({});
  const got = await f.list({ uuids: ["Compendium.packs.rules.Item.class"] });
  assert.equal(got.status, "completed");
  assert.equal(got.documents.length, 1);
  assert.equal(got.documents[0].packId, "packs.rules");
  assert.equal(got.documents[0].summary.identifier, "wizard");
  assert.equal(got.documents[0].document.system.identifier, "wizard");
  const missing = await f.list({ uuids: ["Compendium.packs.rules.Item.nope"] });
  assert.equal(missing.status, "rejected");
  assert.equal(missing.code, "SOURCE_NOT_FOUND");
  const world = await f.list({ uuids: ["Actor.hero"] });
  assert.equal(world.status, "rejected");
  assert.equal(world.code, "INPUT_INVALID");
});
