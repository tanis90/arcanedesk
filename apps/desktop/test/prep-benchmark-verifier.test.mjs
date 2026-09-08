import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import createVerifier from "./fixtures/prep-benchmark-verifier.cjs";

test("undecodable upload is a failed trial instead of aborting the suite", async () => {
  const actor = { id: "a", img: "bad.jpg", prototypeToken: { texture: { src: "bad.jpg" } } };
  const token = { actorId: "a", texture: { src: "bad.jpg" }, name: "test Token1", x: 200, y: 200, width: 1, height: 1 };
  const context = vm.createContext({
    game: { actors: new Map([["a", actor]]), scenes: new Map([["s", { tokens: [token] }]]) },
    location: { origin: "http://127.0.0.1:30000" }, URL,
    fetch: async () => ({ ok: true, blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }),
    crypto: { subtle: { digest: async () => new Uint8Array([1]).buffer } },
    createImageBitmap: async () => { throw new DOMException("The source image could not be decoded.", "InvalidStateError"); }
  });
  const verify = createVerifier(code => vm.runInContext(code, context), "01");
  const result = await verify("upload_image", { actorIds: ["a"], sceneId: "s", label: "test" });
  assert.equal(result.ok, false);
  assert.equal(result.details.loadable, false);
  assert.match(result.details.imageError, /InvalidStateError/);
});

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
