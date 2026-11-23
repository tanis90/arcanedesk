#!/usr/bin/env node
// Real local-stack acceptance for the Desktop → FoundryServices → DirectFoundryRuntime →
// real ArcaneVTT (mt-compat) page contract. NOT part of `npm test` (that glob is
// test/*.test.mjs, and this file is not a unit test): run it explicitly.
//
//   MT_PASS=... node test/e2e-mtcompat-contract.mjs
//   MT_PASS=... node test/e2e-mtcompat-contract.mjs --base=https://.../user-files/compat-x \
//     --compat-root=/path/to/mt-foundry-compat --out=/tmp/arcane-desktop-contract-mtcompat-image
//   (npm run test:e2e:mtcompat-contract is the same entry; options: --headed, --keep,
//    --watchdog-ms, --playwright=<module>; MT_USER/MT_PASS/MT_CHROME/MT_COMPAT_BASE env overrides)
//
// What is real here:
//   - the local stack face (play.html + bootstrap/shim/packs), the real Keycloak account
//     and the real ArcaneVTT backend (campaigns, WS document persistence, user-files);
//   - the real AgentHost tool pool (createFoundryTools + world_status + foundry_page_eval);
//   - the real FoundryServices (operation journal, readRefs, local asset fence, Chromium
//     image decode through evaluateNavigationSafe);
//   - the real DirectFoundryRuntime over the real WebContents transport
//     (evaluateNavigationSafe + readFoundryPageState) adapted to a Playwright page;
//   - the page runtime installed from the compat working tree's web/agent-runtime.js
//     (the compat worktree is read-only for this repo) and adopted through
//     adoptMtcompatRuntimeFromPage's page-handle delegation branch.
//
// What this is NOT: the Electron window/UI. No electron main-process wiring, panel
// navigation, approvals UI or renderer is exercised; only the tool host/service/runtime
// code paths and the real page.
//
// The two backend probes are hard assertions: uploaded bytes must be readable through
// the page's signing path while durable references stay unsigned, and an ordinary Roll
// update must not hit the entitlement gate.
// Any regression in either path fails this contract instead of being skipped.
//
// Typed surfaces exercised (all via the real tool.execute path, never pageEval):
//   world_status, foundry_page_eval, static/play context, compendium browse, content
//   search, actor create/read/update, conditions set, image (PNG/JPEG/WebP upload,
//   Actor/Item/JournalEntryPage apply, syncPlacedTokens across two Scenes), scene import
//   (create/update), scene apply (create, Token update, activate, delete, local
//   background), scene portal (pair lifecycle, stale-read rejection, Token transfer,
//   real player visibility and GM gating), actor grant items, advancement plan +
//   actor advance, and non-combat narrative executeAction (cantrip plus a real
//   1st-level slot). pageEval is used only
//   for native fixtures (Folder, Item, JournalEntryPage, canvas-rendered image bytes,
//   Token selection) and for the two backend probes.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const prefix = `--${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const BASE = (option("base", process.env.MT_COMPAT_BASE ?? "https://mtlocal.internal:30002/user-files/compat-fix-agent-runtime-integration")).replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const COMPAT_ROOT = path.resolve(option("compat-root", process.env.MT_FOUNDRY_COMPAT_ROOT
  ?? path.resolve(appRoot, "../../../mt-foundry-compat-fix-agent-runtime")));
const OUT_DIR = path.resolve(option("out", "/tmp/arcane-desktop-contract-mtcompat-image"));
const KEEP = args.includes("--keep");
const WATCHDOG_MS = Math.max(60_000, Number(option("watchdog-ms", "900000")) || 900_000);
const GM_USER = process.env.MT_USER ?? "spike-gm";
const GM_PASS = process.env.MT_PASS ?? "";
const PLAYER_USER = process.env.MT_PLAYER_USER ?? null;
const PLAYER_PASS = process.env.MT_PLAYER_PASS ?? "";
const RUN_ID = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
const CAMPAIGN_PREFIX = "[desktop-contract-mtcompat-image]";
const CAMPAIGN_NAME = `${CAMPAIGN_PREFIX} ${RUN_ID}`;

process.env.MT_API_BASE ??= ORIGIN;
process.env.MT_REALM ??= "arcanevtt";
process.env.MT_CLIENT_ID ??= "arcanevtt";

mkdirSync(OUT_DIR, { recursive: true });

const report = {
  schema: "arcane-desktop-contract/v1",
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  base: BASE,
  compatRoot: COMPAT_ROOT,
  outDir: OUT_DIR,
  mode: "real-tool-host + real-runtime + playwright-page",
  campaign: null,
  runtime: null,
  coverage: {},
  checks: [],
  failures: [],
  environmentFailures: [],
  notCovered: [
    "Electron window/panel UI: no BrowserWindow, renderer, foundry_open or approval UI participates",
    "Keycloak interactive browser login: the campaign and page session use the real Keycloak password grant token",
    "combat and automatic (midi/roll) execution: only the non-combat narrative path is exercised",
    "Ring-enabled Token image synchronization: the fixture Actors keep ring.enabled false",
    "Lobby tools (foundry_lobby_*): covered by the separate lobby harness",
    "Cancellation/timeout interruption of typed writes: unit-tested, not repeated here",
  ],
  commands: {},
  checksSummary: {},
};

