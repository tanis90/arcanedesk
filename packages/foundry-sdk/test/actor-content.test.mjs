import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function fixture() {
  let writes = 0;
  const actors = new Map();
  const makeActor = (id, data = {}) => {
    const actor = { documentName: "Actor", id, uuid: `Actor.${id}`, name: "Guard", type: "npc", img: "guard.png", folder: null,
      system: { attributes: { hp: { value: 10, max: 12, temp: 0 }, ac: { calc: "flat", flat: 13, value: 13 } } },
      prototypeToken: { name: "Guard", width: 1, height: 1, disposition: -1 }, items: new Map(), ...data,
      async update(patch) { writes++; for (const [key, value] of Object.entries(patch)) {
        const keys = key.split("."); let target = this; for (const part of keys.slice(0, -1)) target = target[part]; target[keys.at(-1)] = value;
      } },
      async createEmbeddedDocuments(_type, entries) { writes++; return entries.map((entry, index) => {
        const item = { ...entry, id: `item${this.items.size}`, uuid: `${this.uuid}.Item.item${this.items.size}` };
        this.items.set(item.id, item); return item;
      }); },
    };
    actors.set(id, actor); return actor;
  };
  const actor = makeActor("a");
  const source = (documentName, id, data) => ({ documentName, id, uuid: `Compendium.test.pack.${documentName}.${id}`,
    name: data.name, type: data.type, toObject: () => structuredClone({ _id: id, ...data }) });
  const sources = new Map([
    ["weapon", source("Item", "weapon", { name: "Sword", type: "weapon", system: { quantity: 1, equipped: false } })],
    ["npc", source("Actor", "npc", { name: "Source Guard", type: "npc", folder: "foreign-folder" })],
  ]);
  const game = { ready: true, user: { isGM: true }, world: { id: "w" }, actors,
    folders: new Map([["folder", { id: "folder", type: "Actor" }]]), scenes: [], packs: new Map([["test.pack", { getDocument: async id => sources.get(id) }]]) };
  const context = vm.createContext({ game, location: { origin: "https://f.test" },
    fromUuid: async uuid => [...actors.values()].find(value => value.uuid === uuid),
    CONFIG: { Actor: { documentClass: { create: async data => { writes++; return makeActor(`new${actors.size}`, data); } } } } });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  const call = async (action, args = {}) => JSON.parse(JSON.stringify(await run(action, args, {})));
  const identity = { world: { origin: "https://f.test", id: "w" }, requestId: "request" };
  return { actor, game, actors, sources, call, identity, writes: () => writes,
    read: include => call("actorRead", { actorUuid: actor.uuid, include }),
    edit: (readState, changes) => call("actorEdit", { ...identity, actorUuid: actor.uuid, readState, changes }) };
}

test("Actor update checks only touched fields; unrelated HP changes do not block renaming", async () => {
  const f = fixture(), read = await f.read();
  f.actor.system.attributes.hp.value = 7;
  assert.equal((await f.edit(read.readState, { name: "Renamed" })).status, "completed");
  assert.equal(f.actor.name, "Renamed"); assert.equal(f.actor.system.attributes.hp.value, 7);
  assert.equal((await f.edit(read.readState, { name: "Again" })).code, "READ_REF_STALE");
  assert.equal(f.writes(), 1);
});

test("unread prototype fields, arbitrary patches, invalid HP and derived AC modes reject before writes", async () => {
  const f = fixture(), read = await f.read();
  assert.equal((await f.edit(read.readState, { prototypeToken: { width: 2 } })).code, "READ_REF_STALE");
  assert.equal((await f.edit(read.readState, { "system.spells.spell1.value": 99 })).code, "INPUT_INVALID");
  assert.equal((await f.edit(read.readState, { dnd5e: { hp: { value: 13 } } })).code, "INPUT_INVALID");
  f.actor.system.attributes.ac.calc = "default";
  assert.equal((await f.edit(read.readState, { dnd5e: { ac: { flat: 20 } } })).code, "INPUT_INVALID");
  assert.equal(f.writes(), 0);
});

