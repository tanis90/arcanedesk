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

function fixture({ classFlows = [], raceFlows = [], spells = [], classSystem = {}, actorLevel = 0, actorHp = null, actorType = "character", actorSpells = null, traitExpansion = {}, actorItems = [] } = {}) {
  let writes = 0;
  const itemUpdates = [], itemDeletes = [];
  const preItems = actorItems.map(item => ({ ...item }));
  const actor = { documentName: "Actor", id: "hero", uuid: "Actor.hero", name: "Hero", type: actorType,
    items: actorItems.map(item => ({ ...item, id: item._id, toObject: () => JSON.parse(JSON.stringify(item)) })),
    system: { attributes: { hp: actorHp ?? { value: 10, max: 10 } }, details: { level: actorLevel },
      ...(actorSpells ? { spells: actorSpells } : {}),
      abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: 8, proficient: 0 }])) },
    async update(patch = {}) { writes++; for (const [key, value] of Object.entries(patch)) {
      if (!key.includes(".")) { actor[key] = value; continue; }
      const keys = key.split("."); let target = actor.system;
      for (const part of keys.slice(1, -1)) target = target?.[part];
      if (target) target[keys.at(-1)] = value;
    } },
    async createEmbeddedDocuments(_kind, data = []) { writes++; const made = data.map((d, i) => ({ id: "made" + i + "_" + writes, uuid: "Actor.hero.Item.made" + i + "_" + writes, name: d.name, type: d.type, flags: d.flags ?? {}, system: d.system ?? {}, _stats: {}, toObject() { return JSON.parse(JSON.stringify({ ...d, _id: this.id })); } })); actor.items.push(...made); return made; },
    async updateEmbeddedDocuments(_kind, data = []) { writes++; itemUpdates.push(...data); },
    async deleteEmbeddedDocuments(_kind, ids = []) { writes++; itemDeletes.push(...ids); } };
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
        toObject: () => ({ items: [...items.values()].map(item => JSON.parse(JSON.stringify(item))) }),
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
    dnd5e: { applications: { advancement: { AdvancementManager: manager } }, registry: { spellLists: { forType: () => null } },
      documents: { Trait: { keyLabel: key => key, ...(traitExpansion ? { mixedChoices: async keys => {
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
  const readState = { actorUuid: actor.uuid, world: { origin: "https://foundry.test", id: "w" }, include: [], fields: {}, items: [] };
  return { actor, docs, preItems, writes: () => writes, itemUpdates, itemDeletes,
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

test("expertise picks ride choices.expertise and may re-pick a same-call proficiency slot value", async () => {
  const skills = new TraitAdvancement({ grants: [], choices: [{ count: 1, pool: ["skills:slt", "skills:ste"] }] }, "Skills");
  const expertise = new TraitAdvancement({ mode: "expertise", grants: [], choices: [{ count: 1, pool: ["skills:slt", "skills:ste"] }] }, "Expertise");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: skills }, { level: 1, advancement: expertise }] });
  f.actor.system.skills = { slt: { value: 0 }, ste: { value: 0 } };
  // Simulate the native apply order: the proficiency slot lands value 1, expertise upgrades to 2.
  skills.apply = async (_level, data) => { for (const key of data.chosen ?? []) if (key.startsWith("skills:")) f.actor.system.skills[key.slice(7)].value = 1; };
  expertise.apply = async (_level, data) => { for (const key of data.chosen ?? []) if (key.startsWith("skills:")) f.actor.system.skills[key.slice(7)].value = 2; };
  const result = await f.advance({ choices: { skills: ["skills:slt"], expertise: ["skills:slt"] } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.verification.traits.skills, ["slt"]);
  assert.deepEqual(result.verification.traits.expertise, { skills: ["slt"], tools: [] });
});

test("expertise picks outside the proficient set reject the whole advance before any write", async () => {
  const expertise = new TraitAdvancement({ mode: "expertise", grants: [], choices: [{ count: 1, pool: ["skills:slt", "skills:ste"] }] }, "Expertise");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: expertise }] });
  f.actor.system.skills = { slt: { value: 0 }, ste: { value: 1 } };
  const result = await f.advance({ choices: { expertise: ["skills:slt"] } });
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "ADVANCEMENT_NEEDS_CHOICE");
  assert.match(result.message, /expertise picks not proficient: skills:slt/);
  assert.equal(f.writes(), 0);
});

