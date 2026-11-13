// Real Electron + CDP acceptance fixture for play -> lobby -> play (plan B).
//
// Usage: electron test/fixtures/lobby-return-e2e-app.mjs --report=<json>
//        [--user-data-dir=<dir>] [--compat-root=<mt-foundry-compat>] [--rounds=3]
//
// What is real in this fixture:
//   - Electron BrowserWindow + real main-frame navigation (observed through CDP
//     Page.frameNavigated).
//   - The mt-foundry-compat working tree's web/agent-runtime.js and web/play-exit.mjs,
//     served verbatim from disk (no hand-written runtime, no pageEval substitute).
//   - DirectFoundryRuntime with the mtcompat runtimeSource/allowedActions/profile,
//     including the SDK call queue and evaluateNavigationSafe transport.
//   - MtLobbyClient and createLobbyTools; foundry_lobby_return({}) is the actual tool.
//
// What is stubbed (allowed by the task): the fixture pages supply minimal
// game/auth/lobby-service data, a delayed lobby service install, and auditable
// teardown/listener counters. No production backend or owner artifacts are used.
//
// Deliberately NOT covered here (reported as notCovered, never faked):
//   - foundry_open (AgentHost) E2E: the return leg is BrowserWindow.loadURL of the
//     receipt's returnPlayUrl only.
//   - The native "return to campaign lobby" UI control (needs the full compat
//     bootstrap/artifact graph).
//   - combat tool isolation (covered by unit tests; not repeated here).
import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => {
  const index = arg.indexOf("=");
  return index < 0 ? [arg.slice(2), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
const reportFile = typeof args.get("report") === "string" ? args.get("report") : null;
const userDataDir = typeof args.get("user-data-dir") === "string" ? path.resolve(args.get("user-data-dir")) : null;
const compatRoot = typeof args.get("compat-root") === "string"
  ? path.resolve(args.get("compat-root"))
  : path.resolve(process.env.MT_FOUNDRY_COMPAT_ROOT
    ?? fileURLToPath(new URL("../../../../../mt-foundry-compat/", import.meta.url)));
const rounds = Math.max(1, Math.min(10, Number(args.get("rounds") ?? 3) || 3));
const LOBBY_SERVICE_DELAY_MS = 900;
const CAMPAIGN_ID = "campaign-alpha";
const DECOY_CAMPAIGN = "campaign-decoy";
const DECOY_WORLD_ID = "world-decoy-777";

if (userDataDir) app.setPath("userData", userDataDir);

function log(message) {
  console.log(`[lobby-return-e2e-app] ${message}`);
}

const report = {
  status: "running",
  mode: "fixture-real-electron-cdp",
  startedAt: new Date().toISOString(),
  compat: {},
  coverage: {
    realElectronBrowserWindow: true,
    realMainFrameNavigation: true,
    realCompatAgentRuntimeFile: false,
    realCompatPlayExitFile: false,
    realDirectFoundryRuntime: false,
    sdkCallQueue: true,
    evaluateNavigationSafeTransport: true,
    realMtLobbyClient: true,
    realCreateLobbyTools: true,
    typedNavigateToLobbyAction: false,
    foundryOpenE2E: false,
    nativeUiReturnControl: false,
    combatToolIsolation: false,
    productionBackend: false,
  },
  notCovered: [
    "foundry_open (AgentHost) E2E: the return leg is BrowserWindow.loadURL(receipt.returnPlayUrl)",
    "native UI 'return to campaign lobby' control: full compat bootstrap/artifacts not assembled in this fixture",
    "combat tool isolation: covered by unit tests only",
    "alreadyInLobby idempotency and LOGIN_REQUIRED/TARGET_CHANGED/JOB_INDETERMINATE failure paths: unit-tested, not repeated here",
    "production Keycloak/live-client backend: replaced by fixture auth/lobby-service stubs; teardown/socket cleanup is observed through auditable counters",
  ],
  checks: {},
  failures: [],
  rounds: [],
  cdpNavigations: [],
  runtimeCalls: [],
  toolCalls: [],
  console: [],
  errors: [],
};

function saveReport() {
  if (!reportFile) return;
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportFile, `${JSON.stringify(bounded(report), null, 2)}\n`);
}

const watchdogMs = Math.max(10_000, Number(args.get("watchdog-ms") ?? 150_000) || 150_000);
setTimeout(() => {
  report.status = "failed";
  report.errors.push(`fixture watchdog fired after ${watchdogMs} ms`);
  log(`watchdog fired after ${watchdogMs} ms`);
  try { saveReport(); } catch (error) { log(`watchdog save failed: ${error?.message ?? error}`); }
  app.exit(1);
}, watchdogMs);

function bounded(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 1500 ? `${value.slice(0, 1500)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 6) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 40).map(item => bounded(item, depth + 1, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (++count > 60) break;
      result[key] = bounded(item, depth + 1, seen);
    }
    return result;
  }
  return String(value);
}

function check(name, condition, detail) {
  const ok = Boolean(condition);
  report.checks[name] = ok;
  if (!ok) report.failures.push({ check: name, detail: bounded(detail) });
  return ok;
}

function requireCheck(name, condition, detail) {
  if (!check(name, condition, detail)) {
    throw new Error(`E2E check failed: ${name}${detail === undefined ? "" : ` (${JSON.stringify(bounded(detail))})`}`);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function evalPage(contents, expression, label, timeoutMs = 10_000) {
  const started = Date.now();
  let timer = null;
  try {
    return await Promise.race([
      contents.executeJavaScript(expression, true),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`executeJavaScript timed out after ${timeoutMs} ms: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    log(`eval ${label} ${Date.now() - started} ms`);
  }
}

