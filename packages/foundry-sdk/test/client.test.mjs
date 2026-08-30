import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_DIRECT_ACTIONS,
  DIRECT_ACTION_EFFECTS,
  FOUNDRY_SDK_ERROR_CODES,
  FoundryRuntimeClient,
  FoundrySdkError,
  READ_DIRECT_ACTIONS,
  SAFE_DIRECT_ACTIONS,
  WRITE_DIRECT_ACTIONS,
  isWriteDirectAction,
} from "../dist/index.js";

const TEST_RUNTIME_SOURCE = `async function (action, args, options) {
  if (action === "executeTurn") return { status: "completed", debug: { action, args, options } };
  return { action, args, options };
}`;

function readyState(overrides = {}) {
  return {
    url: "https://example.test/game",
    path: "/game",
    detected: true,
    ready: true,
    gm: true,
    user: "Gamemaster",
    world: "test-world",
    ...overrides,
  };
}

function createRuntime({
  context = { destroyed: false },
  acquire = () => context,
  isAvailable = value => !value.destroyed,
  inspect = async () => ({ ok: true, state: readyState() }),
  evaluate = async (_context, expression) => ({
    status: "completed",
    value: await Function(`"use strict"; return (${expression});`)(),
  }),
  readyPollMs = 1,
  runtimeSource = TEST_RUNTIME_SOURCE,
  allowedActions,
  requireGM,
  onCallResult,
  log,
} = {}) {
  return new FoundryRuntimeClient({
    transport: { acquire, isAvailable, inspect, evaluate },
    readyPollMs,
    runtimeSource,
    ...(allowedActions ? { allowedActions } : {}),
    ...(requireGM === undefined ? {} : { requireGM }),
    ...(onCallResult ? { onCallResult } : {}),
    ...(log ? { log } : {}),
  });
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof FoundrySdkError);
    assert.equal(error.code, code);
    return true;
  });
}

test("public allowlists are complete and the safe default is narrow", () => {
  assert.deepEqual(SAFE_DIRECT_ACTIONS, [
    "worldInfo",
    "battleContext",
    "turnContext",
    "executeTurn",
  ]);
  assert.deepEqual(Object.keys(DIRECT_ACTION_EFFECTS), ALL_DIRECT_ACTIONS);
  assert.deepEqual(READ_DIRECT_ACTIONS, [
    "doctor",
    "worldInfo",
    "sceneSnapshot",
    "combatSnapshot",
    "actorSearch",
    "actorGet",
    "actorExport",
    "tokenDetails",
    "tokenActions",
    "battleContext",
    "turnContext",
  ]);
  assert.deepEqual(WRITE_DIRECT_ACTIONS, [
    "actorImport",
    "actorCreateFromCompendium",
    "actorUpdate",
    "actorDamageMigrate",
    "actorBilingualSync",
    "actorAddItems",
    "actorAddItemsFromCompendium",
    "actorSetImage",
    "assetUpload",
    "createToken",
    "deleteToken",
    "useAction",
    "executeTurn",
    "profileExecuteTurn",
    "applyTokenState",
    "startCombat",
    "nextTurn",
  ]);
  assert.equal(ALL_DIRECT_ACTIONS.length, 28);
  assert.equal(READ_DIRECT_ACTIONS.length, 11);
  assert.equal(WRITE_DIRECT_ACTIONS.length, 17);
  for (const action of ALL_DIRECT_ACTIONS) {
    assert.equal(isWriteDirectAction(action), DIRECT_ACTION_EFFECTS[action] === "write");
  }
});

test("safe actions dispatch JSON data with GM enforcement", async () => {
  const runtime = createRuntime();

  for (const action of ["worldInfo", "battleContext", "turnContext"]) {
    const result = await runtime.call(action, { marker: action }, { executionTimeoutMs: 321 });
    assert.deepEqual(result, {
      action,
      args: { marker: action },
      options: { requireGM: true, timeoutMs: 321 },
    });
  }

  const write = await runtime.call(
    "executeTurn",
    { actionId: "action-id" },
    { executionTimeoutMs: 654 },
  );
  assert.equal(write.status, "completed");
  assert.deepEqual(write.debug.options, { requireGM: true, timeoutMs: 654 });
});

test("unsupported actions fail before acquire, inspect, or evaluate", async () => {
  let acquisitions = 0;
  let inspections = 0;
  let evaluations = 0;
  const runtime = createRuntime({
    acquire: () => {
      acquisitions += 1;
      return {};
    },
    inspect: async () => {
      inspections += 1;
      return { ok: true, state: readyState() };
    },
    evaluate: async () => {
      evaluations += 1;
      return { status: "completed", value: null };
    },
  });

  await rejectsWithCode(
    runtime.call("doctor", {}),
    FOUNDRY_SDK_ERROR_CODES.ACTION_UNSUPPORTED,
  );
  assert.deepEqual({ acquisitions, inspections, evaluations }, {
    acquisitions: 0,
    inspections: 0,
    evaluations: 0,
  });
});

