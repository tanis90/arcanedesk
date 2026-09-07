import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function fixture() {
  const actors = Array.from({ length: 105 }, (_, index) => ({ id: String(index).padStart(3, "0"),
    uuid: `Actor.${String(index).padStart(3, "0")}`, name: "Guard", type: index % 2 ? "character" : "npc", system: { private: "not returned" } }));
  const pack = { collection: "example.monsters", documentName: "Actor", metadata: { packageName: "example" },
    getIndex: async () => [{ _id: "wolf", name: "Wolf", type: "npc" }, { _id: "bear", name: "Bear", type: "npc" }] };
  const game = { ready: true, user: { isGM: true }, actors, scenes: [{ id: "s", uuid: "Scene.s", name: "Town" }], packs: new Map([[pack.collection, pack]]) };
  const run = vm.runInNewContext(`(${runtimeFunction})`, { game });
  return { run: async args => JSON.parse(JSON.stringify(await run("contentSearch", args, {}))) };
}

test("world search returns bounded exact references without actor contents; cursor retrieves the remainder", async () => {
  const f = fixture(), query = { scope: "world", documentType: "Actor", query: "guard", limit: 100 };
  const first = await f.run(query), second = await f.run({ ...query, cursor: first.nextCursor });
  assert.equal(first.entries.length, 100); assert.equal(second.entries.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(value => value.uuid)).size, 105);
  assert.equal(JSON.stringify(first).includes("not returned"), false);
  await assert.rejects(f.run({ ...query, query: "other", cursor: first.nextCursor }), /cursor/);
});

test("compendium search preserves package/pack/entry identity and filters type", async () => {
  const f = fixture();
  const result = await f.run({ scope: "compendium", documentType: "Actor", query: "Wolf", actorType: "npc", packIds: ["example.monsters"] });
  assert.deepEqual(result.entries[0], { uuid: "Compendium.example.monsters.Actor.wolf", id: "wolf", entryId: "wolf",
    name: "Wolf", type: "npc", documentType: "Actor", packId: "example.monsters", package: "example" });
  assert.equal(result.total, 1);
});

test("unsupported document combinations, mismatched packs and excessive limits reject", async () => {
  const f = fixture();
  await assert.rejects(f.run({ scope: "world", documentType: "Item", query: "" }), /INPUT_INVALID/);
  await assert.rejects(f.run({ scope: "compendium", documentType: "Scene", query: "" }), /INPUT_INVALID/);
  await assert.rejects(f.run({ scope: "compendium", documentType: "Item", query: "", packIds: ["example.monsters"] }), /PACK_NOT_FOUND/);
  await assert.rejects(f.run({ scope: "world", documentType: "Actor", query: "", limit: 101 }), /limit/);
});
