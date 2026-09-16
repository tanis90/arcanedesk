import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";
import { SAFE_DIRECT_ACTIONS, DIRECT_ACTION_EFFECTS } from "../dist/contracts.js";

function fixture(count = 2) {
  const tokens = new Map(Array.from({ length: count }, (_, index) => {
    const id = `t${index}`;
    return [id, { id, uuid: `Scene.s.Token.${id}`, name: id, hidden: index % 2 === 0,
      actor: { id: `a${index}`, uuid: `Actor.a${index}`, items: new Map(), effects: [], statuses: new Set(),
        system: { attributes: { hp: { value: 8, max: 10 } }, spells: { spell1: { value: 2, max: 3 } } } } }];
  }));
  const scene = { id: "s", uuid: "Scene.s", tokens };
  const game = { ready: true, user: { isGM: true }, world: { id: "w" }, combats: [], combat: null };
  const context = vm.createContext({ game, canvas: { scene, tokens: { get: () => null, placeables: [] } },
    location: { origin: "http://foundry.test" } });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  return { game, scene, tokens, read: async action => JSON.parse(JSON.stringify(await run(action, {}, {}))) };
}

test("Scene reads include all 125 document Tokens, even hidden and unrendered Tokens", async () => {
  const f = fixture(125);
  f.tokens.get("t124").actor = null;
  const heavy = await f.read("staticContext");
  const light = await f.read("playContext");
  assert.equal(heavy.combatants.length, 125);
  assert.deepEqual(heavy.combatants.map(t => t.tokenUuid), light.combatants.map(t => t.tokenUuid));
  assert.equal(heavy.turn, null);
  assert.deepEqual(heavy.combatants[124].actions, []);
  assert.deepEqual(heavy.combatants[124].warnings, ["TOKEN_HAS_NO_ACTOR"]);
  assert.equal(heavy.contextRef, light.contextRef);
  assert.equal(light.combatants[0].resources.spell1, 2);
  assert.ok(light.combatants.every(t => !("static" in t) && !("actions" in t)));
});

test("only a started combat in the current Scene replaces Scene focus", async () => {
  const f = fixture();
  const combat = { id: "c", scene: { id: "s" }, started: false, round: 0, turn: 0,
    combatants: [{ tokenId: "t1", actorId: "a1", token: f.tokens.get("t1") }] };
  combat.combatant = combat.combatants[0];
  f.game.combats = [combat];
  f.game.combat = combat;
  assert.equal((await f.read("staticContext")).combatants.length, 2);
  combat.started = true;
  combat.round = 1;
  const heavy = await f.read("staticContext");
  const light = await f.read("playContext");
  assert.deepEqual(heavy.combatants.map(t => t.tokenId), ["t1"]);
  assert.equal(light.turn.tokenId, "t1");
  assert.equal(light.scope.combatId, "c");
  combat.scene.id = "elsewhere";
  assert.equal((await f.read("staticContext")).combatants.length, 2);
});

test("a sceneless combat takes focus, matching the v13 combat tracker", async () => {
  const f = fixture();
  const combat = { id: "c", scene: null, started: true, active: true, isActive: true, round: 1, turn: 0,
    combatants: [{ tokenId: "t1", actorId: "a1", token: f.tokens.get("t1") }] };
  combat.combatant = combat.combatants[0];
  f.game.combats = [combat];
  f.game.combat = combat;
  const light = await f.read("playContext");
  assert.equal(light.scope.combatId, "c");
  assert.equal(light.turn.tokenId, "t1");
  assert.deepEqual(light.combatants.map(t => t.tokenId), ["t1"]);
});

test("an inactive sceneless started combat still takes focus; two of them are ambiguous", async () => {
  const f = fixture();
  const make = id => ({ id, scene: null, started: true, active: false, isActive: false, round: 1, turn: 0,
    combatants: [{ tokenId: "t1", actorId: "a1", token: f.tokens.get("t1") }] });
  f.game.combats = [make("c")];
  const light = await f.read("playContext");
  assert.equal(light.scope.combatId, "c");
  f.game.combats = [make("c"), make("d")];
  await assert.rejects(f.read("playContext"), /AMBIGUOUS_COMBAT/);
});

