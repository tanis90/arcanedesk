import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  runtimeFunction as sdkRuntimeFunction,
  runtimeHash,
} from "@arcanedesk/foundry-sdk/runtime";
import { DirectFoundryRuntime } from "../src/main/direct-foundry-runtime.js";

const TEST_RUNTIME_SOURCE = `async function (action, args, options) {
  return action === "executeTurn"
    ? { status: "completed", action, args, options }
    : { action, args, options };
}`;

function readyState(overrides = {}) {
  return {
    url: "https://foundry.example/game",
    path: "/game",
    detected: true,
    ready: true,
    gm: true,
    user: "Gamemaster",
    world: "test-world",
    ...overrides,
  };
}

function fakeWebContents({ destroyed = false } = {}) {
  return {
    isDestroyed() {
      return destroyed;
    },
  };
}

function createRuntime({
  webContents = fakeWebContents(),
  getWebContents = () => webContents,
  inspectPage = async () => ({ ok: true, state: readyState() }),
  evaluate = async (_webContents, expression) => ({
    status: "completed",
    value: await Function(`"use strict"; return (${expression});`)(),
  }),
  readyPollMs = 1,
  runtimeSource = TEST_RUNTIME_SOURCE,
  onCallResult = null,
} = {}) {
  return new DirectFoundryRuntime({
    getWebContents,
    inspectPage,
    evaluate,
    readyPollMs,
    runtimeSource,
    onCallResult,
  });
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("fixed actions dispatch data to the trusted runtime with requireGM enabled", async () => {
  const runtime = createRuntime();

  for (const action of ["worldInfo", "battleContext", "turnContext", "executeTurn"]) {
    const result = await runtime.call(action, { marker: action }, { executionTimeoutMs: 321 });
    assert.deepEqual(result, {
      ...(action === "executeTurn" ? { status: "completed" } : {}),
      action,
      args: { marker: action },
      options: { requireGM: true, timeoutMs: 321 },
    });
  }
});

test("unsupported actions are rejected before page inspection or evaluation", async () => {
  let inspections = 0;
  let evaluations = 0;
  const runtime = createRuntime({
    inspectPage: async () => {
      inspections += 1;
      return { ok: true, state: readyState() };
    },
    evaluate: async () => {
      evaluations += 1;
      return { status: "completed", value: null };
    },
  });

  await rejectsWithCode(runtime.call("debugEval", {}), "FOUNDRY_SDK_ACTION_UNSUPPORTED");
  assert.equal(inspections, 0);
  assert.equal(evaluations, 0);
});

test("arguments remain JSON data and U+2028/U+2029 cannot inject JavaScript", async () => {
  let capturedExpression = "";
  let evaluations = 0;
  globalThis.__arcaneRuntimeInjected = false;
  const hostile = `\"); globalThis.__arcaneRuntimeInjected = true; //\u2028next\u2029line`;
  const runtime = createRuntime({
    evaluate: async (_webContents, expression) => {
      evaluations += 1;
      capturedExpression = expression;
      return {
        status: "completed",
        value: await Function(`"use strict"; return (${expression});`)(),
      };
    },
  });

  const result = await runtime.call("turnContext", { hostile });

  assert.equal(evaluations, 1);
  assert.equal(result.args.hostile, hostile);
  assert.equal(globalThis.__arcaneRuntimeInjected, false);
  assert.equal(capturedExpression.includes("\u2028"), false);
  assert.equal(capturedExpression.includes("\u2029"), false);
  assert.equal(capturedExpression.includes("\\u2028"), true);
  assert.equal(capturedExpression.includes("\\u2029"), true);
  delete globalThis.__arcaneRuntimeInjected;
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
    "FOUNDRY_SDK_INVALID_ARGUMENTS"
  );
  assert.equal(evaluations, 0);
});

