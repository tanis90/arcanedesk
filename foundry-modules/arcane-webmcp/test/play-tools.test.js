import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPlayLedger,
  PLAY_LEDGER_SCHEMA_VERSION,
  PLAY_LEDGER_SETTING,
} from "../src/play-ledger.js";
import {
  CONDITION_ALIASES,
  createPlayTools,
  joinPlayContext,
  normalizePlayWriteReceipt,
} from "../src/play-session.js";

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

function playGame({
  isGM = true,
  worldId = "testworld",
  selected = [],
  ledgerState = initialLedgerState(),
} = {}) {
  return {
    user: { id: "gm", name: "Gamemaster", isGM },
    world: { id: worldId, title: "Test World" },
    settings: fakeSettings(ledgerState),
    canvas: { tokens: { controlled: selected } },
  };
}

function fakeRuntime(responses = {}) {
  const calls = [];
  const runtime = async (action, args, options) => {
    calls.push([action, args, options]);
    const handler = responses[action];
    return typeof handler === "function" ? handler(args) : handler ?? { status: "completed" };
  };
  runtime.calls = calls;
  return runtime;
}

async function failCode(thunk) {
  try {
    await thunk();
  } catch (error) {
    return error.code;
  }
  assert.fail("expected the call to fail");
}

function staticManual({ combatId = null, contextRef = "ctx-1" } = {}) {
  return {
    schema: "arcane.play.v1",
    contextRef,
    scope: {
      world: { origin: "http://localhost:30000", id: "testworld" },
      sceneUuid: "Scene.a",
      combatId,
    },
    combatants: [
      {
        tokenUuid: "Scene.a.Token.alverin",
        tokenId: "alverin",
        actorUuid: "Actor.1",
        actorId: "1",
        name: "Alverin",
        side: "party",
        static: { maxHp: 20, ac: 15, speed: 30, senses: [], traits: [] },
        actions: [
          {
            id: "act-firebolt",
            actionRef: "alverin:fire-bolt",
            itemId: "Item.fb",
            activityId: null,
            name: "Fire Bolt",
            kind: "attack",
            summary: "",
            target: { kind: "creature", count: 1, range: 120 },
            input: {},
            resolution: "auto",
          },
          {
            id: "act-heal",
            actionRef: "alverin:cure-wounds",
            itemId: "Item.cw",
            activityId: null,
            name: "Cure Wounds",
            kind: "spell",
            summary: "",
            target: { kind: "creature", count: 1, range: 60 },
            input: {},
            resolution: "narrative",
            resource: { kind: "slot", key: "spell1" },
          },
          {
            id: "act-litany",
            actionRef: "alverin:litany",
            itemId: "Item.li",
            activityId: null,
            name: "Litany",
            kind: "spell",
            summary: "",
            target: { kind: "creature", count: 1, range: 60 },
            input: {},
            resolution: "narrative",
            resource: { kind: "none" },
          },
        ],
      },
    ],
  };
}

function playData({
  contextRef = "ctx-1",
  available = ["act-firebolt"],
  resources = { spell1: 0 },
  combatId = "combat-1",
} = {}) {
  return {
    schema: "arcane.play.v1",
    contextRef,
    scope: {
      world: { origin: "http://localhost:30000", id: "testworld" },
      sceneUuid: "Scene.a",
      combatId,
    },
    turn: { round: 1, index: 0, tokenId: "alverin", actorId: "1" },
    combatants: [
      {
        tokenUuid: "Scene.a.Token.alverin",
        tokenId: "alverin",
        actorUuid: "Actor.1",
        actorId: "1",
        name: "Alverin",
        hp: { value: 15, temp: 0 },
        resources,
        conditions: [],
        concentration: null,
        visible: true,
        defeated: false,
        availableActionIds: available,
        activeBuffRiderIds: [],
      },
    ],
  };
}

function createTools({ game = playGame(), runtime, ledger } = {}) {
  const sharedLedger = ledger ?? createPlayLedger({ gameRef: game });
  const tools = createPlayTools({
    gameRef: game,
    locationRef: { origin: "http://localhost:30000", href: "http://localhost:30000/game" },
    canvasRef: game.canvas,
    runtime,
    ledger: sharedLedger,
  });
  return { tools, ledger: sharedLedger };
}

