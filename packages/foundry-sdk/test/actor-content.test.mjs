import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { runtimeFunction } from "../dist/runtime.js";

function fixture(globals = {}) {
  let writes = 0;
  const actors = new Map();
  const makeActor = (id, data = {}) => {
    const actor = { documentName: "Actor", id, uuid: `Actor.${id}`, name: "Guard", type: "npc", img: "guard.png", folder: null,
      system: { attributes: { hp: { value: 10, max: 12, temp: 0 }, ac: { calc: "flat", flat: 13, value: 13 } } },
      prototypeToken: { name: "Guard", width: 1, height: 1, disposition: -1, texture: { src: "guard.png" }, ring: { enabled: false, subject: { texture: "" } } }, items: new Map(), ...data,
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
    CONFIG: { Actor: { documentClass: { create: async data => { writes++; return makeActor(`new${actors.size}`, data); } } } }, ...globals });
  const run = vm.runInContext(`(${runtimeFunction})`, context);
  const call = async (action, args = {}) => JSON.parse(JSON.stringify(await run(action, args, {})));
  const identity = { world: { origin: "https://f.test", id: "w" }, requestId: "request" };
  return { actor, game, actors, sources, call, identity, writes: () => writes,
    read: include => call("actorRead", { actorUuid: actor.uuid, include }),
    edit: (readState, changes) => call("actorEdit", { ...identity, actorUuid: actor.uuid, readState, changes }) };
}

