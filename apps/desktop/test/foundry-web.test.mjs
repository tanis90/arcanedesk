import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { evaluateNavigationSafe, readFoundryPageState } from "../src/main/foundry-web.js";
import { AgentHost } from "../src/main/agent-host.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

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
    state: { detected: true, path: "/game", ready: true, gm: true, runtimeReady: true, profile: "foundry" },
  });
  assert.match(expression, /runtimeReady/);
  assert.doesNotMatch(expression, /arcane-agent-bridge|moduleActive/);
});

test("foundry page state is decorated with the foundry profile and keeps in-page verdicts", async () => {
  const webContents = new FakeWebContents(async () => ({
    url: "http://localhost:30000/join",
    path: "/join",
    detected: true,
    ready: false,
    gm: false,
    runtimeReady: false,
    hasGame: true,
  }));
  const { ok, state } = await readFoundryPageState(webContents);
  assert.equal(ok, true);
  assert.equal(state.profile, "foundry");
  assert.equal(state.detected, true); // Foundry 档:页面内结论原样保留
  assert.equal(state.runtimeReady, false);
});

test("mtcompat page state resolves by URL and recomputes detection/readiness from raw signals", async () => {
  const mtState = {
    url: "https://49.7.212.177:30002/user-files/compat/play.html",
    path: "/user-files/compat/play.html",
    detected: false, // Foundry 公式(无 join/setup/标题)对 mtcompat 不适用
    ready: false,
    gm: false,
    user: null,
    world: null,
    hasGame: true, // pre-bootstrap:window.game 已存在
    runtimeReady: false,
  };
  const preBootstrap = new FakeWebContents(async () => ({ ...mtState }));
  const pre = await readFoundryPageState(preBootstrap);
  assert.equal(pre.ok, true);
  assert.equal(pre.state.profile, "mtcompat");
  assert.equal(pre.state.detected, true); // 按档位重算:有 window.game 即检测通过
  assert.equal(pre.state.runtimeReady, false);

  const bootstrapped = new FakeWebContents(async () => ({
    ...mtState,
    ready: true,
    user: "gm",
    world: "curse-of-strahd",
  }));
  const ready = await readFoundryPageState(bootstrapped);
  assert.equal(ready.state.profile, "mtcompat");
  assert.equal(ready.state.detected, true);
  assert.equal(ready.state.runtimeReady, true);
});

test("a sticky profileId decorates pages whose URL left the profile path (Keycloak hop)", async () => {
  const keycloak = new FakeWebContents(async () => ({
    url: "https://49.7.212.177:30002/auth/realms/mt/protocol/openid-connect/auth",
    path: "/auth/realms/mt/protocol/openid-connect/auth",
    detected: false,
    ready: false,
    hasGame: false,
    runtimeReady: false,
  }));
  // 不带 profileId:URL 不匹配任何模式 → Foundry 开放默认档,页面内结论保留。
  const byUrl = await readFoundryPageState(keycloak);
  assert.equal(byUrl.state.profile, "foundry");
  assert.equal(byUrl.state.detected, false);
  // 带 profileId(打开流程知道目标是什么档):登录跳转页归 mtcompat 档解释。
  const sticky = await readFoundryPageState(keycloak, { profileId: "mtcompat" });
  assert.equal(sticky.state.profile, "mtcompat");
  assert.equal(sticky.state.detected, false);
  assert.equal(sticky.state.runtimeReady, false);
});

test("page tools execute concurrently and use the current view", async () => {
  const raw = deferred(); let calls = 0;
  let view = { webContents: new FakeWebContents(() => { calls++; return raw.promise; }) };
  const create = () => new AgentHost({ profile: { mode: "prep" }, getFoundryView: () => view,
    sendToRenderer() {}, log() {} });
  const tool = h => h.buildTools().find(t => t.name === "browser_evaluate");
  const a = tool(create()).execute("a", { code: "read" });
  const b = tool(create()).execute("b", { code: "read" });
  await tick(); assert.equal(calls, 2);
  raw.resolve("old page"); await Promise.all([a, b]);
  view = { webContents: new FakeWebContents(async () => "new page") };
  assert.match(JSON.stringify(await tool(create()).execute("c", { code: "read" })), /new page/);
});

test("timeout removes listeners and does not block a later page operation", async () => {
  const raw = deferred(); let calls = 0;
  const wc = new FakeWebContents(() => ++calls === 1 ? raw.promise : Promise.resolve("second"));
  assert.equal((await evaluateNavigationSafe(wc, "slow", { timeoutMs: 5 })).status, "timeout");
  assert.equal((await evaluateNavigationSafe(wc, "read")).value, "second");
  assert.equal(wc.eventNames().length, 0);
  raw.resolve("late");
});