test("condition alias table stays byte-identical to the Desktop host", () => {
  assert.deepEqual(CONDITION_ALIASES, {
    倒地: "prone",
    中毒: "poisoned",
    失明: "blinded",
    魅惑: "charmed",
    耳聋: "deafened",
    恐慌: "frightened",
    恐惧: "frightened",
    擒抱: "grappled",
    失能: "incapacitated",
    隐形: "invisible",
    麻痹: "paralyzed",
    石化: "petrified",
    束缚: "restrained",
    震慑: "stunned",
    昏迷: "unconscious",
    专注: "concentrating",
    concentration: "concentrating",
  });
});

test("joinPlayContext matches the Desktop readPlay join", () => {
  const manual = staticManual();
  const data = playData({ available: ["act-firebolt", "act-heal", "act-litany"] });
  const joined = joinPlayContext(data, manual);

  assert.equal(joined.staticContextValid, true);
  const alverin = joined.combatants[0];
  // Auto action available; narrative with an exhausted slot filtered; narrative
  // with no resource kept.
  assert.deepEqual(alverin.availableActionIds, [
    "alverin:fire-bolt",
    "alverin:litany",
  ]);

  const funded = joinPlayContext(
    playData({ available: ["act-firebolt"], resources: { spell1: 2 } }),
    manual,
  );
  assert.deepEqual(funded.combatants[0].availableActionIds, [
    "alverin:fire-bolt",
    "alverin:cure-wounds",
    "alverin:litany",
  ]);

  const stale = joinPlayContext(playData({ contextRef: "ctx-other" }), manual);
  assert.equal(stale.staticContextValid, false);
  assert.deepEqual(stale.combatants[0].availableActionIds, []);

  const empty = joinPlayContext(playData(), null);
  assert.equal(empty.staticContextValid, false);
  assert.deepEqual(empty.combatants[0].availableActionIds, []);
});

test("normalizePlayWriteReceipt ports the Desktop executeAction branch", () => {
  const completed = normalizePlayWriteReceipt(
    { status: "completed" },
    { action: "executeAction", args: { resolvedActions: [{ sourceTokenUuid: "Scene.a.Token.alverin" }] } },
  );
  assert.equal(completed.steps.length, 1);
  assert.equal(completed.steps[0].step, "execute-action");
  assert.equal(completed.steps[0].state, "completed");
  assert.deepEqual(completed.steps[0].targets, ["Scene.a.Token.alverin"]);
  assert.deepEqual(completed.verification, [{ kind: "native-execution", confirmed: true }]);

  const rejected = normalizePlayWriteReceipt({ status: "rejected", code: "BATTLE_NOT_ACTIVE" }, {});
  assert.equal(rejected.message, "BATTLE_NOT_ACTIVE");

  const partial = normalizePlayWriteReceipt({ status: "partial" }, { action: "conditionsSet", args: {} });
  assert.equal(partial.retry, false);
});

test("play ledger journals, settles, and replays idempotently", async () => {
  const game = playGame();
  const ledger = createPlayLedger({ gameRef: game });
  const first = await ledger.execute({
    requestId: "op-1",
    worldId: "testworld",
    action: "conditionsSet",
    fingerprint: "fp-1",
    run: async () => ({ status: "completed", steps: [] }),
  });
  assert.equal(first.replayed, false);
  assert.equal(first.result.status, "completed");

  const replayed = ledger.replay({ requestId: "op-1", action: "conditionsSet", fingerprint: "fp-1" });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.result.status, "completed");

  assert.equal(
    await failCode(() => ledger.replay({ requestId: "op-1", action: "conditionsSet", fingerprint: "fp-2" })),
    "IDEMPOTENCY_KEY_REUSE",
  );

  assert.equal(ledger.lookup("op-1").status, "completed");
  assert.equal(ledger.lookup("missing"), null);
});

