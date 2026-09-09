import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function fixture() {
  const world = { origin: "https://f.test", id: "w" }, documents = new Map();
  let writes = 0;
  const game = { ready: true, user: { isGM: true }, world: { id: "w" } };
  const add = (uuid, documentName, type) => {
    const data = { img: "old.png", src: "old.png", name: "Keep name", type, system: { keep: true } };
    const doc = { uuid, documentName, type, toObject: () => structuredClone(data),
      update: async patch => { writes++; Object.assign(data, patch); } };
    documents.set(uuid, doc); return doc;
  };
  const run = vm.runInNewContext(`(${runtimeFunction})`, { game, location: { origin: world.origin }, fromUuid: async uuid => documents.get(uuid) });
  return { add, game, writes: () => writes,
    apply: async values => JSON.parse(JSON.stringify(await run("imageApply", { world, image: { dataPath: "assets/new.png" }, ...values }, {}))) };
}

test("image asset paths are independent from document targets", async () => {
  const f = fixture(), result = await f.apply({});
  assert.equal(result.status, "completed"); assert.equal(result.dataPath, "assets/new.png"); assert.equal(f.writes(), 0);
});
test("world and embedded Items and Journal image pages use their native image fields", async () => {
  const f = fixture();
  for (const [uuid, kind, type, key] of [["Item.i", "Item", "weapon", "img"], ["Actor.a.Item.i", "Item", "spell", "img"], ["JournalEntry.j.JournalEntryPage.p", "JournalEntryPage", "image", "src"]]) {
    const doc = f.add(uuid, kind, type), result = await f.apply({ targetUuid: uuid });
    assert.equal(result.status, "completed"); assert.equal(doc.toObject()[key], "assets/new.png");
    assert.equal(doc.toObject().name, "Keep name"); assert.deepEqual(doc.toObject().system, { keep: true });
  }
});
test("unsupported targets and Actor-only sync reject before document writes", async () => {
  const f = fixture(); f.add("JournalEntry.j.JournalEntryPage.p", "JournalEntryPage", "text"); f.add("Item.i", "Item", "weapon");
  for (const params of [{ targetUuid: "Compendium.pack.Item.i" }, { targetUuid: "JournalEntry.j.JournalEntryPage.p" }, { targetUuid: "Item.i", syncPlacedTokens: true }, { syncPlacedTokens: true }]) {
    assert.equal((await f.apply(params)).status, "rejected");
  }
  assert.equal(f.writes(), 0);
});
test("ignored native changes remain uncertain and never automatically retry", async () => {
  const f = fixture(), doc = f.add("Item.i", "Item", "weapon"); let calls = 0;
  doc.update = async () => { calls++; };
  const result = await f.apply({ targetUuid: doc.uuid });
  assert.equal(result.status, "partial"); assert.equal(result.retry, false); assert.equal(calls, 1);
});