test("creation sets an explicit prototype name in one write and preserves source fields", async () => {
  const f = fixture(), source = f.sources.get("npc"), toObject = source.toObject;
  source.toObject = () => ({ ...toObject(), prototypeToken: { name: "Source", width: 2, height: 3, actorLink: false, texture: { src: "source.webp" } } });
  const result = await f.call("actorCreate", { ...f.identity, source: { kind: "compendium", packId: "test.pack", entryId: "npc" }, name: "New Actor", prototypeToken: { name: "New Token" } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const created = f.actors.get(result.steps[0].targets[0].split(".")[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(created.prototypeToken)), { name: "New Token", width: 2, height: 3, actorLink: false, texture: { src: "source.webp" } });
  assert.equal(f.writes(), 1);
});

test("blank creation accepts prototype name and omission keeps native behavior", async () => {
  for (const prototypeToken of [undefined, { name: "Custom Token" }]) {
    const f = fixture();
    const result = await f.call("actorCreate", { ...f.identity, source: { kind: "blank", actorType: "npc" }, name: "New Actor", ...(prototypeToken ? { prototypeToken } : {}) });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(f.actors.get(result.steps[0].targets[0].split(".")[1]).prototypeToken.name, prototypeToken?.name ?? "Guard");
    assert.equal(f.writes(), 1);
  }
});

test("invalid creation prototype names or extra fields reject before any write", async () => {
  for (const prototypeToken of [{}, { name: " " }, { name: 1 }, { name: "a".repeat(257) }, { name: "Token", width: 2 }]) {
    const f = fixture();
    const result = await f.call("actorCreate", { ...f.identity, source: { kind: "blank", actorType: "npc" }, name: "New Actor", prototypeToken });
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.equal(f.writes(), 0);
  }
});

test("native creation ignoring the prototype name reports partial without replay", async () => {
  let creates = 0;
  const f = fixture({ CONFIG: { Actor: { documentClass: { create: async data => { creates++; return { uuid: "Actor.created", name: data.name, prototypeToken: { name: "Wrong" } }; } } } } });
  const result = await f.call("actorCreate", { ...f.identity, source: { kind: "blank", actorType: "npc" }, name: "New Actor", prototypeToken: { name: "Expected" } });
  assert.equal(result.status, "partial"); assert.equal(result.retry, false); assert.equal(creates, 1);
  assert.equal(result.steps[0].state, "completed"); assert.equal(result.steps[1].state, "unknown");
});

test("Actor update checks only touched fields; unrelated HP changes do not block renaming", async () => {
  const f = fixture(), read = await f.read();
  f.actor.system.attributes.hp.value = 7;
  assert.equal((await f.edit(read.readState, { name: "Renamed" })).status, "completed");
  assert.equal(f.actor.name, "Renamed"); assert.equal(f.actor.system.attributes.hp.value, 7);
  assert.equal((await f.edit(read.readState, { name: "Again" })).code, "READ_REF_STALE");
  assert.equal(f.writes(), 1);
});

test("native update may expand and mutate its input without corrupting readback expectations", async () => {
  const f = fixture(), nativeUpdate = f.actor.update;
  f.actor.update = async function(patch) {
    await nativeUpdate.call(this, patch);
    // Foundry expands dotted keys in the caller's update object in place.
    patch.prototypeToken = { name: patch["prototypeToken.name"] };
    delete patch["prototypeToken.name"];
  };
  const read = await f.read(["prototypeToken"]);
  const result = await f.edit(read.readState, { name: "Renamed", prototypeToken: { name: "Token name" } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.steps.find(step => step.step === "prototypeToken.name").after, "Token name");
  assert.equal(f.writes(), 1);
});

test("Actor image uses Data paths, preserves disabled rings and checks relevant read fields", async () => {
  const f = fixture();
  const unread = await f.read();
  assert.equal((await f.edit(unread.readState, { image: { dataPath: "assets/new.webp" } })).code, "READ_REF_STALE");
  const read = await f.read(["prototypeToken"]);
  for (const dataPath of ["../new.png", "C:/new.png", "a\\b.png", "https://a/b.png", "a/%2e%2e/b.png", "a.svg"])
    assert.equal((await f.edit(read.readState, { image: { dataPath } })).code, "INPUT_INVALID", dataPath);
  assert.equal(f.writes(), 0);
  f.actor.system.attributes.hp.value = 2;
  const result = await f.edit(read.readState, { image: { dataPath: "assets/new.webp" } });
  assert.equal(result.status, "completed");
  assert.equal(f.actor.img, "assets/new.webp");
  assert.equal(f.actor.prototypeToken.texture.src, "assets/new.webp");
  assert.equal(f.actor.prototypeToken.ring.enabled, false);
  assert.equal(f.actor.prototypeToken.ring.subject.texture, "");
  assert.equal(f.actor.system.attributes.hp.value, 2);
});

function placedImages(f, failIndex = -1) {
  const tokens = [true, false, true].map((actorLink, index) => ({
    id: `t${index}`, uuid: `Scene.s${index}.Token.t${index}`, actorId: "a", actorLink,
    actor: { uuid: actorLink ? "Actor.a" : `Scene.s${index}.Token.t${index}.Actor.a` },
    name: `Independent ${index}`, x: index * 100, width: index + 1,
    texture: { src: "placed.png" }, ring: { enabled: index !== 2, subject: { texture: "old.png" } },
    async update(patch) {
      if (index === failIndex) throw new Error("network interrupted");
      for (const [key, value] of Object.entries(patch)) {
        const keys = key.split("."); let target = this;
        for (const part of keys.slice(0, -1)) target = target[part];
        target[keys.at(-1)] = value;
      }
    },
  }));
  f.game.scenes = tokens.map((token, index) => ({ uuid: `Scene.s${index}`, tokens: [token] }));
  return tokens;
}

test("placed image confirmation reads persisted fields while canvas texture still shows its prior image", async () => {
  const f = fixture();
  placedImages(f);
  const token = f.game.scenes[0].tokens[0];
  const originalUpdate = token.update;
  let storedTexture = { ...token.texture };
  token.toObject = () => ({ texture: storedTexture, ring: token.ring });
  token.update = async patch => {
    const visibleBefore = token.texture.src;
    await originalUpdate.call(token, patch);
    storedTexture = { ...token.texture };
    token.texture.src = visibleBefore;
  };
  const read = await f.read(["prototypeToken", "sceneTokens"]);
  const result = await f.edit(read.readState, { image: { dataPath: "assets/persisted.png", syncPlacedTokens: true } });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(storedTexture.src, "assets/persisted.png");
  assert.equal(token.texture.src, "placed.png");
});

test("Actor images synchronize linked and unlinked Tokens across Scenes without changing layout", async () => {
  const f = fixture(), tokens = placedImages(f);
  f.actor.prototypeToken.ring.enabled = true;
  const read = await f.read(["prototypeToken", "sceneTokens"]);
  tokens[0].x = 777; // A layout edit is unrelated to the image operation.
  const result = await f.edit(read.readState, { image: { dataPath: "assets/new.png", syncPlacedTokens: true } });
  assert.equal(result.status, "completed");
  assert.equal(f.actor.prototypeToken.ring.subject.texture, "assets/new.png");
  assert.equal(result.steps.filter(step => step.step === "token-image").length, 3);
  for (const [index, token] of tokens.entries()) {
    assert.equal(token.texture.src, "assets/new.png");
    assert.equal(token.ring.subject.texture, index === 2 ? "old.png" : "assets/new.png");
    assert.equal(token.ring.enabled, index !== 2);
    assert.equal(token.name, `Independent ${index}`);
    assert.equal(token.width, index + 1);
    assert.equal(token.x, index === 0 ? 777 : index * 100);
  }
});

test("image sync rejects stale membership/images before Actor write; interrupted sync reports each document", async () => {
  const f = fixture(), tokens = placedImages(f, 1);
  const read = await f.read(["prototypeToken", "sceneTokens"]);
  const changes = { image: { dataPath: "assets/new.png", syncPlacedTokens: true } };
  tokens[0].texture.src = "changed.png";
  assert.equal((await f.edit(read.readState, changes)).code, "READ_REF_STALE");
  assert.equal(f.writes(), 0);
  const fresh = await f.read(["prototypeToken", "sceneTokens"]);
  const result = await f.edit(fresh.readState, changes);
  assert.equal(result.status, "partial");
  assert.equal(result.retry, false);
  assert.deepEqual(result.steps.filter(step => step.step === "token-image").map(step => step.state), ["completed", "unknown", "not-started"]);
  assert.equal(f.actor.img, "assets/new.png");
  assert.equal(tokens[2].texture.src, "placed.png");
});

test("creation applies image after Actor creation and before initial grants", async () => {
  const f = fixture();
  const result = await f.call("actorCreate", { ...f.identity, source: { kind: "blank", actorType: "npc" },
    name: "Illustrated", image: { dataPath: "assets/npc.png" }, initialItems: [{ packId: "test.pack", entryId: "weapon" }] });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.steps.map(step => step.step), ["create-actor", "actor-image", "grant-items"]);
  assert.equal(f.actors.get("new1").img, "assets/npc.png");
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
  assert.equal(reread.items[0].quantity, 2); assert.equal(reread.items[0].equipped, true);
  assert.equal("quantity" in reread.readState.items[0], false);
  // Resource use does not invalidate the identity-only grant readRef.
  [...f.actor.items.values()][0].system.quantity = 1;
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

test("bounded image upload validates hash, reuses identical assets and never overwrites collisions", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=", "base64");
  const hash = createHash("sha256").update(bytes).digest("hex"), dataPath = `arcanedesk/assets/${hash}.png`;
  const stored = new Map(); let uploads = 0, directories = 0;
  const f = fixture({ crypto: webcrypto, atob, URL, File,
    location: { origin: "https://f.test", href: "https://f.test/game" },
    FilePicker: {
      createDirectory: async () => { directories++; },
      browse: async () => ({ files: [...stored.keys()] }),
      upload: async (_source, directory, file, options) => {
        assert.equal(directory, "arcanedesk/assets"); assert.equal(options.overwrite, false);
        uploads++; stored.set(`${directory}/${file.name}`, Buffer.from(await file.arrayBuffer()));
        return { path: `${directory}/${file.name}` };
      },
    },
    fetch: async url => new Response(stored.get(new URL(url).pathname.slice(1)) ?? "missing"),
  });
  const image = { dataPath, upload: { base64: bytes.toString("base64"), hash, extension: "png", mimeType: "image/png" } };
  const read = await f.read(["prototypeToken"]);
  const bad = await f.edit(read.readState, { image: { ...image, upload: { ...image.upload, base64: Buffer.from("wrong").toString("base64") } } });
  assert.equal(bad.status, "rejected"); assert.equal(f.writes(), 0); assert.equal(directories, 0);
  const result = await f.edit(read.readState, { image });
  assert.equal(result.status, "completed"); assert.equal(uploads, 1); assert.equal(f.actor.img, dataPath);
  assert.equal(result.steps[0].step, "upload-image"); assert.equal(result.steps[0].state, "completed");
  assert.equal(JSON.stringify(result).includes(image.upload.base64), false);
  const next = await f.read(["prototypeToken"]);
  const reused = await f.edit(next.readState, { image });
  assert.equal(reused.status, "completed"); assert.equal(reused.steps[0].reused, true); assert.equal(uploads, 1);
  stored.set(dataPath, Buffer.from("different content"));
  const beforeWrites = f.writes();
  const collision = await f.edit(next.readState, { image });
  assert.equal(collision.status, "indeterminate"); assert.match(collision.message, /IMAGE_CONTENT_COLLISION/);
  assert.equal(uploads, 1); assert.equal(f.writes(), beforeWrites);
  assert.equal(stored.get(dataPath).toString(), "different content");
});

test("a Token changed during Actor image update is left untouched and reported as not started", async () => {
  const f = fixture(), tokens = placedImages(f);
  const read = await f.read(["prototypeToken", "sceneTokens"]), nativeUpdate = f.actor.update.bind(f.actor);
  f.actor.update = async patch => { await nativeUpdate(patch); tokens[0].texture.src = "dm-edit.png"; };
  const result = await f.edit(read.readState, { image: { dataPath: "assets/new.png", syncPlacedTokens: true } });
  assert.equal(result.status, "partial"); assert.equal(tokens[0].texture.src, "dm-edit.png");
  assert.deepEqual(result.steps.filter(step => step.step === "token-image").map(step => step.state), ["not-started", "not-started", "not-started"]);
});

test("HTTP image hashing fallback agrees with SHA-256 across block and padding boundaries", async () => {
  const instrumented = runtimeFunction.replace('case "actorRead": { return await actorReadData(args); }', 'case "actorRead": { return await prepImageHash(Uint8Array.from(args.bytes)); }');
  assert.notEqual(instrumented, runtimeFunction);
  const context = vm.createContext({ game: { ready: true, user: { isGM: true } } });
  const run = vm.runInContext(`(${instrumented})`, context);
  for (const size of [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 1024, 10000]) {
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + 13) % 256));
    assert.equal(await run("actorRead", { bytes: [...bytes] }, {}), createHash("sha256").update(bytes).digest("hex"), `length=${size}`);
  }
});