test("play ledger answers started receipts as non-replayable interruptions", () => {
  const game = playGame({
    ledgerState: {
      schemaVersion: PLAY_LEDGER_SCHEMA_VERSION,
      records: [{
        requestId: "op-stuck",
        fingerprint: "fp",
        worldId: "testworld",
        action: "executeAction",
        status: "started",
        startedAt: "2026-09-21T00:00:00.000Z",
        settledAt: null,
        result: null,
      }],
    },
  });
  const ledger = createPlayLedger({ gameRef: game });
  const replayed = ledger.replay({ requestId: "op-stuck", action: "executeAction", fingerprint: "fp" });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.result.status, "indeterminate");
  assert.equal(replayed.result.retry, false);
  assert.equal(ledger.lookup("op-stuck").status, "indeterminate");
});

test("play ledger evicts the oldest settled record when full", async () => {
  const game = playGame();
  const ledger = createPlayLedger({ gameRef: game });
  for (let index = 0; index < 21; index += 1) {
    await ledger.execute({
      requestId: `op-${index}`,
      worldId: "testworld",
      action: "conditionsSet",
      fingerprint: `fp-${index}`,
      run: async () => ({ status: "completed" }),
    });
  }
  const state = ledger.readStateForTesting();
  assert.equal(state.records.length, 20);
  assert.equal(ledger.lookup("op-0"), null);
  assert.equal(ledger.lookup("op-20").status, "completed");
});

test("play ledger rejects corrupted stored state", () => {
  const ledger = createPlayLedger({
    gameRef: playGame({ ledgerState: { schemaVersion: 99, records: [] } }),
  });
  assert.throws(() => ledger.lookup("anything"), /INVALID_PLAY_LEDGER/);
});

test("staticContext caches the manual and clears turn evidence", async () => {
  const runtime = fakeRuntime({
    staticContext: staticManual({ combatId: "combat-1" }),
    playContext: playData(),
  });
  const { tools } = createTools({ runtime });

  await tools.staticContext();
  await tools.playContext({ view: "turn" });
  assert.ok(tools.stateForTesting().turnSnapshot);

  await tools.staticContext();
  assert.equal(tools.stateForTesting().turnSnapshot, null);
  assert.equal(runtime.calls.at(-1)[0], "staticContext");
});

test("playContext stores turn evidence only for view=turn", async () => {
  const runtime = fakeRuntime({ playContext: playData() });
  const { tools } = createTools({ runtime });

  await tools.playContext({});
  assert.equal(tools.stateForTesting().turnSnapshot, null);

  const joined = await tools.playContext({ view: "turn" });
  assert.ok(tools.stateForTesting().turnSnapshot);
  assert.equal(joined.staticContextValid, false);
  assert.deepEqual(joined.combatants[0].availableActionIds, []);
});

test("playContext resolves stored operations and unknown refs", async () => {
  const game = playGame();
  const ledger = createPlayLedger({ gameRef: game });
  await ledger.execute({
    requestId: "op-9",
    worldId: "testworld",
    action: "conditionsSet",
    fingerprint: "fp",
    run: async () => ({ status: "completed", steps: [] }),
  });
  const { tools } = createTools({ game, runtime: fakeRuntime(), ledger });

  const found = await tools.playContext({ view: "operation", operationRef: "op-9" });
  assert.equal(found.status, "completed");
  const missing = await tools.playContext({ view: "operation", operationRef: "nope" });
  assert.deepEqual(missing, {
    status: "rejected",
    code: "OPERATION_NOT_FOUND",
    message: "Unknown play operation in this world",
  });
  assert.equal(
    await failCode(() => tools.playContext({ operationRef: "op-9" })),
    "INVALID_INPUT",
  );
});

