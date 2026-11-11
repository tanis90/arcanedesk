// Electron fixture for the real lobby tool + native CDP file channel.
// Usage: electron test/fixtures/lobby-e2e-app.mjs --report=<json> [--source=<zip>]
//        [--url=<real lobby url>] [--wait-auth-ms=120000] [--keep]
//
// The fixture page implements the mt-compat lobby contract and hashes the File
// that Desktop bound through DOM.setFileInputFiles. A persistent debugger is
// attached before the tools run, so this also covers the "debugger already
// attached" path and counts Page.fileChooserOpened events (must stay zero).
import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => {
  const index = arg.indexOf("=");
  return index < 0 ? [arg.slice(2), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
const reportFile = typeof args.get("report") === "string" ? args.get("report") : null;
const userDataDir = typeof args.get("user-data-dir") === "string" ? path.resolve(args.get("user-data-dir")) : null;
if (userDataDir) app.setPath("userData", userDataDir);
const realUrl = typeof args.get("url") === "string" ? args.get("url") : null;
const waitAuthMs = Number(args.get("wait-auth-ms") ?? 120_000);
const keep = args.get("keep") === true;
const mutate = !realUrl || args.get("mutate") === true;

const report = {
  status: "running",
  mode: realUrl ? "real-lobby" : "fixture",
  steps: [],
  checks: {},
  approvals: [],
  errors: [],
  fileChooserOpened: 0,
};

function saveReport() {
  if (!reportFile) return;
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}

function step(name, value) {
  report.steps.push({ name, at: new Date().toISOString(), ...(value === undefined ? {} : { value }) });
}

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>mt-compat lobby fixture</title></head>
<body>
<main>fixture lobby</main>
<input id="lobby-file" type="file" hidden>
<script>
(() => {
  const state = window.__E2E__ = {
    inspectCalls: 0, runCalls: 0, statusCalls: 0, cancelCalls: 0,
    file: null, boundFile: null, prep: "prep-e2e", job: "job-e2e",
    campaignRevision: 2, packRevision: 5, packs: [
      { packId: "pack-a", name: "Pack A" },
      { packId: "pack-b", name: "Pack B" }
    ],
    updateCalls: [], deleteCalls: [], deletePreviewCalls: [],
    statusTerminalAfter: 2
  };
  const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  window.__MT_AUTH__ = { access_token: "fixture-token" };
  window.__MT_AGENT_RUNTIME__ = function fixtureRuntime() {};
  window.__MT_AGENT_RUNTIME_SOURCE__ = "function fixtureRuntime() {}";
  window.__MT_LOBBY_SERVICE__ = {
    protocolVersion: 1,
    getFileInput() { return document.getElementById("lobby-file"); },
    async lobbyImportInspect(input) {
      state.inspectCalls += 1;
      const file = document.getElementById("lobby-file").files[0];
      if (!file) throw Object.assign(new Error("no File bound by Desktop"), { code: "FILE_NOT_BOUND" });
      const digest = await sha256(await file.arrayBuffer());
      state.file = { name: file.name, size: file.size, lastModified: file.lastModified, sha256: digest, path: file.path };
      if (file.name !== input.filename || file.size !== input.size || digest !== input.sha256) {
        throw Object.assign(new Error("bound File identity mismatch"), { code: "FILE_MISMATCH" });
      }
      return {
        preparationId: state.prep,
        kind: input.expectedKind || "world",
        plan: { kind: input.expectedKind || "world", assets: [{ name: "a.png" }], sourcePath: "/server/secret/world.zip", preparationId: state.prep }
      };
    },
    async lobbyImportRun({ preparationId }) {
      state.runCalls += 1;
      if (preparationId !== state.prep) throw Object.assign(new Error("unknown preparation"), { code: "PREPARATION_UNKNOWN" });
      return { jobId: state.job, plan: { kind: "world", campaignName: "E2E" } };
    },
    async lobbyImportStatus({ jobId }) {
      state.statusCalls += 1;
      if (state.statusCalls < state.statusTerminalAfter) return { jobId, phase: "running", progress: { stage: "assets", done: 1, total: 3 }, failureCount: 0 };
      return { jobId, phase: "succeeded", terminal: true, report: { campaignId: "campaign-e2e", actors: 3 }, failures: [] };
    },
    async lobbyImportCancel({ jobId }) { state.cancelCalls += 1; return { jobId, phase: "cancelling" }; },
    async lobbyCampaignsList() { return { campaigns: [{ id: "campaign-e2e", name: "E2E Campaign", ruleset: "dnd5e", owner: "dm", playUrl: "https://example.test/play.html" }] }; },
    async lobbyCampaignPacksGet({ campaignId }) {
      return { campaignId, revision: state.campaignRevision, selected: ["pack-a"], missing: [], builtIn: [{ id: "srd", readOnly: true }], enabledSources: { srd: true } };
    },
    async lobbyCampaignPacksUpdate(input) {
      state.updateCalls.push(input);
      if (String(input.expectedRevision) !== String(state.campaignRevision)) throw Object.assign(new Error("stale revision"), { code: "REVISION_MISMATCH" });
      state.campaignRevision += 1;
      return { campaignId: input.campaignId, revision: state.campaignRevision, selected: ["pack-a", ...(input.add || [])] };
    },
    async lobbyPacksList() { return { revision: state.packRevision, modules: [{ moduleId: "module-e2e", packs: state.packs }] }; },
    async lobbyPackRead({ packId, limit }) {
      const entries = Array.from({ length: 8 }, (_, i) => ({ entryId: "e-" + i, name: "Entry " + i }));
      return { pack: state.packs.find(pack => pack.packId === packId) || null, entries: entries.slice(0, limit || 20), nextCursor: null };
    },
    async lobbyPacksDeletePreview({ packIds, expectedRevision }) {
      state.deletePreviewCalls.push({ packIds, expectedRevision });
      return { packIds, entryCount: packIds.length * 2, assetCount: packIds.length };
    },
    async lobbyPacksDelete({ packIds, expectedRevision }) {
      state.deleteCalls.push({ packIds, expectedRevision });
      state.packs = state.packs.filter(pack => !packIds.includes(pack.packId));
      state.packRevision += 1;
      return { deleted: packIds, revision: state.packRevision };
    }
  };
})();
</script>
</body></html>`;

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  console.log("[lobby-e2e-app] main start");
  if (!app.requestSingleInstanceLock()) { console.log("[lobby-e2e-app] single instance lock denied"); app.quit(); return; }
  console.log("[lobby-e2e-app] lock acquired");
  await app.whenReady();
  console.log("[lobby-e2e-app] app ready");

  const scratch = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-e2e-"));
  const sourceDirectory = path.join(scratch, "prep");
  const mirrorStage = path.join(scratch, "arcane-fvtt-world-e2e");
  const outsideDirectory = path.join(scratch, "outside");
  for (const directory of [sourceDirectory, path.join(mirrorStage, "artifacts", "world"), outsideDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  const sourceFile = typeof args.get("source") === "string"
    ? path.resolve(args.get("source"))
    : path.join(sourceDirectory, "world-e2e.zip");
  if (!(typeof args.get("source") === "string")) writeFileSync(sourceFile, "PK fixture world bytes for native File binding");
  const outsideFile = path.join(outsideDirectory, "outside.zip");
  writeFileSync(outsideFile, "outside fence");
  const mirrorFile = path.join(mirrorStage, "artifacts", "world", "package.zip");
  const mirrorBytes = "mirror cache bytes";
  writeFileSync(mirrorFile, mirrorBytes);
  writeFileSync(path.join(mirrorStage, "stage.json"), JSON.stringify({
    kind: "foundry-world-profile-stage",
    mirrorGenerated: "2026-11-11T00:00:00.000Z",
    world: { sha256: createHash("sha256").update(mirrorBytes).digest("hex") },
    artifacts: [{ archive: "artifacts/world/package.zip" }],
  }));

  let server = null;
  let pageUrl = realUrl;
  let origin = null;
  if (!pageUrl) {
    server = http.createServer((request, response) => {
      if (request.url?.startsWith("/user-files/compat/lobby.html")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE_HTML);
      } else {
        response.writeHead(404);
        response.end("not found");
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    pageUrl = `${origin}/user-files/compat/lobby.html`;
  } else {
    origin = new URL(pageUrl).origin;
  }

  const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const contents = window.webContents;
  contents.on("render-process-gone", (_event, details) => console.log("[lobby-e2e-app] renderer gone", JSON.stringify(details)));
  contents.on("did-fail-load", (_event, code, description, url) => console.log("[lobby-e2e-app] did-fail-load", code, description, url));

  console.log("[lobby-e2e-app] loading", pageUrl);
  await contents.loadURL(pageUrl);
  console.log("[lobby-e2e-app] loaded");
  const expectedReady = realUrl
    ? "window.__MT_AUTH__ && window.__MT_LOBBY_SERVICE__"
    : "window.__MT_LOBBY_SERVICE__";
  try {
    await waitFor(async () => {
      try { return Boolean(await contents.executeJavaScript(`Boolean(${expectedReady})`)); } catch { return false; }
    }, realUrl ? waitAuthMs : 10_000, "lobby service/auth");
  } catch (error) {
    report.status = "needs-login";
    report.errors.push(error.message);
    saveReport();
    if (attachedHere) { try { contents.debugger.detach(); } catch { /* ignore */ } }
    app.exit(2);
    return;
  }

  let attachedHere = false;
  try {
    contents.debugger.attach("1.3");
    attachedHere = true;
  } catch (error) {
    report.errors.push(`debugger attach (fixture): ${error.message}`);
  }
  contents.debugger.on("message", (_event, method) => {
    if (method === "Page.fileChooserOpened") report.fileChooserOpened += 1;
  });
  try { await contents.debugger.sendCommand("Page.enable"); } catch { /* not required for DOM.setFileInputFiles */ }


  const { MtLobbyClient } = await import("../../src/main/mt-lobby-client.js");
  const { createLobbyTools } = await import("../../src/main/lobby-tools.js");
  const { findMirrorStageRoots } = await import("../../src/main/lobby-mirror-cache.js");
  const client = new MtLobbyClient({
    getWebContents: () => contents,
    ...(realUrl ? {} : { trustedOrigins: [origin], lobbyPathPattern: /^\/user-files\/compat\/lobby\.html$/ }),
    log: message => report.steps.push({ name: "client-log", message }),
  });
  let deny = false;
  const sourceRoots = [path.dirname(sourceFile), sourceDirectory, ...findMirrorStageRoots({ tmpdir: scratch })];
  const host = {
    profile: { mode: "prep" },
    log: message => report.steps.push({ name: "host-log", message }),
    cwd: () => path.dirname(sourceFile),
    lobbyFileRoots: () => sourceRoots,
    lobbyClient: () => client,
    maybeRequestApproval: async (payload) => {
      report.approvals.push({ tool: payload.tool, summary: payload.summary, args: payload.args, denied: deny });
      return !deny;
    },
  };
  const tools = new Map(createLobbyTools(host).map(tool => [tool.name, tool]));
  const invoke = async (name, params) => {
    const result = await tools.get(name).execute(`e2e-${name}`, params);
    step(name, { text: result.content?.[0]?.text, details: result.details, isError: result.isError ?? false });
    return result;
  };

  try {
    const campaigns = await invoke("foundry_lobby_campaigns_list", {});
    const library = await invoke("foundry_lobby_packs_read", {});
    if (realUrl) {
      report.checks.campaignsListed = Array.isArray(campaigns.details?.campaigns);
      report.checks.packLibraryRead = library.details !== undefined && !library.isError;
      report.checks.readOnlyMode = !mutate;
    } else {
      report.checks.campaignsListed = campaigns.details?.campaigns?.[0]?.id === "campaign-e2e";
      report.checks.packLibraryRead = library.details?.revision === 5;
      const read = await invoke("foundry_lobby_packs_read", { packId: "pack-a", limit: 3 });
      report.checks.packEntriesRead = read.details?.entries?.length === 3;
    }

    if (mutate) {
      const start = await invoke("foundry_lobby_import_start", { sourcePath: sourceFile, expectedKind: "world" });
      report.checks.importStarted = Boolean(start.details?.jobId);
      const job = await invoke("foundry_lobby_import_job", { jobId: start.details.jobId, action: "status", waitMs: 3_000 });
      report.checks.importCompleted = job.details?.status === "succeeded";
      const pageState = await contents.executeJavaScript("window.__E2E__");
      report.fileEvidence = pageState.file;
      report.checks.nativeFileBound = Boolean(pageState.file && pageState.file.size > 0);
      report.checks.nativeFilePathHidden = pageState.file?.path === undefined || pageState.file?.path === null;
      report.checks.nativeFileReadable = pageState.inspectCalls === 1;

      const packs = await invoke("foundry_lobby_campaign_packs_get", { campaignId: "campaign-e2e" });
      report.checks.campaignPacksRead = packs.details?.revision === 2;
      const update = await invoke("foundry_lobby_campaign_packs_update", {
        campaignId: "campaign-e2e", expectedRevision: packs.details.revision, add: ["pack-b"],
        enabledSourcesPatch: { srd2014: true },
      });
      report.checks.campaignPacksUpdated = update.details?.current?.revision === 3;

      const deleted = await invoke("foundry_lobby_packs_delete", { packIds: ["pack-b"], expectedRevision: library.details.revision });
      report.checks.packDeleted = deleted.details?.revision === 6;

      const fence = await invoke("foundry_lobby_import_start", { sourcePath: outsideFile });
      report.checks.outsideFenceRejected = fence.details?.code === "FILE_OUTSIDE_FENCE";
      const mirror = await invoke("foundry_lobby_import_start", { sourcePath: mirrorFile });
      report.checks.mirrorCacheAllowed = Boolean(mirror.details?.jobId);

      deny = true;
      const denied = await invoke("foundry_lobby_campaign_packs_update", {
        campaignId: "campaign-e2e", expectedRevision: 3, add: ["pack-a"],
      });
      report.checks.approvalDenied = denied.details?.code === "DECLINED";
      const stateAfterDeny = await contents.executeJavaScript("window.__E2E__");
      report.checks.approvalDeniedZeroWrite = stateAfterDeny.updateCalls.length === 1;
      report.checks.planSanitized = !JSON.stringify(start.details).includes("prep-e2e")
        && !JSON.stringify(start.details).includes("/server/secret");
    }
    report.checks.noFileChooserOpened = report.fileChooserOpened === 0;
    report.status = Object.values(report.checks).every(Boolean) ? "completed" : "failed";
    report.mutated = mutate;
  } catch (error) {
    report.status = "failed";
    report.errors.push(error?.stack ?? String(error));
  } finally {
    saveReport();
    if (attachedHere) { try { contents.debugger.detach(); } catch { /* ignore */ } }
    if (!keep) {
      try { await rm(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (server) await new Promise(resolve => server.close(resolve));
    app.exit(report.status === "completed" ? 0 : 1);
  }
}

main().catch(error => {
  report.status = "failed";
  report.errors.push(error?.stack ?? String(error));
  saveReport();
  app.exit(1);
});