test("the post-write net reports EXPERTISE_NOT_LANDED when the native apply drops a valid pick", async () => {
  const expertise = new TraitAdvancement({ mode: "expertise", grants: [], choices: [{ count: 1, pool: ["skills:slt"] }] }, "Expertise");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: expertise }] });
  f.actor.system.skills = { slt: { value: 1 } };
  // The mock apply never upgrades the value, emulating a native drop the pre-write check passed.
  const result = await f.advance({ choices: { expertise: ["skills:slt"] } });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.warnings.map(w => w.code), ["EXPERTISE_NOT_LANDED"]);
  assert.equal(result.warnings[0].value, "skills:slt");
});

test("additionalItems receipt entries report the created item's activity count", async () => {
  const f = fixture({ classFlows: [hp(1)] });
  f.docs.set("Compendium.packs.gear.Item.sword", { documentName: "Item", uuid: "Compendium.packs.gear.Item.sword", pack: "packs.gear", type: "weapon", name: "Longsword",
    system: { activities: { attack: {} } },
    toObject: () => ({ uuid: "Compendium.packs.gear.Item.sword", type: "weapon", name: "Longsword", system: { activities: { attack: {} } } }) });
  const result = await f.advance({ additionalItems: [{ uuid: "Compendium.packs.gear.Item.sword" }] });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.verification.createdItems.length, 1);
  assert.equal(result.verification.createdItems[0].name, "Longsword");
  assert.equal(result.verification.createdItems[0].activities, 1);
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
  assert.equal(result.verification.abilities.str.asi, 2);
  assert.equal(result.verification.abilities.dex.asi, 0);
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
  f.actor.system.details.race = { type: "race", name: "人类", flags: { dnd5e: { sourceId: "Compendium.packs.rules.Item.race" } } };
  const result = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race" });
  assert.equal(result.status, "completed");
  assert.deepEqual(applied(racial.applied), [[0, { type: "asi", assignments: { str: 0, dex: 0, con: 2, int: 0, wis: 1, cha: 0 } }]]);
  assert.equal(result.verification.abilities.con.race, 2);
  assert.equal(result.verification.abilities.wis.race, 1);
  assert.equal(result.verification.abilities.str.race, 0);
  assert.deepEqual(result.verification.race, { uuid: "Compendium.packs.rules.Item.race", name: "人类", size: null });
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

test("advance receipt carries the actor end-state blocks for reconciliation", async () => {
  const f = fixture({ classFlows: [hp(1)] });
  const result = await f.advance({});
  assert.equal(result.status, "completed");
  const v = result.verification;
  assert.deepEqual(v.abilities.str, { before: 8, after: 8, race: 0, asi: 0 });
  assert.equal(v.subclass, null);
  assert.equal(v.race, null);
  assert.deepEqual(v.movement, { walk: null });
  assert.deepEqual(v.languages, { applied: [] });
  assert.deepEqual(v.traits, { saves: [], skills: [], expertise: { skills: [], tools: [] }, armor: [], weapons: [], tools: [] });
  assert.deepEqual(v.proficiency, { bonus: null });
  assert.equal(v.spellcasting, null);
  assert.deepEqual(v.ac, { value: null, calc: null });
  assert.deepEqual(v.resources, []);
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

test("NPC advance receipt reports an empty preservation diff when innate traits survive", async () => {
  const f = fixture({ classFlows: [hp(1)], actorType: "npc" });
  f.actor.system.traits = { di: { value: ["poison"] }, size: "med" };
  const result = await f.advance({ targetLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verification.preservation, { changed: [] });
});

test("NPC preservation diff names the exact trait path that changed", async () => {
  const lang = new TraitAdvancement({ grants: [], choices: [{ count: 1, pool: ["languages:standard:common", "languages:standard:elvish"] }] }, "Languages");
  const f = fixture({ classFlows: [hp(1), { level: 1, advancement: lang }], actorType: "npc" });
  f.actor.system.traits = { di: { value: ["poison"] }, size: "med" };
  lang.apply = async (_level, data) => { f.actor.system.traits.languages = { value: data.chosen.map(key => key.split(":").pop()) }; };
  const result = await f.advance({ targetLevel: 1, choices: { languages: ["languages:standard:elvish"] } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verification.preservation.changed, [{ path: "traits.languages", before: null, after: { value: ["elvish"] } }]);
});

test("grantedItems entries carry the item identifier when the source has one", async () => {
  const f = fixture({ classFlows: [hp(1)], raceFlows: [hp(0)] });
  const raceDoc = f.docs.get("Compendium.packs.rules.Item.race"), base = raceDoc.toObject();
  f.docs.set("Compendium.packs.rules.Item.race", { ...raceDoc, toObject: () => ({ ...base, system: { identifier: "human" } }) });
  const result = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race" });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const raceGrant = result.verification.grantedItems.find(entry => entry.type === "race");
  assert.equal(raceGrant?.identifier, "human");
});

test("race language pools consume choices.languages with grants included", async () => {
  const trait = new TraitAdvancement({ grants: ["languages:standard:common"], choices: [
    { count: 1, pool: ["languages:standard:elvish", "languages:standard:dwarvish"] }] }, "Languages");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: trait }] });
  const result = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race", choices: { languages: ["languages:standard:elvish"] } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(applied(trait.applied), [[0, { chosen: ["languages:standard:common", "languages:standard:elvish"] }]]);
  assert.equal(result.warnings.length, 0);
});

test("wildcard trait pools expand and accept any matching concrete key", async () => {
  const trait = new TraitAdvancement({ grants: ["languages:standard:common"], choices: [
    { count: 1, pool: ["languages:*"] }] }, "Languages");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: trait }],
    traitExpansion: { languages: ["languages:standard:elvish", "languages:exotic:deep", "languages:cant"] } });
  const result = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race", choices: { languages: ["languages:exotic:deep"] } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(applied(trait.applied), [[0, { chosen: ["languages:standard:common", "languages:exotic:deep"] }]]);
  const rejected = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race", choices: { languages: ["skills:arc"] } });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.code, "ADVANCEMENT_NEEDS_CHOICE");
});

