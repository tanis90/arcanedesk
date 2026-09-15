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

function fixture({ classFlows = [], raceFlows = [], spells = [], classSystem = {}, actorLevel = 0, actorHp = null } = {}) {
  let writes = 0;
  const preItems = [];
  const actor = { documentName: "Actor", id: "hero", uuid: "Actor.hero", name: "Hero", type: "character",
    items: [], system: { attributes: { hp: actorHp ?? { value: 10, max: 10 } }, details: { level: actorLevel } },
    async update(patch = {}) { writes++; for (const [key, value] of Object.entries(patch)) {
      if (!key.includes(".")) { actor[key] = value; continue; }
      const keys = key.split("."); let target = actor.system;
      for (const part of keys.slice(1, -1)) target = target?.[part];
      if (target) target[keys.at(-1)] = value;
    } },
    async createEmbeddedDocuments(_kind, data = []) { writes++; const made = data.map((d, i) => ({ id: "made" + i + "_" + writes, uuid: "Actor.hero.Item.made" + i + "_" + writes, name: d.name, type: d.type, flags: d.flags ?? {}, system: d.system ?? {}, _stats: {} })); actor.items.push(...made); return made; },
    async updateEmbeddedDocuments() { writes++; }, async deleteEmbeddedDocuments() { writes++; } };
  const source = (uuid, type, flows, system = {}) => ({ documentName: "Item", uuid, pack: "packs.rules", type, name: type,
    system, toObject: () => ({ uuid, type, name: type, system: { ...system }, __flows: flows }) });
  const docs = new Map();
  docs.set("Compendium.packs.rules.Item.class", source("Compendium.packs.rules.Item.class", "class", classFlows, { identifier: "wizard", ...classSystem }));
  docs.set("Compendium.packs.rules.Item.race", source("Compendium.packs.rules.Item.race", "race", raceFlows));
  docs.set("Compendium.packs.rules.Item.sub", source("Compendium.packs.rules.Item.sub", "subclass", []));
  docs.set(actor.uuid, actor);
  const spellIndex = spells.map(([id, name, level, identifier, flags]) => ({ _id: id, name, type: "spell", system: { identifier, level }, ...(flags ? { flags } : {}) }));
  for (const [id, name, level, identifier] of spells) {
    const uuid = "Compendium.dnd5e.spells.Item." + id;
    docs.set(uuid, { documentName: "Item", uuid, pack: "dnd5e.spells", type: "spell", name,
      system: { identifier, level }, toObject: () => ({ uuid, type: "spell", name, system: { identifier, level } }) });
  }
  const spellPack = { metadata: { id: "dnd5e.spells", type: "Item" }, getIndex: async () => spellIndex };
  const packs = Object.assign([spellPack], { get: id => (id === "dnd5e.spells" ? spellPack : null) });
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
  const context = vm.createContext({
    game: { ready: true, user: { isGM: true }, world: { id: "w" }, packs },
    location: { origin: "https://foundry.test" },
    CONFIG: { DND5E: { abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, {}])) } },
    dnd5e: { applications: { advancement: { AdvancementManager: manager } }, registry: { spellLists: { forType: () => null } } },
    fromUuid: async uuid => docs.get(uuid) ?? null,
  });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  const readState = { actorUuid: actor.uuid, world: { origin: "https://foundry.test", id: "w" }, include: [], fields: {}, items: [] };
  return { actor, docs, preItems, writes: () => writes,
    advance: async (input = {}) => JSON.parse(JSON.stringify(await run("actorAdvance", {
      world: { origin: "https://foundry.test", id: "w" }, requestId: "r1", actorUuid: actor.uuid, readState,
      classUuid: "Compendium.packs.rules.Item.class", targetLevel: 1, ...input }, {}))) };
}

const applied = calls => JSON.parse(JSON.stringify(calls));
const hp = level => ({ level, advancement: new HitPointsAdvancement({}, "Hit Points") });
const asiConfig = (over = {}) => ({ fixed: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 }, points: 2, cap: 2, locked: [], ...over });

