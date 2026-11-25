// Electron fixture for the real lobby tool + native CDP file channel.
// Usage: electron test/fixtures/lobby-e2e-app.mjs --report=<json> [--source=<zip>]
//        [--url=<real lobby url>] [--mutate] [--compat-root=<compat worktree>]
//        [--campaign-prefix=<name>] [--wait-auth-ms=120000] [--insecure-tls] [--keep]
//
// Fixture mode (default; no cloud, backend, or login required) serves the mt-compat
// lobby contract from an in-process page and calls the real createLobbyTools and
// createMapApiTools implementations. It asserts native CDP File binding, generic
// campaign create/read and pack-delete preview, and zero Page.fileChooserOpened.
//
// Real mode (--url=<lobby url>) loads the deployed mt-compat lobby page in a real
// BrowserWindow and drives the same tools against the real ArcaneVTT backend:
//   - Login uses Keycloak ROPC with MT_ACCEPT_USER / MT_ACCEPT_PASSWORD from the
//     process environment only (never argv, never the report). The access/refresh
//     token is injected into sessionStorage["mt.session"], the page is reloaded,
//     and the session is cleared + revoked in the finally block.
//   - The trusted-origin gate is exercised the same way main.js does it:
//     createPanelProfileOverrides() points this deployment at "mtcompat".
//   - --insecure-tls is a harness-only Electron switch for the self-signed local
//     stack; it never touches production configuration.
//
// Real + --mutate runs the full mutation contract against isolated objects only:
//   - map_api_call creates, reads and deletes an isolated campaign (ruleset 2024);
//   - a collection (module) package imported through the native File channel;
//   - a world package imported through the same channel, which creates its own
//     campaign with ruleset=2024.
// Then: packs read/entries, lobbyCampaignPacksGet/Update with expectedRevision, stale +
// approval-denial zero-write checks, pack delete preview/delete, play-page rejection,
// and map_lobby_return play->lobby through the production DirectFoundryRuntime.
// Every campaign/pack this run creates is deleted again; pre-existing packs and
// campaigns are never deleted.
import { app, BrowserWindow } from "electron";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = new Map(process.argv.slice(2).filter(arg => arg.startsWith("--")).map(arg => {
  const index = arg.indexOf("=");
  return index < 0 ? [arg.slice(2), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
const reportFile = typeof args.get("report") === "string" ? args.get("report") : null;
const userDataDir = typeof args.get("user-data-dir") === "string" ? path.resolve(args.get("user-data-dir")) : null;
if (userDataDir) app.setPath("userData", userDataDir);
const realUrl = typeof args.get("url") === "string" ? args.get("url") : null;
const realMutate = realUrl ? args.get("mutate") === true : true;
const insecureTls = realUrl !== null && args.get("insecure-tls") === true;
const waitAuthMs = Number(args.get("wait-auth-ms") ?? 120_000);
const keep = args.get("keep") === true;
const campaignPrefix = typeof args.get("campaign-prefix") === "string" ? args.get("campaign-prefix") : "arcanedesk-lobby-e2e";
const compatRoot = typeof args.get("compat-root") === "string"
  ? path.resolve(args.get("compat-root"))
  : path.resolve(process.env.MT_FOUNDRY_COMPAT_ROOT
    ?? fileURLToPath(new URL("../../../../../mt-foundry-compat/", import.meta.url)));
const moduleId = "t7-fixture-module";

// Fail fast in real mode: no page load, no browser window, no network before we know
// the test account was supplied through the environment (never argv).
const credentialsPresent = Boolean(process.env.MT_ACCEPT_USER && process.env.MT_ACCEPT_PASSWORD);
if (realUrl && !credentialsPresent) {
  const text = `${JSON.stringify({
    mode: "real-lobby",
    status: "needs-credentials",
    errors: ["MT_ACCEPT_USER and MT_ACCEPT_PASSWORD must be set in the environment (never in argv)"],
  }, null, 2)}\n`;
  if (reportFile) {
    try {
      mkdirSync(path.dirname(reportFile), { recursive: true });
      writeFileSync(reportFile, text);
    } catch { /* surfaced by the launcher */ }
  }
  console.error("[lobby-e2e-app] real-lobby mode needs MT_ACCEPT_USER and MT_ACCEPT_PASSWORD in the environment");
  process.exit(2);
}

if (insecureTls) {
  // Harness-level only: the local mtlocal.internal stack uses a self-signed cert.
  app.commandLine.appendSwitch("ignore-certificate-errors");
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const report = {
  status: "running",
  mode: realUrl ? (realMutate ? "real-lobby-mutate" : "real-lobby-read") : "fixture",
  steps: [],
  checks: {},
  approvals: [],
  errors: [],
  notCovered: [],
  fileChooserOpened: 0,
};

// Secrets are kept in memory only: the password/tokens never enter argv or the report.
const secrets = [];
const rememberSecret = value => {
  if (typeof value === "string" && value.length >= 6 && !secrets.includes(value)) secrets.push(value);
};
function scrubValue(value) {
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join("[secret]");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item);
    return out;
  }
  return value;
}

function saveReport() {
  if (!reportFile) return;
  // Compute from the unscrubbed object: masking first would hide exactly the leak
  // this check is supposed to detect.
  report.checks.noSecretsInReport = reportHasNoSecrets();
  const finalText = `${JSON.stringify(scrubValue(report), null, 2)}\n`;
  try {
    mkdirSync(path.dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, finalText);
  } catch (error) {
    console.error(`[lobby-e2e-app] report write failed: ${error?.message ?? error}`);
  }
}

function reportHasNoSecrets() {
  const text = JSON.stringify(report);
  return secrets.every(secret => !secret || !text.includes(secret));
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
    },
    async lobbyRulesetsList() {
      return { rulesets: [
        { id: "2024", label: "D&D 2024", system: "dnd5e" },
        { id: "coc7", label: "Call of Cthulhu", system: "brp", supportLevel: "experimental" },
      ] };
    },
    async lobbyCampaignCreate({ name, ruleset }) {
      const campaign = { id: "campaign-generic", name, ruleset, owner: "dm", imageUrl: null };
      state.createdCampaign = campaign;
      return { campaign, playUrl: "https://example.test/play.html?campaign=campaign-generic", warnings: [] };
    },
    async lobbyCampaignRead({ campaignId }) {
      if (state.createdCampaign?.id === campaignId) {
        return { campaign: state.createdCampaign, playUrl: "https://example.test/play.html?campaign=campaign-generic" };
      }
      throw Object.assign(new Error("campaign not found"), { code: "CAMPAIGN_NOT_FOUND" });
    }
  };
  const service = window.__MT_LOBBY_SERVICE__;
  const action = (id, effect, inputSchema, example, extra = {}) => ({
    id, kind: "action", effect, summary: id, access: effect === "read" ? "authenticated" : "owner",
    inputSchema, example, idempotent: effect === "read", ...extra
  });
  const operations = [
    action("lobbyRulesetsList", "read", { type: "object", properties: {} }, {}),
    action("lobbyCampaignsList", "read", { type: "object", properties: {} }, {}),
    action("lobbyCampaignCreate", "write", { type: "object", properties: { name: { type: "string" }, ruleset: { type: "string" } }, required: ["name", "ruleset"] }, { name: "Generic Campaign", ruleset: "2024" }, { idempotent: false }),
    action("lobbyCampaignRead", "read", { type: "object", properties: { campaignId: { type: "string" } }, required: ["campaignId"] }, { campaignId: "campaign-generic" }),
    action("lobbyPacksList", "read", { type: "object", properties: {} }, {}),
    action("lobbyPackRead", "read", { type: "object", properties: { packId: { type: "string" }, limit: { type: "integer" } }, required: ["packId"] }, { packId: "pack-a", limit: 3 }),
    action("lobbyCampaignPacksGet", "read", { type: "object", properties: { campaignId: { type: "string" } }, required: ["campaignId"] }, { campaignId: "campaign-e2e" }),
    action("lobbyCampaignPacksUpdate", "write", { type: "object", properties: { campaignId: { type: "string" }, expectedRevision: {}, add: { type: "array" } }, required: ["campaignId", "expectedRevision"] }, { campaignId: "campaign-e2e", expectedRevision: 2, add: ["pack-b"] }, { idempotent: false }),
    action("lobbyPacksDelete", "write", { type: "object", properties: { packIds: { type: "array" }, expectedRevision: {} }, required: ["packIds", "expectedRevision"] }, { packIds: ["pack-b"], expectedRevision: 5 }, { idempotent: false, requiresPreview: true })
  ];
  service.apiOperationSearch = async ({ prefix = "", kind, limit = 10 } = {}) => ({
    revision: 2,
    page: "lobby",
    operations: operations.filter(operation => (!prefix || operation.id.startsWith(prefix)) && (!kind || operation.kind === kind)).slice(0, limit)
  });
  service.apiCall = async ({ id, args, preview = false }) => {
    const operation = operations.find(candidate => candidate.id === id);
    if (!operation) throw Object.assign(new Error("unknown operation"), { code: "ACTION_UNKNOWN" });
    if (preview) {
      if (!operation.requiresPreview) return { status: "preview", operationId: id, value: null };
      return { status: "preview", operationId: id, value: await service.lobbyPacksDeletePreview(args) };
    }
    if (typeof service[id] !== "function") throw Object.assign(new Error("missing operation implementation"), { code: "CAPABILITY_UNAVAILABLE" });
    return { status: "completed", operationId: id, value: await service[id](args) };
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

async function restJson(origin, token, method, apiPath, body) {
  const response = await fetch(`${origin}${apiPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token.access_token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: response.status, json, text };
}

/**
 * Keycloak ROPC login from process env. Credentials/tokens are remembered only so
 * the report scrubber can prove they never leaked; nothing is printed.
 */
async function loginReal(origin) {
  const username = process.env.MT_ACCEPT_USER;
  const password = process.env.MT_ACCEPT_PASSWORD;
  if (!username || !password) {
    const error = new Error("MT_ACCEPT_USER and MT_ACCEPT_PASSWORD are required for real-lobby login (environment only; never argv)");
    error.code = "E2E_CREDENTIALS_MISSING";
    throw error;
  }
  rememberSecret(password);
  const configResponse = await fetch(`${origin}/api/config`);
  if (!configResponse.ok) throw new Error(`GET /api/config failed with HTTP ${configResponse.status}`);
  const config = await configResponse.json();
  if (!config?.authority || !config?.clientId) throw new Error("/api/config did not return authority/clientId");
  const tokenResponse = await fetch(`${config.authority}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: config.clientId, username, password }),
  });
  if (!tokenResponse.ok) throw new Error(`Keycloak token request failed with HTTP ${tokenResponse.status}`);
  const token = await tokenResponse.json();
  if (!token?.access_token) throw new Error("Keycloak token response did not include access_token");
  rememberSecret(token.access_token);
  rememberSecret(token.refresh_token);
  return { token, authority: config.authority, clientId: config.clientId, username };
}

