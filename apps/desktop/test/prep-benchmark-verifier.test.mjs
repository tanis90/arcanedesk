import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import createVerifier from "./fixtures/prep-benchmark-verifier.cjs";

function fixture() {
  const actors = new Map();
  const ids = ["a", "b", "c"];
  for (const id of ids) {
    const effects = new Map([["sentinel", { name: "Unrelated", disabled: false, statuses: new Set() }]]);
    effects.filter = predicate => [...effects.values()].filter(predicate);
    const statuses = new Set(id === "c" ? [] : ["prone", "poisoned"]);
    for (const status of statuses) effects.set(status, { name: status, statuses: new Set([status]) });
    actors.set(id, { effects, statuses });
  }
  const context = vm.createContext({ game: { actors, scenes: new Map([["scene", {}]]) } });
  const verify = createVerifier(code => vm.runInContext(code, context), "unused");
  const data = { actorIds: ids, sceneId: "scene", protectedEffects: ids.map(actorId => ({ actorId, effectId: "sentinel", name: "Unrelated" })) };
  return { actors, run: () => verify("conditions", data) };
}

test("benchmark accepts exact conditions with unrelated effects preserved", async () => {
  const f = fixture(); assert.equal((await f.run()).ok, true);
});
test("benchmark rejects deleting an unrelated effect even when final statuses match", async () => {
  const f = fixture(); f.actors.get("a").effects.delete("sentinel");
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.details.protectedIntact, false);
});
test("benchmark rejects duplicate status effects even when final statuses match", async () => {
  const f = fixture(); f.actors.get("a").effects.set("duplicate", { statuses: new Set(["prone"]) });
  const result = await f.run(); assert.equal(result.ok, false); assert.equal(result.details.uniqueStatuses, false);
});
test("benchmark rejects affecting the excluded third actor", async () => {
  const f = fixture(); f.actors.get("c").statuses.add("poisoned");
  assert.equal((await f.run()).ok, false);
});
