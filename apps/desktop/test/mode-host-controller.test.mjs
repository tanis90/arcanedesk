import assert from "node:assert/strict";
import test from "node:test";

import { ModeHostController } from "../src/main/mode-host-controller.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hosts(overrides = {}) {
  return {
    combat: { start: async () => {}, name: "combat", ...overrides.combat },
    prep: { start: async () => {}, name: "prep", ...overrides.prep },
  };
}

test("defaults to prep mode when no saved mode is provided", () => {
  const controller = new ModeHostController({ hosts: hosts() });
  assert.equal(controller.snapshot().mode, "prep");
});

test("concurrent lazy starts share one promise", async () => {
  const gate = deferred();
  let starts = 0;
  const controller = new ModeHostController({
    hosts: hosts({ prep: { start: async () => { starts += 1; await gate.promise; } } }),
  });

  const first = controller.ensureStarted("prep");
  const second = controller.ensureStarted("prep");
  await Promise.resolve();
  assert.equal(starts, 1);

  gate.resolve();
  assert.equal(await first, await second);
  assert.equal(starts, 1);
});

test("failed lazy start can be retried", async () => {
  let starts = 0;
  const controller = new ModeHostController({
    hosts: hosts({
      prep: {
        start: async () => {
          starts += 1;
          if (starts === 1) throw new Error("first start failed");
        },
      },
    }),
  });

  await assert.rejects(controller.ensureStarted("prep"), /first start failed/);
  await controller.ensureStarted("prep");
  assert.equal(starts, 2);
});

test("a later mode request wins over an older slow switch", async () => {
  const prepGate = deferred();
  const controller = new ModeHostController({
    hosts: hosts({ prep: { start: () => prepGate.promise } }),
    initialMode: "combat",
  });
  await controller.ensureStarted("combat");

  const slowPrep = controller.switchTo("prep");
  await Promise.resolve();
  const laterCombat = await controller.switchTo("combat");
  assert.equal(laterCombat.mode, "combat");
  assert.equal(laterCombat.stale, false);

  prepGate.resolve();
  const stalePrep = await slowPrep;
  assert.equal(stalePrep.stale, true);
  assert.equal(stalePrep.mode, "combat");
  assert.equal(controller.snapshot().mode, "combat");
});

test("mode generation changes only when the active mode changes", async () => {
  const controller = new ModeHostController({ hosts: hosts(), initialMode: "combat" });
  await controller.ensureStarted("combat");
  assert.equal(controller.snapshot().generation, 0);

  const unchanged = await controller.switchTo("combat");
  assert.equal(unchanged.generation, 0);

  const prep = await controller.switchTo("prep");
  assert.equal(prep.generation, 1);
  assert.equal(prep.mode, "prep");
});

test("explicit stale renderer context is rejected while legacy calls use the current snapshot", async () => {
  const controller = new ModeHostController({ hosts: hosts(), initialMode: "combat" });
  await controller.ensureStarted("combat");
  const legacy = controller.validateRequest(undefined);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.context.mode, "combat");

  await controller.switchTo("prep");
  assert.deepEqual(
    controller.validateRequest({ mode: "combat", generation: 0 }),
    {
      ok: false,
      code: "STALE_MODE_CONTEXT",
      error: "模式已经切换，请在当前模式重试",
      mode: "prep",
      generation: 1,
    },
  );
  assert.deepEqual(
    controller.validateRequest({ mode: "typo", generation: 1 }),
    {
      ok: false,
      code: "INVALID_MODE_CONTEXT",
      error: "无效的模式上下文",
      mode: "prep",
      generation: 1,
    },
  );
});
