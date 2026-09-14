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

function fixture({ classFlows = [], raceFlows = [], subclassFlows = [], spells = [], wizardList = [], classSystem = {}, subclassEntries = [] } = {}) {
  let writes = 0;
  const preItems = [];
  const actor = { documentName: "Actor", id: "hero", uuid: "Actor.hero", name: "Hero", type: "character",
    items: [], system: { attributes: { hp: { value: 10, max: 10 } }, details: { level: 0 } },
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
  const spellIndex = spells.map(([id, name, level, identifier]) => ({ _id: id, name, type: "spell", system: { identifier, level } }));
  const spellPack = { metadata: { id: "dnd5e.spells", type: "Item" }, getIndex: async () => spellIndex };
  const subclassPack = { metadata: { id: "dnd5e.subclasses", type: "Item" }, getIndex: async () => subclassEntries };
  const packs = Object.assign([spellPack, subclassPack], { get: id => (id === "dnd5e.spells" ? spellPack : null) });
  const context = vm.createContext({
    game: { ready: true, user: { isGM: true }, world: { id: "w" }, packs },
    location: { origin: "https://foundry.test" },
    CONFIG: { DND5E: { abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, {}])) } },
    dnd5e: { applications: { advancement: { AdvancementManager: manager } },
      registry: { spellLists: { forType: key => (key === "class:wizard" ? { has: uuid => wizardList.some(suffix => uuid.endsWith(suffix)) } : null) } } },
    fromUuid: async uuid => docs.get(uuid) ?? null,
  });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  return { actor, docs, writes: () => writes,
    list: async (input = {}) => JSON.parse(JSON.stringify(await run("contentList", { scope: "compendium", ...input }, {}))) };
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
  assert.deepEqual({ count: skillReq.count, candidates: skillReq.candidates, required: skillReq.required, fill: skillReq.fill },
    { count: 2, candidates: ["skills:arc", "skills:his", "skills:med"], required: true, fill: ["choices.skills"] });
  const asiReq = result.choiceRequirements.find(r => r.kind === "AbilityScoreImprovementAdvancement");
  assert.equal(asiReq.cap, 2);
  assert.equal(asiReq.valueFormat, "asi-assignment");
  assert.ok(result.choiceRequirements.some(r => r.valueFormat === "subclass-uuid"));
  assert.ok(result.choiceRequirements.some(r => r.valueFormat === "hp-mode" && r.required === false));
  assert.ok(result.automaticSteps.some(s => s.kind === "ItemGrantAdvancement" && s.summary === "grant 1 items"));
  assert.equal(result.coverage.nativeStepCount, 6);
  assert.equal(result.coverage.uncoveredRequiredSteps.length, 1);
  assert.match(result.coverage.uncoveredRequiredSteps[0], /class:1:TraitAdvancement:1/);
  assert.equal(f.writes(), 0);
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
  const f = fixture({ spells: [["fb", "火球术", 3, "fireball"], ["ble", "祝福术", 1, "bless"], ["mm", "魔法飞弹", 1, "magic-missile"]], wizardList: [".fb"] });
  const byQuery = await f.list({ type: "spell", query: "火球" });
  assert.deepEqual(byQuery.candidates.map(c => c.uuid), ["Compendium.dnd5e.spells.Item.fb"]);
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
  assert.deepEqual(paladin.spellBudget, { ability: "cha", progression: "half" });
  const artificer = await list5(fixture({ classFlows: [hp(1)], classSystem: { ...casting("artificer"), identifier: "artificer" } }));
  assert.deepEqual(artificer.spellBudget, { ability: "int", progression: "artificer", cantrips: 2 });
  const fighter = await list5(fixture({ classFlows: [hp(1)], classSystem: { identifier: "fighter" } }));
  assert.equal(fighter.spellBudget, null);
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
