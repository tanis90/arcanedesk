import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPlayLedger,
  PLAY_LEDGER_SCHEMA_VERSION,
  PLAY_LEDGER_SETTING,
} from "../src/play-ledger.js";
import { normalizePlayWriteReceipt } from "../src/play-session.js";
import {
  createPrepTools,
  validateDataImagePath,
} from "../src/prep-session.js";

function initialLedgerState() {
  return { schemaVersion: PLAY_LEDGER_SCHEMA_VERSION, records: [] };
}

function fakeSettings(initial) {
  let state = initial;
  return {
    register: async () => {},
    get: (_moduleId, key) => (key === PLAY_LEDGER_SETTING ? state : undefined),
    set: async (_moduleId, key, value) => {
      state = value;
    },
  };
}

function prepGame({
  isGM = true,
  worldId = "testworld",
  ledgerState = initialLedgerState(),
} = {}) {
  return {
    user: { id: "gm", name: "Gamemaster", isGM },
    world: { id: worldId, title: "Test World" },
    settings: fakeSettings(ledgerState),
  };
}

function fakeRuntime(responses = {}) {
  const calls = [];
  const runtime = async (action, args, options) => {
    calls.push([action, args, options]);
    const handler = responses[action];
    return typeof handler === "function" ? handler(args, options) : handler ?? { status: "completed" };
  };
  runtime.calls = calls;
  return runtime;
}

function refCounter() {
  let n = 0;
  return () => `readref-${(n += 1)}`;
}

function makePrepTools({
  game = prepGame(),
  responses = {},
  newReadRef = refCounter(),
} = {}) {
  const runtime = fakeRuntime(responses);
  const ledger = createPlayLedger({ gameRef: game });
  const tools = createPrepTools({
    gameRef: game,
    locationRef: { origin: "http://localhost:30000" },
    runtime,
    ledger,
    newReadRef,
  });
  return { tools, runtime, ledger, game };
}

async function failCode(thunk) {
  try {
    await thunk();
  } catch (error) {
    return error.code;
  }
  assert.fail("expected the call to fail");
}

const ACTOR_READ_RESULT = {
  actorUuid: "Actor.abc",
  name: "Alverin",
  type: "character",
  hp: { value: 10, max: 20, temp: 0 },
  ac: 15,
  readState: {
    actorUuid: "Actor.abc",
    world: { origin: "http://localhost:30000", id: "testworld" },
    include: ["items"],
    fields: { "system.attributes.hp.value": 10 },
    items: [{ id: "i1", uuid: "Item.i1", name: "Longsword", type: "weapon", sourceUuid: null }],
  },
};

const SCENE_READ_RESULT = {
  sceneUuid: "Scene.xyz",
  name: "Old Road",
  active: true,
  width: 2000,
  height: 2000,
  placeables: {},
  nextCursors: {},
  readState: {
    sceneUuid: "Scene.xyz",
    world: { origin: "http://localhost:30000", id: "testworld" },
    include: ["tokens"],
    fields: { name: "Old Road" },
    tokens: [{ id: "t1", uuid: "Scene.xyz.Token.t1", fields: { x: 100 }, fingerprint: "f1" }],
  },
};

test("actorGet strips the SDK readState and issues an opaque session readRef", async () => {
  const { tools, runtime } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });
  const first = await tools.actorGet({ actorUuid: "Actor.abc", include: ["items"] });
  const second = await tools.actorGet({ actorUuid: "Actor.abc", include: ["items"] });

  assert.equal(first.readState, undefined);
  assert.match(first.readRef, /^readref-\d+$/);
  assert.notEqual(first.readRef, second.readRef);
  assert.equal(first.name, "Alverin");
  assert.deepEqual(runtime.calls[0][1], { actorUuid: "Actor.abc", include: ["items"] });
  // The module stores its own clone; the model never sees the snapshot.
  assert.equal(tools.stateForTesting().readRefs.get(first.readRef).actorUuid, "Actor.abc");
});

