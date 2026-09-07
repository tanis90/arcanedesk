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
  return { actor, effect, scene, writes: () => writes,
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
