import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWriteProbeStore,
  MODULE_ID,
  registerWriteProbeSetting,
  WRITE_PROBE_SETTING,
} from "../src/write-probe.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function testGame({ isGM = true } = {}) {
  let state;
  let registration;
  let setCalls = 0;

  const game = {
    user: { isGM },
    world: { id: "testclean", title: "Test Clean" },
    settings: {
      register(namespace, key, options) {
        registration = { namespace, key, options };
        state = clone(options.default);
      },
      get(namespace, key) {
        assert.equal(namespace, MODULE_ID);
        assert.equal(key, WRITE_PROBE_SETTING);
        return clone(state);
      },
      async set(namespace, key, value) {
        assert.equal(namespace, MODULE_ID);
        assert.equal(key, WRITE_PROBE_SETTING);
        setCalls += 1;
        state = clone(value);
        return clone(state);
      },
    },
  };

  return {
    game,
    registration: () => registration,
    replaceState: (value) => {
      state = clone(value);
    },
    setCalls: () => setCalls,
  };
}

test("registers a hidden world-scoped module setting with safe defaults", () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });

  assert.equal(fixture.registration().namespace, MODULE_ID);
  assert.equal(fixture.registration().key, WRITE_PROBE_SETTING);
  assert.equal(fixture.registration().options.scope, "world");
  assert.equal(fixture.registration().options.config, false);
  assert.deepEqual(fixture.registration().options.default, {
    schemaVersion: 2,
    revision: 0,
    value: "idle",
    receipts: [],
  });
});

test("commits once and returns the same receipt on an identical retry", async () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  const store = createWriteProbeStore({
    gameRef: fixture.game,
    now: () => "2026-09-03T04:00:00.000Z",
  });
  const input = {
    requestId: "p1-test-001",
    expectedWorldId: "testclean",
    value: "armed",
    expectedRevision: 0,
  };

  const committed = await store.write(input);
  const replayed = await store.write(input);

  assert.equal(committed.replayed, false);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.receipt, committed.receipt);
  assert.equal(fixture.setCalls(), 1);
  assert.deepEqual(store.read().state, {
    schemaVersion: 2,
    revision: 1,
    value: "armed",
    receipts: [committed.receipt],
  });
});

test("rejects revision conflicts without mutating state", async () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  const store = createWriteProbeStore({ gameRef: fixture.game });

  await assert.rejects(
    () =>
      store.write({
        requestId: "p1-conflict",
        expectedWorldId: "testclean",
        value: "armed",
        expectedRevision: 7,
      }),
    /\[REVISION_CONFLICT\]/,
  );
  assert.equal(fixture.setCalls(), 0);
  assert.equal(store.read().state.revision, 0);
});

test("rejects reuse of an idempotency key with different arguments", async () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  const store = createWriteProbeStore({ gameRef: fixture.game });

  await store.write({
    requestId: "p1-reuse",
    expectedWorldId: "testclean",
    value: "armed",
    expectedRevision: 0,
  });
  await assert.rejects(
    () =>
      store.write({
        requestId: "p1-reuse",
        expectedWorldId: "testclean",
        value: "idle",
        expectedRevision: 1,
      }),
    /\[IDEMPOTENCY_KEY_REUSE\]/,
  );
  assert.equal(fixture.setCalls(), 1);
  assert.equal(store.read().state.value, "armed");
});

test("response delay happens only after the write is persisted", async () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  let observedDuringDelay;
  const store = createWriteProbeStore({
    gameRef: fixture.game,
    delay: async (milliseconds) => {
      observedDuringDelay = {
        milliseconds,
        state: store.read().state,
      };
    },
  });

  await store.write({
    requestId: "p1-delayed",
    expectedWorldId: "testclean",
    value: "armed",
    expectedRevision: 0,
    simulateResponseDelayMs: 2500,
  });

  assert.equal(observedDuringDelay.milliseconds, 2500);
  assert.equal(observedDuringDelay.state.revision, 1);
  assert.equal(observedDuringDelay.state.value, "armed");
});

test("read and write both preserve the GM guard", async () => {
  const fixture = testGame({ isGM: false });
  registerWriteProbeSetting({ gameRef: fixture.game });
  const store = createWriteProbeStore({ gameRef: fixture.game });

  assert.throws(() => store.read(), /\[GM_REQUIRED\]/);
  await assert.rejects(
    () =>
      store.write({
        requestId: "p1-player",
        expectedWorldId: "testclean",
        value: "armed",
        expectedRevision: 0,
      }),
    /\[GM_REQUIRED\]/,
  );
  assert.equal(fixture.setCalls(), 0);
});
test("input validation rejects broad or unknown writes", async () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  const store = createWriteProbeStore({ gameRef: fixture.game });

  await assert.rejects(
    () =>
      store.write({
        requestId: "bad request id",
        expectedWorldId: "testclean",
        value: "anything",
        expectedRevision: 0,
        actorId: "Actor.secret",
      }),
    /\[INVALID_INPUT\]/,
  );
  assert.equal(fixture.setCalls(), 0);
});

test("rejects a write addressed to a different browser world", async () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  const store = createWriteProbeStore({ gameRef: fixture.game });

  await assert.rejects(
    () =>
      store.write({
        requestId: "p1-other-world",
        expectedWorldId: "another-world",
        value: "armed",
        expectedRevision: 0,
      }),
    /\[WORLD_MISMATCH\]/,
  );
  assert.equal(fixture.setCalls(), 0);
  assert.equal(store.read().world.id, "testclean");
});

test("reads legacy P1 receipts as world-bound schema v2 data", () => {
  const fixture = testGame();
  registerWriteProbeSetting({ gameRef: fixture.game });
  fixture.replaceState({
    schemaVersion: 1,
    revision: 1,
    value: "armed",
    receipts: [
      {
        requestId: "legacy-1",
        requestedValue: "armed",
        expectedRevision: 0,
        before: { revision: 0, value: "idle" },
        after: { revision: 1, value: "armed" },
        committedAt: "2026-09-03T04:00:00.000Z",
      },
    ],
  });
  const store = createWriteProbeStore({ gameRef: fixture.game });

  const result = store.read();
  assert.equal(result.state.schemaVersion, 2);
  assert.equal(result.state.receipts[0].worldId, "testclean");
  assert.equal(fixture.setCalls(), 0);
});