test("sceneGet issues readRefs the same way", async () => {
  const { tools } = makePrepTools({ responses: { sceneRead: SCENE_READ_RESULT } });
  const result = await tools.sceneGet({ sceneUuid: "Scene.xyz", include: ["tokens"] });
  assert.equal(result.readState, undefined);
  assert.equal(tools.stateForTesting().readRefs.get(result.readRef).sceneUuid, "Scene.xyz");
});

test("non-creating writes refuse to dispatch without a valid same-identity readRef", async () => {
  const { tools, runtime } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });

  assert.equal(
    await failCode(() => tools.actorUpdate({
      requestId: "req-1",
      actorUuid: "Actor.abc",
      readRef: "readref-404",
      changes: { name: "Renamed" },
    })),
    "READ_REF_INVALID",
  );
  // The update schema itself requires a readRef (schema-level rejection).
  assert.equal(
    await failCode(() => tools.actorUpdate({
      requestId: "req-2",
      actorUuid: "Actor.abc",
      changes: { name: "Renamed" },
    })),
    "INVALID_INPUT",
  );

  // A readRef for another document never authorizes this target.
  const scene = await tools.sceneGet({ sceneUuid: "Scene.xyz" });
  assert.equal(
    await failCode(() => tools.actorUpdate({
      requestId: "req-3",
      actorUuid: "Actor.abc",
      readRef: scene.readRef,
      changes: { name: "Renamed" },
    })),
    "READ_REF_INVALID",
  );
  assert.equal(runtime.calls.filter(([action]) => action === "actorEdit").length, 0);
});

test("actorUpdate re-attaches the stored readState with world and requestId", async () => {
  const { tools, runtime, ledger } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });
  const read = await tools.actorGet({ actorUuid: "Actor.abc" });

  const receipt = await tools.actorUpdate({
    requestId: "req-edit-1",
    actorUuid: "Actor.abc",
    readRef: read.readRef,
    changes: { name: "Alverin the Bold", dnd5e: { hp: { value: 12 } } },
  });

  assert.equal(receipt.result.status, "completed");
  const dispatch = runtime.calls.find(([action]) => action === "actorEdit");
  assert.ok(dispatch);
  const args = dispatch[1];
  assert.equal(args.requestId, "req-edit-1");
  assert.equal(args.world.id, "testworld");
  assert.equal(args.readState.actorUuid, "Actor.abc");
  assert.equal(args.readState, tools.stateForTesting().readRefs.get(read.readRef));
  assert.equal(args.readRef, undefined);
  // The ledger settled a prep action through the shared whitelist.
  assert.equal(ledger.readStateForTesting().records[0].action, "actorEdit");
});

test("identical retries replay from the ledger; reused requestIds with new input fail closed", async () => {
  const { tools, runtime } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });
  const read = await tools.actorGet({ actorUuid: "Actor.abc" });
  const base = {
    requestId: "req-once",
    actorUuid: "Actor.abc",
    readRef: read.readRef,
    changes: { name: "Renamed" },
  };

  const first = await tools.actorUpdate(base);
  const replay = await tools.actorUpdate(base);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(runtime.calls.filter(([action]) => action === "actorEdit").length, 1);

  assert.equal(
    await failCode(() => tools.actorUpdate({ ...base, changes: { name: "Different" } })),
    "IDEMPOTENCY_KEY_REUSE",
  );
});

test("runtime rejections settle as rejected receipts retryable with a new requestId", async () => {
  let stale = true;
  const { tools } = makePrepTools({
    responses: {
      actorRead: ACTOR_READ_RESULT,
      actorEdit: () => (stale
        ? { status: "rejected", code: "READ_REF_STALE", message: "READ_REF_STALE: reread affected field name" }
        : { status: "completed" }),
    },
  });
  const read = await tools.actorGet({ actorUuid: "Actor.abc" });
  const first = await tools.actorUpdate({
    requestId: "req-stale",
    actorUuid: "Actor.abc",
    readRef: read.readRef,
    changes: { name: "Renamed" },
  });
  assert.equal(first.result.status, "rejected");
  assert.equal(first.result.code, "READ_REF_STALE");

  // Re-read (fresh readRef), then retry the corrected write with a new key.
  const fresh = await tools.actorGet({ actorUuid: "Actor.abc" });
  stale = false;
  const second = await tools.actorUpdate({
    requestId: "req-retry",
    actorUuid: "Actor.abc",
    readRef: fresh.readRef,
    changes: { name: "Renamed" },
  });
  assert.equal(second.result.status, "completed");
});

