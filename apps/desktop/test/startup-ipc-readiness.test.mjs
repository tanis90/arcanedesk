import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preloadSource = readFileSync(path.join(appRoot, "preload.cjs"), "utf8");
const mainSource = readFileSync(path.join(appRoot, "src/main/main.js"), "utf8");

function loadPreload(readiness) {
  const calls = [];
  let api;
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ channel, args });
      if (channel === "app:ready") return readiness;
      return Promise.resolve({ ok: true, channel });
    },
    on() {},
    removeListener() {},
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      assert.equal(name, "arcane");
      api = value;
    },
  };
  vm.runInNewContext(preloadSource, {
    require(id) {
      assert.equal(id, "electron");
      return { contextBridge, ipcRenderer };
    },
  }, { filename: "preload.cjs" });
  return { api, calls };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("preload holds every business IPC until main readiness resolves", async () => {
  let release;
  const readiness = new Promise(resolve => { release = resolve; });
  const { api, calls } = loadPreload(readiness);

  const activity = api.activitySnapshot();
  const navigation = api.sessionNavigation();
  const prompt = api.prompt("hello", [], {});
  await flush();
  assert.deepEqual(calls.map(call => call.channel), ["app:ready"]);

  release({ ok: true });
  await Promise.all([activity, navigation, prompt]);
  assert.deepEqual(calls.map(call => call.channel), [
    "app:ready",
    "activity:snapshot",
    "sessions:navigation",
    "chat:prompt",
  ]);
});

test("preload surfaces initialization failure without issuing business IPC", async () => {
  const { api, calls } = loadPreload(Promise.resolve({ ok: false, error: "startup failed" }));
  await assert.rejects(api.activitySnapshot(), /startup failed/);
  assert.deepEqual(calls.map(call => call.channel), ["app:ready"]);
});

test("preload has no ungated literal business IPC channels", () => {
  const channels = [...preloadSource.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(channels, ["app:ready"]);
});

test("main registers readiness before window load and releases after all business handlers", () => {
  const startup = mainSource.indexOf("app.whenReady().then");
  const readyHandler = mainSource.indexOf('ipcMain.handle("app:ready"', startup);
  const windowCreation = mainSource.indexOf("  createWindow();", startup);
  assert.ok(readyHandler >= 0 && readyHandler < windowCreation);

  const release = mainSource.indexOf("resolveMainReady({ ok: true })");
  const lastHandler = mainSource.lastIndexOf("ipcMain.handle(");
  const agentStart = mainSource.indexOf("await modeController.ensureStarted", release);
  assert.ok(release > lastHandler, "readiness must resolve after the final business handler");
  assert.ok(agentStart > release, "readiness must not wait for the agent's slower startup");
  assert.match(mainSource, /resolveMainReady\(\{ ok: false, error:/);
});