test("resources, statuses and turns do not invalidate structure; Token and Item changes do", async () => {
  const f = fixture();
  const first = await f.read("staticContext");
  const actor = f.tokens.get("t0").actor;
  actor.system.attributes.hp.value = 1;
  actor.system.spells.spell1.value = 0;
  actor.statuses.add("prone");
  const changed = await f.read("playContext");
  assert.equal(changed.contextRef, first.contextRef);
  assert.equal(changed.combatants[0].hp.value, 1);
  actor.items.set("new", { id: "new", name: "New item", type: "loot", system: {} });
  assert.notEqual((await f.read("playContext")).contextRef, first.contextRef);
  actor.items.clear();
  f.tokens.delete("t1");
  assert.notEqual((await f.read("playContext")).contextRef, first.contextRef);
});

test("ambiguous combats reject and SDK defaults remain the original four actions", async () => {
  const f = fixture();
  f.game.combats = [1, 2].map(id => ({ id, scene: { id: "s" }, started: true }));
  await assert.rejects(f.read("playContext"), /AMBIGUOUS_COMBAT/);
  assert.deepEqual(SAFE_DIRECT_ACTIONS, ["worldInfo", "battleContext", "turnContext", "executeTurn"]);
  assert.equal(DIRECT_ACTION_EFFECTS.playContext, "read");
  assert.equal(DIRECT_ACTION_EFFECTS.staticContext, "read");
});

test("world status reports module versions and entry availability without claiming summon support", async () => {
  const f = fixture();
  f.game.system = { id: "dnd5e", title: "D&D 5e", version: "5.3.3" };
  f.game.version = "13.351";
  f.game.modules = new Map([["arcane-dnd5e-2014-automation", { active: true, version: "legacy" }]]);
  const result = await f.read("worldInfo");
  assert.equal(result.ready,true);
  assert.equal(result.moduleVersions["arcane-dnd5e-2014-automation"],"legacy");
  assert.equal(result.modules["arcane-dnd5e-2014-automation"],true);
  assert.equal(result.capabilities.nativeActionEntryAvailable,false);
  assert.equal(result.capabilities.narrativeSpellConsumption,true);
  assert.equal(result.capabilities.summonPlacement,false);
  assert.equal(result.capabilities.summonDependency,"AUTO-001");
});

test("runtime flags and spent uses preserve the context while supported contract changes invalidate it", async () => {
  const f = fixture(1), actor = f.tokens.get("t0").actor;
  const moduleId = "arcane-dnd5e-2014-automation";
  const activity = { id: "attack", name: "Strike", type: "attack", activation: { type: "action" },
    damage: { parts: [{ formula: "1d6" }] }, uses: { max: "3", spent: 0 }, flags: { [moduleId]: { interaction: { version: 1, input: "selected-targets" } } } };
  const item = { id: "weapon", name: "Sword", type: "weapon", flags: {}, system: { properties: new Set(["ver"]), uses: { max: "3", spent: 0 }, activities: new Map([[activity.id,activity]]) } };
  actor.items.set(item.id,item);
  const initial = (await f.read("playContext")).contextRef;
  item.flags.arcanedesk = { requestId: "operation" };
  item.flags[moduleId] = { latestReceipt: { operation: "one", completed: true } };
  activity.flags[moduleId].latestReceipt = { operation: "two" };
  item.system.uses.spent = 1; activity.uses.spent = 1;
  actor.statuses.add("prone"); actor.system.spells.spell1.value = 1;
  assert.equal((await f.read("playContext")).contextRef,initial);
  item.system.properties.add("thr");
  assert.notEqual((await f.read("playContext")).contextRef,initial);
  item.system.properties.delete("thr");
  for (const [target,key,value] of [[activity,"name","Heavy strike"], [activity,"damage",{ parts: [{ formula: "2d6" }] }],
    [activity.uses,"max","4"], [activity.flags[moduleId],"interaction",{ version: 1, input: "self" }]]) {
    const before = target[key]; target[key] = value;
    assert.notEqual((await f.read("playContext")).contextRef,initial,key);
    target[key] = before;
    assert.equal((await f.read("playContext")).contextRef,initial);
  }
});