test("actorCreate needs no readRef and dispatches through the ledger", async () => {
  const { tools, runtime, ledger } = makePrepTools();
  const receipt = await tools.actorCreate({
    requestId: "req-create-1",
    source: { kind: "blank", actorType: "character" },
    name: "New Hero",
    dnd5e: { abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 } },
  });
  assert.equal(receipt.result.status, "completed");
  const args = runtime.calls[0][1];
  assert.equal(args.action, undefined);
  assert.deepEqual(args.source, { kind: "blank", actorType: "character" });
  assert.equal(args.readState, undefined);
  assert.equal(ledger.readStateForTesting().records[0].action, "actorCreate");
});

test("actorGrantItems and actorAdvance validate and pass the readRef gate", async () => {
  const { tools, runtime } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });
  const read = await tools.actorGet({ actorUuid: "Actor.abc", include: ["items"] });

  await tools.actorGrantItems({
    requestId: "req-grant-1",
    actorUuid: "Actor.abc",
    readRef: read.readRef,
    items: [{ packId: "dnd5e.items", entryId: "longbow", expectedName: "Longbow", quantity: 1, equipped: true }],
  });
  let args = runtime.calls.find(([action]) => action === "actorGrantItems")[1];
  assert.equal(args.requestId, "req-grant-1");
  assert.equal(args.items[0].packId, "dnd5e.items");

  await tools.actorAdvance({
    requestId: "req-adv-1",
    actorUuid: "Actor.abc",
    readRef: read.readRef,
    classUuid: "Compendium.dnd5e.classes.Item.Fighter",
    targetLevel: 2,
    choices: { bySlot: { "asi-1": { abilityScore: { str: 2 } } }, hp: "avg" },
    additionalItems: [{ uuid: "Compendium.dnd5e.items.Item.Shield" }],
    fullSpellList: false,
  });
  args = runtime.calls.find(([action]) => action === "actorAdvance")[1];
  assert.equal(args.targetLevel, 2);
  assert.deepEqual(args.choices.bySlot["asi-1"], { abilityScore: { str: 2 } });
  assert.equal(args.readState.items.length, 1);
});

test("sceneApply update requires a scene-identity readRef; create does not", async () => {
  const { tools, runtime } = makePrepTools({ responses: { sceneRead: SCENE_READ_RESULT } });

  // The update shape itself requires a readRef (schema-level rejection).
  assert.equal(
    await failCode(() => tools.sceneApply({
      requestId: "req-scene-1",
      operation: "update",
      sceneUuid: "Scene.xyz",
      scene: { active: false },
    })),
    "INVALID_INPUT",
  );
  // A readRef that resolves to nothing or to another document never authorizes the write.
  assert.equal(
    await failCode(() => tools.sceneApply({
      requestId: "req-scene-1b",
      operation: "update",
      sceneUuid: "Scene.xyz",
      readRef: "readref-404",
      scene: { active: false },
    })),
    "READ_REF_INVALID",
  );

  await tools.sceneApply({
    requestId: "req-scene-create",
    operation: "create",
    scene: { name: "Ambush", grid: { size: 100, distance: 5, units: "ft" } },
    tokens: { create: [{ actorUuid: "Actor.abc", x: 500, y: 500 }] },
  });
  let args = runtime.calls.find(([action]) => action === "sceneApply")[1];
  assert.equal(args.operation, "create");
  assert.equal(args.scene.name, "Ambush");
  assert.equal(args.readState, undefined);

  const read = await tools.sceneGet({ sceneUuid: "Scene.xyz", include: ["tokens"] });
  await tools.sceneApply({
    requestId: "req-scene-2",
    operation: "update",
    sceneUuid: "Scene.xyz",
    readRef: read.readRef,
    tokens: { update: [{ tokenId: "t1", changes: { x: 200 } }], deleteIds: ["t2"] },
  });
  args = runtime.calls.filter(([action]) => action === "sceneApply").at(-1)[1];
  assert.equal(args.readState.sceneUuid, "Scene.xyz");
  assert.equal(args.tokens.update[0].changes.x, 200);
});