test("a CLI can explicitly opt into the complete runtime allowlist", async () => {
  const runtime = createRuntime({ allowedActions: ALL_DIRECT_ACTIONS });
  const result = await runtime.call("doctor", { marker: true });
  assert.deepEqual(result.args, { marker: true });
});

test("arguments remain JSON data and U+2028/U+2029 cannot inject source", async () => {
  let capturedExpression = "";
  globalThis.__sdkInjected = false;
  const hostile = `\"); globalThis.__sdkInjected = true; //\u2028next\u2029line`;
  const runtime = createRuntime({
    evaluate: async (_context, expression) => {
      capturedExpression = expression;
      return {
        status: "completed",
        value: await Function(`"use strict"; return (${expression});`)(),
      };
    },
  });

  const result = await runtime.call("turnContext", { hostile });
  assert.equal(result.args.hostile, hostile);
  assert.equal(globalThis.__sdkInjected, false);
  assert.equal(capturedExpression.includes("\u2028"), false);
  assert.equal(capturedExpression.includes("\u2029"), false);
  assert.equal(capturedExpression.includes("\\u2028"), true);
  assert.equal(capturedExpression.includes("\\u2029"), true);
  delete globalThis.__sdkInjected;
});

test("non-serializable arguments fail before evaluation", async () => {
  let evaluations = 0;
  const runtime = createRuntime({
    evaluate: async () => {
      evaluations += 1;
      return { status: "completed", value: null };
    },
  });
  const circular = {};
  circular.self = circular;

  await rejectsWithCode(
    runtime.call("battleContext", circular),
    FOUNDRY_SDK_ERROR_CODES.INVALID_ARGUMENTS,
  );
  assert.equal(evaluations, 0);
});