test("wildcard pools fall back to raw keys plus prefix matching when the trait registry is unavailable", async () => {
  const trait = new TraitAdvancement({ grants: [], choices: [{ count: 1, pool: ["languages:*"] }] }, "Languages");
  const f = fixture({ classFlows: [hp(1)], raceFlows: [{ level: 0, advancement: trait }], traitExpansion: null });
  const prefixed = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race", choices: { languages: ["languages:standard:elvish"] } });
  assert.equal(prefixed.status, "completed", JSON.stringify(prefixed));
  assert.deepEqual(applied(trait.applied), [[0, { chosen: ["languages:standard:elvish"] }]]);
  const rejected = await f.advance({ raceUuid: "Compendium.packs.rules.Item.race", choices: { languages: ["skills:arc"] } });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.code, "ADVANCEMENT_NEEDS_CHOICE");
});

test("creation advance fills spell slots and reports slotFill", async () => {
  const f = fixture({ classFlows: [hp(1)], actorSpells: {
    spell1: { value: 0, max: 4 }, spell2: { value: 2, max: 2 }, spell3: { value: 0, max: 0 }, pact: { value: 0, max: 1 } } });
  const result = await f.advance({ targetLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.verification.slotFill, { before: { spell1: 0, pact: 0 }, after: { spell1: 4, pact: 1 } });
  assert.equal(f.actor.system.spells.spell1.value, 4);
});

test("advance of an already-leveled actor never fills slots", async () => {
  const f = fixture({ classFlows: [hp(4)], actorLevel: 3, actorSpells: { spell1: { value: 0, max: 4 } } });
  const result = await f.advance({ targetLevel: 4 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.verification.slotFill, undefined);
  assert.equal(f.actor.system.spells.spell1.value, 0);
});

test("NPC actors advance with avg hit dice at every level and never fill hp", async () => {
  const hp1 = new HitPointsAdvancement({}, "Hit Points"), hp2 = new HitPointsAdvancement({}, "Hit Points");
  const f = fixture({ classFlows: [{ level: 1, advancement: hp1 }, { level: 2, advancement: hp2 }],
    actorType: "npc", actorHp: { value: 50, max: 58 } });
  const result = await f.advance({ targetLevel: 2 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(applied(hp1.applied), [[1, { 1: "avg" }]]);
  assert.deepEqual(applied(hp2.applied), [[2, { 2: "avg" }]]);
  assert.equal(result.verification.hpFill, undefined);
  assert.deepEqual(result.verification.hp, { value: 50, max: 58 });
});

test("pre-existing items are never rewritten or deleted by advancement commit", async () => {
  const axe = { _id: "w1", name: "Greataxe", type: "weapon", flags: {}, system: { damage: "1d12" } };
  const f = fixture({ classFlows: [hp(1)], actorType: "npc", actorItems: [axe] });
  const result = await f.advance({ targetLevel: 1 });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(f.itemUpdates, []);
  assert.deepEqual(f.itemDeletes, []);
  const f2 = fixture({ classFlows: [hp(1)], actorType: "npc", actorItems: [axe] });
  f2.preItems[0].flags = { dnd5e: {} };
  const result2 = await f2.advance({ targetLevel: 1 });
  assert.equal(result2.status, "completed", JSON.stringify(result2));
  assert.deepEqual(f2.itemUpdates, [], "empty flags materialized by the clone roundtrip must not trigger a rewrite");
  assert.deepEqual(f2.itemDeletes, []);
});
