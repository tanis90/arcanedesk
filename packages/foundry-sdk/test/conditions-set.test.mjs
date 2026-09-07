import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function fixture() {
  let writes = 0;
  const actor = { documentName: "Actor", uuid: "Scene.s.Token.t.Actor.a", name: "Synthetic", effects: [],
    statuses: new Set(), concentration: { effects: new Set() } };
  const effect = (key, extra = {}) => {
    const value = { uuid: `${actor.uuid}.ActiveEffect.${actor.effects.length}`, statuses: new Set([key]),
      changes: [], flags: {}, ...extra,
      async delete() { writes++; actor.effects = actor.effects.filter(e => e !== value); actor.statuses.delete(key); } };
    actor.effects.push(value);
    actor.statuses.add(key);
    return value;
  };
  actor.toggleStatusEffect = async key => { writes++; effect(key); };
  actor.endConcentration = async value => { assert.ok(actor.concentration.effects.has(value)); await value.delete(); };
  const token = { documentName: "Token", id: "t", uuid: "Scene.s.Token.t", name: "Token", actor };
  const scene = { id: "s", uuid: "Scene.s", tokens: new Map([["t", token]]) };
  const context = vm.createContext({ game: { ready: true, user: { isGM: true }, world: { id: "w" } },
    canvas: { scene }, location: { origin: "https://foundry.test" },
    CONFIG: { statusEffects: ["prone", "poisoned", "concentrating"].map(id => ({ id })) },
    fromUuid: async uuid => uuid === actor.uuid ? actor : uuid === token.uuid ? token : null });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  const defaults = { targets: [{ kind: "token", tokenUuid: token.uuid }], mode: "combat", world: { origin: "https://foundry.test", id: "w" } };
  return { actor, effect, scene, context, token, writes: () => writes,
    set: async (conditions, input = {}) => JSON.parse(JSON.stringify(await run("conditionsSet", { ...defaults, conditions, ...input }, {}))) };
}

test("explicit state is idempotent and linked duplicate Actors write once", async () => {
  const f = fixture();
  const conditions = [{ key: "prone", active: true }];
  assert.equal((await f.set(conditions, { targets: [1, 2].map(() => ({ kind: "token", tokenUuid: "Scene.s.Token.t" })) })).status, "completed");
  assert.equal(f.writes(), 1);
  assert.equal((await f.set(conditions)).steps[0].noop, true);
  assert.equal(f.writes(), 1);
  assert.equal((await f.set([{ key: "prone", active: false }])).status, "completed");
  assert.equal(f.writes(), 2);
});

test("world or focus changes during UUID resolution reject before any status write", async () => {
  for (const change of [f => { f.context.game.world.id = "other"; },
    f => { f.context.canvas.scene = { id: "other", uuid: "Scene.other", tokens: new Map() }; }]) {
    const f = fixture();
    f.context.fromUuid = async () => { change(f); return f.token; };
    const result = await f.set([{ key: "prone", active: true }]);
    assert.equal(result.status,"rejected");
    assert.ok(["WORLD_CHANGED","SOURCE_OUT_OF_FOCUS"].includes(result.code));
    assert.equal(f.writes(),0);
  }
});

test("a later manual marker gaining a source is preserved after an earlier condition completes", async () => {
  const f = fixture(), poison = f.effect("poisoned"), nativeSet = f.actor.toggleStatusEffect;
  f.actor.toggleStatusEffect = async key => { await nativeSet(key); poison.origin = "Actor.other.Item.spell"; };
  const result = await f.set([{ key: "prone", active: true },{ key: "poisoned", active: false }]);
  assert.equal(result.status,"partial"); assert.equal(result.retry,false);
  assert.equal(result.steps[0].state,"completed");
  assert.match(result.message,/CONDITION_CHANGED/);
  assert.equal(f.writes(),1); assert.ok(f.actor.effects.includes(poison));
});