function saveReport() {
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

const watchdog = setTimeout(() => {
  report.failures.push({ id: "harness.watchdog", detail: `watchdog fired after ${WATCHDOG_MS} ms` });
  console.error(`[contract] watchdog fired after ${WATCHDOG_MS} ms`);
  try { saveReport(); } catch { /* ignore */ }
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

function safeDetail(value, limit = 1200) {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function check(id, ok, detail) {
  const state = ok ? "pass" : "fail";
  report.checks.push({ id, state, detail: safeDetail(detail) });
  if (!ok) report.failures.push({ id, detail: safeDetail(detail) });
  console.log(`  ${ok ? "✔" : "✘"} ${id}${detail === undefined ? "" : ` — ${safeDetail(detail, 400)}`}`);
  return ok;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchStatus(url) {
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  } catch (error) {
    return { status: null, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/**
 * Playwright page → Electron webContents surface actually consumed by Desktop:
 * `evaluateNavigationSafe` (executeJavaScript + did-start-navigation/destroyed),
 * `readFoundryPageState`, `readPageAgentRuntimeSource` and `captureFoundryInputContext`.
 * This keeps foundry-web.js and the WebContentsFoundryTransport production code in the loop.
 */
function createPageContents(page) {
  const listeners = new Map();
  const add = (event, fn) => {
    const list = listeners.get(event) ?? [];
    list.push(fn);
    listeners.set(event, list);
  };
  const remove = (event, fn) => {
    const list = listeners.get(event) ?? [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  const emit = (event, ...payload) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(...payload); };
  let lastUrl = page.url();
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const realNavigation = url.split("#")[0] !== lastUrl.split("#")[0];
    lastUrl = url;
    if (realNavigation) emit("did-start-navigation", {}, url, false, true);
  });
  page.on("close", () => emit("destroyed"));
  return {
    isDestroyed: () => page.isClosed(),
    executeJavaScript: (code) => page.evaluate(code),
    on: add,
    off: remove,
  };
}

function resolvePlaywright() {
  const explicit = option("playwright", process.env.MT_PLAYWRIGHT_MODULE);
  const candidates = [
    explicit,
    path.join(appRoot, "node_modules", "playwright", "index.mjs"),
    path.join(COMPAT_ROOT, "node_modules", "playwright", "index.mjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { statSync(candidate); return candidate; } catch { /* next */ }
  }
  const require = createRequire(path.join(COMPAT_ROOT, "package.json"));
  try { return require.resolve("playwright"); } catch { /* fall through */ }
  throw new Error("Playwright not found: pass --playwright=<module> or set MT_PLAYWRIGHT_MODULE");
}

function readCompatFile(relative) {
  return readFileSync(path.join(COMPAT_ROOT, relative), "utf8");
}

async function main() {
  if (!GM_PASS) {
    console.error("[contract] MT_PASS is required (the local-stack Keycloak account password is never stored in the repository)");
    process.exit(2);
  }
  console.log(`[contract] base=${BASE}`);
  console.log(`[contract] compat=${COMPAT_ROOT}`);
  console.log(`[contract] out=${OUT_DIR}`);

  // ---- compat working tree (read-only) ------------------------------------
  const runtimeFile = path.join(COMPAT_ROOT, "web", "agent-runtime.js");
  const runtimeText = readCompatFile("web/agent-runtime.js");
  const { loadRuntimeSource } = await import(pathToFileURL(path.join(COMPAT_ROOT, "tools", "arcane-e2e", "lib", "sdk.mjs")).href);
  const compatRuntime = loadRuntimeSource(COMPAT_ROOT);
  report.runtime = {
    worktreeFile: runtimeFile,
    worktreeSha256: digest(Buffer.from(runtimeText)),
    header: compatRuntime.header,
    version: compatRuntime.version,
    protocolVersion: compatRuntime.protocolVersion,
    sourceBytes: compatRuntime.source.length,
  };
  check("runtime.worktree-readable", statSync(runtimeFile).isFile() && runtimeText.length > 100_000, {
    file: runtimeFile, bytes: runtimeText.length, header: compatRuntime.header,
  });

  // ---- REST: isolated campaign -------------------------------------------
  const { login, mtApi } = await import(pathToFileURL(path.join(COMPAT_ROOT, "tools", "mt-client.mjs")).href);
  const auth = await login(GM_USER, GM_PASS);
  const api = mtApi(auth.token);
  await api.get("/api/profiles/me").catch(() => {});
  const campaign = await api.post("/api/campaigns", { name: CAMPAIGN_NAME, ruleset: "2024" });
  const campaignId = campaign?.id;
  if (!campaignId) throw new Error(`campaign creation failed for ${CAMPAIGN_NAME}`);
  report.campaign = { id: campaignId, name: CAMPAIGN_NAME, user: GM_USER };
  check("setup.campaign", campaign?.ruleset === "2024", { campaign: campaignId, ruleset: campaign?.ruleset });

  let browser = null;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "arcane-contract-"));
  const prepDir = path.join(rootDir, "prep");
  const workDir = path.join(rootDir, "work");
  mkdirSync(prepDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  try {
    // ---- page -------------------------------------------------------------
    const { chromium } = await import(pathToFileURL(resolvePlaywright()).href);
    const launch = {
      headless: !args.includes("--headed"),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    };
    const chrome = process.env.MT_CHROME ?? "/usr/bin/google-chrome";
    try { statSync(chrome); launch.executablePath = chrome; } catch { /* playwright default */ }
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("pageerror", error => consoleErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on("console", message => {
      if (message.type() === "error" && consoleErrors.length < 40) consoleErrors.push(message.text().slice(0, 300));
    });
    await page.addInitScript(([token, id]) => {
      sessionStorage.setItem("mt.session", JSON.stringify({ access_token: token, refresh_token: null }));
      sessionStorage.setItem("mt.campaign", id);
    }, [auth.token, campaignId]);
    const playUrl = `${BASE}/play.html?campaign=${encodeURIComponent(campaignId)}`;
    report.commands.playUrl = playUrl;
    await page.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const ready = await page.waitForFunction(
      () => window.__MT_READY__ === true && typeof window.__MT_AGENT_RUNTIME__ === "function"
        && typeof window.__MT_AGENT_RUNTIME_SOURCE__ === "string",
      undefined,
      { timeout: 180_000, polling: 300 },
    ).then(() => true, () => false);
    if (!ready) {
      throw new Error(`play page did not become ready: ${page.url().slice(0, 120)}`);
    }
    const deployedFace = await page.evaluate(() => ({
      header: String(window.__MT_AGENT_RUNTIME_SOURCE__ ?? "").split("\n")[0],
      sourceBytes: String(window.__MT_AGENT_RUNTIME_SOURCE__ ?? "").length,
      hasHandle: typeof window.__MT_AGENT_RUNTIME__ === "function",
      hasImportFile: typeof game?.scenes?.directory?._importSceneJsonFile === "function",
      hasApplyImport: typeof game?.scenes?.directory?._applySceneImport === "function",
      worldId: game?.world?.id ?? null,
      gm: game?.user?.isGM === true,
    }));
    report.runtime.deployedFace = deployedFace;
    check("setup.page-ready", deployedFace.hasHandle && deployedFace.gm === true && deployedFace.worldId === campaignId, deployedFace);
    check("setup.page-surfaces", deployedFace.hasImportFile, {
      _importSceneJsonFile: deployedFace.hasImportFile,
      _applySceneImport: deployedFace.hasApplyImport,
    });

    // Install the compat working-tree runtime into the real page. The deployed face may
    // lag (it is read-only for this repo); the page runtime under test must be the file
    // the task names. The IIFE registers __MT_AGENT_RUNTIME__/__MT_AGENT_RUNTIME_SOURCE__.
    await page.addScriptTag({ content: runtimeText });
    const installed = await page.evaluate(() => ({
      header: String(window.__MT_AGENT_RUNTIME_SOURCE__ ?? "").split("\n")[0],
      source: String(window.__MT_AGENT_RUNTIME_SOURCE__ ?? ""),
      handle: typeof window.__MT_AGENT_RUNTIME__,
    }));
    check("runtime.page-installed-from-worktree", installed.handle === "function"
      && installed.header === compatRuntime.header, { header: installed.header, bytes: installed.source.length });
    check("runtime.page-source-is-worktree-source", installed.source === compatRuntime.source, {
      pageBytes: installed.source.length, worktreeBytes: compatRuntime.source.length,
    });

    // ---- Desktop transport / runtime --------------------------------------
    const contents = createPageContents(page);
    const AZ = path.resolve(appRoot, "src/main");
    const { DirectFoundryRuntime, PageProfileRoutedRuntime, adoptMtcompatRuntimeFromPage, createMtcompatRuntimeClient, resolveMtAgentRuntimeSource } = await import(pathToFileURL(path.join(AZ, "direct-foundry-runtime.js")).href);
    const { readFoundryPageState, readPageAgentRuntimeSource, evaluateNavigationSafe } = await import(pathToFileURL(path.join(AZ, "foundry-web.js")).href);
    const { captureFoundryInputContext } = await import(pathToFileURL(path.join(AZ, "foundry-input-context.js")).href);
    const { AgentHost } = await import(pathToFileURL(path.join(AZ, "agent-host.js")).href);
    const { PAGE_PROFILES } = await import(pathToFileURL(path.join(AZ, "page-profiles.js")).href);

    const createRuntime = runtimeSource => createMtcompatRuntimeClient({
      runtimeSource,
      getWebContents: () => contents,
      log: (level, message) => console.log(`  [runtime:${level}] ${message}`),
    });
    const foundryRuntime = new DirectFoundryRuntime({
      getWebContents: () => contents,
      readyPollMs: 100,
      log: (level, message) => console.log(`  [foundry-runtime:${level}] ${message}`),
    });
    // Production starts the mtcompat client from the packaged copy; adoption then swaps
    // in the page source. resolveMtAgentRuntimeSource is the real loader for that copy.
    const bundled = resolveMtAgentRuntimeSource({
      bundledFile: path.join(appRoot, "runtime", "mt-agent-runtime.js"),
    });
    let injectedSource = null;
    const routed = new PageProfileRoutedRuntime({
      foundry: foundryRuntime,
      mtcompat: bundled ? createRuntime(bundled.source) : null,
      getActiveProfileId: () => PAGE_PROFILES.mtcompat.id,
      log: message => console.log(`  [route] ${message}`),
    });
    const adopt = currentSource => adoptMtcompatRuntimeFromPage({
      routed,
      currentSource,
      readPageSource: () => readPageAgentRuntimeSource(contents, { timeoutMs: 5_000 }),
      createRuntime: source => {
        injectedSource = source;
        return createRuntime(source);
      },
      log: (level, message) => console.log(`  [adopt:${level}] ${message}`),
    });
    let adopted = await adopt(bundled?.source ?? null);
    let adoptionMode = "bundled-source-prior";
    if (!adopted.adopted && adopted.reason === "unchanged") {
      // The packaged fallback copy already equals the page source (a valid production
      // short-circuit). Re-adopt as the cold-start path so the handle branch still runs.
      adopted = await adopt(null);
      adoptionMode = "cold-start";
    }
    check("runtime.adopted-from-page", adopted.adopted === true && adopted.reason === "adopted", {
      reason: adopted.reason,
      adoptionMode,
      bundledSource: Boolean(bundled?.source),
      sourceBytes: adopted.source?.length ?? null,
    });
    check("runtime.page-source-reported", adopted.source === compatRuntime.source, {
      bytes: adopted.source?.length, header: String(adopted.source ?? "").split("\n")[0],
    });
    // The handle-delegation branch: a self-contained delegate, never Function.toString of
    // the page function (minified builds lose outer closure variables that way).
    check("runtime.handle-delegation-injected",
      typeof injectedSource === "string"
        && injectedSource.includes("globalThis.__MT_AGENT_RUNTIME__")
        && injectedSource.length < 400
        && !injectedSource.includes("prepPrepareImage"), {
        bytes: injectedSource?.length ?? null,
      });

    // Prove calls really go through the live page handle: wrap it, then count.
    report.runtime.handleCapabilities = await page.evaluate(() => ({
      has32MiBLimit: String(window.__MT_AGENT_RUNTIME__).includes("MAX_IMAGE_UPLOAD_BYTES"),
    }));
    check("runtime.handle-uses-candidate-code", report.runtime.handleCapabilities.has32MiBLimit,
      report.runtime.handleCapabilities);
    await page.evaluate(() => {
      const handle = window.__MT_AGENT_RUNTIME__;
      window.__MT_E2E_CALLS__ = 0;
      window.__MT_AGENT_RUNTIME__ = async (action, args, options) => {
        window.__MT_E2E_CALLS__ += 1;
        return handle(action, args, options);
      };
    });
    const runtimeCalls = () => page.evaluate(() => window.__MT_E2E_CALLS__ ?? 0);
    report.coverage.pageHandleDelegation = true;

    // ---- real host: AgentHost + tool pool ---------------------------------
    const view = { webContents: contents };
    const host = new AgentHost({
      foundryRuntime: routed,
      getFoundryView: () => view,
      openFoundry: async () => ({ ok: true, summary: "contract harness" }),
      sendToRenderer: () => {},
      log: () => {},
      profile: { mode: "prep", getCwd: () => prepDir },
      getPanelProfileId: () => PAGE_PROFILES.mtcompat.id,
      operationStorageDir: workDir,
      taskStorageDir: path.join(workDir, "tasks"),
    });
    host.describeCurrent = () => ({ id: "contract-e2e" });
    const inputContext = await captureFoundryInputContext(contents);
    if (!inputContext?.world?.id) throw new Error("captureFoundryInputContext returned no world");
    check("setup.input-binding", inputContext.world.id === campaignId && inputContext.world.origin === ORIGIN, inputContext);
    // Task admission seam: the real host builds this object in TaskCoordinator.currentInputBinding();
    // the harness supplies the same shape with the real capture above because there is no model turn.
    host.taskCoordinator = () => ({
      currentInputBinding: () => ({ taskId: "contract-task", inputId: "contract-input", metadata: Promise.resolve(inputContext) }),
    });

    const tools = new Map(host.buildTools().map(tool => [tool.name, tool]));
    const required = ["world_status", "foundry_page_eval", "foundry_image", "foundry_scene_get",
      "foundry_scene_import", "foundry_scene_portal", "foundry_actor_get", "foundry_actor_create", "foundry_actor_update",
      "foundry_conditions_set", "foundry_static_context", "foundry_play_context",
      "foundry_compendium_browse", "foundry_content_search"];
    check("setup.tool-pool", required.every(name => tools.has(name)), {
      missing: required.filter(name => !tools.has(name)),
    });
    report.coverage.toolPoolSize = tools.size;

    let callSeq = 0;
    const invoke = async (name, params, { id } = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} is not registered`);
      const toolCallId = id ?? `${name}-${++callSeq}`;
      const started = Date.now();
      const result = await tool.execute(toolCallId, params);
      const text = String(result.content?.[0]?.text ?? "");
      const entry = {
        id: `tool.${name}`,
        state: result.isError ? "fail" : "pass",
        detail: safeDetail({ toolCallId, text: text.slice(0, 700) }, 1000),
      };
      report.checks.push(entry);
      if (result.isError) report.failures.push({ id: `tool.${name}`, detail: text.slice(0, 700) });
      console.log(`  ${result.isError ? "✘" : "✔"} tool ${name} (${Date.now() - started} ms)`);
      return { details: result.details, text, isError: Boolean(result.isError), toolCallId };
    };

    // ---- worldInfo --------------------------------------------------------
    const world = await invoke("world_status", {});
    check("world.info", world.details?.runtime?.name === "mt-agent-runtime"
      && world.details?.runtime?.protocolVersion === 3
      && world.details?.world?.id === campaignId
      && world.details?.user?.isGM === true
      && String(world.details?.page?.path ?? "").endsWith("/play.html"), {
      runtime: world.details?.runtime, world: world.details?.world, user: world.details?.user, page: world.details?.page,
    });

    // ---- pageEval ---------------------------------------------------------
    const pageEval = await invoke("foundry_page_eval", {
      code: "return { ready: game.ready === true, gm: game.user?.isGM === true, scenes: [...game.scenes].length };",
    });
    check("pageEval.receipt", pageEval.details?.status === "completed"
      && pageEval.details?.value?.ready === true
      && pageEval.details?.value?.gm === true
      && Array.isArray(pageEval.details?.touched)
      && Array.isArray(pageEval.details?.missing), pageEval.details);

    // ---- static / play context -------------------------------------------
    const staticContext = await invoke("foundry_static_context", {});
    const playContext = await invoke("foundry_play_context", { view: "current" });
    check("context.static-and-play", staticContext.details?.schema === "arcane.play.v1"
      && typeof staticContext.details?.contextRef === "string"
      && playContext.details?.schema === "arcane.play.v1"
      && typeof playContext.details?.contextRef === "string", {
      staticRef: staticContext.details?.contextRef, playRef: playContext.details?.contextRef,
    });

    // ---- compendium / content read ---------------------------------------
    const compendium = await invoke("foundry_compendium_browse", { scope: "compendium", type: "spell", rules: "2024", pageSize: 3 });
    check("content.compendium-read", compendium.details?.status === "completed"
      && Array.isArray(compendium.details?.candidates)
      && compendium.details.candidates.length > 0
      && compendium.details.candidates.every(entry => String(entry.uuid).startsWith("Compendium.")), {
      candidates: compendium.details?.candidates?.length,
    });

    // ---- fixture: Actor Folder (no typed tool exists for folders) --------
    const folderFixture = await invoke("foundry_page_eval", {
      code: "const folder = await CONFIG.Folder.documentClass.create({ name: 'Contract Actors', type: 'Actor' }); return { folderId: folder.id };",
    });
    const folderId = folderFixture.details?.value?.folderId ?? null;
    check("fixture.actor-folder", typeof folderId === "string" && folderId.length > 0, { folderId });

    // ---- actorCreate / actorRead / actorEdit (Folder) --------------------
    const actorName = `Contract NPC ${RUN_ID}`;
    const created = await invoke("foundry_actor_create", {
      source: { kind: "blank", actorType: "npc" }, name: actorName, folderId,
    });
    const actorUuid = created.details?.verification?.[0]?.actorUuid ?? null;
    check("actor.create-with-folder", created.details?.status === "completed"
      && typeof actorUuid === "string", { status: created.details?.status, actorUuid });

    const readActor = await invoke("foundry_actor_get", { actorUuid, include: ["prototypeToken", "items"] });
    check("actor.read-folder", readActor.details?.folderId === folderId
      && typeof readActor.details?.readRef === "string", { folderId: readActor.details?.folderId });

    const edited = await invoke("foundry_actor_update", {
      actorUuid, readRef: readActor.details.readRef,
      changes: { name: `${actorName} renamed`, folderId: null, prototypeToken: { disposition: 0 } },
    });
    check("actor.edit-rename-and-unfolder", edited.details?.status === "completed"
      && edited.details?.steps?.some(step => step.step === "folder" && step.after === null)
      && edited.details?.steps?.some(step => step.step === "name"), edited.details?.steps);

    const reread = await invoke("foundry_actor_get", { actorUuid });
    check("actor.reread", reread.details?.name === `${actorName} renamed` && reread.details?.folderId === null, {
      name: reread.details?.name, folderId: reread.details?.folderId,
    });
    const missingFolder = await invoke("foundry_actor_update", {
      actorUuid, readRef: reread.details.readRef, changes: { folderId: "NoSuchFolder" },
    });
    check("actor.edit-unknown-folder-rejected", missingFolder.details?.status === "rejected"
      && missingFolder.details?.code === "FOLDER_NOT_FOUND", missingFolder.details);

    // ---- conditionsSet ---------------------------------------------------
    const conditionsOn = await invoke("foundry_conditions_set", {
      targets: [{ kind: "actor", actorUuid }], conditions: [{ key: "prone", active: true }],
    });
    check("conditions.set", conditionsOn.details?.status === "completed"
      && conditionsOn.details?.verification?.some(entry => entry.after === true), conditionsOn.details);
    const conditionsOff = await invoke("foundry_conditions_set", {
      targets: [{ kind: "actor", actorUuid }], conditions: [{ key: "prone", active: false }],
    });
    check("conditions.clear", conditionsOff.details?.status === "completed"
      && conditionsOff.details?.verification?.some(entry => entry.after === false), conditionsOff.details);

    // ---- image: local upload + apply to Actor / Item / Journal -----------
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    writeFileSync(path.join(prepDir, "map.png"), png);
    const pngHash = digest(png);

    const uploaded = await invoke("foundry_image", { sourcePath: "map.png" });
    const uploadedUrl = typeof uploaded.details?.dataPath === "string" && /^https:\/\//.test(uploaded.details.dataPath)
      ? uploaded.details.dataPath : null;
    check("image.upload-local-png", uploaded.details?.status === "completed"
      && uploadedUrl !== null
      && uploaded.details?.steps?.some(step => step.step === "upload-image" && step.state === "completed")
      && !uploaded.text.includes(png.toString("base64")), {
      dataPath: uploadedUrl, steps: uploaded.details?.steps?.map(step => step.step),
    });

    const actorImage = await invoke("foundry_image", { sourcePath: "map.png", targetUuid: actorUuid });
    check("image.apply-actor", actorImage.details?.status === "completed"
      && actorImage.details?.steps?.some(step => step.step === "img" && step.after === uploadedUrl)
      && actorImage.details?.steps?.some(step => String(step.step).startsWith("prototypeToken.") && step.after === uploadedUrl), {
      dataPath: actorImage.details?.dataPath, steps: actorImage.details?.steps?.map(step => `${step.step}:${step.state}`),
    });
    const actorReadImage = await invoke("foundry_actor_get", { actorUuid });
    check("image.actor-img-persisted", actorReadImage.details?.img === uploadedUrl, { img: actorReadImage.details?.img });

    const itemFixture = await invoke("foundry_page_eval", {
      code: "const item = await CONFIG.Item.documentClass.create({ name: 'Contract Loot', type: 'loot' }); return { itemUuid: item.uuid };",
    });
    const itemUuid = itemFixture.details?.value?.itemUuid ?? null;
    const itemImage = uploadedUrl
      ? await invoke("foundry_image", { dataPath: uploadedUrl, targetUuid: itemUuid })
      : null;
    check("image.apply-item", itemImage?.details?.status === "completed"
      && itemImage.details?.steps?.some(step => step.step === "document-image" && step.after === uploadedUrl)
      && itemImage.details?.verification?.[0]?.targetUuid === itemUuid, itemImage?.details);

    const journalFixture = await invoke("foundry_page_eval", {
      code: "const journal = await CONFIG.JournalEntry.documentClass.create({ name: 'Contract Journal' }); const pages = await journal.createEmbeddedDocuments('JournalEntryPage', [{ name: 'Contract Map', type: 'image', src: '' }]); return { pageUuid: pages?.[0]?.uuid ?? null };",
    });
    const pageUuid = journalFixture.details?.value?.pageUuid ?? null;
    const journalImage = uploadedUrl
      ? await invoke("foundry_image", { dataPath: uploadedUrl, targetUuid: pageUuid })
      : null;
    check("image.apply-journal-page", journalImage?.details?.status === "completed"
      && journalImage.details?.steps?.some(step => step.step === "document-image" && step.after === uploadedUrl), journalImage?.details);

    const appliedReadback = await invoke("foundry_page_eval", {
      code: `const item = await fromUuid(${JSON.stringify(itemUuid)}); const page = await fromUuid(${JSON.stringify(pageUuid)});
        return { itemImg: item?.img ?? null, pageSrc: page?.src ?? null };`,
    });
    check("image.targets-readback", appliedReadback.details?.value?.itemImg === uploadedUrl
      && appliedReadback.details?.value?.pageSrc === uploadedUrl, appliedReadback.details?.value);


    // ---- scene import: create with local JSON + background in one call ---
    const sceneName = `Contract Scene ${RUN_ID}`;
    const sceneJson = {
      name: sceneName,
      width: 1400,
      height: 1000,
      padding: 0.1,
      grid: { type: 1, size: 100, distance: 5, units: "ft" },
      environment: { darknessLevel: 0.2 },
      walls: [
        { c: [0, 0, 1000, 0], move: 20, sight: 20, sound: 20 },
        { c: [1000, 0, 1000, 700], move: 20, sight: 20, sound: 20 },
        { c: [0, 0, 0, 700], move: 20, sight: 20, sound: 20 },
      ],
      lights: [{ x: 400, y: 350, dim: 60, bright: 30, color: "#ffaa00", alpha: 0.6 }],
    };
    writeFileSync(path.join(prepDir, "scene.json"), JSON.stringify(sceneJson));
    const imported = await invoke("foundry_scene_import", {
      operation: "create", sourcePath: "scene.json", backgroundSourcePath: "map.png",
    });
    const sceneUuid = imported.details?.sceneUuid ?? null;
    check("scene.import-receipt-readable", !imported.text.includes("[Circular]")
      && imported.details?.steps?.find(step => step.step === "import-scene-json")?.stats?.walls === 3, {
      text: imported.text.slice(0, 300),
    });
    check("scene.import-create", imported.details?.status === "completed"
      && typeof sceneUuid === "string"
      && imported.details?.stats?.walls === 3
      && imported.details?.stats?.lights === 1
      && imported.details?.stats?.gridSize === 100
      && imported.details?.dataPath === uploadedUrl
      && imported.details?.verification?.[0]?.name === sceneName
      && imported.details?.steps?.some(step => step.step === "create-scene" && step.state === "completed")
      && imported.details?.steps?.some(step => step.step === "import-scene-json" && step.state === "completed"), {
      status: imported.details?.status, sceneUuid, stats: imported.details?.stats,
      dataPath: imported.details?.dataPath, steps: imported.details?.steps?.map(step => step.step),
    });

    const sceneRead = await invoke("foundry_scene_get", { sceneUuid, include: ["walls", "lights", "tiles", "notes", "sounds"] });
    check("scene.read-after-import", sceneRead.details?.name === sceneName
      && sceneRead.details?.sceneUuid === sceneUuid, { name: sceneRead.details?.name, sceneUuid: sceneRead.details?.sceneUuid });
    check("scene.walls-and-lights-imported",
      (sceneRead.details?.placeables?.walls?.length ?? -1) === 3
      && (sceneRead.details?.placeables?.lights?.length ?? -1) === 1
      && sceneRead.details?.["background.src"] === uploadedUrl, {
      walls: sceneRead.details?.placeables?.walls?.length,
      lights: sceneRead.details?.placeables?.lights?.length,
      background: sceneRead.details?.["background.src"],
    });
    const sceneReadRef = sceneRead.details?.readRef ?? null;
    check("scene.read-ref", typeof sceneReadRef === "string", { readRef: sceneReadRef });

    // ---- scene import: update via readRef --------------------------------
    const sceneJson2 = {
      name: `${sceneName} v2`,
      width: 1000,
      height: 800,
      grid: { type: 1, size: 70, distance: 5, units: "ft" },
      walls: [{ c: [0, 0, 100, 0], move: 20, sight: 20, sound: 20 }],
      lights: [],
    };
    writeFileSync(path.join(prepDir, "scene2.json"), JSON.stringify(sceneJson2));
    const updated = await invoke("foundry_scene_import", {
      operation: "update", sceneUuid, readRef: sceneReadRef, sourcePath: "scene2.json",
    });
    check("scene.import-update", updated.details?.status === "completed"
      && updated.details?.stats?.walls === 1
      && updated.details?.stats?.gridSize === 70
      && updated.details?.verification?.[0]?.name === `${sceneName} v2`, {
      status: updated.details?.status, stats: updated.details?.stats, name: updated.details?.verification?.[0]?.name,
    });
    const rereadScene = await invoke("foundry_scene_get", { sceneUuid, include: ["walls", "lights"] });
    check("scene.update-readback", rereadScene.details?.placeables?.walls?.length === 1
      && rereadScene.details?.placeables?.lights?.length === 0
      && rereadScene.details?.["grid.size"] === 70, {
      walls: rereadScene.details?.placeables?.walls?.length,
      lights: rereadScene.details?.placeables?.lights?.length,
      grid: rereadScene.details?.["grid.size"],
    });

    // ---- scene import: JSON-declared bare HTTPS background (no local file)
    const remoteBackground = `${BASE}/img/demo-map-hall.jpg`;
    const remoteStatus = await fetchStatus(remoteBackground);
    const sceneJson3 = {
      name: `${sceneName} remote`,
      width: 900,
      height: 700,
      background: { src: remoteBackground },
      grid: { type: 1, size: 90, distance: 5, units: "ft" },
      walls: [],
      lights: [],
    };
    writeFileSync(path.join(prepDir, "scene3.json"), JSON.stringify(sceneJson3));
    const importedRemote = await invoke("foundry_scene_import", { operation: "create", sourcePath: "scene3.json" });
    check("scene.import-json-https-background", importedRemote.details?.status === "completed"
      && importedRemote.details?.dataPath === remoteBackground
      && importedRemote.details?.verification?.[0]?.["background.src"] === remoteBackground, {
      status: importedRemote.details?.status,
      dataPath: importedRemote.details?.dataPath,
      fetchStatus: remoteStatus.status,
    });

    // ---- failure paths stay on the Desktop fenced side -------------------
    writeFileSync(path.join(rootDir, "outside.json"), "{}");
    const outsideScene = await invoke("foundry_scene_import", { operation: "create", sourcePath: "../outside.json" });
    check("scene.path-fence", outsideScene.details?.status === "rejected"
      && outsideScene.details?.code === "SCENE_PATH_OUTSIDE_CWD", outsideScene.details);
    const outsideImage = await invoke("foundry_scene_import", {
      operation: "create", sourcePath: "scene.json", backgroundSourcePath: path.join(rootDir, "outside.json"),
    });
    check("scene.background-path-fence", outsideImage.details?.status === "rejected"
      && outsideImage.details?.code === "IMAGE_PATH_OUTSIDE_CWD", outsideImage.details);
    const missingRef = await invoke("foundry_scene_import", { operation: "update", sceneUuid, sourcePath: "scene2.json" });
    check("scene.update-without-readref-rejected", missingRef.details?.status === "rejected"
      && missingRef.details?.code === "INPUT_INVALID", missingRef.details);

    // ---- idempotency: identical tool call replays without a second dispatch
    writeFileSync(path.join(prepDir, "scene4.json"), JSON.stringify({
      ...sceneJson3, name: `${sceneName} replay`, background: { src: remoteBackground },
    }));
    const callsBeforeReplay = await runtimeCalls();
    const replayId = `scene-replay-${Date.now()}`;
    const first = await invoke("foundry_scene_import", { operation: "create", sourcePath: "scene4.json" }, { id: replayId });
    const callsAfterFirst = await runtimeCalls();
    const replay = await invoke("foundry_scene_import", { operation: "create", sourcePath: "scene4.json" }, { id: replayId });
    const callsAfterReplay = await runtimeCalls();
    check("scene.import-replay-idempotent",
      replay.details?.operationRef === first.details?.operationRef
      && callsAfterReplay === callsAfterFirst
      && callsAfterFirst > callsBeforeReplay, {
      firstRef: first.details?.operationRef, replayRef: replay.details?.operationRef,
      calls: [callsBeforeReplay, callsAfterFirst, callsAfterReplay],
    });
    const conflict = await invoke("foundry_scene_import", { operation: "create", sourcePath: "scene.json", backgroundSourcePath: "map.png" }, { id: replayId });
    check("scene.import-same-id-different-input-conflicts", conflict.details?.status === "rejected"
      && conflict.details?.code === "TOOL_CALL_CONFLICT", conflict.details);

    // ---- image: JPEG and WebP fixtures rendered by the real page canvas ---
    // The fixtures come from the page's own canvas encoder + Chromium decoder, so the
    // bytes are real JPEG/WebP rather than hand-written magic bytes.
    const canvasFixtures = await invoke("foundry_page_eval", {
      code: `const draw = (type, quality) => {
          const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 48;
          const ctx = canvas.getContext("2d");
          const gradient = ctx.createLinearGradient(0, 0, 64, 48);
          gradient.addColorStop(0, "#204060"); gradient.addColorStop(1, "#c05a20");
          ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 48);
          ctx.fillStyle = "#ffcc66"; ctx.fillRect(8, 8, 20, 12);
          return canvas.toDataURL(type, quality); };
        return { jpeg: draw("image/jpeg", 0.92), webp: draw("image/webp", 0.9) };`,
    });
    const dataUrlBytes = dataUrl => Buffer.from(String(dataUrl).split(",")[1] ?? "", "base64");
    const jpeg = dataUrlBytes(canvasFixtures.details?.value?.jpeg);
    const webp = dataUrlBytes(canvasFixtures.details?.value?.webp);
    writeFileSync(path.join(prepDir, "fixture.jpg"), jpeg);
    writeFileSync(path.join(prepDir, "fixture.webp"), webp);
    check("fixture.canvas-jpeg-webp", jpeg.length > 200 && webp.length > 100
      && String(canvasFixtures.details?.value?.jpeg).startsWith("data:image/jpeg;base64,")
      && String(canvasFixtures.details?.value?.webp).startsWith("data:image/webp;base64,"), {
      jpegBytes: jpeg.length, webpBytes: webp.length,
    });

    const signedAssetUrl = url => page.evaluate(async rawUrl => {
      const mod = await import(new URL("asset-sign.mjs", document.baseURI).href);
      return mod.signUrl(rawUrl);
    }, url);
    const imageProbes = [];
    if (uploadedUrl) imageProbes.push({ kind: "png", url: uploadedUrl });
    for (const [kind, file, extension] of [["jpeg", "fixture.jpg", "jpg"], ["webp", "fixture.webp", "webp"]]) {
      const applied = await invoke("foundry_image", { sourcePath: file, targetUuid: actorUuid });
      const appliedUrl = typeof applied.details?.dataPath === "string" ? applied.details.dataPath : null;
      if (appliedUrl) imageProbes.push({ kind, url: appliedUrl });
      check(`image.upload-${kind}-and-apply`, applied.details?.status === "completed"
        && appliedUrl !== null
        && new RegExp(`\\.${extension}$`).test(new URL(appliedUrl).pathname)
        && applied.details?.steps?.some(step => step.step === "upload-image" && step.state === "completed")
        && applied.details?.steps?.some(step => step.step === "img" && step.after === appliedUrl)
        && applied.details?.steps?.some(step => String(step.step).startsWith("prototypeToken.") && step.after === appliedUrl)
        && !applied.text.includes(dataUrlBytes(canvasFixtures.details?.value?.[kind]).toString("base64")), {
        status: applied.details?.status, code: applied.details?.code, dataPath: appliedUrl,
        steps: applied.details?.steps?.map(step => `${step.step}:${step.state}`),
      });
    }
    const actorReadFormats = await invoke("foundry_actor_get", { actorUuid });
    check("image.formats-actor-img", actorReadFormats.details?.img === imageProbes.at(-1)?.url, {
      img: actorReadFormats.details?.img,
    });

    // ---- image: syncPlacedTokens across two Scenes -----------------------
    const syncActor = await invoke("foundry_actor_create", {
      source: { kind: "blank", actorType: "character" }, name: `Contract Sync ${RUN_ID}`,
    });
    const syncActorUuid = syncActor.details?.verification?.[0]?.actorUuid ?? null;
    const syncSceneA = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Sync A ${RUN_ID}`, width: 1000, height: 800, grid: { type: 1, size: 100, distance: 5, units: "ft" } },
      tokens: { create: [{ actorUuid: syncActorUuid, x: 120, y: 140, name: "Sync Token A", hidden: true }] },
    });
    const syncSceneB = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Sync B ${RUN_ID}`, width: 900, height: 700, grid: { type: 1, size: 80, distance: 5, units: "ft" } },
      tokens: { create: [{ actorUuid: syncActorUuid, x: 260, y: 280 }] },
    });
    const syncSceneAUuid = syncSceneA.details?.verification?.[0]?.sceneUuid ?? null;
    const syncSceneBUuid = syncSceneB.details?.verification?.[0]?.sceneUuid ?? null;
    check("scene.apply-create-two-scenes", syncSceneA.details?.status === "completed"
      && syncSceneB.details?.status === "completed"
      && syncSceneA.details?.verification?.[0]?.tokenCount === 1
      && syncSceneB.details?.verification?.[0]?.tokenCount === 1, {
      a: syncSceneA.details?.status, b: syncSceneB.details?.status,
      aTokens: syncSceneA.details?.verification?.[0]?.tokenCount,
      bTokens: syncSceneB.details?.verification?.[0]?.tokenCount,
    });
    const syncRead = await invoke("foundry_actor_get", { actorUuid: syncActorUuid, include: ["prototypeToken", "sceneTokens"] });
    check("actor.read-scene-tokens", Array.isArray(syncRead.details?.sceneTokens)
      && syncRead.details.sceneTokens.length === 2
      && new Set(syncRead.details.sceneTokens.map(entry => entry.sceneUuid)).size === 2, {
      sceneTokens: syncRead.details?.sceneTokens?.map(entry => entry.sceneUuid),
    });
    const synced = await invoke("foundry_image", {
      sourcePath: "fixture.webp", targetUuid: syncActorUuid, syncPlacedTokens: true,
    });
    const syncedUrl = typeof synced.details?.dataPath === "string" ? synced.details.dataPath : null;
    const syncTokenSteps = synced.details?.steps?.filter(step => step.step === "token-image") ?? [];
    check("image.sync-placed-tokens-steps", synced.details?.status === "completed"
      && syncTokenSteps.length === 2
      && syncTokenSteps.every(step => step.state === "completed"), {
      status: synced.details?.status, tokenSteps: syncTokenSteps.map(step => `${step.targets?.[0]}:${step.state}`),
    });
    // sceneRead's Token projection has no texture field, so the image readback is a
    // read-only page inspection; layout fields still come from the typed scene read.
    const syncReadA = await invoke("foundry_scene_get", { sceneUuid: syncSceneAUuid, include: ["tokens"] });
    const syncReadB = await invoke("foundry_scene_get", { sceneUuid: syncSceneBUuid, include: ["tokens"] });
    const syncTextures = await invoke("foundry_page_eval", {
      code: `const pick = (uuid) => [...game.scenes].find(scene => scene.uuid === uuid);
        const one = pick(${JSON.stringify(syncSceneAUuid)}); const two = pick(${JSON.stringify(syncSceneBUuid)});
        const shape = scene => scene ? [...scene.tokens].map(token => ({ name: token.name,
          src: token.texture?.src ?? token._source?.texture?.src ?? null })) : null;
        return { a: shape(one), b: shape(two) };`,
    });
    const tokenA = syncReadA.details?.placeables?.tokens?.[0];
    const tokenB = syncReadB.details?.placeables?.tokens?.[0];
    const textureA = syncTextures.details?.value?.a?.[0]?.src ?? null;
    const textureB = syncTextures.details?.value?.b?.[0]?.src ?? null;
    check("image.sync-placed-tokens-landed", syncedUrl !== null
      && textureA === syncedUrl && textureB === syncedUrl
      && tokenA?.x === 120 && tokenA?.y === 140 && tokenA?.name === "Sync Token A" && tokenA?.hidden === true
      && tokenB?.x === 260 && tokenB?.y === 280, {
      dataPath: syncedUrl, textureA, textureB, tokenA, tokenB,
    });
    const syncActorRead = await invoke("foundry_actor_get", { actorUuid: syncActorUuid, include: ["prototypeToken"] });
    check("image.sync-actor-and-prototype", syncActorRead.details?.img === syncedUrl
      && syncActorRead.details?.prototypeToken?.["texture.src"] === syncedUrl, {
      img: syncActorRead.details?.img, prototype: syncActorRead.details?.prototypeToken,
    });
    const syncOnItem = await invoke("foundry_image", { dataPath: syncedUrl ?? "", targetUuid: itemUuid, syncPlacedTokens: true });
    check("image.sync-requires-actor-target", syncOnItem.details?.status === "rejected"
      && syncOnItem.details?.code === "INPUT_INVALID", syncOnItem.details);

    // ---- sceneApply: token update, activation, deletion ------------------
    const applyScene = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Apply ${RUN_ID}`, width: 1200, height: 900, grid: { type: 1, size: 100, distance: 5, units: "ft" } },
      tokens: { create: [{ actorUuid, x: 100, y: 150, name: "Apply Token" }] },
    });
    const applySceneUuid = applyScene.details?.verification?.[0]?.sceneUuid ?? null;
    check("scene.apply-create", applyScene.details?.status === "completed"
      && applyScene.details?.verification?.[0]?.tokenCount === 1
      && applyScene.details?.verification?.[0]?.active === false, {
      status: applyScene.details?.status, verification: applyScene.details?.verification?.[0],
    });
    const applyRead = await invoke("foundry_scene_get", { sceneUuid: applySceneUuid, include: ["tokens"] });
    const applyToken = applyRead.details?.placeables?.tokens?.[0] ?? null;
    check("scene.apply-token-placement", applyToken?.x === 100 && applyToken?.y === 150
      && applyToken?.name === "Apply Token" && typeof applyRead.details?.readRef === "string", applyToken);
    const applyUpdated = await invoke("foundry_scene_apply", {
      operation: "update", sceneUuid: applySceneUuid, readRef: applyRead.details.readRef,
      scene: { active: true }, tokens: { update: [{ tokenId: applyToken.id, changes: { x: 400, y: 450, hidden: true } }] },
    });
    check("scene.apply-update-and-activate", applyUpdated.details?.status === "completed"
      && applyUpdated.details?.steps?.some(step => step.step === "update-tokens" && step.state === "completed")
      && applyUpdated.details?.steps?.some(step => step.step === "activate-scene" && step.state === "completed"), {
      status: applyUpdated.details?.status, steps: applyUpdated.details?.steps?.map(step => `${step.step}:${step.state}`),
    });
    const applyReread = await invoke("foundry_scene_get", { sceneUuid: applySceneUuid, include: ["tokens"] });
    check("scene.apply-update-landed", applyReread.details?.active === true
      && applyReread.details?.placeables?.tokens?.[0]?.x === 400
      && applyReread.details?.placeables?.tokens?.[0]?.y === 450
      && applyReread.details?.placeables?.tokens?.[0]?.hidden === true, {
      active: applyReread.details?.active, token: applyReread.details?.placeables?.tokens?.[0],
    });
    const applyDeleted = await invoke("foundry_scene_apply", {
      operation: "update", sceneUuid: applySceneUuid, readRef: applyReread.details.readRef,
      tokens: { deleteIds: [applyToken.id] },
    });
    const applyAfterDelete = await invoke("foundry_scene_get", { sceneUuid: applySceneUuid, include: ["tokens"] });
    check("scene.apply-delete-token", applyDeleted.details?.status === "completed"
      && applyDeleted.details?.steps?.some(step => step.step === "delete-tokens" && step.state === "completed")
      && (applyAfterDelete.details?.placeables?.tokens?.length ?? -1) === 0, {
      status: applyDeleted.details?.status, remaining: applyAfterDelete.details?.placeables?.tokens?.length,
    });

    // ---- sceneApply: local JPEG background in the same call --------------
    const applyBackground = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Apply BG ${RUN_ID}`, width: 900, height: 700,
        grid: { type: 1, size: 100, distance: 5, units: "ft" }, background: { sourcePath: "fixture.jpg" } },
    });
    const applyBackgroundUrl = applyBackground.details?.verification?.[0]?.["background.src"] ?? null;
    check("scene.apply-local-background", applyBackground.details?.status === "completed"
      && /\/fixture-|\.jpg$/.test(String(applyBackgroundUrl))
      && applyBackground.details?.steps?.some(step => step.step === "upload-image" && step.state === "completed"), {
      status: applyBackground.details?.status, background: applyBackgroundUrl,
      steps: applyBackground.details?.steps?.map(step => `${step.step}:${step.state}`),
    });
    if (applyBackgroundUrl) imageProbes.push({ kind: "scene-background", url: applyBackgroundUrl });

    // ---- scene portals: pair lifecycle, Token transfer and real player visibility ----
    const portalActor = await invoke("foundry_actor_create", {
      source: { kind: "blank", actorType: "npc" }, name: `Contract Portal ${RUN_ID}`,
    });
    const portalActorUuid = portalActor.details?.verification?.[0]?.actorUuid;
    const portalSource = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Portal Source ${RUN_ID}`, active: true, width: 1600, height: 1200,
        grid: { type: 1, size: 100, distance: 5, units: "ft" } },
      tokens: { create: [{ actorUuid: portalActorUuid, x: 100, y: 100, actorLink: false }] },
    });
    const portalTarget = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Portal Target ${RUN_ID}`, width: 1600, height: 1200,
        grid: { type: 1, size: 100, distance: 5, units: "ft" } },
    });
    const sourceSceneUuid = portalSource.details?.verification?.[0]?.sceneUuid;
    const targetSceneUuid = portalTarget.details?.verification?.[0]?.sceneUuid;
    const sourceSceneId = sourceSceneUuid?.startsWith("Scene.") ? sourceSceneUuid.slice(6) : null;
    const targetSceneId = targetSceneUuid?.startsWith("Scene.") ? targetSceneUuid.slice(6) : null;
    const beforePairRead = await invoke("foundry_scene_get", { sceneUuid: sourceSceneUuid, include: ["portals", "tokens"] });
    const sourceTokenUuid = beforePairRead.details?.placeables?.tokens?.[0]?.uuid;
    const sourceTokenId = sourceTokenUuid?.split(".Token.").at(-1) ?? null;
    const pair = await invoke("foundry_scene_portal", {
      operation: "create", sourceSceneUuid, targetSceneUuid,
      sourcePoint: { x: 200, y: 200 }, targetPoint: { x: 400, y: 400 },
      name: "Contract Portal", playerVisible: false,
    });
    const sourcePortalId = pair.details?.sourcePortalId;
    const targetPortalId = pair.details?.targetPortalId;
    check("portal.create-pair", pair.details?.status === "completed"
      && typeof pair.details?.pairId === "string" && typeof sourcePortalId === "string" && typeof targetPortalId === "string", {
      status: pair.details?.status, code: pair.details?.code, message: pair.details?.message,
      pairId: pair.details?.pairId, sourcePortalId, targetPortalId,
    });
    const staleDelete = await invoke("foundry_scene_portal", {
      operation: "delete", sceneUuid: sourceSceneUuid, portalId: sourcePortalId, readRef: beforePairRead.details?.readRef,
    });
    check("portal.stale-read-rejected", staleDelete.details?.status === "rejected"
      && staleDelete.details?.code === "READ_REF_STALE", {
      status: staleDelete.details?.status, code: staleDelete.details?.code, message: staleDelete.details?.message,
    });
    const targetPairRead = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["portals"] });
    check("portal.read-mirrored-pair", targetPairRead.details?.placeables?.portals?.length === 1
      && targetPairRead.details.placeables.portals[0].targetPortalId === sourcePortalId
      && targetPairRead.details.placeables.portals[0].targetSceneId === sourceSceneId
      && targetPairRead.details.placeables.portals[0].playerVisible === false, {
      portals: targetPairRead.details?.placeables?.portals,
    });
    const beforeMoveRead = await invoke("foundry_scene_get", { sceneUuid: sourceSceneUuid, include: ["tokens"] });
    const tokenShift = await invoke("foundry_scene_apply", {
      operation: "update", sceneUuid: sourceSceneUuid, readRef: beforeMoveRead.details?.readRef,
      tokens: { update: [{ tokenId: sourceTokenId, changes: { x: 120 } }] },
    });
    const staleTeleport = await invoke("foundry_scene_portal", {
      operation: "teleport", tokenUuid: sourceTokenUuid, targetSceneUuid, targetPortalId,
      readRef: beforeMoveRead.details?.readRef,
    });
    check("portal.stale-token-read-rejected", tokenShift.details?.status === "completed"
      && staleTeleport.details?.status === "rejected" && staleTeleport.details?.code === "READ_REF_STALE", {
      shiftStatus: tokenShift.details?.status, status: staleTeleport.details?.status,
      code: staleTeleport.details?.code, message: staleTeleport.details?.message,
    });
    const currentMoveRead = await invoke("foundry_scene_get", { sceneUuid: sourceSceneUuid, include: ["tokens"] });
    const moved = await invoke("foundry_scene_portal", {
      operation: "teleport", tokenUuid: sourceTokenUuid, targetSceneUuid, targetPortalId,
      readRef: currentMoveRead.details?.readRef,
    });
    const sourceAfterMove = await invoke("foundry_scene_get", { sceneUuid: sourceSceneUuid, include: ["tokens"] });
    const targetAfterMove = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["tokens"] });
    check("portal.teleport-preserves-token-id-and-scene-active", moved.details?.status === "completed"
      && sourceAfterMove.details?.placeables?.tokens?.length === 0
      && targetAfterMove.details?.placeables?.tokens?.length === 1
      && targetAfterMove.details.placeables.tokens[0].id === sourceTokenId
      && targetAfterMove.details.placeables.tokens[0].uuid === `Scene.${targetSceneId}.Token.${sourceTokenId}`
      && targetAfterMove.details.placeables.tokens[0].x === 350 && targetAfterMove.details.placeables.tokens[0].y === 350
      && sourceAfterMove.details?.active === true && targetAfterMove.details?.active === false, {
      status: moved.details?.status, code: moved.details?.code, message: moved.details?.message,
      sourceTokens: sourceAfterMove.details?.placeables?.tokens,
      targetTokens: targetAfterMove.details?.placeables?.tokens,
    });
    const deleteRead = await invoke("foundry_scene_get", { sceneUuid: sourceSceneUuid, include: ["portals"] });
    const deleted = await invoke("foundry_scene_portal", {
      operation: "delete", sceneUuid: sourceSceneUuid, portalId: sourcePortalId, readRef: deleteRead.details?.readRef,
    });
    const sourceAfterDelete = await invoke("foundry_scene_get", { sceneUuid: sourceSceneUuid, include: ["portals"] });
    const targetAfterDelete = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["portals"] });
    check("portal.delete-pair", deleted.details?.status === "completed"
      && sourceAfterDelete.details?.placeables?.portals?.length === 0
      && targetAfterDelete.details?.placeables?.portals?.length === 0, {
      status: deleted.details?.status, code: deleted.details?.code, message: deleted.details?.message,
    });

    const samePair = await invoke("foundry_scene_portal", {
      operation: "create", sourceSceneUuid: targetSceneUuid, targetSceneUuid,
      sourcePoint: { x: 600, y: 600 }, targetPoint: { x: 800, y: 800 },
      sourceScale: 1.5, targetScale: 0.75, name: "same-scene-portal",
    });
    const sameSceneRead = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["portals", "tokens"] });
    const samePortals = sameSceneRead.details?.placeables?.portals?.filter(portal => portal.pairId === samePair.details?.pairId) ?? [];
    check("portal.same-scene-scaled-pair", samePair.details?.status === "completed" && samePortals.length === 2
      && samePortals.find(portal => portal.id === samePair.details?.sourcePortalId)?.scale === 1.5
      && samePortals.find(portal => portal.id === samePair.details?.targetPortalId)?.scale === 0.75, {
      status: samePair.details?.status, code: samePair.details?.code, message: samePair.details?.message, portals: samePortals,
    });
    const sameTokenUuid = sameSceneRead.details?.placeables?.tokens?.[0]?.uuid;
    const sameMoved = await invoke("foundry_scene_portal", {
      operation: "teleport", tokenUuid: sameTokenUuid, targetSceneUuid,
      targetPortalId: samePair.details?.targetPortalId, readRef: sameSceneRead.details?.readRef,
    });
    const sameAfterMove = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["tokens"] });
    check("portal.same-scene-teleport", sameMoved.details?.status === "completed"
      && sameAfterMove.details?.placeables?.tokens?.length === 1
      && sameAfterMove.details.placeables.tokens[0].uuid === sameTokenUuid
      && sameAfterMove.details.placeables.tokens[0].x === 750 && sameAfterMove.details.placeables.tokens[0].y === 750
      && sameAfterMove.details?.active === false, {
      status: sameMoved.details?.status, code: sameMoved.details?.code, message: sameMoved.details?.message,
      tokens: sameAfterMove.details?.placeables?.tokens,
    });
    const sameDeleteRead = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["portals"] });
    const sameDeleted = await invoke("foundry_scene_portal", {
      operation: "delete", sceneUuid: targetSceneUuid, portalId: samePair.details?.sourcePortalId,
      readRef: sameDeleteRead.details?.readRef,
    });
    const sameAfterDelete = await invoke("foundry_scene_get", { sceneUuid: targetSceneUuid, include: ["portals"] });
    check("portal.same-scene-delete", sameDeleted.details?.status === "completed"
      && sameAfterDelete.details?.placeables?.portals?.length === 0, {
      status: sameDeleted.details?.status, code: sameDeleted.details?.code, message: sameDeleted.details?.message,
      portals: sameAfterDelete.details?.placeables?.portals,
    });

    if (PLAYER_USER && PLAYER_PASS) {
      const hiddenPair = await invoke("foundry_scene_portal", {
        operation: "create", sourceSceneUuid, targetSceneUuid,
        sourcePoint: { x: 200, y: 200 }, targetPoint: { x: 400, y: 400 },
        name: "hidden-from-player", playerVisible: false,
      });
      check("portal.hidden-pair-created", hiddenPair.details?.status === "completed", {
        status: hiddenPair.details?.status, code: hiddenPair.details?.code, message: hiddenPair.details?.message,
      });
      await invoke("foundry_page_eval", {
        code: `const scene = [...game.scenes].find(value => value.uuid === ${JSON.stringify(sourceSceneUuid)});
          await scene.update({ navigation: true }); return { navigation: scene.navigation };`,
      });
      const fullCampaign = await api.get(`/api/campaigns/${campaignId}`);
      const playerAuth = await login(PLAYER_USER, PLAYER_PASS);
      const playerApi = mtApi(playerAuth.token);
      await playerApi.put(`/api/campaigns/join/${fullCampaign.joinId}`, {});
      const playerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
      const playerPage = await playerContext.newPage();
      await playerPage.addInitScript(([token, id]) => {
        sessionStorage.setItem("mt.session", JSON.stringify({ access_token: token, refresh_token: null }));
        sessionStorage.setItem("mt.campaign", id);
      }, [playerAuth.token, campaignId]);
      await playerPage.goto(`${BASE}/play.html?campaign=${encodeURIComponent(campaignId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const playerReady = await playerPage.waitForFunction(() => window.__MT_READY__ === true
        && typeof window.__MT_AGENT_RUNTIME__ === "function", undefined, { timeout: 180_000, polling: 300 }).then(() => true, () => false);
      check("player.page-ready-real-account", playerReady, { ready: playerReady });
      const playerContents = createPageContents(playerPage);
      const playerClient = createMtcompatRuntimeClient({ runtimeSource: compatRuntime.source, getWebContents: () => playerContents });
      const playerRuntime = new PageProfileRoutedRuntime({
        foundry: foundryRuntime, mtcompat: playerClient, getActiveProfileId: () => PAGE_PROFILES.mtcompat.id,
      });
      const playerHost = new AgentHost({
        foundryRuntime: playerRuntime,
        getFoundryView: () => ({ webContents: playerContents }),
        openFoundry: async () => ({ ok: true, summary: "player contract" }),
        sendToRenderer: () => {}, log: () => {},
        profile: { mode: "prep", getCwd: () => prepDir },
        getPanelProfileId: () => PAGE_PROFILES.mtcompat.id,
        operationStorageDir: path.join(workDir, "player"),
        taskStorageDir: path.join(workDir, "player-tasks"),
      });
      const playerInput = await captureFoundryInputContext(playerContents);
      playerHost.taskCoordinator = () => ({
        currentInputBinding: () => ({ taskId: "contract-player", inputId: "player-input", metadata: Promise.resolve(playerInput) }),
      });
      const playerTools = new Map(playerHost.buildTools().map(tool => [tool.name, tool]));
      const playerInvoke = async (name, params) => {
        const result = await playerTools.get(name).execute(`player-${name}`, params);
        return { details: result.details, text: String(result.content?.[0]?.text ?? ""), isError: Boolean(result.isError) };
      };
      const playerStatus = await playerInvoke("world_status", {});
      check("player.world-status-gm-boundary", playerStatus.isError || playerStatus.details?.status === "rejected"
        || /GM user is required|not a GM|ACTION_FORBIDDEN|FOUNDRY_NOT_GM/.test(playerStatus.text), {
        status: playerStatus.details?.status, code: playerStatus.details?.code, text: playerStatus.text.slice(0, 240),
      });
      const playerWrite = await playerInvoke("foundry_scene_portal", {
        operation: "create", sourceSceneUuid, targetSceneUuid,
        sourcePoint: { x: 200, y: 200 }, targetPoint: { x: 400, y: 400 }, name: "player-forbidden",
      });
      check("player.portal-write-forbidden", playerWrite.details?.status === "rejected"
        && ["ACTION_FORBIDDEN", "FOUNDRY_NOT_GM"].includes(playerWrite.details?.code), {
        status: playerWrite.details?.status, code: playerWrite.details?.code, message: playerWrite.details?.message,
      });
      const playerVisibility = await playerPage.evaluate(async ({ uuid }) => {
        const scene = [...game.scenes].find(value => value.uuid === uuid);
        const mod = await import(new URL("scene-portals.mjs", document.baseURI).href);
        return {
          isGM: game.user?.isGM,
          rawPortals: mod.scenePortals(scene).length,
          visiblePortals: mod.visiblePortalsFor(mod.scenePortals(scene), game.user).length,
        };
      }, { uuid: sourceSceneUuid });
      check("player.hidden-portal-not-visible", playerVisibility.isGM === false
        && playerVisibility.rawPortals === 1 && playerVisibility.visiblePortals === 0, playerVisibility);
      await playerContext.close();
    } else {
      report.notCovered.push("Real player portal visibility and GM write gating: set MT_PLAYER_USER and MT_PLAYER_PASS to enable");
    }

    // ---- advancement: Fighter + Human from the real compendium -----------
    const classIndex = await invoke("foundry_compendium_browse", { scope: "compendium", type: "class", rules: "2024" });
    const raceIndex = await invoke("foundry_compendium_browse", { scope: "compendium", type: "race", rules: "2024" });
    const fighter = classIndex.details?.candidates?.find(entry => entry.identifier === "fighter") ?? null;
    const human = raceIndex.details?.candidates?.find(entry => entry.identifier === "human") ?? null;
    check("compendium.class-and-race-index", Boolean(fighter?.uuid) && Boolean(human?.uuid), {
      fighter: fighter?.uuid, human: human?.uuid,
    });

    const choicesFromPlan = plan => {
      const bySlot = {};
      for (const requirement of plan?.choiceRequirements ?? []) {
        if (requirement.valueFormat === "trait-key" || requirement.valueFormat === "pool-uuid") {
          bySlot[requirement.key] = requirement.candidates.slice(0, requirement.count);
        }
      }
      return { hp: "max", bySlot };
    };

    const fighterActor = await invoke("foundry_actor_create", {
      source: { kind: "blank", actorType: "character" }, name: `Contract Fighter ${RUN_ID}`,
    });
    const fighterActorUuid = fighterActor.details?.verification?.[0]?.actorUuid ?? null;
    const fighterRead = await invoke("foundry_actor_get", { actorUuid: fighterActorUuid, include: ["items", "resources", "prototypeToken"] });
    const fighterPlan = await invoke("foundry_advancement_plan", {
      actorUuid: fighterActorUuid, classUuid: fighter?.uuid, raceUuid: human?.uuid, characterLevel: 1,
    });
    check("advancement.plan", fighterPlan.details?.status === "completed"
      && fighterPlan.details?.actorAdvanceArgs?.targetLevel === 1
      && fighterPlan.details?.choiceRequirements?.length > 0
      && fighterPlan.details?.choiceRequirements.every(requirement => Array.isArray(requirement.candidates) && requirement.candidates.length > 0)
      && fighterPlan.details?.coverage?.uncoveredRequiredSteps?.length === 0, {
      status: fighterPlan.details?.status,
      slots: fighterPlan.details?.choiceRequirements?.map(requirement => `${requirement.key}:${requirement.count}`),
      template: fighterPlan.details?.choicesTemplate,
    });
    const badSlot = await invoke("foundry_actor_advance", {
      actorUuid: fighterActorUuid, readRef: fighterRead.details?.readRef, classUuid: fighter?.uuid,
      raceUuid: human?.uuid, targetLevel: 1, choices: { hp: "max", bySlot: { "class:99:UnknownAdvancement:0": ["x"] } },
    });
    check("advancement.unknown-slot-rejected", badSlot.details?.status === "rejected"
      && badSlot.details?.code === "CHOICE_SLOT_UNKNOWN", badSlot.details);

    const advanced = await invoke("foundry_actor_advance", {
      actorUuid: fighterActorUuid, readRef: fighterRead.details?.readRef, classUuid: fighter?.uuid,
      raceUuid: human?.uuid, targetLevel: 1, choices: choicesFromPlan(fighterPlan.details),
    });
    check("advancement.level-1", advanced.details?.status === "completed"
      && advanced.details?.verification?.level === 1
      && advanced.details?.verification?.classUuid === fighter?.uuid
      && advanced.details?.verification?.race?.uuid === human?.uuid
      && advanced.details?.verification?.hp?.max > 0
      && advanced.details?.verification?.itemCount > 0, {
      status: advanced.details?.status, code: advanced.details?.code,
      level: advanced.details?.verification?.level,
      classUuid: advanced.details?.verification?.classUuid,
      race: advanced.details?.verification?.race,
      hp: advanced.details?.verification?.hp,
    });
    const fighterAfter = await invoke("foundry_actor_get", { actorUuid: fighterActorUuid, include: ["items", "resources"] });
    const fighterItemNames = (fighterAfter.details?.items ?? []).map(item => item.name);
    check("advancement.actor-read-reconciles", fighterItemNames.some(name => /战士|Fighter/.test(name))
      && fighterItemNames.some(name => /人类|Human/.test(name))
      && fighterAfter.details?.hp?.max === advanced.details?.verification?.hp?.max
      && fighterAfter.details?.hp?.max >= 10, {
      items: fighterItemNames, hp: fighterAfter.details?.hp,
      receiptHp: advanced.details?.verification?.hp,
    });

    // ---- actorGrantItems: real sources, exact-name guard, idempotency ---
    const shortsword = await invoke("foundry_compendium_browse", {
      scope: "compendium", type: "item", names: ["Shortsword"], rules: "2024",
    });
    const shortswordHit = shortsword.details?.resolutions?.[0]?.candidates?.[0] ?? null;
    const cantrip = await invoke("foundry_compendium_browse", {
      scope: "compendium", type: "spell", names: ["Prestidigitation"], rules: "2024",
    });
    const cantripHit = cantrip.details?.resolutions?.[0]?.candidates?.[0] ?? null;
    const fogSpell = await invoke("foundry_compendium_browse", {
      scope: "compendium", type: "spell", names: ["Fog Cloud"], rules: "2024",
    });
    const fogHit = fogSpell.details?.resolutions?.[0]?.candidates?.[0] ?? null;
    check("compendium.grant-sources", shortswordHit?.uuid && cantripHit?.uuid && fogHit?.uuid, {
      shortsword: shortswordHit, cantrip: cantripHit?.uuid, fog: fogHit?.uuid,
    });

    const grantRead = await invoke("foundry_actor_get", { actorUuid: fighterActorUuid, include: ["items", "resources"] });
    const granted = await invoke("foundry_actor_grant_items", {
      actorUuid: fighterActorUuid, readRef: grantRead.details?.readRef,
      items: [
        { uuid: shortswordHit?.uuid, expectedName: shortswordHit?.name, expectedType: "weapon" },
        { uuid: cantripHit?.uuid, expectedName: cantripHit?.name, expectedType: "spell" },
        { uuid: fogHit?.uuid, expectedName: fogHit?.name, expectedType: "spell" },
      ],
    });
    const createdGrant = granted.details?.steps?.find(step => step.step === "grant-items")?.created ?? [];
    check("grant.items-created", granted.details?.status === "completed"
      && createdGrant.length === 3
      && createdGrant.some(entry => entry.name === shortswordHit?.name && entry.type === "weapon")
      && createdGrant.filter(entry => entry.type === "spell").length === 2, {
      status: granted.details?.status, created: createdGrant.map(entry => `${entry.name}:${entry.type}`),
    });
    const grantReread = await invoke("foundry_actor_get", { actorUuid: fighterActorUuid, include: ["items"] });
    const repeat = await invoke("foundry_actor_grant_items", {
      actorUuid: fighterActorUuid, readRef: grantReread.details?.readRef,
      items: [{ uuid: shortswordHit?.uuid, expectedName: shortswordHit?.name, expectedType: "weapon" }],
    });
    const repeatStep = repeat.details?.steps?.find(step => step.step === "grant-items");
    check("grant.existing-skipped", repeat.details?.status === "completed"
      && repeatStep?.created?.length === 0
      && repeatStep?.skippedExisting?.length === 1, {
      status: repeat.details?.status, step: repeatStep,
    });
    const drift = await invoke("foundry_actor_grant_items", {
      actorUuid: fighterActorUuid, readRef: grantReread.details?.readRef,
      items: [{ uuid: shortswordHit?.uuid, expectedName: "Shortsword", expectedType: "weapon" }],
    });
    check("grant.name-drift-rejected", drift.details?.status === "rejected"
      && drift.details?.code === "SOURCE_MISMATCH", drift.details);

    // ---- executeAction: narrative cantrip and slot consumption ----------
    const wizardClass = classIndex.details?.candidates?.find(entry => entry.identifier === "wizard") ?? null;
    const wizardActor = await invoke("foundry_actor_create", {
      source: { kind: "blank", actorType: "character" }, name: `Contract Wizard ${RUN_ID}`,
    });
    const wizardActorUuid = wizardActor.details?.verification?.[0]?.actorUuid ?? null;
    const wizardRead = await invoke("foundry_actor_get", { actorUuid: wizardActorUuid, include: ["items", "resources", "prototypeToken"] });
    const wizardPlan = await invoke("foundry_advancement_plan", {
      actorUuid: wizardActorUuid, classUuid: wizardClass?.uuid, raceUuid: human?.uuid, characterLevel: 1,
    });
    const wizardAdvanced = await invoke("foundry_actor_advance", {
      actorUuid: wizardActorUuid, readRef: wizardRead.details?.readRef, classUuid: wizardClass?.uuid,
      raceUuid: human?.uuid, targetLevel: 1, choices: choicesFromPlan(wizardPlan.details),
    });
    const wizardGrantRead = await invoke("foundry_actor_get", { actorUuid: wizardActorUuid, include: ["items", "resources"] });
    const wizardGrant = await invoke("foundry_actor_grant_items", {
      actorUuid: wizardActorUuid, readRef: wizardGrantRead.details?.readRef,
      items: [
        { uuid: cantripHit?.uuid, expectedName: cantripHit?.name, expectedType: "spell" },
        { uuid: fogHit?.uuid, expectedName: fogHit?.name, expectedType: "spell" },
      ],
    });
    check("execute.narrative-fixture-ready", wizardClass?.uuid && wizardAdvanced.details?.status === "completed"
      && wizardGrant.details?.status === "completed"
      && Number(wizardGrantRead.details?.resources?.spell1 ?? 0) >= 1, {
      wizard: wizardClass?.uuid, advance: wizardAdvanced.details?.status,
      grant: wizardGrant.details?.status, slots: wizardGrantRead.details?.resources,
    });

    const narrativeScene = await invoke("foundry_scene_apply", {
      operation: "create",
      scene: { name: `Contract Narrative ${RUN_ID}`, active: true, width: 1000, height: 1000,
        grid: { type: 1, size: 100, distance: 5, units: "ft" } },
      tokens: { create: [{ actorUuid: wizardActorUuid, x: 200, y: 200 }] },
    });
    const narrativeSceneUuid = narrativeScene.details?.verification?.[0]?.sceneUuid ?? null;
    const narrativeRead = await invoke("foundry_scene_get", { sceneUuid: narrativeSceneUuid, include: ["tokens"] });
    const narrativeTokenUuid = narrativeRead.details?.placeables?.tokens?.[0]?.uuid ?? null;
    const selected = await invoke("foundry_page_eval", {
      code: `const token = [...(canvas?.tokens?.placeables ?? [])]
          .find(placeable => (placeable.document?.uuid ?? placeable.uuid) === ${JSON.stringify(narrativeTokenUuid)});
        token?.control?.({ releaseOthers: true });
        return { selected: [...(canvas?.tokens?.controlled ?? [])].map(placeable => placeable.document?.uuid ?? placeable.uuid) };`,
    });
    check("execute.token-selected", selected.details?.value?.selected?.includes(narrativeTokenUuid), selected.details?.value);

    const narrativeStatic = await invoke("foundry_static_context", {});
    const narrativePlay = await invoke("foundry_play_context", { view: "current" });
    const narrativeCombatant = (narrativeStatic.details?.combatants ?? []).find(entry => entry.actorUuid === wizardActorUuid) ?? null;
    const cantripAction = (narrativeCombatant?.actions ?? []).find(action => /Prestidigitation|魔法伎俩/i.test(action.itemName ?? ""));
    const lightAction = (narrativeCombatant?.actions ?? []).find(action => /(^|\s)Light$|光亮术/i.test(action.itemName ?? ""));
    check("execute.context-shares-ref", narrativeStatic.details?.contextRef === narrativePlay.details?.contextRef
      && Boolean(cantripAction?.actionRef)
      && narrativePlay.details?.combatants?.some(entry => entry.tokenUuid === narrativeTokenUuid
        && entry.availableActionIds?.includes(cantripAction.actionRef)), {
      staticRef: narrativeStatic.details?.contextRef, playRef: narrativePlay.details?.contextRef,
      cantrip: cantripAction?.actionRef,
    });
    // Light's 2024 activity is a summon that Play does not expose; recorded honestly
    // instead of pretending a narrative entry exists.
    check("execute.light-not-exposed-as-narrative", !lightAction, {
      offered: (narrativeCombatant?.actions ?? []).map(action => `${action.itemName}:${action.resolution}`),
    });

    const messagesBefore = await page.evaluate(() => [...(game.messages ?? [])].length);
    const cantripExecution = cantripAction
      ? await invoke("foundry_execute_action", { actionRef: cantripAction.actionRef, resolution: "narrative" })
      : null;
    check("execute.narrative-cantrip", cantripExecution?.details?.status === "completed"
      && !(cantripExecution.details?.steps ?? []).some(step => step.step === "spell-consumption"), {
      status: cantripExecution?.details?.status, code: cantripExecution?.details?.code,
      steps: cantripExecution?.details?.steps,
    });

    const refundStatic = await invoke("foundry_static_context", {});
    const fogAction = (refundStatic.details?.combatants ?? [])
      .find(entry => entry.actorUuid === wizardActorUuid)?.actions
      ?.find(action => /Fog Cloud|云雾术/i.test(action.itemName ?? "")) ?? null;
    const slotsBefore = Number(wizardGrantRead.details?.resources?.spell1 ?? 0);
    const fogExecution = fogAction
      ? await invoke("foundry_execute_action", { actionRef: fogAction.actionRef, resolution: "narrative" })
      : null;
    const slotStep = (fogExecution?.details?.steps ?? []).find(step => step.step === "spell-consumption") ?? null;
    check("execute.narrative-spell-slot", fogExecution?.details?.status === "completed"
      && slotStep?.state === "completed"
      && slotStep?.before === slotsBefore
      && slotStep?.after === slotsBefore - 1, {
      status: fogExecution?.details?.status, code: fogExecution?.details?.code,
      step: slotStep, slotsBefore,
    });
    const wizardAfterExec = await invoke("foundry_actor_get", { actorUuid: wizardActorUuid, include: ["resources"] });
    const messagesAfter = await page.evaluate(() => [...(game.messages ?? [])].length);
    check("execute.narrative-no-roll-and-slot-live",
      wizardAfterExec.details?.resources?.spell1 === slotsBefore - 1
      && messagesAfter === messagesBefore, {
      spell1: wizardAfterExec.details?.resources?.spell1, slotsBefore,
      messagesBefore, messagesAfter,
    });

    // ---- content search sees the created world documents -----------------
    const search = await invoke("foundry_content_search", { scope: "world", documentType: "Actor", query: "Contract NPC" });
    check("content.world-search", search.details?.entries?.some(entry => entry.uuid === actorUuid), {
      entries: search.details?.entries?.map(entry => entry.name),
    });

    // ---- backend probe: ordinary Roll update entitlement -----------------
    const rollProbe = await invoke("foundry_page_eval", {
      code: `const roll = await new Roll("1d20").evaluate();
        const message = await ChatMessage.create({ content: "contract roll", type: 5, timestamp: Date.now() });
        try { await message.update({ rolls: [roll.toJSON()], flavor: "contract roll" }); return { updated: true }; }
        catch (error) { return { updated: false, error: String(error?.message ?? error) }; }`,
    });
    const rollValue = rollProbe.details?.value ?? {};
    check("env.roll-update", rollValue.updated === true, rollValue);

    // dataPath is the durable, unsigned document reference. Private buckets require the
    // page's signing path for reads; assert real bytes there without persisting signed URLs.
    const probedImages = [];
    for (const probe of imageProbes) {
      const readUrl = await signedAssetUrl(probe.url);
      probedImages.push({ ...probe, signed: readUrl !== probe.url, ...(await fetchStatus(readUrl)) });
    }
    check("env.image-get", probedImages.length > 0
      && probedImages.every(probe => probe.status === 200 && !new URL(probe.url).search && !new URL(probe.url).hash),
      { probes: probedImages });

    // ---- persistence: the imported scene survives a page reload ----------
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    const reloaded = await page.waitForFunction(() => window.__MT_READY__ === true, undefined, { timeout: 180_000, polling: 300 })
      .then(() => true, () => false);
    const persisted = reloaded
      ? await page.evaluate((uuid) => {
        const scene = [...game.scenes].find(value => value.uuid === uuid);
        return { found: Boolean(scene), name: scene?.name ?? null, walls: scene ? [...scene.walls].length : null };
      }, sceneUuid)
      : { found: false, name: null, walls: null };
    check("scene.persisted-after-reload", persisted.found === true
      && persisted.name === `${sceneName} v2`
      && persisted.walls === 1, persisted);

    // Navigation resets the page runtime and the handle wrapper. Reinstall and adopt the
    // candidate before the large-map checks instead of silently testing the deployed fallback.
    await page.addScriptTag({ content: runtimeText });
    const reloadedAdoption = await adopt(null);
    report.runtime.reloadedHandleCapabilities = await page.evaluate(() => ({
      has32MiBLimit: String(window.__MT_AGENT_RUNTIME__).includes("MAX_IMAGE_UPLOAD_BYTES"),
    }));
    check("runtime.reloaded-candidate", reloadedAdoption.adopted === true
      && reloadedAdoption.source === compatRuntime.source
      && report.runtime.reloadedHandleCapabilities.has32MiBLimit, {
      adopted: reloadedAdoption.adopted, reason: reloadedAdoption.reason,
      sourceBytes: reloadedAdoption.source?.length,
      handle: report.runtime.reloadedHandleCapabilities,
    });

    // ---- >10 MiB map: real local JPEG decoding + upload + native scene import ----
    const largeImageUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 6150; canvas.height = 6450;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#7b786d"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      let seed = 0x6afdb44a;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
      for (let y = 0; y < canvas.height; y += 5) for (let x = 0; x < canvas.width; x += 5) {
        ctx.fillStyle = `rgb(${60 + Math.floor(random() * 100)},${55 + Math.floor(random() * 90)},${45 + Math.floor(random() * 70)})`;
        ctx.fillRect(x, y, 5, 5);
      }
      ctx.strokeStyle = "#252a30"; ctx.lineWidth = 8;
      for (let x = 0; x <= canvas.width; x += 150) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
      for (let y = 0; y <= canvas.height; y += 150) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
      return canvas.toDataURL("image/jpeg", 0.92);
    });
    const largeJpeg = dataUrlBytes(largeImageUrl);
    writeFileSync(path.join(prepDir, "large-map.jpg"), largeJpeg);
    check("fixture.large-jpeg", largeJpeg.length > 10 * 1024 * 1024 && largeJpeg.length <= 32 * 1024 * 1024, {
      width: 6150, height: 6450, bytes: largeJpeg.length,
      note: "deterministic synthetic fixture above the former 10 MiB cap, not the user's original church image",
    });
    const largeSceneName = `Contract Large Map ${RUN_ID}`;
    writeFileSync(path.join(prepDir, "large-map.json"), JSON.stringify({
      name: largeSceneName, width: 6150, height: 6450,
      grid: { type: 1, size: 150, distance: 5, units: "ft" },
      globalLight: true, darkness: 0.6,
      walls: Array.from({ length: 65 }, (_, index) => ({
        c: [100 + (index % 8) * 600, 100 + Math.floor(index / 8) * 600,
          500 + (index % 8) * 600, 100 + Math.floor(index / 8) * 600],
        move: 20, sight: 20, light: 20, sound: 20, door: index < 6 ? 1 : 0, ds: 0,
      })),
      lights: Array.from({ length: 26 }, (_, index) => ({
        x: 500 + (index % 6) * 800, y: 500 + Math.floor(index / 6) * 1000,
        dim: 200, bright: 100, color: "#ffffff", alpha: 0.25,
      })),
    }));
    const largeImport = await invoke("foundry_scene_import", {
      operation: "create", sourcePath: "large-map.json", backgroundSourcePath: "large-map.jpg",
    });
    const largeUuid = largeImport.details?.sceneUuid ?? null;
    const largeUrl = largeImport.details?.dataPath ?? null;
    check("scene.large-import", largeImport.details?.status === "completed"
      && largeImport.details?.stats?.walls === 65 && largeImport.details?.stats?.lights === 26
      && largeImport.details?.verification?.[0]?.width === 6150
      && largeImport.details?.verification?.[0]?.height === 6450
      && largeImport.details?.verification?.[0]?.["grid.size"] === 150 && /\.jpg$/.test(largeUrl), {
      status: largeImport.details?.status, code: largeImport.details?.code, message: largeImport.details?.message,
      stats: largeImport.details?.stats, verification: largeImport.details?.verification,
    });
    if (largeUrl) imageProbes.push({ kind: "large-jpeg", url: largeUrl });
    const largeReadUrl = largeUrl ? await signedAssetUrl(largeUrl) : null;
    const largeProbe = largeReadUrl ? await fetchStatus(largeReadUrl) : null;
    check("image.large-get", largeProbe?.status === 200 && largeProbe.bytes === largeJpeg.length, largeProbe);
    const largeRead = largeUuid ? await invoke("foundry_scene_get", { sceneUuid: largeUuid, include: ["walls", "lights"], limit: 100 }) : null;
    check("scene.large-readback", largeRead?.details?.placeables?.walls?.length === 65
      && largeRead.details.placeables.lights.length === 26 && largeRead.details["background.src"] === largeUrl, {
      walls: largeRead?.details?.placeables?.walls?.length, lights: largeRead?.details?.placeables?.lights?.length,
    });
    const largeActivated = largeUuid && largeRead?.details?.readRef ? await invoke("foundry_scene_apply", {
      operation: "update", sceneUuid: largeUuid, readRef: largeRead.details.readRef, scene: { active: true },
    }) : null;
    const largeRendered = await page.evaluate(async ({ uuid, expectedUrl }) => {
      const scene = [...game.scenes].find(value => value.uuid === uuid);
      if (!scene) return { scene: false };
      const image = new Image(); image.src = expectedUrl;
      try { await image.decode(); } catch { return { scene: true, decoded: false }; }
      const deadline = Date.now() + 15000;
      let colors = 0;
      while (Date.now() < deadline) {
        const ctx = document.getElementById("mt-canvas")?.getContext("2d");
        if (ctx && globalThis.canvas?.scene?.uuid === uuid) {
          const pixels = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
          const samples = new Set();
          for (let y = 0; y < ctx.canvas.height; y += 32) for (let x = 0; x < ctx.canvas.width; x += 32) {
            const at = (y * ctx.canvas.width + x) * 4;
            samples.add(`${pixels[at]},${pixels[at + 1]},${pixels[at + 2]},${pixels[at + 3]}`);
          }
          colors = samples.size;
          if (colors > 32) break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { scene: true, decoded: true, width: image.naturalWidth, height: image.naturalHeight, colors };
    }, { uuid: largeUuid, expectedUrl: largeReadUrl }).catch(error => ({ error: String(error?.message ?? error) }));
    check("scene.large-render", largeActivated?.details?.status === "completed"
      && largeRendered.decoded === true && largeRendered.width === 6150 && largeRendered.height === 6450
      && largeRendered.colors > 32, largeRendered);
    await page.screenshot({ path: path.join(OUT_DIR, `large-map-${RUN_ID}.png`) }).catch(() => {});

    // ---- journal hygiene: no bytes or scene JSON entered the operation log
    const journalFiles = [];
    try {
      const entries = await import("node:fs").then(fs => fs.readdirSync(workDir));
      for (const name of entries) if (name.endsWith(".jsonl")) journalFiles.push(path.join(workDir, name));
    } catch { /* no journal */ }
    const journalText = journalFiles.map(file => readFileSync(file, "utf8")).join("\n");
    check("journal.no-bytes-or-scene-json", journalFiles.length > 0
      && !journalText.includes(png.toString("base64"))
      && !journalText.includes("sceneJson")
      && !journalText.includes("prepPrepareImage"), {
      files: journalFiles.map(file => path.basename(file)), bytes: journalText.length,
    });

    await page.screenshot({ path: path.join(OUT_DIR, `play-${RUN_ID}.png`) }).catch(() => {});
    report.consoleErrors = consoleErrors.slice(0, 30);
    report.coverage = {
      ...report.coverage,
      realPage: true,
      realKeycloakGrant: true,
      realBackendPersistence: true,
      realAgentHostToolPool: true,
      realFoundryServices: true,
      realDirectFoundryRuntime: true,
      realWebContentsTransport: true,
      pageHandleDelegation: true,
      chromiumImageDecode: true,
      jpegAndWebpUpload: true,
      syncPlacedTokensAcrossScenes: true,
      actorAdvanceAtLevelOne: true,
      actorGrantItems: true,
      sceneApplyTokenLifecycle: true,
      scenePortals: true,
      realPlayer: Boolean(PLAYER_USER && PLAYER_PASS),
      executeActionNarrative: true,
      electronUi: false,
    };
  } finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    if (!KEEP) rmSync(rootDir, { recursive: true, force: true });
    // Campaign isolation: always delete this run, then sweep leftovers with the same prefix.
    let cleanupOk = true;
    if (campaignId) {
      await api.delete(`/api/campaigns/${campaignId}`).catch(() => { cleanupOk = false; });
    }
    try {
      const list = await api.get("/api/campaigns").then(value => (Array.isArray(value) ? value : value?.campaigns ?? []), () => []);
      for (const entry of list.filter(item => String(item.name ?? "").startsWith(CAMPAIGN_PREFIX))) {
        await api.delete(`/api/campaigns/${entry.id}`).catch(() => { cleanupOk = false; });
      }
    } catch { cleanupOk = false; }
    check("teardown.campaign-deleted", cleanupOk, { campaignId, prefix: CAMPAIGN_PREFIX });
    report.checksSummary = report.checks.reduce((summary, entry) => {
      summary[entry.state] = (summary[entry.state] ?? 0) + 1;
      return summary;
    }, {});
    report.status = report.failures.length === 0 ? "completed" : "failed";
    saveReport();
    console.log(`\n[contract] ${report.status}: ${JSON.stringify(report.checksSummary)}`);
    for (const failure of report.failures) console.error(`  [fail] ${failure.id} — ${failure.detail}`);
    for (const envFailure of report.environmentFailures) console.error(`  [environment] ${envFailure.id} — ${envFailure.detail}`);
    console.log(`[contract] report ${path.join(OUT_DIR, "report.json")}`);
    process.exit(report.failures.length === 0 ? 0 : 1);
  }
}

main().catch(async error => {
  report.failures.push({ id: "harness.fatal", detail: safeDetail(error?.stack ?? error, 4000) });
  report.status = "failed";
  console.error(error?.stack ?? error);
  try { saveReport(); } catch { /* ignore */ }
  process.exit(1);
});