test("image rejects uploads and invalid Data paths before dispatch", async () => {
  const { tools, runtime } = makePrepTools();

  assert.equal(
    await failCode(() => tools.image({ requestId: "req-img-1", sourcePath: "C:/art/portrait.png" })),
    "CAPABILITY_UNAVAILABLE",
  );
  for (const dataPath of [
    "/absolute/portrait.png",
    "modules/../secrets/key.png",
    "uploads\\portrait.png",
    "uploads/portrait.bmp",
    "uploads/portrait.png?x=1",
    "",
  ]) {
    assert.equal(
      await failCode(() => tools.image({ requestId: "req-img-2", dataPath })),
      "INVALID_INPUT",
      `expected ${JSON.stringify(dataPath)} to fail`,
    );
  }
  assert.equal(runtime.calls.length, 0);

  const receipt = await tools.image({
    requestId: "req-img-3",
    dataPath: "modules/mymodule/art/portrait.PNG",
    targetUuid: "Actor.abc",
    syncPlacedTokens: true,
  });
  assert.equal(receipt.result.status, "completed");
  const args = runtime.calls[0][1];
  assert.deepEqual(args.image, { dataPath: "modules/mymodule/art/portrait.PNG" });
  assert.equal(args.targetUuid, "Actor.abc");
  assert.equal(args.syncPlacedTokens, true);
});

test("validateDataImagePath accepts extension case variants and nested Data paths", () => {
  assert.equal(validateDataImagePath("uploads/a/b/portrait.webp"), "uploads/a/b/portrait.webp");
  assert.equal(validateDataImagePath("icons.JPEG"), "icons.JPEG");
  assert.throws(() => validateDataImagePath("icons.svg"));
  assert.throws(() => validateDataImagePath("icons.png/"));
});

test("schema parity: input bounds mirror the Desktop foundry-tools definitions", async () => {
  const { tools } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });

  // Unknown fields and enum drift fail closed.
  assert.equal(await failCode(() => tools.contentSearch({ scope: "world", documentType: "actor", query: "" })), "INVALID_INPUT");
  assert.equal(await failCode(() => tools.compendiumBrowse({ scope: "compendium", type: "racecar" })), "INVALID_INPUT");
  assert.equal(await failCode(() => tools.advancementPlan({ actorUuid: "Actor.abc", classUuid: "c", characterLevel: 21 })), "INVALID_INPUT");
  assert.equal(await failCode(() => tools.actorGet({ actorUuid: "Actor.abc", include: ["items", "items"] })), "INVALID_INPUT");
  assert.equal(await failCode(() => tools.sceneGet({ sceneUuid: "Scene.xyz", include: ["rocks"] })), "INVALID_INPUT");
  assert.equal(await failCode(() => tools.actorCreate({ requestId: "r", source: { kind: "blank", actorType: "monster" }, name: "X" })), "INVALID_INPUT");

  // Grant list ceiling: 51 entries rejected at validation time.
  const manyGrants = Array.from({ length: 51 }, () => ({ uuid: "Compendium.dnd5e.items.Item.x" }));
  assert.equal(
    await failCode(() => tools.actorGrantItems({ requestId: "r", actorUuid: "Actor.abc", readRef: "nope", items: manyGrants })),
    "INVALID_INPUT",
  );

  // Ability and placement bounds.
  const read = await tools.actorGet({ actorUuid: "Actor.abc" });
  assert.equal(
    await failCode(() => tools.actorUpdate({
      requestId: "r", actorUuid: "Actor.abc", readRef: read.readRef,
      changes: { dnd5e: { abilities: { str: 25 } } },
    })),
    "INVALID_INPUT",
  );
  assert.equal(
    await failCode(() => tools.sceneApply({
      requestId: "r", operation: "create",
      scene: { name: "S" },
      tokens: { create: [{ actorUuid: "Actor.abc", x: -1, y: 0, disposition: 5 }] },
    })),
    "INVALID_INPUT",
  );
  assert.equal(
    await failCode(() => tools.actorAdvance({
      requestId: "r", actorUuid: "Actor.abc", readRef: read.readRef,
      classUuid: "c", targetLevel: 1,
      choices: { bySlot: { trait: [{}] } },
    })),
    "INVALID_INPUT",
  );
});