async function injectSession(contents, token) {
  const session = JSON.stringify({ access_token: token.access_token, refresh_token: token.refresh_token ?? null });
  await contents.executeJavaScript(
    `sessionStorage.setItem("mt.session", ${JSON.stringify(session)});`
    + ` sessionStorage.removeItem("mt.lobby.pkce"); sessionStorage.removeItem("mt.lobby.pkce.backup");`
    + ` location.reload(); true`,
  );
}

async function clearSession(contents, login) {
  try {
    await contents.executeJavaScript(
      `sessionStorage.removeItem("mt.session"); sessionStorage.removeItem("mt.lobby.pkce");`
      + ` sessionStorage.removeItem("mt.lobby.pkce.backup"); sessionStorage.removeItem("mt.campaign"); true`,
    );
  } catch { /* page may be gone */ }
  if (!login?.token?.refresh_token) return null;
  try {
    const response = await fetch(`${login.authority}/protocol/openid-connect/logout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: login.clientId, refresh_token: login.token.refresh_token }),
    });
    return response.status;
  } catch {
    return null;
  }
}

/** Page-side evidence that Desktop bound a real disk-backed File to the service slot. */
async function readNativeFileEvidence(contents) {
  return contents.executeJavaScript(`(async () => {
    const service = globalThis.__MT_LOBBY_SERVICE__;
    const input = service && typeof service.getFileInput === "function" ? service.getFileInput() : null;
    const file = input && input.files ? input.files[0] ?? null : null;
    if (!file) return null;
    return {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified ?? null,
      path: file.path ?? null,
      slice: typeof file.slice,
      arrayBuffer: typeof file.arrayBuffer,
      purposeSlot: input.getAttribute ? input.getAttribute("data-mt-lobby-file-slot") : null,
    };
  })()`);
}

async function runRealContract({ contents, invoke, rest, scratch, pageUrl, setDeny, setRuntime }) {
  const origin = new URL(pageUrl).origin;
  const state = {
    campaignId: null,
    campaignName: `${campaignPrefix}-${Date.now().toString(36)}`,
    baselineRevision: null,
    baselinePackCount: null,
    baselinePackIds: [],
    packIds: [],
    deletedPack: false,
    campaignDeleted: false,
    worldCampaignId: null,
    worldCampaignDeleted: false,
  };
  const checks = report.checks;
  report.real = {
    ...(report.real ?? {}),
    origin,
    deploymentPath: new URL(pageUrl).pathname,
    campaignName: state.campaignName,
    moduleId,
    compatRoot,
    tlsVerification: insecureTls ? "disabled (harness-only, self-signed local stack)" : "system",
  };
  try {
    const rulesets = await invoke("foundry_lobby_rulesets_list", {});
    checks.realRulesetsListed = Array.isArray(rulesets.details?.rulesets)
      && rulesets.details.rulesets.some(ruleset => ruleset.id === "2024");
    report.real.deploymentRulesets = (rulesets.details?.rulesets ?? []).map(ruleset => ruleset.id);

    const created = await invoke("map_api_call", {
      id: "lobbyCampaignCreate", args: { name: state.campaignName, ruleset: "2024" },
    });
    state.campaignId = created.details?.value?.campaign?.id ?? created.details?.campaignId ?? null;
    checks.isolatedCampaignCreated = created.details?.status === "completed"
      && typeof state.campaignId === "string" && created.details.value.campaign.ruleset === "2024";
    if (!checks.isolatedCampaignCreated) {
      throw new Error(`isolated campaign create failed: ${JSON.stringify(created.details ?? created.content?.[0]?.text).slice(0, 300)}`);
    }
    report.real.campaignId = state.campaignId;
    const readBack = await invoke("map_api_call", { id: "lobbyCampaignRead", args: { campaignId: state.campaignId } });
    checks.isolatedCampaignReadBack = readBack.details?.value?.campaign?.name === state.campaignName
      && readBack.details.value.campaign.ruleset === "2024";

    const campaigns = await invoke("map_api_call", { id: "lobbyCampaignsList", args: {} });
    const listed = (campaigns.details?.value?.campaigns ?? []).find(campaign => campaign.id === state.campaignId);
    checks.campaignsListReturnsIsolated = Boolean(listed)
      && listed.name === state.campaignName
      && listed.ruleset === "2024";

    const baseline = await invoke("foundry_lobby_packs_read", {});
    state.baselineRevision = baseline.details?.revision ?? null;
    state.baselinePackCount = baseline.details?.packCount ?? null;
    const baselineModules = baseline.details?.modules ?? [];
    state.baselinePackIds = baselineModules.flatMap(module => (module.packs ?? []).map(pack => pack.packId));
    checks.libraryBaselineRead = typeof state.baselineRevision === "string" && state.baselineRevision.length > 0;
    checks.fixtureModuleAbsentBeforeImport = !baselineModules.some(module => module.moduleId === moduleId);
    if (!checks.fixtureModuleAbsentBeforeImport) {
      throw new Error(`refusing to import: module ${moduleId} already exists in this account's library (would replace existing packs)`);
    }
    report.real.baseline = { revision: state.baselineRevision, packCount: state.baselinePackCount, packs: state.baselinePackIds.length };

    const fixtureModule = await import(pathToFileURL(path.join(compatRoot, "tools/fixtures/make-t7-module-zip.mjs")).href);
    if (typeof fixtureModule.moduleZip !== "function") throw new Error("compat fixture generator has no moduleZip()");
    const zipBytes = fixtureModule.moduleZip({ version: "1.0.0", count: 3 });
    const zipPath = path.join(scratch, "prep", `lobby-contract-${Date.now().toString(36)}.zip`);
    writeFileSync(zipPath, zipBytes);
    const localSha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    report.real.source = { filename: path.basename(zipPath), size: statSync(zipPath).size, sha256: localSha256 };

    const start = await invoke("map_lobby_import_start", { sourcePath: zipPath, expectedKind: "collection" });
    checks.importStarted = typeof start.details?.jobId === "string" && start.details.jobId.length > 0;
    if (!checks.importStarted) {
      throw new Error(`import_start failed: ${JSON.stringify(start.details ?? start.content?.[0]?.text).slice(0, 300)}`);
    }

    const fileEvidence = await readNativeFileEvidence(contents);
    report.real.nativeFile = fileEvidence;
    checks.nativeFileBound = Boolean(fileEvidence)
      && fileEvidence.name === report.real.source.filename
      && fileEvidence.size === report.real.source.size;
    checks.nativeFilePathHidden = fileEvidence?.path === null || fileEvidence?.path === undefined;
    checks.nativeFileSliceable = fileEvidence?.slice === "function" && fileEvidence?.arrayBuffer === "function";

    let job = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      job = await invoke("map_lobby_import_job", { jobId: start.details.jobId, action: "status", waitMs: 25_000 });
      if (job.details?.terminal) break;
    }
    checks.importJobTerminal = job.details?.terminal === true;
    checks.importJobSucceeded = job.details?.status === "succeeded";
    checks.importReportModule = job.details?.report?.module?.id === moduleId;
    checks.planSanitized = !JSON.stringify(start.details ?? {}).includes("preparationId")
      && !JSON.stringify(job.details ?? {}).includes("preparationId")
      && !JSON.stringify(start.details ?? {}).includes(zipPath);
    if (!checks.importJobSucceeded) {
      throw new Error(`import job did not succeed: ${JSON.stringify(job.details ?? {}).slice(0, 400)}`);
    }

    const afterImport = await invoke("foundry_lobby_packs_read", {});
    const importedModule = (afterImport.details?.modules ?? []).find(module => module.moduleId === moduleId);
    state.packIds = (importedModule?.packs ?? []).map(pack => pack.packId);
    checks.importedPackListed = state.packIds.length > 0;
    checks.libraryRevisionChanged = afterImport.details?.revision !== state.baselineRevision;

    const packRead = state.packIds[0]
      ? await invoke("foundry_lobby_packs_read", { packId: state.packIds[0], limit: 2 })
      : null;
    checks.packEntriesRead = (packRead?.details?.entries?.length ?? 0) === 2
      && Boolean(packRead?.details?.nextCursor)
      && packRead?.details?.pack?.packId === state.packIds[0];

    const packsGet = await invoke("foundry_lobby_campaign_packs_get", { campaignId: state.campaignId });
    checks.campaignPacksRead = typeof packsGet.details?.revision === "string"
      && packsGet.details?.ruleset === "2024"
      && packsGet.details?.srdApplicable === true;

    const updated = await invoke("foundry_lobby_campaign_packs_update", {
      campaignId: state.campaignId,
      expectedRevision: packsGet.details.revision,
      add: state.packIds,
      enabledSourcesPatch: { srd2024: true },
    });
    const current = updated.details?.current;
    checks.campaignPacksUpdated = Boolean(current)
      && state.packIds.every(packId => (current.selected ?? []).some(entry => entry.packId === packId))
      && current.enabledSources?.srd2024 === true;
    checks.campaignPacksRevisionBumped = Boolean(current?.revision) && current.revision !== packsGet.details.revision;

    const stale = await invoke("foundry_lobby_campaign_packs_update", {
      campaignId: state.campaignId,
      expectedRevision: packsGet.details.revision,
      remove: state.packIds,
    });
    checks.staleCampaignUpdateRejected = stale.details?.code === "REVISION_MISMATCH";
    const afterStale = await invoke("foundry_lobby_campaign_packs_get", { campaignId: state.campaignId });
    checks.staleCampaignUpdateZeroWrite = afterStale.details?.revision === current?.revision
      && (afterStale.details?.selected ?? []).some(entry => entry.packId === state.packIds[0]);

    setDeny(true);
    const denied = await invoke("foundry_lobby_campaign_packs_update", {
      campaignId: state.campaignId,
      expectedRevision: afterStale.details.revision,
      remove: state.packIds,
    });
    setDeny(false);
    checks.approvalDenied = denied.details?.code === "DECLINED";
    const afterDenied = await invoke("foundry_lobby_campaign_packs_get", { campaignId: state.campaignId });
    checks.approvalDeniedZeroWrite = afterDenied.details?.revision === afterStale.details?.revision
      && (afterDenied.details?.selected ?? []).some(entry => entry.packId === state.packIds[0]);

    const removed = await invoke("foundry_lobby_campaign_packs_update", {
      campaignId: state.campaignId,
      expectedRevision: afterDenied.details.revision,
      remove: state.packIds,
    });
    checks.campaignPacksRemoved = state.packIds.every(packId => !(removed.details?.current?.selected ?? []).some(entry => entry.packId === packId));

    // Real world import: same native File channel, world dump parsed by the shared
    // compat service, campaign created with ruleset=2024. The world's own campaign is
    // tracked separately and deleted with the rest of this run's objects.
    const worldFixture = fixtureModule.worldZip();
    if (typeof worldFixture === "undefined" || !(worldFixture instanceof Uint8Array)) {
      throw new Error("compat fixture generator has no worldZip()");
    }
    const worldName = `${campaignPrefix}-world-${Date.now().toString(36)}`;
    const worldPath = path.join(scratch, "prep", `${path.basename(worldName)}.zip`);
    writeFileSync(worldPath, worldFixture);
    report.real.worldSource = {
      filename: path.basename(worldPath),
      size: statSync(worldPath).size,
      sha256: createHash("sha256").update(worldFixture).digest("hex"),
    };
    const worldStart = await invoke("map_lobby_import_start", {
      sourcePath: worldPath,
      expectedKind: "world",
      campaignName: worldName,
      ruleset: "2024",
    });
    checks.worldImportStarted = typeof worldStart.details?.jobId === "string";
    let worldJob = null;
    for (let attempt = 0; attempt < 8 && checks.worldImportStarted; attempt += 1) {
      worldJob = await invoke("map_lobby_import_job", { jobId: worldStart.details.jobId, action: "status", waitMs: 25_000 });
      if (worldJob.details?.terminal) break;
    }
    checks.worldImportSucceeded = worldJob?.details?.status === "succeeded";
    const worldReport = worldJob?.details?.report ?? null;
    state.worldCampaignId = worldReport?.campaign?.id ?? null;
    checks.worldImportCreatedCampaign = typeof state.worldCampaignId === "string"
      && worldReport?.campaign?.mode === "new"
      && worldReport?.rules?.id === "2024"
      && (worldReport?.totals?.written ?? 0) > 0;
    checks.worldImportPlanSanitized = !JSON.stringify(worldStart.details ?? {}).includes("preparationId")
      && !JSON.stringify(worldJob?.details ?? {}).includes("preparationId");
    if (state.worldCampaignId) {
      const worldList = await invoke("foundry_lobby_campaigns_list", {});
      const worldListed = (worldList.details?.campaigns ?? []).find(campaign => campaign.id === state.worldCampaignId);
      checks.worldCampaignListedWithRuleset = worldListed?.ruleset === "2024" && worldListed?.name === worldName;
      const worldPacks = await invoke("foundry_lobby_campaign_packs_get", { campaignId: state.worldCampaignId });
      checks.worldCampaignPacksReadable = worldPacks.details?.ruleset === "2024" && !worldPacks.isError;
    }
    report.real.worldImport = {
      campaignId: state.worldCampaignId,
      rules: worldReport?.rules ?? null,
      totals: worldReport?.totals ?? null,
      assets: worldReport?.assets ? { uploads: worldReport.assets.uploads, failures: worldReport.assets.failures } : null,
      warnings: worldReport?.warnings ?? null,
    };

    const already = await invoke("map_lobby_return", {});
    checks.lobbyReturnAlreadyInLobby = already.details?.status === "completed" && already.details?.alreadyInLobby === true;

    const playUrl = new URL("play.html", pageUrl);
    playUrl.search = `?campaign=${encodeURIComponent(state.campaignId)}`;
    await contents.loadURL(playUrl.href);
    const playDeadline = Date.now() + 45_000;
    let playState = null;
    while (Date.now() < playDeadline) {
      playState = await contents.executeJavaScript(`({
        url: location.href,
        gameReady: Boolean(globalThis.game?.ready),
        hasGame: Boolean(globalThis.game),
        hasLobbyService: Boolean(globalThis.__MT_LOBBY_SERVICE__),
        runtime: typeof globalThis.__MT_AGENT_RUNTIME__,
        navigateToLobby: typeof globalThis.__MT_PLAY_EXIT__?.navigateToLobby
      })`).catch(() => null);
      if (playState?.gameReady) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    report.real.playPage = playState;
    checks.playPageIsRealGamePage = playState?.gameReady === true && playState?.hasGame === true;
    checks.playPageHasNoLobbyService = playState?.hasLobbyService === false;
    checks.playPageExposesTypedReturn = playState?.navigateToLobby === "function" && playState?.runtime === "function";

    const rejected = await invoke("foundry_lobby_campaigns_list", {});
    checks.playPageRejectsLobbyTool = rejected.details?.code === "PROFILE_MISMATCH"
      && /lobby\.html/.test(String(rejected.content?.[0]?.text ?? ""));
    const rejectedPacks = await invoke("foundry_lobby_packs_read", {});
    checks.playPageRejectsPacksRead = rejectedPacks.details?.code === "PROFILE_MISMATCH";

    // Real play -> lobby through the actual typed action: the page's own
    // __MT_PLAY_EXIT__.navigateToLobby, dispatched by the production
    // DirectFoundryRuntime queue, then confirmed by MtLobbyClient.waitForLobbyReady.
    const { DirectFoundryRuntime } = await import("../../src/main/direct-foundry-runtime.js");
    const { MTCOMPAT_RUNTIME_ACTIONS } = await import("../../src/main/foundry-tool-policy.js");
    const { PAGE_PROFILES, clientPageProfile } = await import("../../src/main/page-profiles.js");
    const runtimeSource = await contents.executeJavaScript("window.__MT_AGENT_RUNTIME_SOURCE__");
    checks.playPageRuntimeSourceIsReal = typeof runtimeSource === "string"
      && runtimeSource.includes("navigateToLobby")
      && runtimeSource.length > 100_000;
    const runtime = new DirectFoundryRuntime({
      getWebContents: () => contents,
      runtimeSource,
      allowedActions: MTCOMPAT_RUNTIME_ACTIONS,
      pageProfile: clientPageProfile(PAGE_PROFILES.mtcompat),
      readyPollMs: 100,
      log: (level, message) => report.steps.push({ name: "runtime-log", level, message: String(message).slice(0, 300) }),
    });
    setRuntime(runtime);
    const returned = await invoke("map_lobby_return", {});
    report.real.realReturn = returned.details;
    checks.lobbyReturnRealCompleted = returned.details?.status === "completed" && returned.details?.alreadyInLobby !== true;
    checks.lobbyReturnFromCampaign = returned.details?.from?.campaignId === state.campaignId;
    checks.lobbyReturnToLobby = /\/lobby\.html$/.test(String(returned.details?.to?.path ?? ""));
    await waitFor(async () => {
      try {
        return Boolean(await contents.executeJavaScript(
          `globalThis.__MT_LOBBY__?.phase === "ready" && Boolean(globalThis.__MT_AUTH__) && Boolean(globalThis.__MT_LOBBY_SERVICE__)`,
        ));
      } catch { return false; }
    }, waitAuthMs, "lobby ready after real return");
    const lobbyAfterReturn = await contents.executeJavaScript(
      `({ path: location.pathname, phase: globalThis.__MT_LOBBY__?.phase, auth: Boolean(globalThis.__MT_AUTH__), service: Boolean(globalThis.__MT_LOBBY_SERVICE__) })`,
    ).catch(() => null);
    report.real.lobbyAfterReturn = lobbyAfterReturn;
    checks.lobbyReadyAfterRealReturn = lobbyAfterReturn?.phase === "ready"
      && lobbyAfterReturn?.auth === true
      && lobbyAfterReturn?.service === true
      && /\/lobby\.html$/.test(String(lobbyAfterReturn?.path ?? ""));
    if (!checks.lobbyReadyAfterRealReturn) {
      // Fallback only to finish cleanup; the failed check above already records it.
      await contents.loadURL(pageUrl);
      await waitFor(async () => {
        try {
          return Boolean(await contents.executeJavaScript(
            `globalThis.__MT_LOBBY__?.phase === "ready" && Boolean(globalThis.__MT_AUTH__) && Boolean(globalThis.__MT_LOBBY_SERVICE__)`,
          ));
        } catch { return false; }
      }, waitAuthMs, "lobby ready after play rejection");
    }

    const preDelete = await invoke("foundry_lobby_packs_read", {});
    const deleted = await invoke("foundry_lobby_packs_delete", {
      packIds: state.packIds,
      expectedRevision: preDelete.details.revision,
    });
    state.deletedPack = !deleted.isError;
    checks.packDeletePreviewReported = Boolean(deleted.details?.preview?.totals)
      && (deleted.details.preview.totals.packs ?? 0) >= state.packIds.length;
    const postDelete = await invoke("foundry_lobby_packs_read", {});
    checks.packDeleted = !(postDelete.details?.modules ?? []).some(module => module.moduleId === moduleId);
    checks.libraryRevisionRestored = postDelete.details?.revision === state.baselineRevision;
    const remainingPackIds = new Set((postDelete.details?.modules ?? []).flatMap(module => (module.packs ?? []).map(pack => pack.packId)));
    checks.existingPacksUntouched = postDelete.details?.packCount === state.baselinePackCount
      && state.baselinePackIds.every(packId => remainingPackIds.has(packId) && !state.packIds.includes(packId));
    checks.noFileChooserOpened = report.fileChooserOpened === 0;
    report.real.afterDelete = { revision: postDelete.details?.revision, packCount: postDelete.details?.packCount };

    const campaignDelete = await invoke("map_api_call", {
      id: "lobbyCampaignDelete", args: { campaignId: state.campaignId, expectedName: state.campaignName },
    });
    state.campaignDeleted = campaignDelete.details?.value?.deleted === true;
    checks.isolatedCampaignDeleted = state.campaignDeleted;
    checks.isolatedCampaignDeletePreview = report.approvals.some(approval => approval.tool === "map_api_call"
      && approval.args?.operationId === "lobbyCampaignDelete" && approval.args.preview?.expectedNameMatches === true);
    const campaignsAfter = await invoke("map_api_call", { id: "lobbyCampaignsList", args: {} });
    checks.isolatedCampaignAbsentAfterDelete = !(campaignsAfter.details?.value?.campaigns ?? []).some(campaign => campaign.id === state.campaignId);

    if (state.worldCampaignId) {
      const worldDelete = await rest("DELETE", `/api/campaigns/${state.worldCampaignId}`);
      state.worldCampaignDeleted = worldDelete.status === 200 || worldDelete.status === 204 || worldDelete.status === 404;
      checks.worldCampaignDeleted = state.worldCampaignDeleted;
      const campaignsAfterWorld = await invoke("foundry_lobby_campaigns_list", {});
      checks.worldCampaignAbsentAfterDelete = !(campaignsAfterWorld.details?.campaigns ?? []).some(campaign => campaign.id === state.worldCampaignId);
    }
  } finally {
    // Cleanup is limited to objects this run created: the recorded pack ids and the
    // isolated campaign ids. Nothing else is deleted.
    if (!state.deletedPack && state.packIds.length > 0) {
      try {
        const purge = await rest("POST", "/api/collections/foundry-userpacks/profile/me/purge", { packIds: state.packIds });
        state.packCleanupFallback = { status: purge.status };
        state.deletedPack = purge.status === 200;
      } catch (error) {
        state.packCleanupFallback = { error: String(error?.message ?? error).slice(0, 200) };
      }
    }
    for (const [key, id] of [["campaignId", state.campaignId], ["worldCampaignId", state.worldCampaignId]]) {
      if (!id || (key === "campaignId" ? state.campaignDeleted : state.worldCampaignDeleted)) continue;
      try {
        const result = await rest("DELETE", `/api/campaigns/${id}`);
        const deleted = result.status === 200 || result.status === 204 || result.status === 404;
        if (key === "campaignId") { state.campaignDeleted = deleted; state.campaignCleanup = { status: result.status }; }
        else { state.worldCampaignDeleted = deleted; state.worldCampaignCleanup = { status: result.status }; }
      } catch (error) {
        const detail = { error: String(error?.message ?? error).slice(0, 200) };
        if (key === "campaignId") state.campaignCleanup = detail; else state.worldCampaignCleanup = detail;
      }
    }
    checks.cleanupCompleted = state.deletedPack && state.campaignDeleted && (!state.worldCampaignId || state.worldCampaignDeleted);
    report.real.cleanup = {
      campaignDeleted: state.campaignDeleted,
      worldCampaignDeleted: state.worldCampaignDeleted,
      packDeleted: state.deletedPack,
      packCleanupFallback: state.packCleanupFallback ?? null,
      campaignCleanup: state.campaignCleanup ?? null,
      worldCampaignCleanup: state.worldCampaignCleanup ?? null,
    };
  }
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
      } else if (request.url?.startsWith("/user-files/compat/rulesets.mjs")) {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(`export const RULESETS = {
          "2014": { label: "DND5E · 2014 版", system: "dnd5e" },
          "2024": { label: "DND5E · 2024 版", system: "dnd5e" },
          octopus: { label: "章鱼料理研究会", system: "brp" },
          coc7: { label: "COC · 7 版（实验）", system: "brp", supportLevel: "experimental" },
        };`);
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

  let login = null;
  let sessionLogoutStatus = null;
  let attachedHere = false;
  try {
    console.log("[lobby-e2e-app] loading", pageUrl);
    await contents.loadURL(pageUrl);
    console.log("[lobby-e2e-app] loaded");
    if (realUrl) {
      login = await loginReal(origin);
      report.real = {
        ...(report.real ?? {}),
        login: { method: "keycloak-ropc", username: login.username, authority: login.authority },
      };
      await injectSession(contents, login.token);
      console.log("[lobby-e2e-app] session injected; waiting for the real lobby");
    }
  } catch (error) {
    if (error?.code === "E2E_CREDENTIALS_MISSING") {
      report.status = "needs-credentials";
      report.errors.push(error.message);
      saveReport();
      app.exit(2);
      return;
    }
    report.status = "failed";
    report.errors.push(error?.stack ?? String(error));
    saveReport();
    app.exit(1);
    return;
  }

  const expectedReady = realUrl
    ? `globalThis.__MT_LOBBY__?.phase === "ready" && Boolean(globalThis.__MT_AUTH__) && Boolean(globalThis.__MT_LOBBY_SERVICE__)`
    : "Boolean(window.__MT_LOBBY_SERVICE__)";
  try {
    await waitFor(async () => {
      try { return Boolean(await contents.executeJavaScript(expectedReady)); } catch { return false; }
    }, realUrl ? waitAuthMs : 10_000, "lobby service/auth");
  } catch (error) {
    report.status = realUrl ? "needs-login" : "failed";
    report.errors.push(error.message);
    if (realUrl && login) sessionLogoutStatus = await clearSession(contents, login);
    saveReport();
    app.exit(2);
    return;
  }

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
  const { PANEL_PROFILE_OVERRIDE_ENV, PAGE_PROFILES, createPanelProfileOverrides, resolvePageProfile } = await import("../../src/main/page-profiles.js");
  // Mirror main.js: the documented ARCANEDESK_PANEL_PROFILE_OVERRIDES escape hatch
  // (or an explicit override for the local test deployment) is what makes a
  // non-production origin count as mtcompat. The three-origin allowlist is untouched.
  const testOverrides = realUrl
    ? createPanelProfileOverrides(JSON.stringify({
      [new URL("./", pageUrl).href]: PAGE_PROFILES.mtcompat.id,
    }), message => report.steps.push({ name: "profile-override", message }))
    : null;
  const resolvePanel = url => testOverrides?.resolve(url) ?? resolvePageProfile(url) ?? PAGE_PROFILES.foundry;
  report.profileOverride = realUrl
    ? { source: `harness ${PANEL_PROFILE_OVERRIDE_ENV} equivalent`, prefix: new URL("./", pageUrl).href, profile: PAGE_PROFILES.mtcompat.id }
    : null;
  const client = new MtLobbyClient({
    getWebContents: () => contents,
    ...(realUrl
      ? { isTrustedLobbyUrl: url => resolvePanel(url)?.id === PAGE_PROFILES.mtcompat.id }
      : { trustedOrigins: [origin], lobbyPathPattern: /^\/user-files\/compat\/lobby\.html$/ }),
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
    panelProfileId: () => PAGE_PROFILES.mtcompat.id,
    maybeRequestApproval: async (payload) => {
      report.approvals.push({ tool: payload.tool, summary: payload.summary, args: payload.args, denied: deny });
      return !deny;
    },
  };
  const { createMapApiTools } = await import("../../src/main/map-api-tools.js");
  const tools = new Map([...createLobbyTools(host), ...createMapApiTools(host)].map(tool => [tool.name, tool]));
  const invoke = async (name, params) => {
    const result = await tools.get(name).execute(`e2e-${name}`, params);
    step(name, { text: result.content?.[0]?.text, details: result.details, isError: result.isError ?? false });
    return result;
  };
  const rest = (method, apiPath, body) => restJson(origin, login.token, method, apiPath, body);

  try {
    const catalog = await invoke("map_api_search", { prefix: "lobby", limit: 20 });
    report.checks.mapApiCatalogIsMapOnly = catalog.details?.operations?.some(operation => operation.id === "lobbyCampaignCreate")
      && catalog.details.operations.every(operation => operation.kind === "action")
      && !JSON.stringify(catalog.details).includes("map_api_call");
    const rulesets = await invoke("map_api_call", { id: "lobbyRulesetsList", args: {} });
    report.checks.rulesetsListed = rulesets.details?.value?.rulesets?.some(ruleset => ruleset.id === "coc7" && ruleset.supportLevel === "experimental") === true;
    const campaigns = await invoke("map_api_call", { id: "lobbyCampaignsList", args: {} });
    const library = await invoke("map_api_call", { id: "lobbyPacksList", args: {} });
    if (realUrl) {
      report.checks.campaignsListed = Array.isArray(campaigns.details?.value?.campaigns);
      report.checks.packLibraryRead = typeof library.details?.value?.revision === "string" && !library.isError;
      if (realMutate) {
        report.checks.realMutateEnabled = true;
        await runRealContract({
          contents,
          invoke,
          rest,
          scratch,
          pageUrl,
          setDeny: value => { deny = value; },
          setRuntime: runtime => { host.foundryRuntime = runtime; },
        });
      }
    } else {
      report.checks.campaignsListed = campaigns.details?.value?.campaigns?.[0]?.id === "campaign-e2e";
      report.checks.packLibraryRead = library.details?.value?.revision === 5;
      const created = await invoke("map_api_call", { id: "lobbyCampaignCreate", args: { name: "Generic Campaign", ruleset: "2024" } });
      report.checks.mapApiCampaignCreated = created.details?.value?.campaign?.id === "campaign-generic"
        && report.approvals.some(approval => approval.tool === "map_api_call" && approval.args?.operationId === "lobbyCampaignCreate");
      const readBack = await invoke("map_api_call", { id: "lobbyCampaignRead", args: { campaignId: "campaign-generic" } });
      report.checks.mapApiCampaignReadBack = readBack.details?.value?.campaign?.name === "Generic Campaign"
        && readBack.details.value.campaign.ruleset === "2024";
      const read = await invoke("map_api_call", { id: "lobbyPackRead", args: { packId: "pack-a", limit: 3 } });
      report.checks.packEntriesRead = read.details?.value?.entries?.length === 3;
      const legacy = await invoke("foundry_lobby_campaigns_list", {});
      report.checks.legacyAliasesRemainCallable = Array.isArray(legacy.details?.campaigns);
    }

    if (realUrl && !realMutate) {
      report.checks.readOnlyMode = true;
      report.checks.noFileChooserOpened = report.fileChooserOpened === 0;
    }

    if (!realUrl && realMutate) {
      const start = await invoke("map_lobby_import_start", { sourcePath: sourceFile, expectedKind: "world", ruleset: "2024" });
      report.checks.importStarted = Boolean(start.details?.jobId);
      const job = await invoke("map_lobby_import_job", { jobId: start.details.jobId, action: "status", waitMs: 3_000 });
      report.checks.importCompleted = job.details?.status === "succeeded";
      const pageState = await contents.executeJavaScript("window.__E2E__");
      report.fileEvidence = pageState.file;
      report.checks.nativeFileBound = Boolean(pageState.file && pageState.file.size > 0);
      report.checks.nativeFilePathHidden = pageState.file?.path === undefined || pageState.file?.path === null;
      report.checks.nativeFileReadable = pageState.inspectCalls === 1;

      const packs = await invoke("map_api_call", { id: "lobbyCampaignPacksGet", args: { campaignId: "campaign-e2e" } });
      report.checks.campaignPacksRead = packs.details?.value?.revision === 2;
      const update = await invoke("map_api_call", { id: "lobbyCampaignPacksUpdate", args: {
        campaignId: "campaign-e2e", expectedRevision: packs.details.value.revision, add: ["pack-b"],
        enabledSourcesPatch: { srd2014: true },
      } });
      report.checks.campaignPacksUpdated = update.details?.value?.revision === 3;

      const deleted = await invoke("map_api_call", { id: "lobbyPacksDelete", args: { packIds: ["pack-b"], expectedRevision: library.details.value.revision } });
      report.checks.packDeleted = deleted.details?.value?.revision === 6;

      const fence = await invoke("map_lobby_import_start", { sourcePath: outsideFile, ruleset: "2024" });
      report.checks.outsideFenceRejected = fence.details?.code === "FILE_OUTSIDE_FENCE";
      const mirror = await invoke("map_lobby_import_start", { sourcePath: mirrorFile, ruleset: "2024" });
      report.checks.mirrorCacheAllowed = Boolean(mirror.details?.jobId);

      deny = true;
      const denied = await invoke("map_api_call", { id: "lobbyCampaignPacksUpdate", args: {
        campaignId: "campaign-e2e", expectedRevision: 3, add: ["pack-a"],
      } });
      report.checks.approvalDenied = denied.details?.code === "DECLINED";
      const stateAfterDeny = await contents.executeJavaScript("window.__E2E__");
      report.checks.approvalDeniedZeroWrite = stateAfterDeny.updateCalls.length === 1;
      report.checks.deletePreviewBeforeApproval = stateAfterDeny.deletePreviewCalls.length === 1
        && stateAfterDeny.deleteCalls.length === 1;
      report.checks.planSanitized = !JSON.stringify(start.details).includes("prep-e2e")
        && !JSON.stringify(start.details).includes("/server/secret");
      report.checks.noFileChooserOpened = report.fileChooserOpened === 0;
    }
    // The real contract sets this itself; fixture mode sets it above.
    if (!Object.hasOwn(report.checks, "noFileChooserOpened")) report.checks.noFileChooserOpened = report.fileChooserOpened === 0;
    report.checks.noSecretsInReport = reportHasNoSecrets();
    report.status = Object.values(report.checks).every(Boolean) ? "completed" : "failed";
    report.mutated = realMutate;
  } catch (error) {
    report.status = "failed";
    report.errors.push(error?.stack ?? String(error));
  } finally {
    if (realUrl && login) sessionLogoutStatus = await clearSession(contents, login);
    report.session = realUrl ? { cleared: true, keycloakLogoutStatus: sessionLogoutStatus } : null;
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