test("missing required choices reject with every slot listed and zero writes", async () => {
  const skills = new TraitAdvancement({ grants: [], choices: [{ count: 2, pool: ["skills:arc", "skills:his", "skills:med"] }] }, "Skills");
  const asi = new AbilityScoreImprovementAdvancement(asiConfig(), "Ability Score Improvement");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: skills }, { level: 4, advancement: asi }] });
  const result = await f.advance({ targetLevel: 5 });
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "ADVANCEMENT_NEEDS_CHOICE");
  assert.match(result.message, /class:1:TraitAdvancement:0\.pool0/);
  assert.match(result.message, /class:4:AbilityScoreImprovementAdvancement:0/);
  assert.equal(f.writes(), 0);
});

test("trait pools consume pool keys per pool and include grants in chosen", async () => {
  const trait = new TraitAdvancement({ grants: ["saves:int"], choices: [
    { count: 2, pool: ["skills:arc", "skills:his", "skills:med"] },
    { count: 1, pool: ["tool:art:brewer", "tool:art:mason"] }] }, "Proficiencies");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: trait }] });
  const result = await f.advance({ choices: { skills: ["skills:arc", "skills:med"], tools: ["tool:art:mason"] } });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(trait.applied), [[1, { chosen: ["saves:int", "skills:arc", "skills:med", "tool:art:mason"] }]]);
  assert.equal(result.warnings.length, 0);
});

test("item choice uses per-level counts and routes selections by pool membership", async () => {
  const cantripFlow = new ItemChoiceAdvancement({ type: "spell", choices: { 1: { count: 2 } },
    pool: [{ uuid: "Compendium.packs.spells.Item.c1" }, { uuid: "Compendium.packs.spells.Item.c2" }, { uuid: "Compendium.packs.spells.Item.c3" }] }, "Cantrips");
  const bookFlow = new ItemChoiceAdvancement({ type: "spell", choices: { 1: { count: 2 } },
    pool: ["p1", "p2", "p3"].map(s => ({ uuid: "Compendium.packs.spells.Item." + s })) }, "Spellbook");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: cantripFlow }, { level: 1, advancement: bookFlow }] });
  const result = await f.advance({ choices: { cantrips: ["Compendium.packs.spells.Item.c1", "Compendium.packs.spells.Item.c2"],
    preparedSpells: ["Compendium.packs.spells.Item.p1", "Compendium.packs.spells.Item.p2"] } });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(cantripFlow.applied), [[1, { selected: ["Compendium.packs.spells.Item.c1", "Compendium.packs.spells.Item.c2"] }]]);
  assert.deepEqual(applied(bookFlow.applied), [[1, { selected: ["Compendium.packs.spells.Item.p1", "Compendium.packs.spells.Item.p2"] }]]);
});

test("open-pool spell choice validates candidates by restriction level", async () => {
  const choice = new ItemChoiceAdvancement({ type: "spell", choices: { 1: { count: 1 } }, pool: [], restriction: { level: "0", list: [] } }, "Cantrip");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: choice }] });
  f.docs.set("Compendium.packs.spells.Item.cantrip", { documentName: "Item", uuid: "Compendium.packs.spells.Item.cantrip", type: "spell", system: { level: 0 } });
  f.docs.set("Compendium.packs.spells.Item.leveled", { documentName: "Item", uuid: "Compendium.packs.spells.Item.leveled", type: "spell", system: { level: 1 } });
  const rejected = await f.advance({ choices: { cantrips: ["Compendium.packs.spells.Item.leveled"] } });
  assert.equal(rejected.status, "rejected");
  assert.equal(f.writes(), 0);
  const result = await f.advance({ choices: { cantrips: ["Compendium.packs.spells.Item.leveled", "Compendium.packs.spells.Item.cantrip"] } });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(choice.applied), [[1, { selected: ["Compendium.packs.spells.Item.cantrip"] }]]);
  assert.deepEqual(result.warnings.map(w => w.fill), ["choices.cantrips"]);
});

