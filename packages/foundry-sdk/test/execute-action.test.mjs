import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function fixture(nativeUse = null) {
  let writes = 0;
  const item = { id: "spell", name: "Disguise", type: "spell", system: { method: "spell", level: 1, activities: [] } };
  const actor = { id: "a", uuid: "Actor.a", items: new Map([[item.id, item]]), effects: [], statuses: new Set(),
    system: { attributes: { hp: { value: 10, max: 10 } }, spells: { spell1: { value: 2, max: 3 } } },
    async update(change) { writes++; this.system.spells.spell1.value = change["system.spells.spell1.value"]; } };
  const token = { id: "t", uuid: "Scene.s.Token.t", name: "Caster", actor };
  const scene = { id: "s", uuid: "Scene.s", tokens: new Map([[token.id, token]]) };
  const game = { ready: true, user: { isGM: true }, world: { id: "w" }, combats: [], combat: null };
  const context = vm.createContext({ game, __testUse: nativeUse, canvas: { scene, tokens: { get: () => null, placeables: [] } },
    location: { origin: "https://foundry.test" }, performance,
    document: { createElement: () => ({ textContent: "" }) } });
  const source = nativeUse ? runtimeFunction.replace("async function performUseAction(useArgs = {}) {",
    "async function performUseAction(useArgs = {}) { return await g.__testUse(useArgs);") : runtimeFunction;
  const run = vm.runInContext(`(${source})`, context);
  const call = async (action, args = {}) => JSON.parse(JSON.stringify(await run(action, args, {})));
  const resolve = async () => {
    const snapshot = await call("staticContext");
    const definition = snapshot.combatants[0].actions[0];
    assert.ok(definition, "narrative spell must be discoverable without an Activity");
    return { world: snapshot.scope.world, contextRef: snapshot.contextRef, turn: snapshot.turn,
      resolvedActions: [{ actionRef: definition.actionRef, actionId: definition.id, sourceTokenUuid: token.uuid,
        actorUuid: actor.uuid, itemId: item.id, activityId: definition.activityId }] };
  };
  return { actor, item, token, scene, game, call, resolve, writes: () => writes };
}

test("a Scene spell without an Activity is discovered and consumes one slot outside combat", async () => {
  const f = fixture(), input = await f.resolve();
  const result = await f.call("executeAction", input);
  assert.equal(result.status, "completed");
  assert.equal(f.actor.system.spells.spell1.value, 1);
  assert.equal(f.writes(), 1);
  assert.equal(result.verification[0].before, 2);
  assert.equal(result.verification[0].after, 1);
  assert.equal((await f.call("playContext")).contextRef, input.contextRef);
  assert.equal(f.game.combat, null, "narrative use never creates combat");
});

test("stale context, missing Token, insufficient slots and advance outside combat are zero-write", async () => {
  const f = fixture(), input = await f.resolve();
  assert.equal((await f.call("executeAction", { ...input, advance: true })).code, "INPUT_INVALID");
  assert.equal((await f.call("executeAction", { ...input, world: { origin: "other", id: "w" } })).code, "WORLD_CHANGED");
  f.actor.system.spells.spell1.value = 0;
  assert.equal((await f.call("executeAction", input)).code, "RESOURCE_INSUFFICIENT");
  f.scene.tokens.clear();
  assert.equal((await f.call("executeAction", input)).code, "STATIC_CONTEXT_STALE");
  assert.equal(f.writes(), 0);
});

test("narrative cannot bypass a changed combat turn or cast for a non-current Token", async () => {
  const f = fixture();
  const combat = { id: "c", scene: f.scene, started: true, round: 1, turn: 0,
    combatants: [{ tokenId: "t", token: f.token }], combatant: { tokenId: "t", actorId: "a" } };
  f.game.combats = [combat]; f.game.combat = combat;
  const input = await f.resolve();
  combat.round = 2;
  assert.equal((await f.call("executeAction", input)).code, "TURN_CHANGED");
  combat.combatant = { tokenId: "other", actorId: "b" };
  const live = await f.call("playContext");
  assert.equal((await f.call("executeAction", { ...input, turn: live.turn })).code, "ACTOR_NOT_ACTIVE");
  assert.equal(f.writes(), 0);
});

test("a failed consumption never retries or invokes native spell use", async () => {
  const f = fixture(), input = await f.resolve();
  let updates = 0;
  f.actor.update = async () => { updates++; f.actor.system.spells.spell1.value--; throw Error("lost after update"); };
  const result = await f.call("executeAction", input);
  assert.equal(result.status, "indeterminate"); assert.equal(result.retry, false);
  assert.equal(updates, 1); assert.equal(f.actor.system.spells.spell1.value, 1);
});

test("reaction spells and unknown extra resource consumption are not offered as narrative-only actions", async () => {
  const f = fixture();
  f.item.system.activation = { type: "reaction" };
  assert.equal((await f.call("staticContext")).combatants[0].actions.length, 0);
  f.item.system.activation = { type: "action" }; f.item.system.uses = { max: 2 };
  assert.equal((await f.call("staticContext")).combatants[0].actions.length, 0);
  f.item.system.uses.max = "@prof";
  assert.equal((await f.call("staticContext")).combatants[0].actions.length, 0);
  f.item.system.uses.max = "0";
  assert.equal((await f.call("staticContext")).combatants[0].actions.length, 1);
  const known = await f.resolve();
  f.item.system.uses.max = "@prof";
  known.contextRef = (await f.call("playContext")).contextRef;
  assert.equal((await f.call("executeAction",known)).code,"CONSUMPTION_UNSUPPORTED");
  assert.equal(f.writes(),0);
});

