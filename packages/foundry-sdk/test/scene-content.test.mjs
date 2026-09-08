import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runtimeFunction } from "../dist/runtime.js";

function expand(input) {
  const result = {};
  for (const [key,value] of Object.entries(input)) {
    const parts = key.split("."); let target = result;
    for (const part of parts.slice(0,-1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  return result;
}
function patchObject(target, patch) {
  for (const [key,value] of Object.entries(patch)) {
    const parts = key.split("."); let cursor = target;
    for (const part of parts.slice(0,-1)) cursor = cursor[part] ??= {};
    cursor[parts.at(-1)] = value;
  }
}
function fixture({ reverseCreates = false, receipt = created => created } = {}) {
  const scenes = new Map(), events = []; let failure = null, serial = 0, validations = 0;
  class Token {
    constructor(data, { parent } = {}) {
      Object.assign(this, { name: "Guard", x: 0, y: 0, width: 1, height: 1, elevation: 0, hidden: false, disposition: -1, actorLink: true, flags: {} }, structuredClone(data));
      this.id = data._id ?? `t${serial++}`; this.parent = parent; this.uuid = `${parent?.uuid}.Token.${this.id}`;
    }
    toObject() { const { parent, uuid, id, ...data } = this; return structuredClone({ ...data, _id: id }); }
    clone(patch) { const data = this.toObject(); patchObject(data,patch); return new Token(data,{ parent: this.parent }); }
    validate({ changes } = {}) { validations++; if ((changes?.width ?? this.width) > 100) throw new Error("INPUT_INVALID: native Token width constraint"); return true; }
  }
  class Scene {
    constructor(data = {}) {
      Object.assign(this, { name: "Scene", width: 4000, height: 3000, grid: { type: 1, size: 100, distance: 5, units: "ft" }, background: { src: null }, active: false, flags: {} }, structuredClone(data));
      this.id = data._id ?? `s${serial++}`; this.uuid = `Scene.${this.id}`; this.documentName = "Scene";
      this.tokens = new Map((data.tokens ?? []).map(entry => { const token = new Token(entry,{ parent: this }); return [token.id,token]; }));
      for (const key of ["walls","lights","tiles","notes","sounds"]) this[key] = data[key] ?? [];
    }
    toObject() { return { _id: this.id, name: this.name, width: this.width, height: this.height, grid: structuredClone(this.grid), background: structuredClone(this.background), active: this.active, flags: structuredClone(this.flags), tokens: [...this.tokens.values()].map(token => token.toObject()) }; }
    clone(patch) { const data = this.toObject(); patchObject(data,patch); return new Scene(data); }
    validate({ changes } = {}) { validations++; if ((changes?.grid?.size ?? this.grid.size) < 50) throw new Error("INPUT_INVALID: native Scene grid constraint"); return true; }
    static async create(data) { events.push("create-scene"); if (failure === "create-scene") throw Error("connection lost"); const scene = new Scene(data); scenes.set(scene.id,scene); return scene; }
    async update(patch) { events.push("update-scene"); if (failure === "update-scene") throw Error("connection lost"); patchObject(this,patch); }
    async createEmbeddedDocuments(type, entries) {
      assert.equal(type,"Token"); events.push("create-tokens"); if (failure === "create-tokens") throw Error("connection lost");
      const created = entries.map(entry => { const token = new Token(entry,{ parent: this }); this.tokens.set(token.id,token); return token; });
      return receipt(reverseCreates ? created.reverse() : created);
    }
    async updateEmbeddedDocuments(type, entries) {
      assert.equal(type,"Token"); events.push("update-tokens"); if (failure === "update-tokens") throw Error("connection lost");
      for (const { _id, ...patch } of entries) patchObject(this.tokens.get(_id),patch);
    }
    async deleteEmbeddedDocuments(type, ids) { assert.equal(type,"Token"); events.push("delete-tokens"); for (const id of ids) this.tokens.delete(id); }
    async activate() { events.push("activate-scene"); if (failure === "activate-scene") throw Error("connection lost"); for (const scene of scenes.values()) scene.active = scene === this; }
  }
  const current = new Scene({ _id: "current", name: "Current", active: true }); scenes.set(current.id,current);
  const other = new Scene({ _id: "other", name: "Other", tokens: [{ _id: "one", actorId: "actor" }, { _id: "two", actorId: "actor" }] }); scenes.set(other.id,other);
  const actor = { documentName: "Actor", id: "actor", uuid: "Actor.actor", prototypeToken: { toObject: () => ({ name: "Prototype", actorLink: true, width: 2, height: 2, texture: { src: "actor.png" } }) } };
  actor.getTokenDocument = async placement => new Token({ ...actor.prototypeToken.toObject(), ...placement, actorId: actor.id,
    delta: { system: {}, items: [], effects: [], flags: {} } });
  const world = { origin: "https://f.test", id: "world" }, game = { ready: true, user: { isGM: true }, world: { id: "world" }, scenes };
  const run = vm.runInContext(`(${runtimeFunction})`, vm.createContext({ game, canvas: { scene: current }, location: { origin: world.origin },
    fromUuid: async uuid => uuid === actor.uuid ? actor : [...scenes.values()].find(scene => scene.uuid === uuid),
    CONFIG: { Scene: { documentClass: Scene }, Token: { documentClass: Token } }, CONST: { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } }, foundry: { utils: { expandObject: expand } } }));
  const call = async (action,args) => JSON.parse(JSON.stringify(await run(action,args,{})));
  return { call, actor, current, other, scenes, events, Token, world, game, validations: () => validations,
    fail: group => { failure = group; }, read: (include = ["tokens"]) => call("sceneRead",{ sceneUuid: other.uuid, include }),
    apply: args => call("sceneApply",{ world, requestId: "request", ...args }) };
}

test("batch creation receipt accepts reversed native return order without replay", async () => {
  const f = fixture({ reverseCreates: true });
  const result = await f.apply({ operation: "create", scene: { name: "Reversed batch" },
    tokens: { create: [{ actorUuid: f.actor.uuid, name: "A", x: 10, y: 20 }, { actorUuid: f.actor.uuid, name: "B", x: 30, y: 40 }] } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(f.events.filter(event => event === "create-tokens").length, 1);
  const scene = [...f.scenes.values()].find(value => value.name === "Reversed batch");
  assert.equal(scene.tokens.size, 2);
});

test("identical placements each require a distinct created document", async () => {
  const f = fixture({ reverseCreates: true });
  const placement = { actorUuid: f.actor.uuid, name: "Same", x: 10, y: 20 };
  const result = await f.apply({ operation: "create", scene: { name: "Identical batch" }, tokens: { create: [placement, placement] } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.steps.find(step => step.step === "create-tokens").targets.length, 2);
  assert.equal(f.events.filter(event => event === "create-tokens").length, 1);
});

for (const [name, receipt] of [
  ["missing document", created => created.slice(1)],
  ["duplicate returned identity", created => [created[0], created[0]]],
  ["changed placement", created => { created[0].x += 1; return created; }],
  ["wrong ownership", created => { created[0].flags.arcanedesk.requestId = "other"; return created; }],
  ["missing persisted document", created => { created[0].parent.tokens.delete(created[0].id); return created; }],
]) test(`creation receipt rejects ${name} without replay or activation`, async () => {
  const f = fixture({ receipt });
  const result = await f.apply({ operation: "create", scene: { name: "Uncertain batch", active: true },
    tokens: { create: [{ actorUuid: f.actor.uuid, name: "A", x: 10, y: 20 }, { actorUuid: f.actor.uuid, name: "B", x: 30, y: 40 }] } });
  assert.equal(result.status, "partial", JSON.stringify(result));
  assert.equal(result.retry, false);
  assert.equal(result.steps.find(step => step.step === "create-tokens").state, "unknown");
  assert.equal(f.events.filter(event => event === "create-tokens").length, 1);
  assert.equal(f.events.includes("activate-scene"), false);
});

test("explicit Scene read ignores the canvas, projects bounded collections, and binds cursors", async () => {
  const f = fixture();
  for (let index = 0; index < 105; index++) { const token = new f.Token({ _id: `extra${index}`, actorId: "actor" }, { parent: f.other }); f.other.tokens.set(token.id,token); }
  f.other.walls = [{ id: "wall", uuid: "Scene.other.Wall.wall", c: [1,2,3,4], door: 1, ds: 0, flags: { secret: "omit" } }];
  const first = await f.read(["tokens","walls"]);
  assert.equal(first.sceneUuid,"Scene.other"); assert.equal(first.placeables.tokens.length,50); assert.equal(first.placeables.walls.length,1);
  assert.equal("flags" in first.placeables.walls[0],false); assert.equal(first.nextCursors.walls,null);
  const second = await f.call("sceneRead",{ sceneUuid: f.other.uuid, include: ["tokens","walls"], cursor: first.nextCursors.tokens });
  assert.equal(second.placeables.tokens.length,50); assert.notEqual(second.placeables.tokens[0].id,first.placeables.tokens[0].id);
  await assert.rejects(f.call("sceneRead",{ sceneUuid: f.current.uuid, include: ["tokens","walls"], cursor: first.nextCursors.tokens }),/cursor mismatch/);
  assert.equal(f.events.length,0);
});

test("Scene create uses native validation, preserves prototype actorLink, batches Tokens and activates last", async () => {
  const f = fixture();
  const result = await f.apply({ operation: "create", scene: { name: "Encounter", grid: { type: 0, size: 150 }, background: { dataPath: "assets/map.webp" }, active: true },
    tokens: { create: [{ actorUuid: f.actor.uuid, x: 10, y: 20 }, { actorUuid: f.actor.uuid, x: 30, y: 40, actorLink: false }] } });
  assert.equal(result.status,"completed",JSON.stringify(result));
  assert.deepEqual(f.events,["create-scene","create-tokens","activate-scene"]);
  const scene = [...f.scenes.values()].find(value => value.name === "Encounter");
  assert.equal(scene.grid.type,0); assert.equal(scene.grid.size,150); assert.equal(scene.background.src,"assets/map.webp");
  assert.deepEqual([...scene.tokens.values()].map(token => token.actorLink),[true,false]);
  assert.equal([...scene.tokens.values()][0].flags.arcanedesk.requestId,"request");
  assert.equal(f.current.active,false); assert.equal(scene.active,true); assert.ok(f.validations() >= 3);
  const repeated = await f.apply({ operation: "create", scene: { name: "Encounter" } });
  assert.equal(repeated.code,"REQUEST_ALREADY_APPLIED"); assert.equal(f.scenes.size,3);
});

test("layout applies create/update/delete once per group to the explicit Scene, with local read checks", async () => {
  const f = fixture(), read = await f.read();
  f.other.tokens.get("one").hidden = true; // unrelated to x-only edit
  const result = await f.apply({ operation: "update", sceneUuid: f.other.uuid, readState: read.readState, scene: { name: "Edited" },
    tokens: { create: [{ actorUuid: f.actor.uuid, x: 10, y: 10 }], update: [{ tokenId: "one", changes: { x: 222 } }], deleteIds: ["two"] } });
  assert.equal(result.status,"completed",JSON.stringify(result));
  assert.deepEqual(f.events,["update-scene","create-tokens","update-tokens","delete-tokens"]);
  assert.equal(f.other.tokens.get("one").x,222); assert.equal(f.other.tokens.get("one").hidden,true);
  assert.equal(f.other.tokens.has("two"),false); assert.equal(f.current.name,"Current");
});

test("conflicts, unsupported fields, native validation and stale destructive reads reject before writes", async () => {
  const f = fixture(), read = await f.read();
  const base = { operation: "update", sceneUuid: f.other.uuid, readState: read.readState };
  for (const changes of [
    { tokens: { update: [{ tokenId: "one", changes: { x: 1 } }], deleteIds: ["one"] } },
    { scene: { walls: [] } }, { scene: { grid: { size: 10 } } },
    { tokens: { create: [{ actorUuid: f.actor.uuid, x: 1, y: 2, width: 101 }] } },
    { tokens: { create: Array(101).fill({ actorUuid: f.actor.uuid, x: 1, y: 2 }) } },
  ]) assert.equal((await f.apply({ ...base, ...changes })).status,"rejected");
  f.other.tokens.get("two").hidden = true;
  assert.equal((await f.apply({ ...base, tokens: { deleteIds: ["two"] } })).code,"READ_REF_STALE");
  assert.equal(f.events.length,0);
});

test("failure in a later group preserves completed identities and never activates or retries", async () => {
  const f = fixture(), read = await f.read(); f.fail("update-tokens");
  const result = await f.apply({ operation: "update", sceneUuid: f.other.uuid, readState: read.readState, scene: { name: "Edited", active: true },
    tokens: { create: [{ actorUuid: f.actor.uuid, x: 1, y: 2 }], update: [{ tokenId: "one", changes: { x: 4 } }], deleteIds: ["two"] } });
  assert.equal(result.status,"partial"); assert.equal(result.retry,false);
  assert.deepEqual(result.steps.map(step => [step.step,step.state]),[["update-scene","completed"],["create-tokens","completed"],["update-tokens","unknown"]]);
  assert.deepEqual(f.events,["update-scene","create-tokens","update-tokens"]);
  assert.equal(f.other.tokens.has("two"),true); assert.equal(f.current.active,true);
});
