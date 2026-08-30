import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { evaluateNavigationSafe, readFoundryPageState } from "../src/main/foundry-web.js";

class FakeWebContents extends EventEmitter {
  constructor(evaluate) {
    super();
    this.evaluate = evaluate;
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  executeJavaScript(code) {
    return this.evaluate(code, this);
  }
}

test("browser evaluation returns ordinary values", async () => {
  const webContents = new FakeWebContents(async () => ({ ready: true }));
  const result = await evaluateNavigationSafe(webContents, "window.game", { timeoutMs: 100 });

  assert.deepEqual(result, { status: "completed", value: { ready: true } });
});

test("browser evaluation settles on navigation even when the old page promise hangs", async () => {
  const webContents = new FakeWebContents(() => new Promise(() => {}));
  const resultPromise = evaluateNavigationSafe(webContents, "location.reload()", { timeoutMs: 1_000 });
  queueMicrotask(() => {
    webContents.emit("did-start-navigation", {}, "http://localhost:30000/game", false, true);
  });

  assert.deepEqual(await resultPromise, {
    status: "navigated",
    url: "http://localhost:30000/game",
  });
});

test("browser evaluation supports timeout and abort", async () => {
  const webContents = new FakeWebContents(() => new Promise(() => {}));
  assert.deepEqual(await evaluateNavigationSafe(webContents, "never", { timeoutMs: 10 }), {
    status: "timeout",
    timeoutMs: 10,
  });

  const controller = new AbortController();
  const aborted = evaluateNavigationSafe(webContents, "never", { timeoutMs: 1_000, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { status: "aborted" });
});

test("Foundry page state reports direct runtime readiness without module state", async () => {
  let expression = "";
  const webContents = new FakeWebContents(async (code) => {
    expression = code;
    return { detected: true, path: "/game", ready: true, gm: true, runtimeReady: true };
  });

  assert.deepEqual(await readFoundryPageState(webContents), {
    ok: true,
    state: { detected: true, path: "/game", ready: true, gm: true, runtimeReady: true },
  });
  assert.match(expression, /runtimeReady/);
  assert.doesNotMatch(expression, /arcane-agent-bridge|moduleActive/);
});