test("executeAction enforces the full guard chain in order", async () => {
  const noGm = createTools({ game: playGame({ isGM: false }), runtime: fakeRuntime() });
  assert.equal(
    await failCode(() => noGm.tools.executeAction({ requestId: "r1", actionRef: "alverin:fire-bolt" })),
    "GM_REQUIRED",
  );

  const runtime = fakeRuntime({
    staticContext: staticManual({ combatId: "combat-1" }),
    playContext: playData(),
  });
  const { tools } = createTools({ runtime });

  assert.equal(
    await failCode(() => tools.executeAction({ requestId: "r1", actionRef: "alverin:fire-bolt", surprise: true })),
    "INVALID_INPUT",
  );
  assert.equal(
    await failCode(() => tools.executeAction({ requestId: "r1", actionRef: "alverin:fire-bolt" })),
    "STATIC_CONTEXT_REQUIRED",
  );

  await tools.staticContext();
  assert.equal(
    await failCode(() => tools.executeAction({ requestId: "r1", actionRef: "ghost:action" })),
    "ACTION_REFERENCE_UNKNOWN",
  );
  assert.equal(
    await failCode(() => tools.executeAction({ requestId: "r1", actionRef: "alverin:fire-bolt" })),
    "TURN_CONTEXT_REQUIRED",
  );

  await tools.playContext({ view: "turn" });
  const receipt = await tools.executeAction({
    requestId: "r1",
    actionRef: "alverin:fire-bolt",
    targetTokenUuids: ["Scene.a.Token.goblin"],
    input: { attackRollMode: "advantage", spellLevel: 2 },
  });

  assert.equal(receipt.replayed, false);
  assert.equal(receipt.result.status, "completed");
  const dispatch = runtime.calls.find(([action]) => action === "executeAction");
  assert.deepEqual(dispatch[2], { requireGM: true });
  assert.equal(dispatch[1].world.id, "testworld");
  assert.equal(dispatch[1].world.origin, "http://localhost:30000");
  assert.equal(dispatch[1].contextRef, "ctx-1");
  assert.deepEqual(dispatch[1].turn, { round: 1, index: 0, tokenId: "alverin", actorId: "1" });
  assert.equal(dispatch[1].resolution, "auto");
  assert.equal(dispatch[1].advance, false);
  assert.deepEqual(dispatch[1].resolvedActions, [{
    actionRef: "alverin:fire-bolt",
    actionId: "act-firebolt",
    sourceTokenUuid: "Scene.a.Token.alverin",
    actorUuid: "Actor.1",
    itemId: "Item.fb",
    activityId: null,
    targetTokenUuids: ["Scene.a.Token.goblin"],
    input: { attackRollMode: "advantage", spellLevel: 2 },
  }]);

  // Replaying the same requestId with identical input never re-dispatches.
  const replayed = await tools.executeAction({
    requestId: "r1",
    actionRef: "alverin:fire-bolt",
    targetTokenUuids: ["Scene.a.Token.goblin"],
    input: { attackRollMode: "advantage", spellLevel: 2 },
  });
  assert.equal(replayed.replayed, true);
  assert.equal(runtime.calls.filter(([action]) => action === "executeAction").length, 1);

  assert.equal(
    await failCode(() => tools.executeAction({ requestId: "r1", actionRef: "alverin:litany" })),
    "IDEMPOTENCY_KEY_REUSE",
  );
});

test("every combat execution invalidates the turn read, including failed ones", async () => {
  const runtime = fakeRuntime({
    staticContext: staticManual({ combatId: "combat-1" }),
    playContext: playData(),
    executeAction: () => ({ status: "rejected", code: "ACTION_BLOCKED" }),
  });
  const { tools } = createTools({ runtime });

  await tools.staticContext();
  await tools.playContext({ view: "turn" });
  const rejected = await tools.executeAction({ requestId: "r1", actionRef: "alverin:fire-bolt" });
  assert.equal(rejected.result.status, "rejected");

  assert.equal(
    await failCode(() => tools.executeAction({ requestId: "r2", actionRef: "alverin:fire-bolt" })),
    "TURN_CONTEXT_REQUIRED",
  );

  await tools.playContext({ view: "turn" });
  const second = await tools.executeAction({ requestId: "r2", actionRef: "alverin:fire-bolt" });
  assert.equal(second.result.status, "rejected");
});