test("items projection is paginated and sceneTokens includes linked/unlinked Tokens across Scenes", async () => {
  const f = fixture();
  for (let i = 0; i < 35; i++) f.actor.items.set(String(i), { id: String(i), uuid: `Actor.a.Item.${i}`, name: "Loot", type: "loot", system: { secret: "omit" } });
  f.game.scenes = ["one", "two"].map((id, index) => ({ uuid: `Scene.${id}`, tokens: [{ id: "t", uuid: `Scene.${id}.Token.t`, actorId: "a", actorLink: !index, actor: { uuid: index ? "Synthetic" : "Actor.a" } }] }));
  const read = await f.read(["items", "sceneTokens", "prototypeToken"]);
  assert.equal(read.items.length, 30); assert.equal(read.sceneTokens.length, 2);
  assert.equal(read.prototypeToken.width, 1); assert.equal(JSON.stringify(read).includes("omit"), false);
  const next = await f.call("actorRead", { actorUuid: "Actor.a", include: ["items", "sceneTokens", "prototypeToken"], cursor: read.nextCursor });
  assert.equal(next.items.length, 5); assert.equal(next.nextCursor, null);
});

test("grant is one batch and existing sources are skipped instead of stacked", async () => {
  const f = fixture(), read = await f.read(["items"]);
  const params = { ...f.identity, actorUuid: "Actor.a", readState: read.readState, items: [{ packId: "test.pack", entryId: "weapon", quantity: 2, equipped: true }] };
  const result = await f.call("actorGrantItems", params);
  assert.equal(result.status, "completed"); assert.equal(f.actor.items.size, 1);
  assert.equal([...f.actor.items.values()][0].system.quantity, 2);
  const reread = await f.read(["items"]);
  const skipped = await f.call("actorGrantItems", { ...params, readState: reread.readState });
  assert.equal(skipped.status, "completed"); assert.equal(skipped.steps[0].skippedExisting.length, 1);
  assert.equal(f.writes(), 1);
});

test("a bad source is rejected before creating an Actor; names collide and successful creation preserves exact source", async () => {
  const f = fixture(), input = { ...f.identity, source: { kind: "compendium", packId: "test.pack", entryId: "npc" }, name: "New Guard" };
  const bad = await f.call("actorCreate", { ...input, initialItems: [{ packId: "test.pack", entryId: "npc" }] });
  assert.equal(bad.status, "rejected"); assert.equal(f.writes(), 0);
  assert.equal((await f.call("actorCreate", { ...input, name: "Guard" })).code, "NAME_COLLISION");
  const created = await f.call("actorCreate", input);
  assert.equal(created.status, "completed"); assert.equal(f.actors.size, 2);
  assert.equal(f.actors.get("new1").folder, null);
  assert.equal(f.actors.get("new1").flags.arcanedesk.sourceUuid, "Compendium.test.pack.Actor.npc");
  const recovered = await f.call("actorCreate", input);
  assert.equal(recovered.status, "partial"); assert.equal(f.writes(), 1);
});

test("initial item failure leaves the created Actor and reports partial without deleting or recreating it", async () => {
  const f = fixture();
  // Give newly created Actors a native hook which fails in the grant phase.
  const originalSet = f.actors.set.bind(f.actors);
  f.actors.set = (id, actor) => { if (id !== "a") actor.createEmbeddedDocuments = async () => { throw Error("grant failure"); }; return originalSet(id, actor); };
  const result = await f.call("actorCreate", { ...f.identity, source: { kind: "blank", actorType: "npc" }, name: "Partial",
    initialItems: [{ packId: "test.pack", entryId: "weapon" }] });
  assert.equal(result.status, "partial"); assert.equal(result.retry, false);
  assert.equal(result.steps[0].targets[0], "Actor.new1"); assert.equal(f.actors.size, 2);
});