async function waitUntilIdle(contents, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (contents.isLoading() && Date.now() < deadline) await delay(100);
  log(`idle ${label} loading=${contents.isLoading()}`);
}

async function waitFor(contents, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await contents.executeJavaScript(expression, true);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function fingerprint(file) {
  const bytes = readFileSync(file);
  return {
    file: path.basename(file),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    text: bytes.toString("utf8"),
  };
}

const PLAY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>mt-compat play · lobby-return e2e</title></head>
<body>
<main id="e2e-play">play fixture</main>
<script>
(() => {
  const store = window.sessionStorage;
  const read = (key, fallback) => { try { const v = store.getItem(key); return v === null ? fallback : v; } catch (error) { return fallback; } };
  const write = (key, value) => { try { store.setItem(key, value); } catch (error) { /* ignore */ } };
  const bump = (key) => write(key, String(Number(read(key, "0")) + 1));
  if (read("mt.session", null) === null) write("mt.session", JSON.stringify({ access_token: "e2e-session-token", user: "gm-e2e" }));
  if (read("mt.campaign", null) === null) write("mt.campaign", "campaign-alpha");
  bump("mt.e2e.playLoads");
  const loadId = "play-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  write("mt.e2e.lastPlayLoad", loadId);
  window.__E2E_PLAY_LOAD_ID__ = loadId;
  bump("mt.e2e.listeners");
  if (read("mt.e2e.worldWrites", null) === null) write("mt.e2e.worldWrites", "0");
  const world = {
    id: "world-decoy-777",
    title: "E2E decoy world",
    update: function () { bump("mt.e2e.worldWrites"); return Promise.resolve(world); },
    create: function () { bump("mt.e2e.worldWrites"); return Promise.resolve({}); },
    delete: function () { bump("mt.e2e.worldWrites"); return Promise.resolve({}); },
    setFlag: function () { bump("mt.e2e.worldWrites"); return Promise.resolve(world); }
  };
  window.game = {
    ready: true,
    version: "13.351",
    release: { version: "13.351" },
    world: world,
    system: { id: "dnd5e", title: "D&D 5e", version: "5.3.3" },
    user: { id: "user-gm-e2e", name: "E2E GM", isGM: true },
    modules: {},
    scenes: [],
    actors: [],
    folders: [],
    combat: null,
    socket: null,
    location: window.location
  };
  window.__MT_AUTH__ = { access_token: "e2e-session-token" };
  window.__MT_READY__ = true;
  window.__E2E__ = { loadId: loadId };
})();
</script>
<script type="module" src="/user-files/compat/agent-runtime.js"></script>
<script type="module" src="/user-files/compat/play-exit.mjs"></script>
<script type="module">
(() => {
  const exit = window.__MT_PLAY_EXIT__;
  const state = window.__E2E__ || {};
  if (!exit || typeof exit.navigateToLobby !== "function" || exit.version !== 1) {
    window.__E2E_PLAY_ERROR__ = "real play-exit handle missing";
    window.__E2E_PLAY_READY__ = false;
    return;
  }
  const teardown = async () => {
    const store = window.sessionStorage;
    const raw = store.getItem("mt.e2e.teardownLog");
    const log = raw ? JSON.parse(raw) : [];
    log.push({ loadId: window.__E2E_PLAY_LOAD_ID__, at: Date.now() });
    store.setItem("mt.e2e.teardownLog", JSON.stringify(log.slice(-50)));
    const current = Number(store.getItem("mt.e2e.listeners") || "0");
    store.setItem("mt.e2e.listeners", String(Math.max(0, current - 1)));
  };
  const first = exit.registerTeardown(teardown);
  const second = exit.registerTeardown(teardown);
  state.playExitVersion = exit.version;
  state.teardownRegistrations = [first, second];
  state.pendingTeardowns = exit.pendingTeardowns;
  state.runtimeHandle = typeof window.__MT_AGENT_RUNTIME__;
  state.runtimeSourceBytes = typeof window.__MT_AGENT_RUNTIME_SOURCE__ === "string" ? window.__MT_AGENT_RUNTIME_SOURCE__.length : 0;
  window.__E2E__ = state;
  window.__E2E_PLAY_READY__ = exit.pendingTeardowns === 1;
})();
</script>
</body></html>`;

const LOBBY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>mt-compat lobby · lobby-return e2e</title></head>
<body>
<main id="e2e-lobby">lobby fixture</main>
<script>
(() => {
  const store = window.sessionStorage;
  const read = (key, fallback) => { try { const v = store.getItem(key); return v === null ? fallback : v; } catch (error) { return fallback; } };
  const write = (key, value) => { try { store.setItem(key, value); } catch (error) { /* ignore */ } };
  const loadedAt = Date.now();
  const loadIndex = Number(read("mt.e2e.lobbyLoads", "0")) + 1;
  write("mt.e2e.lobbyLoads", String(loadIndex));
  const state = window.__E2E__ = { loadedAt: loadedAt, loadIndex: loadIndex, authInstalledAt: null, serviceInstalledAt: null, calls: {} };
  const record = (name) => { state.calls[name] = (state.calls[name] || 0) + 1; };
  const service = {
    protocolVersion: 1,
    async lobbyCampaignsList() {
      record("lobbyCampaignsList");
      return { campaigns: [{ id: "campaign-alpha", name: "Alpha campaign", ruleset: "dnd5e", owner: "gm-e2e", playUrl: "/user-files/compat/play.html?campaign=campaign-alpha" }] };
    },
    async lobbyCampaignPacksGet(input) { record("lobbyCampaignPacksGet"); return { campaignId: input && input.campaignId, revision: 1, selected: [], missing: [], builtIn: [], enabledSources: {} }; },
    async lobbyCampaignPacksUpdate(input) { record("lobbyCampaignPacksUpdate"); return { campaignId: input && input.campaignId, revision: 2, selected: [] }; },
    async lobbyPacksList() { record("lobbyPacksList"); return { revision: 1, packCount: 0, modules: [] }; },
    async lobbyPackRead() { record("lobbyPackRead"); return { pack: null, entries: [], nextCursor: null }; },
    async lobbyPacksDeletePreview(input) { record("lobbyPacksDeletePreview"); return { packIds: (input && input.packIds) || [], entryCount: 0, assetCount: 0 }; },
    async lobbyPacksDelete(input) { record("lobbyPacksDelete"); return { deleted: (input && input.packIds) || [], revision: 2 }; },
    async lobbyImportInspect() { record("lobbyImportInspect"); return { preparationId: "e2e-preparation", plan: { kind: "world" } }; },
    async lobbyImportRun() { record("lobbyImportRun"); return { jobId: "e2e-job", plan: {} }; },
    async lobbyImportStatus(input) { record("lobbyImportStatus"); return { jobId: input && input.jobId, phase: "succeeded", terminal: true }; },
    async lobbyImportCancel(input) { record("lobbyImportCancel"); return { jobId: input && input.jobId, phase: "cancelling" }; }
  };
  service.dispatch = async (name, input) => {
    if (!service[name] || typeof service[name] !== "function") {
      const error = new Error("CAPABILITY_UNAVAILABLE: lobby service action " + name + " is unavailable");
      error.code = "CAPABILITY_UNAVAILABLE";
      throw error;
    }
    return await service[name](input || {});
  };
  setTimeout(() => {
    window.__MT_AUTH__ = { access_token: "e2e-session-token" };
    state.authInstalledAt = Date.now();
    window.__MT_LOBBY_SERVICE__ = service;
    state.serviceInstalledAt = Date.now();
    write("mt.e2e.lastLobbyReady", JSON.stringify({ loadedAt: loadedAt, authInstalledAt: state.authInstalledAt, serviceInstalledAt: state.serviceInstalledAt }));
  }, ${LOBBY_SERVICE_DELAY_MS});
})();
</script>
<script type="module" src="/user-files/compat/agent-runtime.js"></script>
</body></html>`;

const RULESETS_JS = `export const RULESETS = {
  "2024": { label: "DND5E · 2024", system: "dnd5e" },
  "2014": { label: "DND5E · 2014", system: "dnd5e" },
};`;

function readPageStateExpression() {
  return `(() => {
    const store = window.sessionStorage;
    const read = (key) => { try { return store.getItem(key); } catch (error) { return null; } };
    return {
      url: location.href,
      path: location.pathname,
      search: location.search,
      campaignParam: new URLSearchParams(location.search).get("campaign"),
      hintParam: new URLSearchParams(location.search).get("hint"),
      loadId: window.__E2E_PLAY_LOAD_ID__ || null,
      playReady: Boolean(window.__E2E_PLAY_READY__),
      playError: window.__E2E_PLAY_ERROR__ || null,
      playExitVersion: window.__MT_PLAY_EXIT__ ? window.__MT_PLAY_EXIT__.version : null,
      pendingTeardowns: window.__MT_PLAY_EXIT__ ? window.__MT_PLAY_EXIT__.pendingTeardowns : null,
      runtimeSourceBytes: typeof window.__MT_AGENT_RUNTIME_SOURCE__ === "string" ? window.__MT_AGENT_RUNTIME_SOURCE__.length : 0,
      runtimeHandle: typeof window.__MT_AGENT_RUNTIME__,
      teardownLog: read("mt.e2e.teardownLog"),
      listeners: read("mt.e2e.listeners"),
      worldWrites: read("mt.e2e.worldWrites"),
      session: read("mt.session"),
      campaign: read("mt.campaign")
    };
  })()`;
}

function readLobbyStateExpression() {
  return `(() => {
    const store = window.sessionStorage;
    const read = (key) => { try { return store.getItem(key); } catch (error) { return null; } };
    const state = window.__E2E__ || {};
    return {
      url: location.href,
      path: location.pathname,
      loadedAt: state.loadedAt || null,
      loadIndex: state.loadIndex || null,
      authInstalledAt: state.authInstalledAt || null,
      serviceInstalledAt: state.serviceInstalledAt || null,
      calls: state.calls || {},
      serviceReady: Boolean(window.__MT_LOBBY_SERVICE__),
      authReady: Boolean(window.__MT_AUTH__),
      runtimeHandle: typeof window.__MT_AGENT_RUNTIME__,
      runtimeSourceBytes: typeof window.__MT_AGENT_RUNTIME_SOURCE__ === "string" ? window.__MT_AGENT_RUNTIME_SOURCE__.length : 0,
      listeners: read("mt.e2e.listeners"),
      teardownLog: read("mt.e2e.teardownLog"),
      worldWrites: read("mt.e2e.worldWrites"),
      session: read("mt.session"),
      campaign: read("mt.campaign")
    };
  })()`;
}

async function main() {
  log(`start compat=${compatRoot} rounds=${rounds}`);
  requireCheck("compatAgentRuntimeFileReadable", (() => {
    try { readFileSync(path.join(compatRoot, "web", "agent-runtime.js")); return true; } catch { return false; }
  })(), { compatRoot });
  requireCheck("compatPlayExitFileReadable", (() => {
    try { readFileSync(path.join(compatRoot, "web", "play-exit.mjs")); return true; } catch { return false; }
  })(), { compatRoot });

  const agentRuntime = fingerprint(path.join(compatRoot, "web", "agent-runtime.js"));
  const playExit = fingerprint(path.join(compatRoot, "web", "play-exit.mjs"));
  report.compat = {
    root: compatRoot,
    agentRuntime: {
      file: agentRuntime.file,
      bytes: agentRuntime.bytes,
      sha256: agentRuntime.sha256,
      hasNavigateToLobbyAction: agentRuntime.text.includes('action === "navigateToLobby"'),
      hasProtocolVersion3: /protocolVersion:\s*3/.test(agentRuntime.text),
      hasPageRuntimeHandle: agentRuntime.text.includes("__MT_AGENT_RUNTIME_SOURCE__"),
    },
    playExit: {
      file: playExit.file,
      bytes: playExit.bytes,
      sha256: playExit.sha256,
      hasCreatePlayExit: playExit.text.includes("createPlayExit"),
      hasRegisterTeardown: playExit.text.includes("registerTeardown"),
      hasNavigateToLobby: playExit.text.includes("navigateToLobby"),
    },
  };
  requireCheck("compatAgentRuntimeIsPlanB", report.compat.agentRuntime.hasNavigateToLobbyAction
    && report.compat.agentRuntime.hasProtocolVersion3
    && report.compat.agentRuntime.hasPageRuntimeHandle, report.compat.agentRuntime);
  requireCheck("compatPlayExitIsPlanB", report.compat.playExit.hasCreatePlayExit
    && report.compat.playExit.hasRegisterTeardown
    && report.compat.playExit.hasNavigateToLobby, report.compat.playExit);
  report.coverage.realCompatAgentRuntimeFile = true;
  report.coverage.realCompatPlayExitFile = true;

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    log(`http ${request.method} ${pathname}`);
    const headers = { "cache-control": "no-store" };
    if (pathname === "/user-files/compat/play.html") {
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      response.end(PLAY_HTML);
      return;
    }
    if (pathname === "/user-files/compat/lobby.html") {
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      response.end(LOBBY_HTML);
      return;
    }
    if (pathname === "/user-files/compat/agent-runtime.js") {
      response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
      response.end(readFileSync(path.join(compatRoot, "web", "agent-runtime.js")));
      return;
    }
    if (pathname === "/user-files/compat/play-exit.mjs") {
      response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
      response.end(readFileSync(path.join(compatRoot, "web", "play-exit.mjs")));
      return;
    }
    if (pathname === "/user-files/compat/rulesets.mjs") {
      response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
      response.end(RULESETS_JS);
      return;
    }
    response.writeHead(404, headers);
    response.end("not found");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  log(`serving ${origin}`);

  let win = null;
  let attachedHere = false;
  const navEvents = [];

  try {
    await app.whenReady();
    log("app ready");
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const contents = win.webContents;
    const heartbeat = setInterval(() => {
      try { log(`heartbeat loading=${contents.isLoading()} url=${contents.getURL()}`); } catch { /* window gone */ }
    }, 15_000);
    void heartbeat;
    contents.on("console-message", (_event, level, message, line, sourceId) => {
      if (report.console.length < 40) {
        report.console.push({ level, message: String(message).slice(0, 500), line, sourceId: String(sourceId).slice(0, 200) });
      }
    });
    contents.on("render-process-gone", (_event, details) => {
      report.errors.push(`renderer gone: ${JSON.stringify(details)}`);
    });
    contents.on("did-fail-load", (_event, code, description, url) => {
      report.errors.push(`did-fail-load ${code} ${description} ${url}`);
      log(`did-fail-load ${code} ${description} ${url}`);
    });
    contents.on("did-start-loading", () => log("did-start-loading"));
    contents.on("dom-ready", () => log("dom-ready"));
    contents.on("did-stop-loading", () => log("did-stop-loading"));
    contents.on("did-finish-load", () => log("did-finish-load"));
    contents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
      log(`did-start-navigation ${isMainFrame ? "main" : "sub"} inPlace=${isInPlace} ${url}`);
    });
    contents.on("render-process-gone", (_event, details) => log(`render-process-gone ${JSON.stringify(details)}`));

    const initialPlayUrl = `${origin}/user-files/compat/play.html?campaign=${CAMPAIGN_ID}&hint=${DECOY_CAMPAIGN}&world=${DECOY_WORLD_ID}`;
    report.initialPlayUrl = initialPlayUrl;
    log(`loading ${initialPlayUrl}`);
    const loadStartedAt = Date.now();
    const loadTimer = setTimeout(() => {
      log(`loadURL still pending after ${Date.now() - loadStartedAt} ms; current=${contents.getURL()}`);
    }, 8_000);
    try {
      await contents.loadURL(initialPlayUrl);
    } finally {
      clearTimeout(loadTimer);
    }
    log(`play page loaded in ${Date.now() - loadStartedAt} ms; waiting for runtime handles`);
    await waitUntilIdle(contents, "initial-play");
    await waitFor(contents, `Boolean(window.game?.ready && window.__MT_AGENT_RUNTIME_SOURCE__ && window.__MT_PLAY_EXIT__ && window.__E2E_PLAY_READY__)`, 20_000, "real play page (game + agent-runtime + play-exit)");
    log("play page ready");

    log("reading first play state");
    const pageState = await evalPage(contents, readPageStateExpression(), "first-play-state");
    report.firstPlayState = pageState;
    requireCheck("playPageLoadedRealAgentRuntime", pageState.runtimeSourceBytes > 100_000 && pageState.runtimeHandle === "function", pageState);
    requireCheck("playPageLoadedRealPlayExit", pageState.playExitVersion === 1 && pageState.pendingTeardowns === 1, pageState);
    requireCheck("playExitDeduplicatedTeardownRegistration", pageState.pendingTeardowns === 1, pageState);

    const pageRuntimeSource = await evalPage(contents, "window.__MT_AGENT_RUNTIME_SOURCE__", "page-runtime-source");
    requireCheck("pageRuntimeSourceIsRealCompatRuntime", typeof pageRuntimeSource === "string"
      && pageRuntimeSource.includes("mt-agent-runtime")
      && pageRuntimeSource.includes("navigateToLobby"), {
      length: typeof pageRuntimeSource === "string" ? pageRuntimeSource.length : null,
    });

    log("importing Desktop runtime modules");
    const { DirectFoundryRuntime } = await import("../../src/main/direct-foundry-runtime.js");
    log("imported direct-foundry-runtime");
    const { MtLobbyClient } = await import("../../src/main/mt-lobby-client.js");
    log("imported mt-lobby-client");
    const { createLobbyTools } = await import("../../src/main/lobby-tools.js");
    log("imported lobby-tools");
    const { PAGE_PROFILES, clientPageProfile } = await import("../../src/main/page-profiles.js");
    const { MTCOMPAT_RUNTIME_ACTIONS } = await import("../../src/main/foundry-tool-policy.js");
    log("imported all Desktop modules");

    const runtime = new DirectFoundryRuntime({
      getWebContents: () => contents,
      runtimeSource: pageRuntimeSource,
      allowedActions: MTCOMPAT_RUNTIME_ACTIONS,
      pageProfile: clientPageProfile(PAGE_PROFILES.mtcompat),
      readyPollMs: 100,
      log: (level, message) => {
        if (report.console.length < 40) report.console.push({ level, message: String(message).slice(0, 500) });
      },
      onCallResult: record => {
        report.runtimeCalls.push({
          action: record.action,
          phase: record.phase,
          status: record.status,
          receipt: record.receipt,
          errorCode: record.errorCode,
          durationMs: record.durationMs,
        });
        if (report.runtimeCalls.length > 60) report.runtimeCalls.shift();
      },
    });
    report.coverage.realDirectFoundryRuntime = true;
    report.coverage.typedNavigateToLobbyAction = MTCOMPAT_RUNTIME_ACTIONS.includes("navigateToLobby");

    log("baseline worldInfo via DirectFoundryRuntime");
    const baseline = await Promise.race([
      runtime.call("worldInfo", {}, { readyTimeoutMs: 15_000, executionTimeoutMs: 10_000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("baseline worldInfo timed out after 20s")), 20_000)),
    ]);
    log(`baseline worldInfo done runtime=${baseline?.runtime?.name}@${baseline?.runtime?.protocolVersion}`);
    requireCheck("baselineWorldInfoViaRealRuntime", baseline?.runtime?.name === "mt-agent-runtime"
      && baseline?.runtime?.protocolVersion === 3
      && baseline?.world?.id === DECOY_WORLD_ID
      && baseline?.user?.isGM === true
      && baseline?.page?.path === "/user-files/compat/play.html", baseline);
    report.baselineWorldInfo = {
      runtime: baseline?.runtime,
      world: baseline?.world,
      user: baseline?.user,
      page: baseline?.page,
      ready: baseline?.ready,
    };

    // Attach CDP only once the initial document is fully stopped: attaching while a
    // load is still settling can stall webContents.executeJavaScript (observed as a
    // main-process hang), which would silently break evaluateNavigationSafe.
    const idleDeadline = Date.now() + 10_000;
    while (contents.isLoading() && Date.now() < idleDeadline) await delay(100);
    log(`attaching CDP loading=${contents.isLoading()}`);
    try {
      contents.debugger.attach("1.3");
      attachedHere = true;
      contents.debugger.on("message", (_event, method, params) => {
        if (method !== "Page.frameNavigated" || !params?.frame || params.frame.parentId) return;
        navEvents.push({ url: params.frame.url, at: Date.now() });
        if (navEvents.length > 80) navEvents.shift();
      });
      await contents.debugger.sendCommand("Page.enable");
    } catch (error) {
      report.errors.push(`CDP attach failed: ${error?.message ?? error}`);
    }
    requireCheck("cdpAttached", attachedHere, { error: report.errors.at(-1) });
    log(`cdp attached=${attachedHere}`);

    const lobbyClient = new MtLobbyClient({
      getWebContents: () => contents,
      trustedOrigins: [origin],
      readyTimeoutMs: 15_000,
      readyPollMs: 100,
      log: message => {
        if (report.console.length < 40) report.console.push({ level: "lobby-client", message: String(message).slice(0, 500) });
      },
    });
    const host = {
      profile: { mode: "prep" },
      // Real callForSession telemetry seam: the runtime reports every queued call here
      // (including navigateToLobby), so the report proves the SDK queue path was used.
      telemetry: {
        marker: "lobby-return-e2e",
        foundryRuntimeResult: (record, mode) => {
          report.runtimeCalls.push({
            action: record.action,
            phase: record.phase,
            status: record.status,
            receipt: record.receipt,
            errorCode: record.errorCode,
            durationMs: record.durationMs,
            mode,
            via: "callForSession",
          });
          if (report.runtimeCalls.length > 60) report.runtimeCalls.shift();
        },
      },
      panelProfileId: () => PAGE_PROFILES.mtcompat.id,
      foundryRuntime: runtime,
      lobbyClient: () => lobbyClient,
      maybeRequestApproval: async payload => {
        report.failures.push({ check: "unexpectedApprovalRequest", detail: bounded({ tool: payload?.tool }) });
        return false;
      },
      log: message => {
        if (report.console.length < 40) report.console.push({ level: "host", message: String(message).slice(0, 500) });
      },
    };
    const tools = new Map(createLobbyTools(host).map(tool => [tool.name, tool]));
    const lobbyReturn = tools.get("foundry_lobby_return");
    const campaignsList = tools.get("foundry_lobby_campaigns_list");
    requireCheck("realToolsRegistered", Boolean(lobbyReturn) && Boolean(campaignsList), { tools: [...tools.keys()] });

    const invoke = async (name, params) => {
      const tool = tools.get(name);
      const result = await tool.execute(`e2e-${name}-${Date.now()}`, params);
      report.toolCalls.push({
        name,
        isError: Boolean(result.isError),
        details: bounded(result.details),
        text: String(result.content?.[0]?.text ?? "").slice(0, 500),
      });
      if (report.toolCalls.length > 60) report.toolCalls.shift();
      return result;
    };

    let expectedPlayUrl = initialPlayUrl;
    for (let round = 1; round <= rounds; round += 1) {
      const currentRound = { round, status: "in-progress", checks: {}, timings: {}, evidence: {} };
      report.rounds.push(currentRound);
      if (round > 1) {
        // Same-document URL variation (SPA-style) proves the Desktop saves the *current*
        // trusted play URL each round instead of replaying stale target memory. It does not
        // add a document, so the live-listener counter stays comparable across rounds.
        const relative = `/user-files/compat/play.html?campaign=${CAMPAIGN_ID}&hint=${DECOY_CAMPAIGN}&world=${DECOY_WORLD_ID}&round=${round}`;
        expectedPlayUrl = `${origin}${relative}`;
        await evalPage(contents, `(() => { history.replaceState(null, "", ${JSON.stringify(relative)}); return true; })()`, `round${round}-url-variation`);
        await waitFor(contents, `location.href === ${JSON.stringify(expectedPlayUrl)} && Boolean(window.__E2E_PLAY_READY__)`, 10_000, `play URL variation round ${round}`);
        const urlDeadline = Date.now() + 5_000;
        while (contents.getURL() !== expectedPlayUrl && Date.now() < urlDeadline) await delay(50);
      }

      const before = await evalPage(contents, readPageStateExpression(), `round${round}-before`);
      currentRound.evidence.before = before;
      requireCheck(`round${round}.startsOnTrustedPlayUrl`, before.url === expectedPlayUrl
        && before.path === "/user-files/compat/play.html"
        && before.campaignParam === CAMPAIGN_ID, { url: before.url, expectedPlayUrl });
      requireCheck(`round${round}.playExitReady`, before.playReady === true && before.pendingTeardowns === 1, before);

      log(`round ${round}: invoking foundry_lobby_return from ${before.url}`);
      const returnStartedAt = Date.now();
      const result = await invoke("foundry_lobby_return", {});
      const returnFinishedAt = Date.now();
      log(`round ${round}: foundry_lobby_return finished in ${returnFinishedAt - returnStartedAt} ms (isError=${Boolean(result.isError)})`);
      currentRound.timings.returnMs = returnFinishedAt - returnStartedAt;
      currentRound.evidence.receipt = result.details;
      requireCheck(`round${round}.lobbyReturnCompleted`, result.isError !== true
        && result.details?.status === "completed", result.details);
      requireCheck(`round${round}.receiptFrom`, result.details?.from?.path === "/user-files/compat/play.html"
        && result.details?.from?.campaignId === CAMPAIGN_ID, result.details?.from);
      requireCheck(`round${round}.receiptTo`, result.details?.to?.path === "/user-files/compat/lobby.html", result.details?.to);
      requireCheck(`round${round}.returnPlayUrlIsDesktopTrustedPlayUrl`, result.details?.returnPlayUrl === before.url, {
        returnPlayUrl: result.details?.returnPlayUrl,
        expected: before.url,
      });
      const receiptUrl = new URL(result.details.returnPlayUrl);
      requireCheck(`round${round}.identityComesFromUrlNotWorld`, receiptUrl.searchParams.get("campaign") === CAMPAIGN_ID
        && receiptUrl.searchParams.get("hint") === DECOY_CAMPAIGN
        && before.campaignParam !== DECOY_WORLD_ID
        && result.details?.from?.campaignId !== DECOY_WORLD_ID, {
        campaign: receiptUrl.searchParams.get("campaign"),
        hint: receiptUrl.searchParams.get("hint"),
        worldId: DECOY_WORLD_ID,
      });

      const lobbyState = await evalPage(contents, readLobbyStateExpression(), `round${round}-lobby`);
      currentRound.evidence.lobby = lobbyState;
      requireCheck(`round${round}.landedOnLobby`, lobbyState.path === "/user-files/compat/lobby.html", lobbyState.url);
      requireCheck(`round${round}.lobbyServiceWasDelayed`, typeof lobbyState.loadedAt === "number"
        && typeof lobbyState.serviceInstalledAt === "number"
        && lobbyState.serviceInstalledAt - lobbyState.loadedAt >= LOBBY_SERVICE_DELAY_MS - 50, {
        loadedAt: lobbyState.loadedAt,
        authInstalledAt: lobbyState.authInstalledAt,
        serviceInstalledAt: lobbyState.serviceInstalledAt,
        delayMs: LOBBY_SERVICE_DELAY_MS,
      });
      requireCheck(`round${round}.returnWaitedForLobbyReady`, returnFinishedAt >= (lobbyState.serviceInstalledAt - 250), {
        returnFinishedAt,
        serviceInstalledAt: lobbyState.serviceInstalledAt,
      });

      const campaigns = await invoke("foundry_lobby_campaigns_list", {});
      requireCheck(`round${round}.immediateCampaignsListSucceeded`, campaigns.isError !== true
        && Array.isArray(campaigns.details?.campaigns)
        && campaigns.details.campaigns[0]?.id === CAMPAIGN_ID, campaigns.details);

      const afterList = await evalPage(contents, readLobbyStateExpression(), `round${round}-lobby-after-list`);
      currentRound.evidence.lobbyAfterList = afterList;
      requireCheck(`round${round}.campaignsListReachedLobbyService`, Number(afterList.calls?.lobbyCampaignsList ?? 0) >= 1, afterList.calls);

      const teardownLog = afterList.teardownLog ? JSON.parse(afterList.teardownLog) : [];
      currentRound.evidence.teardownLog = teardownLog;
      requireCheck(`round${round}.teardownRanExactlyOnce`, teardownLog.length === round
        && teardownLog.at(-1)?.loadId === before.loadId, {
        entries: teardownLog.length,
        expected: round,
        loadId: before.loadId,
      });
      requireCheck(`round${round}.listenersCleanedUp`, afterList.listeners === "0", { listeners: afterList.listeners });
      requireCheck(`round${round}.sessionStoragePreserved`, afterList.session === before.session
        && afterList.campaign === before.campaign
        && afterList.campaign === CAMPAIGN_ID, {
        session: afterList.session,
        campaign: afterList.campaign,
      });
      requireCheck(`round${round}.noWorldDocumentWrites`, (afterList.worldWrites ?? "0") === "0", { worldWrites: afterList.worldWrites });

      await contents.loadURL(result.details.returnPlayUrl);
      await waitUntilIdle(contents, `round${round}-return`);
      await waitFor(contents, `Boolean(window.__E2E_PLAY_READY__ && window.__MT_AGENT_RUNTIME_SOURCE__)`, 20_000, `play page restored round ${round}`);
      const afterPlay = await evalPage(contents, readPageStateExpression(), `round${round}-after-play`);
      currentRound.evidence.afterPlay = afterPlay;
      requireCheck(`round${round}.returnedToReceiptPlayUrl`, afterPlay.url === result.details.returnPlayUrl
        && afterPlay.campaignParam === CAMPAIGN_ID, { url: afterPlay.url });
      requireCheck(`round${round}.freshPlayPageHasOneListener`, afterPlay.listeners === "1", { listeners: afterPlay.listeners });

      const worldInfo = await runtime.call("worldInfo", {}, { readyTimeoutMs: 15_000, executionTimeoutMs: 10_000 });
      currentRound.evidence.worldInfo = {
        runtime: worldInfo?.runtime,
        world: worldInfo?.world,
        user: worldInfo?.user,
        page: worldInfo?.page,
      };
      requireCheck(`round${round}.realRuntimeWorldInfoAfterReturn`, worldInfo?.runtime?.name === "mt-agent-runtime"
        && worldInfo?.runtime?.protocolVersion === 3
        && worldInfo?.world?.id === DECOY_WORLD_ID
        && worldInfo?.user?.isGM === true
        && worldInfo?.page?.path === "/user-files/compat/play.html", currentRound.evidence.worldInfo);

      currentRound.checks = Object.fromEntries(Object.entries(report.checks)
        .filter(([name]) => name.startsWith(`round${round}.`))
        .map(([name, ok]) => [name.slice(`round${round}.`.length), ok]));
      currentRound.status = Object.values(currentRound.checks).every(Boolean) ? "completed" : "failed";
    }

    const lobbyNavs = navEvents.filter(event => event.url.startsWith(`${origin}/user-files/compat/lobby.html`));
    const playNavs = navEvents.filter(event => event.url.startsWith(`${origin}/user-files/compat/play.html`));
    report.cdpNavigations = navEvents;
    requireCheck("cdpObservedLobbyNavigations", lobbyNavs.length >= rounds, { lobbyNavigations: lobbyNavs.length, rounds });
    requireCheck("cdpObservedPlayNavigations", playNavs.length >= rounds, { playNavigations: playNavs.length, rounds });

    requireCheck("requestedConsecutiveRoundTrips", report.rounds.length === rounds && report.rounds.every(item => item.checks
      && Object.values(item.checks).every(Boolean)), report.rounds.map(item => ({ round: item.round, checks: item.checks })));
    requireCheck("teardownExactlyOnceAcrossRounds", (() => {
      try {
        const finalLog = report.rounds.at(-1)?.evidence?.teardownLog ?? [];
        return finalLog.length === rounds && new Set(finalLog.map(entry => entry.loadId)).size === rounds;
      } catch {
        return false;
      }
    })(), report.rounds.at(-1)?.evidence?.teardownLog);
    requireCheck("noListenerAccumulationAcrossRounds", report.rounds.every(item => item.evidence?.lobby?.listeners === "0"
      && item.evidence?.afterPlay?.listeners === "1"), report.rounds.map(item => ({
      lobby: item.evidence?.lobby?.listeners,
      afterPlay: item.evidence?.afterPlay?.listeners,
    })));
    requireCheck("noWorldDocumentWritesAcrossRounds", report.rounds.every(item => (item.evidence?.lobby?.worldWrites ?? "0") === "0"
      && (item.evidence?.afterPlay?.worldWrites ?? "0") === "0"), report.rounds.map(item => item.evidence?.afterPlay?.worldWrites));
    requireCheck("sessionPreservedAcrossRounds", report.rounds.every(item => item.evidence?.lobby?.session === item.evidence?.before?.session
      && item.evidence?.lobby?.campaign === CAMPAIGN_ID
      && item.evidence?.afterPlay?.campaign === CAMPAIGN_ID), null);

    report.coverage.realMainFrameNavigation = true;
    report.coverage.sdkCallQueue = report.runtimeCalls.some(call => call.action === "navigateToLobby");
    report.coverage.evaluateNavigationSafeTransport = true;
  } finally {
    if (attachedHere) {
      try { win?.webContents?.debugger?.detach(); } catch { /* ignore */ }
    }
    try { win?.destroy(); } catch { /* ignore */ }
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    await new Promise(resolve => server.close(resolve));
  }

  report.status = report.errors.length === 0
    && report.failures.length === 0
    && Object.values(report.checks).every(Boolean)
    && report.rounds.length === rounds
    && report.rounds.every(item => item.status === "completed")
    ? "completed"
    : "failed";
  saveReport();
  app.exit(report.status === "completed" ? 0 : 1);
}

main().catch(error => {
  report.status = "failed";
  report.errors.push(String(error?.stack ?? error).slice(0, 4000));
  saveReport();
  app.exit(1);
});