test("compendiumBrowse uuids mode excludes every query field", async () => {
  const { tools, runtime } = makePrepTools();
  assert.equal(
    await failCode(() => tools.compendiumBrowse({ scope: "compendium", uuids: ["Compendium.dnd5e.spells.Item.Fireball"], query: "fire" })),
    "INVALID_INPUT",
  );
  await tools.compendiumBrowse({ scope: "compendium", uuids: ["Compendium.dnd5e.spells.Item.Fireball"] });
  assert.equal(runtime.calls[0][0], "compendiumBrowse");
  assert.deepEqual(runtime.calls[0][1].uuids, ["Compendium.dnd5e.spells.Item.Fireball"]);
});

test("every tool requires a GM and a ready world for writes", async () => {
  const { tools } = makePrepTools({ responses: { actorRead: ACTOR_READ_RESULT } });
  await tools.actorGet({ actorUuid: "Actor.abc" });

  const playerGame = prepGame({ isGM: false });
  const player = makePrepTools({ game: playerGame });
  assert.equal(await failCode(() => player.tools.actorGet({ actorUuid: "Actor.abc" })), "GM_REQUIRED");
  assert.equal(await failCode(() => player.tools.actorCreate({ requestId: "r", source: { kind: "blank", actorType: "npc" }, name: "X" })), "GM_REQUIRED");
  assert.equal(await failCode(() => player.tools.contentSearch({ scope: "world", documentType: "Actor", query: "x" })), "GM_REQUIRED");

  const noWorld = makePrepTools({ game: prepGame({ worldId: "" }) });
  assert.equal(
    await failCode(() => noWorld.tools.actorCreate({ requestId: "r", source: { kind: "blank", actorType: "npc" }, name: "X" })),
    "WORLD_UNAVAILABLE",
  );
});

test("normalizePlayWriteReceipt maps upload-image targets to dataPaths", () => {
  const normalized = normalizePlayWriteReceipt({
    status: "completed",
    dataPath: "uploads/art.png",
    steps: [
      { step: "upload-image", targets: ["uploads/art.png"], state: "completed" },
      { step: "document-image", targets: ["Actor.abc"], state: "not-started" },
    ],
    verification: [{ dataPath: "uploads/art.png", targetUuid: "Actor.abc" }],
    warnings: [],
  }, { action: "imageApply" });

  const upload = normalized.steps[0];
  assert.deepEqual(upload.dataPaths, ["uploads/art.png"]);
  assert.deepEqual(upload.targets, []);
  const document = normalized.steps[1];
  assert.equal(document.state, "not_started");
  assert.deepEqual(document.targets, ["Actor.abc"]);
});

test("the shared ledger accepts every prep write action", () => {
  const game = prepGame();
  const ledger = createPlayLedger({ gameRef: game });
  for (const action of ["actorCreate", "actorEdit", "actorGrantItems", "actorAdvance", "sceneApply", "imageApply"]) {
    assert.doesNotThrow(() => {
      ledger.replay({ requestId: `probe-${action}`, action, fingerprint: "f" });
    }, action);
  }
  // Legacy play actions keep working through the same setting.
  assert.doesNotThrow(() => ledger.replay({ requestId: "probe-execute", action: "executeAction", fingerprint: "f" }));
});