test("ability score improvement applies native shapes and enforces cap and points", async () => {
  const asi = new AbilityScoreImprovementAdvancement(asiConfig(), "ASI");
  const f = fixture({ classFlows: [hp(1), { level: 4, advancement: asi }] });
  assert.equal((await f.advance({ targetLevel: 4, choices: { abilityScore: { str: 3 } } })).status, "rejected");
  assert.equal((await f.advance({ targetLevel: 4, choices: { abilityScore: { str: 2, dex: 1 } } })).status, "rejected");
  const result = await f.advance({ targetLevel: 4, choices: { abilityScore: { str: 2 } } });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(asi.applied), [[4, { type: "asi", assignments: { str: 2 } }]]);
});

test("feat branch consumes one feat per ASI step and warns on leftover abilityScore", async () => {
  const asi = new AbilityScoreImprovementAdvancement(asiConfig(), "ASI");
  asi._allowFeat = true;
  const f = fixture({ classFlows: [hp(1), { level: 4, advancement: asi }] });
  const result = await f.advance({ targetLevel: 4, choices: { feats: ["Compendium.packs.feats.Item.alert"], abilityScore: { str: 2 } } });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(asi.applied), [[4, { type: "feat", uuid: "Compendium.packs.feats.Item.alert" }]]);
  assert.deepEqual(result.warnings.map(w => w.fill), ["choices.abilityScore"]);
});

test("race fixed ability bonuses apply automatically without choices", async () => {
  const racial = new AbilityScoreImprovementAdvancement(asiConfig({ points: 0, fixed: { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 } }), "Ability Score Increase");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: racial }] });
  const result = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race" });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(racial.applied), [[0, { type: "asi", assignments: { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 } }]]);
});

test("item grants select non-optional items; spell selections without a consuming step warn", async () => {
  const grant = new ItemGrantAdvancement({ items: [{ uuid: "Compendium.packs.rules.Item.feature" }, { uuid: "Compendium.packs.rules.Item.opt", optional: true }] }, "Features");
  const scale = new ScaleValueAdvancement({}, "Cantrips Known");
  scale.autoValue = { configuration: {} };
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: grant }, { level: 1, advancement: scale }] });
  const result = await f.advance({ choices: { cantrips: ["Compendium.packs.spells.Item.c1"] } });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(grant.applied), [[1, { selected: ["Compendium.packs.rules.Item.feature"] }]]);
  assert.deepEqual(result.warnings, [{ code: "UNCONSUMED_CHOICE", fill: "choices.cantrips", value: "Compendium.packs.spells.Item.c1" }]);
});

test("subclass requires subclassUuid; unknown advancement without native default rejects", async () => {
  const subclass = new SubclassAdvancement({}, "Arcane Tradition");
  const scale = new ScaleValueAdvancement({}, "Mystery");
  const f = fixture({ classFlows: [hp(1), { level: 2, advancement: subclass }, { level: 2, advancement: scale }] });
  const missing = await f.advance({ targetLevel: 2 });
  assert.equal(missing.status, "rejected");
  assert.match(missing.message, /subclassUuid/);
  assert.equal(f.writes(), 0);
  const wrong = await f.advance({ targetLevel: 2, subclassUuid: "Compendium.packs.rules.Item.sub" });
  assert.equal(wrong.status, "rejected");
  assert.match(wrong.message, /Mystery|no native default/);
  assert.equal(f.writes(), 0);
  scale.autoValue = { configuration: {} };
  const done = await f.advance({ targetLevel: 2, subclassUuid: "Compendium.packs.rules.Item.sub" });
  assert.equal(done.status, "completed");
  assert.deepEqual(applied(subclass.applied), [[2, { uuid: "Compendium.packs.rules.Item.sub" }]]);
});

test("hit points default to max at level 1 and avg later unless overridden", async () => {
  const first = hp(1), third = hp(3);
  const f = fixture({ classFlows: [first, third] });
  await f.advance({ targetLevel: 3 });
  assert.deepEqual(applied(first.advancement.applied), [[1, { 1: "max" }]]);
  assert.deepEqual(applied(third.advancement.applied), [[3, { 3: "avg" }]]);
  const override = hp(3);
  const g = fixture({ classFlows: [override] });
  await g.advance({ choices: { hp: "max" } });
  assert.deepEqual(applied(override.advancement.applied), [[3, { 3: "max" }]]);
});

