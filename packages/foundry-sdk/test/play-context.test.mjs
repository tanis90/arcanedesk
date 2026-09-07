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