test("preflight rejects unavailable and invalid Foundry states", async t => {
  await t.test("missing transport context", async () => {
    await rejectsWithCode(
      createRuntime({ acquire: () => null }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      FOUNDRY_SDK_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    );
  });

  await t.test("destroyed transport context", async () => {
    await rejectsWithCode(
      createRuntime({ context: { destroyed: true } }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      FOUNDRY_SDK_ERROR_CODES.TRANSPORT_UNAVAILABLE,
    );
  });

  for (const [name, state, code] of [
    ["join page", { path: "/join" }, FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_GAME],
    ["nested lookalike", { path: "/lookalike/game" }, FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_GAME],
    ["undetected", { detected: false, ready: false, gm: false }, FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_DETECTED],
    ["unready", { ready: false }, FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_READY],
    ["non-GM", { gm: false }, FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_GM],
  ]) {
    await t.test(name, async () => {
      await rejectsWithCode(
        createRuntime({
          inspect: async () => ({ ok: true, state: readyState(state) }),
        }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
        code,
      );
    });
  }
});

test("requireGM false supports an explicitly authorized non-GM consumer", async () => {
  const runtime = createRuntime({
    requireGM: false,
    inspect: async () => ({ ok: true, state: readyState({ gm: false }) }),
  });
  const result = await runtime.call("worldInfo", {});
  assert.equal(result.options.requireGM, false);
});

test("preflight polls until Foundry is detected, ready, and GM", async () => {
  let inspections = 0;
  const runtime = createRuntime({
    inspect: async () => {
      inspections += 1;
      if (inspections === 1) {
        return { ok: true, state: readyState({ detected: false, ready: false, gm: false }) };
      }
      if (inspections === 2) {
        return { ok: true, state: readyState({ ready: false, gm: false }) };
      }
      return { ok: true, state: readyState() };
    },
  });

  const result = await runtime.call("worldInfo", {}, { readyTimeoutMs: 100 });
  assert.equal(result.action, "worldInfo");
  assert.equal(inspections, 3);
});

test("inspection failure becomes a stable coded preflight error", async () => {
  await rejectsWithCode(
    createRuntime({
      inspect: async () => {
        throw new Error("execution context unavailable");
      },
    }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
    FOUNDRY_SDK_ERROR_CODES.INSPECTION_FAILED,
  );
});

test("calls execute serially and a rejected call does not poison the queue", async () => {
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise(resolve => {
    firstStarted = resolve;
  });
  const blocker = new Promise(resolve => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const runtime = createRuntime({
    evaluate: async (_context, expression) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        firstStarted();
        await blocker;
      }
      const value = await Function(`"use strict"; return (${expression});`)();
      active -= 1;
      return { status: "completed", value };
    },
  });

  const first = runtime.call("worldInfo", {});
  const second = runtime.call("turnContext", {});
  await firstStartedPromise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal((await first).action, "worldInfo");
  assert.equal((await second).action, "turnContext");
  assert.equal(maximumActive, 1);

  await rejectsWithCode(runtime.call("doctor", {}), FOUNDRY_SDK_ERROR_CODES.ACTION_UNSUPPORTED);
  assert.equal((await runtime.call("worldInfo", {})).action, "worldInfo");
});

test("abort before dispatch never evaluates", async () => {
  let evaluations = 0;
  const controller = new AbortController();
  const runtime = createRuntime({
    inspect: async () => {
      controller.abort();
      return { ok: true, state: readyState() };
    },
    evaluate: async () => {
      evaluations += 1;
      return { status: "completed", value: null };
    },
  });

  await rejectsWithCode(
    runtime.call("executeTurn", { actionId: "id" }, { signal: controller.signal }),
    FOUNDRY_SDK_ERROR_CODES.ABORTED,
  );
  assert.equal(evaluations, 0);
});

test("read interruptions reject with stable errors", async () => {
  const cases = [
    [{ status: "navigated", url: "https://example.test/join" }, FOUNDRY_SDK_ERROR_CODES.NAVIGATED],
    [{ status: "aborted" }, FOUNDRY_SDK_ERROR_CODES.ABORTED],
    [{ status: "timeout", timeoutMs: 5 }, FOUNDRY_SDK_ERROR_CODES.TIMEOUT],
    [{ status: "error", error: "renderer gone" }, FOUNDRY_SDK_ERROR_CODES.EVALUATION_FAILED],
  ];
  for (const [outcome, code] of cases) {
    await rejectsWithCode(
      createRuntime({ evaluate: async () => outcome }).call("turnContext", {}),
      code,
    );
  }
});

test("non-execute write interruptions reject with machine-readable non-retryable state", async () => {
  const records = [];
  let evaluationTimeoutMs = null;
  const runtime = createRuntime({
    allowedActions: ALL_DIRECT_ACTIONS,
    evaluate: async (_context, _expression, options) => {
      evaluationTimeoutMs = options.timeoutMs;
      return { status: "timeout", timeoutMs: options.timeoutMs };
    },
    onCallResult: record => records.push(record),
  });

  await assert.rejects(
    runtime.call("actorUpdate", { actorId: "a1", updates: { name: "Changed" } }),
    error => {
      assert.ok(error instanceof FoundrySdkError);
      assert.equal(error.code, FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED);
      assert.deepEqual(error.details, {
        status: "indeterminate",
        retry: false,
        code: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
        action: "actorUpdate",
        runtimeStatus: "timeout",
        message: error.message,
      });
      return true;
    },
  );
  assert.equal(evaluationTimeoutMs, 120_000);
  assert.deepEqual(records, [{
    action: "actorUpdate",
    phase: "dispatched",
    status: "timeout",
    receipt: "indeterminate",
    durationMs: records[0].durationMs,
    errorCode: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
  }]);
});

test("executeTurn interruption after dispatch is always non-retryable and indeterminate", async t => {
  for (const [name, outcome] of [
    ["navigation", { status: "navigated", url: "https://example.test/game" }],
    ["abort", { status: "aborted" }],
    ["timeout", { status: "timeout", timeoutMs: 5 }],
    ["transport error", { status: "error", error: "renderer gone" }],
  ]) {
    await t.test(name, async () => {
      const result = await createRuntime({ evaluate: async () => outcome }).call(
        "executeTurn",
        { actionId: "id" },
      );
      assert.equal(result.status, "indeterminate");
      assert.equal(result.retry, false);
      assert.equal(result.code, FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED);
      assert.equal(typeof result.message, "string");
    });
  }
});

test("thrown evaluator errors and invalid write receipts are indeterminate after dispatch", async () => {
  const thrown = await createRuntime({
    evaluate: async () => {
      throw new Error("execution context vanished");
    },
  }).call("executeTurn", { actionId: "id" });
  assert.equal(thrown.status, "indeterminate");
  assert.equal(thrown.retry, false);

  const invalid = await createRuntime({
    evaluate: async () => ({ status: "completed", value: { unexpected: true } }),
  }).call("executeTurn", { actionId: "id" });
  assert.equal(invalid.status, "indeterminate");
  assert.equal(invalid.retry, false);
  assert.match(invalid.message, /invalid receipt/);
});

test("telemetry exposes the dispatch boundary without action arguments", async () => {
  const records = [];
  const runtime = createRuntime({
    evaluate: async () => ({ status: "timeout", timeoutMs: 5 }),
    onCallResult: record => records.push(record),
  });
  const result = await runtime.call("executeTurn", { actionId: "secret-action" });
  assert.equal(result.status, "indeterminate");
  assert.deepEqual(records, [{
    action: "executeTurn",
    phase: "dispatched",
    status: "timeout",
    receipt: "indeterminate",
    durationMs: records[0].durationMs,
    errorCode: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
  }]);
  assert.equal("args" in records[0], false);
});

test("worldInfo cache is explicit and invalidatable", async () => {
  const world = {
    world: { id: "cos", title: "Curse of Strahd" },
    system: { id: "dnd5e", title: "D&D 5e", version: "5" },
    foundryVersion: "13",
    user: { id: "gm", name: "GM", isGM: true },
    modules: {},
  };
  const runtime = createRuntime({
    evaluate: async () => ({ status: "completed", value: world }),
  });
  assert.equal(runtime.lastWorldInfo, null);
  assert.equal(await runtime.call("worldInfo", {}), world);
  assert.equal(runtime.lastWorldInfo, world);
  runtime.invalidate();
  assert.equal(runtime.lastWorldInfo, null);
});