test("subclass item's own grants apply in the same session after the subclass step", async () => {
  const grant = new ItemGrantAdvancement({ items: [{ uuid: "Compendium.packs.rules.Item.feature" }] }, "Tradition Features");
  grant.autoValue = { selected: ["Compendium.packs.rules.Item.feature"] };
  const subclass = new SubclassAdvancement({}, "Arcane Tradition");
  subclass.apply = async function (level, data) { this.applied.push([level, data]); this.value = { document: "sub-clone", uuid: data.uuid }; };
  const f = fixture({ classFlows: [hp(1), { level: 2, advancement: subclass }] });
  f.preItems.push({ _id: "sub-clone", __flows: [{ level: 2, advancement: grant }] });
  const result = await f.advance({ targetLevel: 2, subclassUuid: "Compendium.packs.rules.Item.sub" });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(grant.applied), [[2, { selected: ["Compendium.packs.rules.Item.feature"] }]]);
  assert.ok(result.steps.some(step => step.label === "subclass" && step.kind === "ItemGrantAdvancement"));
  assert.equal(result.warnings.length, 0);
});

test("fullSpellList grants the annotated class spell list after advancement; other classes reject before writes", async () => {
  const mod = "arcane-dnd5e-2014-automation";
  const clericSpells = [
    ["ble", "Bless", 1, "bless", { [mod]: { spellClasses: ["cleric", "paladin"] } }],
    ["cure", "Cure Wounds", 1, "cure-wounds", { [mod]: { spellClasses: ["cleric"] } }],
    ["sw", "Spiritual Weapon", 2, "spiritual-weapon", { [mod]: { spellClasses: ["cleric"] } }],
    ["guard", "Spirit Guardians", 3, "spirit-guardians", { [mod]: { spellClasses: ["cleric"] } }],
    ["fb", "Fireball", 3, "fireball"],
  ];
  const clericSystem = { identifier: "cleric", spellcasting: { progression: "full", ability: "wis" }, source: { rules: "2014" } };
  const f = fixture({ classFlows: [hp(1)], spells: clericSpells, classSystem: clericSystem });
  const result = await f.advance({ targetLevel: 3, fullSpellList: true });
  assert.equal(result.status, "completed");
  assert.equal(result.verification.spellFill.maxLevel, 2);
  assert.equal(result.verification.spellFill.count, 3);
  assert.equal(result.verification.spellFill.created.length, 3);
  assert.deepEqual(result.verification.spellFill.created.map(item => item.name).sort(), ["Bless", "Cure Wounds", "Spiritual Weapon"]);
  // Granting again skips existing sources instead of stacking.
  const again = await f.advance({ targetLevel: 3, fullSpellList: true });
  assert.equal(again.status, "completed");
  assert.equal(again.verification.spellFill.created.length, 0);
  assert.equal(again.verification.spellFill.skippedExisting.length, 3);
  // Wizard is not a prepared-list class: rejected before any write.
  const w = fixture({ classFlows: [hp(1)], spells: clericSpells, classSystem: { identifier: "wizard", spellcasting: { progression: "full", ability: "int" }, source: { rules: "2014" } } });
  const rejected = await w.advance({ targetLevel: 3, fullSpellList: true });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.code, /INPUT_INVALID/);
  assert.equal(w.writes(), 0);
});

test("creation advance (level 0) fills hp to the derived max and reports hpFill", async () => {
  const f = fixture({ classFlows: [hp(1)], actorHp: { value: 24, max: 30 } });
  const result = await f.advance({ targetLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verification.hp, { value: 30, max: 30 });
  assert.deepEqual(result.verification.hpFill, { before: 24, after: 30 });
});

test("advance of an already-leveled character never fills hp", async () => {
  const f = fixture({ classFlows: [hp(1)], actorLevel: 3, actorHp: { value: 24, max: 30 } });
  const result = await f.advance({ targetLevel: 4 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verification.hp, { value: 24, max: 30 });
  assert.equal(result.verification.hpFill, undefined);
});

test("creation advance pulls hp up only, never pushes down", async () => {
  const f = fixture({ classFlows: [hp(1)], actorHp: { value: 40, max: 30 } });
  const result = await f.advance({ targetLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verification.hp, { value: 40, max: 30 });
  assert.equal(result.verification.hpFill, undefined);
});