test("action sequences build one resolvedActions list; actionRef plus actions is rejected", async () => {
  const runtime = fakeRuntime({
    staticContext: staticManual(),
    playContext: playData({ combatId: null }),
  });
  const { tools } = createTools({ runtime });
  await tools.staticContext();

  const receipt = await tools.executeAction({
    requestId: "r-seq",
    actions: [
      { actionRef: "alverin:fire-bolt", targetTokenUuids: ["Scene.a.Token.goblin"] },
      { actionRef: "alverin:litany", input: { spellLevel: 1 } },
    ],
    resolution: "narrative",
    advance: true,
  });
  assert.equal(receipt.result.status, "completed");
  const dispatch = runtime.calls.find(([action]) => action === "executeAction");
  assert.equal(dispatch[1].resolvedActions.length, 2);
  assert.equal(dispatch[1].resolution, "narrative");
  assert.equal(dispatch[1].advance, true);
  assert.equal(dispatch[1].turn, null);

  assert.equal(
    await failCode(() => tools.executeAction({
      requestId: "r-both",
      actionRef: "alverin:fire-bolt",
      actions: [{ actionRef: "alverin:litany" }],
    })),
    "INVALID_INPUT",
  );
});

test("non-combat execution needs no turn read", async () => {
  const runtime = fakeRuntime({ staticContext: staticManual({ combatId: null }) });
  const { tools } = createTools({ runtime });
  await tools.staticContext();
  const receipt = await tools.executeAction({ requestId: "r-out", actionRef: "alverin:fire-bolt" });
  assert.equal(receipt.result.status, "completed");
});

test("conditionsSet maps aliases, binds world and live selection, and is idempotent", async () => {
  const game = playGame({ selected: [{ document: { uuid: "Scene.a.Token.alverin" } }] });
  const runtime = fakeRuntime({
    conditionsSet: () => ({ status: "completed", steps: [{ step: "cond", state: "completed" }] }),
  });
  const { tools } = createTools({ game, runtime });

  const input = {
    requestId: "cond-1",
    targets: [
      { kind: "token", tokenUuid: "Scene.a.Token.alverin" },
      { kind: "name", name: "Goblin", scope: "focus" },
      { kind: "selected" },
    ],
    conditions: [
      { key: "倒地", active: true },
      { key: "专注", active: false },
      { key: "prone", active: false },
    ],
  };
  const receipt = await tools.conditionsSet(input);
  assert.equal(receipt.result.status, "completed");

  const dispatch = runtime.calls.find(([action]) => action === "conditionsSet");
  assert.deepEqual(dispatch[2], { requireGM: true });
  assert.equal(dispatch[1].mode, "combat");
  assert.deepEqual(dispatch[1].world, { origin: "http://localhost:30000", id: "testworld" });
  assert.deepEqual(dispatch[1].selectedTokenUuids, ["Scene.a.Token.alverin"]);
  assert.deepEqual(dispatch[1].conditions, [
    { key: "prone", active: true },
    { key: "concentrating", active: false },
    { key: "prone", active: false },
  ]);

  const replayed = await tools.conditionsSet(input);
  assert.equal(replayed.replayed, true);
  assert.equal(runtime.calls.filter(([action]) => action === "conditionsSet").length, 1);
});

test("conditionsSet rejects prep-only target kinds and malformed input", async () => {
  const { tools } = createTools({ runtime: fakeRuntime() });
  assert.equal(
    await failCode(() => tools.conditionsSet({
      requestId: "c1",
      targets: [{ kind: "actor", actorUuid: "Actor.1" }],
      conditions: [{ key: "prone", active: true }],
    })),
    "INVALID_INPUT",
  );
  assert.equal(
    await failCode(() => tools.conditionsSet({
      requestId: "c1",
      targets: [{ kind: "name", name: "Goblin", scope: "actors" }],
      conditions: [{ key: "prone", active: true }],
    })),
    "INVALID_INPUT",
  );
  assert.equal(
    await failCode(() => tools.conditionsSet({
      requestId: "c1",
      targets: [{ kind: "selected" }],
      conditions: [{ key: "prone", active: "yes" }],
    })),
    "INVALID_INPUT",
  );
});

test("play tools refuse writes without a ready world", async () => {
  const game = playGame();
  game.world = { title: "No id" };
  const { tools } = createTools({ game, runtime: fakeRuntime() });
  assert.equal(
    await failCode(() => tools.conditionsSet({
      requestId: "c1",
      targets: [{ kind: "selected" }],
      conditions: [{ key: "prone", active: true }],
    })),
    "WORLD_UNAVAILABLE",
  );
});