test("preflight rejects missing, destroyed, non-game, undetected, unready, and non-GM pages", async (t) => {
  await t.test("missing panel", async () => {
    await rejectsWithCode(
      createRuntime({ getWebContents: () => null }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      "FOUNDRY_SDK_TRANSPORT_UNAVAILABLE"
    );
  });

  await t.test("destroyed panel", async () => {
    await rejectsWithCode(
      createRuntime({ webContents: fakeWebContents({ destroyed: true }) }).call(
        "worldInfo",
        {},
        { readyTimeoutMs: 0 }
      ),
      "FOUNDRY_SDK_TRANSPORT_UNAVAILABLE"
    );
  });

  await t.test("non-game page", async () => {
    await rejectsWithCode(
      createRuntime({
        inspectPage: async () => ({ ok: true, state: readyState({ path: "/join" }) }),
      }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      "FOUNDRY_SDK_FOUNDRY_NOT_GAME"
    );
  });

  await t.test("lookalike nested game path", async () => {
    await rejectsWithCode(
      createRuntime({
        inspectPage: async () => ({ ok: true, state: readyState({ path: "/lookalike/game" }) }),
      }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      "FOUNDRY_SDK_FOUNDRY_NOT_GAME"
    );
  });

  await t.test("Foundry not detected", async () => {
    await rejectsWithCode(
      createRuntime({
        inspectPage: async () => ({
          ok: true,
          state: readyState({ detected: false, ready: false, gm: false }),
        }),
      }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      "FOUNDRY_SDK_FOUNDRY_NOT_DETECTED"
    );
  });

  await t.test("Foundry not ready", async () => {
    await rejectsWithCode(
      createRuntime({
        inspectPage: async () => ({ ok: true, state: readyState({ ready: false }) }),
      }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      "FOUNDRY_SDK_FOUNDRY_NOT_READY"
    );
  });

  await t.test("non-GM user", async () => {
    await rejectsWithCode(
      createRuntime({
        inspectPage: async () => ({ ok: true, state: readyState({ gm: false }) }),
      }).call("worldInfo", {}, { readyTimeoutMs: 0 }),
      "FOUNDRY_SDK_FOUNDRY_NOT_GM"
    );
  });
});

test("preflight polls until Foundry is detected, ready, and GM", async () => {
  let inspections = 0;
  const runtime = createRuntime({
    inspectPage: async () => {
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

test("a thrown page inspection failure becomes a coded preflight error", async () => {
  const runtime = createRuntime({
    inspectPage: async () => {
      throw new Error("execution context is unavailable");
    },
  });

  await rejectsWithCode(
    runtime.call("worldInfo", {}, { readyTimeoutMs: 0 }),
    "FOUNDRY_SDK_INSPECTION_FAILED"
  );
});

test("all fixed action calls execute serially", async () => {
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const firstBlocker = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const runtime = createRuntime({
    evaluate: async (_webContents, expression) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        firstStarted();
        await firstBlocker;
      }
      const value = await Function(`"use strict"; return (${expression});`)();
      active -= 1;
      return { status: "completed", value };
    },
  });

  const first = runtime.call("worldInfo", {});
  const second = runtime.call("turnContext", {});
  await firstStartedPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseFirst();

  assert.equal((await first).action, "worldInfo");
  assert.equal((await second).action, "turnContext");
  assert.equal(maximumActive, 1);
});

test("abort before dispatch never enters evaluate", async () => {
  let evaluations = 0;
  const controller = new AbortController();
  const runtime = createRuntime({
    inspectPage: async () => {
      controller.abort();
      return { ok: true, state: readyState() };
    },
    evaluate: async () => {
      evaluations += 1;
      return { status: "completed", value: null };
    },
  });

  await rejectsWithCode(
    runtime.call("executeTurn", {}, { signal: controller.signal }),
    "FOUNDRY_SDK_ABORTED"
  );
  assert.equal(evaluations, 0);
});

test("read interruptions reject with coded errors and do not become receipts", async () => {
  const cases = [
    ["navigated", { status: "navigated", url: "https://example.test/join" }, "FOUNDRY_SDK_NAVIGATED"],
    ["aborted", { status: "aborted" }, "FOUNDRY_SDK_ABORTED"],
    ["timeout", { status: "timeout", timeoutMs: 5 }, "FOUNDRY_SDK_TIMEOUT"],
    ["error", { status: "error", error: "renderer gone" }, "FOUNDRY_SDK_EVALUATION_FAILED"],
  ];

  for (const [name, outcome, code] of cases) {
    await rejectsWithCode(
      createRuntime({ evaluate: async () => outcome }).call("turnContext", {}),
      code,
      name
    );
  }
});

test("executeTurn interruptions after dispatch always return a non-retryable indeterminate receipt", async (t) => {
  const outcomes = [
    ["navigation", { status: "navigated", url: "https://example.test/game" }],
    ["abort", { status: "aborted" }],
    ["timeout", { status: "timeout", timeoutMs: 5 }],
    ["renderer error", { status: "error", error: "renderer gone" }],
  ];

  for (const [name, outcome] of outcomes) {
    await t.test(name, async () => {
      const result = await createRuntime({ evaluate: async () => outcome }).call("executeTurn", {});
      assert.equal(result.status, "indeterminate");
      assert.equal(result.retry, false);
      assert.equal(result.code, "FOUNDRY_SDK_RUNTIME_INTERRUPTED");
      assert.equal(typeof result.message, "string");
      assert.ok(result.message.length > 0);
    });
  }
});

test("a thrown evaluator error is also indeterminate only after executeTurn dispatch", async () => {
  const evaluate = async () => {
    throw new Error("execution context vanished");
  };

  const write = await createRuntime({ evaluate }).call("executeTurn", {});
  assert.equal(write.status, "indeterminate");
  assert.equal(write.retry, false);
  await rejectsWithCode(
    createRuntime({ evaluate }).call("worldInfo", {}),
    "FOUNDRY_SDK_EVALUATION_FAILED"
  );
});

test("executeTurn interruption telemetry preserves dispatched status and stable error code", async () => {
  const records = [];
  const runtime = createRuntime({
    evaluate: async () => ({ status: "timeout", timeoutMs: 5 }),
    onCallResult: (record) => records.push(record),
  });
  const receipt = await runtime.call("executeTurn", {});
  assert.equal(receipt.status, "indeterminate");
  assert.equal(receipt.runtimeStatus, "timeout");
  assert.equal(records.length, 1);
  assert.equal(records[0].phase, "dispatched");
  assert.equal(records[0].status, "timeout");
  assert.equal(records[0].receipt, "indeterminate");
  assert.equal(records[0].errorCode, "FOUNDRY_SDK_RUNTIME_INTERRUPTED");
});

test("worldInfo is cached after completion and invalidate clears it", async () => {
  const world = { world: "test-world", ready: true, gm: true };
  const runtime = createRuntime({
    evaluate: async () => ({ status: "completed", value: world }),
  });

  assert.equal(runtime.lastWorldInfo, null);
  assert.equal(await runtime.call("worldInfo", {}), world);
  assert.equal(runtime.lastWorldInfo, world);

  await runtime.call("battleContext", {});
  assert.equal(runtime.lastWorldInfo, world);
  runtime.invalidate();
  assert.equal(runtime.lastWorldInfo, null);
});

test("SDK runtime hash matches its exact contents", () => {
  assert.equal(
    runtimeHash,
    createHash("sha256").update(sdkRuntimeFunction, "utf8").digest("hex")
  );
});