test("world change after a native write yields unknown rather than confirming another world's state", async () => {
  const f = fixture(), nativeSet = f.actor.toggleStatusEffect;
  f.actor.toggleStatusEffect = async key => { await nativeSet(key); f.context.game.world.id = "other"; };
  const result = await f.set([{ key: "prone", active: true },{ key: "poisoned", active: true }]);
  assert.equal(result.status,"indeterminate"); assert.equal(result.retry,false);
  assert.equal(result.steps.length,1); assert.equal(result.steps[0].state,"unknown");
  assert.equal(result.steps[0].after,null);
  assert.match(result.message,/WORLD_CHANGED/); assert.equal(f.writes(),1);
});

test("preflight resolution errors are rejected, while prep explicit targets do not depend on combat ambiguity", async () => {
  const f = fixture();
  f.context.game.combats = [1,2].map(id => ({ id, scene: { id: "s" }, started: true }));
  assert.equal((await f.set([{ key: "prone", active: true }])).code,"AMBIGUOUS_COMBAT");
  assert.equal((await f.set([{ key: "prone", active: true }],{ mode: "prep" })).status,"completed");
  f.context.fromUuid = async () => { throw Error("lookup failed"); };
  const result = await f.set([{ key: "prone", active: false }],{ mode: "prep" });
  assert.equal(result.status,"rejected"); assert.equal(result.code,"SOURCE_RESOLUTION_FAILED");
  assert.equal(f.writes(),1);
});

test("source-managed and multi-status effects reject all targets before writes", async () => {
  const f = fixture();
  const managed = f.effect("poisoned", { origin: "Actor.a.Item.spell", changes: [{ key: "system.attributes.ac.bonus", value: -1 }] });
  const result = await f.set([{ key: "prone", active: true }, { key: "poisoned", active: false }]);
  assert.equal(result.code, "SOURCE_MANAGED");
  assert.equal(f.writes(), 0);
  assert.equal(f.actor.effects[0], managed);
});

test("system concentration uses the native ending API; manual concentration deletes only its marker", async () => {
  const f = fixture();
  const native = f.effect("concentrating", { origin: "Actor.a.Item.spell", flags: { dnd5e: { item: { id: "spell" } } } });
  f.actor.concentration.effects.add(native);
  assert.equal((await f.set([{ key: "concentrating", active: false }])).status, "completed");
  assert.equal(f.writes(), 1);
  f.effect("concentrating");
  assert.equal((await f.set([{ key: "concentrating", active: false }])).status, "completed");
  assert.equal(f.writes(), 2);
});

test("world changes, absent focus, conflicting conditions and unknown keys are zero-write", async () => {
  const f = fixture();
  assert.equal((await f.set([{ key: "prone", active: true }], { world: { origin: "other", id: "w" } })).code, "WORLD_CHANGED");
  assert.equal((await f.set([{ key: "unknown", active: true }])).code, "CONDITION_UNSUPPORTED");
  assert.equal((await f.set([{ key: "prone", active: true }, { key: "prone", active: false }])).code, "INPUT_INVALID");
  f.scene.tokens.clear();
  assert.equal((await f.set([{ key: "prone", active: true }])).code, "SOURCE_OUT_OF_FOCUS");
  assert.equal(f.writes(), 0);
  assert.equal((await f.set([{ key: "prone", active: true }], { mode: "prep" })).status, "completed");
});

test("native failure after dispatch is indeterminate and is never reported as rejected", async () => {
  const f = fixture();
  f.actor.toggleStatusEffect = async () => { throw Error("lost connection after write"); };
  const result = await f.set([{ key: "prone", active: true }]);
  assert.equal(result.status, "indeterminate");
  assert.equal(result.retry, false);
});

test("selection uses submitted UUIDs and play forbids actor-only selectors", async () => {
  const f = fixture();
  const conditions = [{ key: "prone", active: true }];
  assert.equal((await f.set(conditions, { targets: [{ kind: "selected" }] })).code, "INPUT_INVALID");
  assert.equal((await f.set(conditions, { targets: [{ kind: "actor", actorUuid: f.actor.uuid }] })).code, "INPUT_INVALID");
  assert.equal(f.writes(), 0);
  assert.equal((await f.set(conditions, { targets: [{ kind: "selected" }], selectedTokenUuids: ["Scene.s.Token.t"] })).status, "completed");
  assert.equal(f.writes(), 1);
});