test("noncombat attacks use the existing execution pipeline with an explicit source, without creating combat", async () => {
  const calls = [];
  const f = fixture(async args => { calls.push(args); args.factSink.started = true; return { status: "completed" }; });
  f.item.type = "weapon";
  const activity = { id: "attack", type: "attack", activation: { type: "action" },
    target: { affects: { type: "self" }, override: true }, range: { units: "self", override: true } };
  f.item.system.activities = [activity];
  const input = await f.resolve();
  assert.equal((await f.call("executeAction", input)).status, "completed");
  assert.equal(calls.length, 1); assert.equal(calls[0].sourceTokenId, "t");
  assert.equal(calls[0].activityId, "attack"); assert.equal(f.game.combat, null);
});

test("failed native execution never falls back to narrative consumption", async () => {
  let calls = 0;
  const f = fixture(async args => { calls++; args.factSink.started = true; throw Error("native timeout"); });
  f.item.system.activities = [{ id: "use", type: "utility", activation: { type: "action" },
    consumption: { spellSlot: true }, target: { affects: { type: "self" }, override: true }, range: { units: "self", override: true } }];
  const result = await f.call("executeAction", await f.resolve());
  assert.equal(result.status, "indeterminate"); assert.equal(calls, 1);
  assert.equal(f.writes(), 0); assert.equal(f.actor.system.spells.spell1.value, 2);
});

test("summon placement is rejected before native dispatch or consumption while auto pack is deferred", async () => {
  let nativeCalls = 0;
  const f = fixture(async () => { nativeCalls++; });
  const activity = { id: "use", type: "utility", activation: { type: "action" }, consumption: { spellSlot: true },
    target: { affects: { type: "self" }, override: true }, range: { units: "self", override: true } };
  f.item.system.activities = [activity];
  const input = await f.resolve();
  activity.type = "summon";
  input.contextRef = (await f.call("playContext")).contextRef;
  const result = await f.call("executeAction", input);
  assert.equal(result.code, "CAPABILITY_UNAVAILABLE"); assert.equal(f.writes(), 0); assert.equal(nativeCalls, 0);
});

test("narrative advance failure reports partial and never repeats consumption", async () => {
  const f = fixture();
  const combat = { id: "c", scene: f.scene, started: true, round: 1, turn: 0,
    combatants: [{ tokenId: "t", token: f.token }], combatant: { tokenId: "t", actorId: "a" },
    nextTurn: async () => { throw Error("advance failed"); } };
  f.game.combats = [combat]; f.game.combat = combat;
  const result = await f.call("executeAction", { ...await f.resolve(), advance: true });
  assert.equal(result.status, "partial"); assert.equal(result.retry, false); assert.equal(f.writes(), 1);
});

test("the first static manual includes existing buff riders; dynamic state tracks activation without rebuilding it", async () => {
  let nativeCalls = 0;
  const f = fixture(async args => { nativeCalls++; args.factSink.started = true; return { status: "completed" }; });
  f.item.type = "weapon";
  f.item.system.activities = [{ id: "attack", type: "attack", activation: { type: "action" },
    target: { affects: { type: "self" }, override: true }, range: { units: "self", override: true } }];
  const moduleId = "arcane-dnd5e-2014-automation";
  f.actor.items.set("buff", { id: "buff", name: "Existing buff", type: "spell", system: { method: "atwill", level: 1 },
    flags: { [moduleId]: { declaredActiveBuff: { identifier: "existing-buff", requiredArtifactId: "buff-artifact" } } } });
  const heavy = await f.call("staticContext"), input = await f.resolve();
  assert.deepEqual(heavy.combatants[0].actions[0].declaredRiders.map(rider => [rider.id,rider.requiresArtifactId]),[["existing-buff","buff-artifact"]]);
  const before = await f.call("playContext");
  assert.deepEqual(before.combatants[0].activeBuffRiderIds,[]);
  input.resolvedActions[0].input = { declaredRiders: [{ id: "existing-buff" }] };
  assert.equal((await f.call("executeAction",input)).status,"rejected"); assert.equal(nativeCalls,0);
  f.actor.effects.push({ disabled: false, flags: { [moduleId]: { compilerArtifactIds: ["buff-artifact"] } } });
  const after = await f.call("playContext");
  assert.equal(after.contextRef,heavy.contextRef);
  assert.deepEqual(after.combatants[0].activeBuffRiderIds,["existing-buff"]);
  assert.equal(JSON.stringify(after).includes("requiresArtifactId"),false);
  assert.equal((await f.call("executeAction",input)).status,"completed"); assert.equal(nativeCalls,1);
  f.actor.effects[0].disabled = true;
  const ended = await f.call("playContext");
  assert.equal(ended.contextRef,heavy.contextRef); assert.deepEqual(ended.combatants[0].activeBuffRiderIds,[]);
});
