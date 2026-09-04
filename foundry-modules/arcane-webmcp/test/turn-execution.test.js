import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTurnExecutor,
  registerTurnExecutionSetting,
  TURN_EXECUTION_SETTING,
} from "../src/turn-execution.js";
import { MODULE_ID } from "../src/write-probe.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function identity() {
  return {
    sessionId: "session-test",
    moduleVersion: "0.4.0",
    runtimeVersion: "0.1.0",
    protocolVersion: 2,
    runtimeHash: "a".repeat(64),
  };
}

function validInput(overrides = {}) {
  return {
    requestId: "turn-test-001",
    expectedBridgeSessionId: "session-test",
    expectedModuleVersion: "0.4.0",
    expectedRuntimeVersion: "0.1.0",
    expectedProtocolVersion: 2,
    expectedRuntimeHash: "a".repeat(64),
    expectedWorldId: "testclean",
    expectedBattleId: "battle-1",
    expectedRound: 1,
    expectedTurnIndex: 0,
    expectedSourceTokenId: "source-token",
    actionId: "action-1",
    targetTokenIds: ["target-token"],
    ...overrides,
  };
}

function turnContext() {
  return {
    schema: "arcane.turn.v2",
    battleId: "battle-1",
    ended: false,
    turn: {
      round: 1,
      index: 0,
      tokenId: "source-token",
    },
    actor: { availableActionIds: ["action-1"] },
    combatants: [
      { tokenId: "source-token" },
      { tokenId: "target-token" },
    ],
  };
}

function fixture({ runtimeResult = { status: "completed" }, runtimeError } = {}) {
  let settingState;
  let setCalls = 0;
  const runtimeCalls = [];
  const game = {
    user: { isGM: true },
    world: { id: "testclean", title: "Test Clean" },
    settings: {
      register(namespace, key, options) {
        assert.equal(namespace, MODULE_ID);
        assert.equal(key, TURN_EXECUTION_SETTING);
        settingState = clone(options.default);
      },
      get() {
        return clone(settingState);
      },
      async set(namespace, key, value) {
        assert.equal(namespace, MODULE_ID);
        assert.equal(key, TURN_EXECUTION_SETTING);
        setCalls += 1;
        settingState = clone(value);
      },
    },
  };
  const runtime = async (action, args, options) => {
    runtimeCalls.push([action, args, options]);
    if (action === "turnContext") return turnContext();
    if (runtimeError) throw runtimeError;
    return clone(runtimeResult);
  };
  registerTurnExecutionSetting({ gameRef: game });
  const executor = createTurnExecutor({
    gameRef: game,
    runtime,
    identity: identity(),
    now: () => "2026-09-03T05:00:00.000Z",
  });
  return {
    executor,
    game,
    runtimeCalls,
    setCalls: () => setCalls,
  };
}

test("registers a hidden world-scoped execution ledger", () => {
  const item = fixture();
  assert.deepEqual(item.executor.read().state, {
    schemaVersion: 1,
    records: [],
  });
  assert.equal(item.executor.read().world.id, "testclean");
});

test("preflights, executes once, and durably replays a completed action", async () => {
  const item = fixture();

  const first = await item.executor.execute(validInput());
  const replay = await item.executor.execute(validInput());

  assert.equal(first.replayed, false);
  assert.deepEqual(first.result, { status: "completed" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(
    item.runtimeCalls.filter(([action]) => action === "executeTurn").length,
    1,
  );
  assert.deepEqual(item.runtimeCalls.at(-1), [
    "executeTurn",
    {
      actionId: "action-1",
      targetTokenIds: ["target-token"],
      advance: false,
    },
    { requireGM: true },
  ]);
  assert.equal(item.setCalls(), 2);
  assert.equal(item.executor.read().state.records[0].status, "completed");
});

test("runtime failure settles as indeterminate and cannot be retried", async () => {
  const item = fixture({ runtimeError: new Error("page navigated") });

  const first = await item.executor.execute(validInput());
  const replay = await item.executor.execute(validInput());

  assert.equal(first.result.status, "indeterminate");
  assert.equal(first.result.retry, false);
  assert.match(first.result.message, /page navigated/);
  assert.equal(replay.replayed, true);
  assert.equal(
    item.runtimeCalls.filter(([action]) => action === "executeTurn").length,
    1,
  );
});

test("reusing a request ID for another action fails closed", async () => {
  const item = fixture();
  await item.executor.execute(validInput());

  await assert.rejects(
    () => item.executor.execute(validInput({ targetTokenIds: ["source-token"] })),
    /\[IDEMPOTENCY_KEY_REUSE\]/,
  );
  assert.equal(
    item.runtimeCalls.filter(([action]) => action === "executeTurn").length,
    1,
  );
});

test("stale bridge, world, and turn identities are rejected before a receipt", async () => {
  for (const overrides of [
    { expectedBridgeSessionId: "old-session" },
    { expectedWorldId: "other-world" },
    { expectedRound: 2 },
  ]) {
    const item = fixture();
    await assert.rejects(() => item.executor.execute(validInput(overrides)));
    assert.equal(item.executor.read().state.records.length, 0);
    assert.equal(item.setCalls(), 0);
  }
});

test("unavailable actions and non-combatant targets fail preflight", async () => {
  for (const overrides of [
    { actionId: "not-available" },
    { targetTokenIds: ["not-a-combatant"] },
  ]) {
    const item = fixture();
    await assert.rejects(() => item.executor.execute(validInput(overrides)));
    assert.equal(
      item.runtimeCalls.filter(([action]) => action === "executeTurn").length,
      0,
    );
    assert.equal(item.executor.read().state.records.length, 0);
  }
});

test("non-GM execution and broad input are rejected", async () => {
  const item = fixture();
  item.game.user.isGM = false;
  await assert.rejects(() => item.executor.execute(validInput()), /\[GM_REQUIRED\]/);

  item.game.user.isGM = true;
  await assert.rejects(
    () => item.executor.execute(validInput({ advance: true })),
    /\[INVALID_INPUT\]/,
  );
  assert.equal(item.setCalls(), 0);
});
