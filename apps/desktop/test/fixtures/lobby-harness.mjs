// Node 测试用的页面替身：在同一 vm 沙箱里执行 Desktop 固定表达式，并模拟
// webContents.debugger 的 Runtime.evaluate / DOM.setFileInputFiles。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const LOBBY_URL = "https://arcanemap.com/user-files/compat/lobby.html";

const FIXTURE_RULESETS = {
  2014: { label: "DND5E · 2014 版", system: "dnd5e" },
  2024: { label: "DND5E · 2024 版", system: "dnd5e" },
  octopus: { label: "章鱼料理研究会", system: "brp" },
  coc7: { label: "COC · 7 版（实验）", system: "brp", supportLevel: "experimental" },
};

export function createLobbyState() {
  return {
    boundFile: null,
    fileInput: { tagName: "INPUT", type: "file", hidden: true, files: [] },
    inspectCalls: [],
    runCalls: [],
    statusCalls: 0,
    cancelCalls: [],
    listCalls: 0,
    packReadCalls: [],
    deletePreviewCalls: [],
    deleteCalls: [],
    campaignPacksGetCalls: [],
    campaignPacksUpdateCalls: [],
    previewCalls: 0,
    campaignRevision: 4,
    packRevision: 7,
    packs: [{ packId: "pack-a", name: "Pack A" }, { packId: "pack-b", name: "Pack B" }],
    terminalAfterStatusCalls: 2,
    failLogin: false,
  };
}

export function createLobbyService(state = createLobbyState(), overrides = {}) {
  return {
    protocolVersion: 1,
    getFileInput() { return state.fileInput; },
    async lobbyImportInspect(params) {
      state.inspectCalls.push(params);
      if (state.failLogin) throw Object.assign(new Error("login expired"), { code: "LOGIN_REQUIRED" });
      if (!state.boundFile) throw Object.assign(new Error("no native file bound"), { code: "FILE_NOT_BOUND" });
      if (state.boundFile.name !== params.filename || state.boundFile.size !== params.size || state.boundFile.sha256 !== params.sha256) {
        throw Object.assign(new Error("native file identity mismatch"), { code: "FILE_MISMATCH" });
      }
      return {
        preparationId: "prep-secret",
        kind: params.expectedKind ?? "world",
        plan: {
          kind: params.expectedKind ?? "world",
          assets: [{ name: "a.png" }, { name: "b.png" }],
          sourcePath: "C:\\Users\\secret\\world.zip",
          preparationId: "prep-secret",
          keepAssetIds: ["internal-asset"],
        },
      };
    },
    async lobbyImportRun({ preparationId }) {
      state.runCalls.push({ preparationId });
      if (preparationId !== "prep-secret") throw Object.assign(new Error("unknown preparation"), { code: "PREPARATION_UNKNOWN" });
      return { jobId: "job-1", plan: { kind: "world", campaignName: "Test", preparationId: "prep-secret" } };
    },
    async lobbyImportStatus({ jobId }) {
      state.statusCalls += 1;
      if (state.statusCalls < state.terminalAfterStatusCalls) {
        return { jobId, phase: "running", progress: { stage: "assets", done: 1, total: 3 }, failures: [{ why: "x" }] };
      }
      return {
        jobId,
        phase: "succeeded",
        terminal: true,
        report: { campaignId: "campaign-1", actors: 12, entries: 3 },
        failures: [],
      };
    },
    async lobbyImportCancel({ jobId }) {
      state.cancelCalls.push({ jobId });
      return { jobId, phase: "cancelling", terminal: false };
    },
    async lobbyRulesetsList() {
      return {
        rulesets: Object.entries(FIXTURE_RULESETS).map(([id, definition]) => ({ id, ...definition })),
      };
    },
    async lobbyCampaignsList() {
      state.listCalls += 1;
      return { campaigns: [{ id: "campaign-1", name: "Curse of Strahd", ruleset: "dnd5e", owner: "dm", playUrl: "https://arcanemap.com/user-files/compat/play.html?campaign=campaign-1" }] };
    },
    async lobbyPacksList({ moduleId } = {}) {
      state.packListCalls = (state.packListCalls ?? 0) + 1;
      return { revision: state.packRevision, packCount: state.packs.length, modules: [{ moduleId: moduleId ?? "module-a", packs: state.packs }] };
    },
    async lobbyPackRead({ packId, query, cursor, limit }) {
      state.packReadCalls.push({ packId, query, cursor, limit });
      const all = Array.from({ length: 120 }, (_, index) => ({ entryId: `entry-${index}`, name: `Entry ${index}` }));
      const start = cursor ? Number(cursor) : 0;
      const size = limit ?? 20;
      return { pack: state.packs.find(pack => pack.packId === packId) ?? null, entries: all.slice(start, start + size), nextCursor: start + size < all.length ? String(start + size) : null };
    },
    async lobbyPacksDeletePreview({ packIds, expectedRevision }) {
      state.deletePreviewCalls.push({ packIds, expectedRevision });
      return { packIds, entryCount: packIds.length * 3, assetCount: packIds.length, campaignRefs: 1 };
    },
    async lobbyPacksDelete({ packIds, expectedRevision }) {
      state.deleteCalls.push({ packIds, expectedRevision });
      state.packs = state.packs.filter(pack => !packIds.includes(pack.packId));
      state.packRevision += 1;
      return { deleted: packIds, revision: state.packRevision };
    },
    async lobbyCampaignPacksGet({ campaignId }) {
      state.campaignPacksGetCalls.push({ campaignId });
      return { campaignId, revision: state.campaignRevision, selected: ["pack-a"], missing: [], builtIn: [{ id: "srd", readOnly: true }], enabledSources: { srd: true, moduleA: true } };
    },
    async lobbyCampaignPacksUpdate({ campaignId, expectedRevision, add, remove, enabledSourcesPatch }) {
      state.campaignPacksUpdateCalls.push({ campaignId, expectedRevision, add, remove, enabledSourcesPatch });
      if (String(expectedRevision) !== String(state.campaignRevision)) throw Object.assign(new Error("stale revision"), { code: "REVISION_MISMATCH" });
      state.campaignRevision += 1;
      return { campaignId, revision: state.campaignRevision, selected: ["pack-a", ...(add ?? [])] };
    },
    ...overrides,
  };
}

export function createLobbyFixture({
  url = LOBBY_URL,
  state = createLobbyState(),
  service = createLobbyService(state),
  auth = true,
  runtime = true,
  protocolVersion,
} = {}) {
  if (protocolVersion !== undefined) service.protocolVersion = protocolVersion;
  const initial = new URL(url);
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    crypto: globalThis.crypto,
    location: { href: initial.href, pathname: initial.pathname, origin: initial.origin },
    __MT_AUTH__: auth ? { access_token: "x" } : null,
    __MT_AGENT_RUNTIME__: runtime ? function fixtureRuntime() {} : undefined,
    __MT_AGENT_RUNTIME_SOURCE__: runtime ? "function fixtureRuntime() {}" : undefined,
    __MT_LOBBY_SERVICE__: service,
    __fileInput: state.fileInput,
  };
  const context = vm.createContext(sandbox);

  const commands = [];
  let attached = false;
  let currentUrl = initial.href;
  let destroyed = false;
  const listeners = new Map();
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };

  const evaluateInPage = (expression) => Promise.resolve(new vm.Script(expression).runInContext(context));

  const debuggerApi = {
    isAttached: () => attached,
    attach() { attached = true; },
    detach() { attached = false; },
    async sendCommand(method, params = {}) {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const value = await evaluateInPage(params.expression);
        if (!value || typeof value !== "object") {
          return { result: { type: "undefined" } };
        }
        return { result: { type: "object", objectId: "fixture-input-object", description: "input" } };
      }
      if (method === "DOM.enable") return {};
      if (method === "DOM.setFileInputFiles") {
        const file = params.files?.[0];
        if (!file) throw new Error("no file");
        const info = statSync(file);
        const bytes = readFileSync(file);
        state.boundFile = {
          name: path.basename(file),
          size: info.size,
          lastModified: info.mtimeMs,
          path: undefined,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        sandbox.__fileInput.files = [{ name: state.boundFile.name, size: state.boundFile.size }];
        return {};
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP method ${method}`);
    },
  };

  const webContents = {
    id: 41,
    debugger: debuggerApi,
    isDestroyed: () => destroyed,
    getURL: () => currentUrl,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    off(event, listener) {
      const list = listeners.get(event) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    executeJavaScript: evaluateInPage,
    navigate(nextUrl) {
      currentUrl = nextUrl;
      const parsed = new URL(nextUrl);
      sandbox.location.href = parsed.href;
      sandbox.location.pathname = parsed.pathname;
      sandbox.location.origin = parsed.origin;
      emit("did-start-navigation", {}, nextUrl, false, true);
    },
    navigateInPage(nextUrl) {
      currentUrl = nextUrl;
      sandbox.location.href = nextUrl;
      emit("did-navigate-in-page", {}, nextUrl, true);
    },
    crash() {
      emit("render-process-gone", {}, { reason: "crashed" });
    },
    close() {
      destroyed = true;
      emit("destroyed");
    },
  };

  return {
    webContents,
    sandbox,
    state,
    service,
    commands,
    evaluateCount: () => commands.filter(command => command.method === "Runtime.evaluate").length,
    setAuth(value) {
      sandbox.__MT_AUTH__ = value ? { access_token: "x" } : null;
    },
    setService(value) { sandbox.__MT_LOBBY_SERVICE__ = value; },
    setRuntime(value) {
      sandbox.__MT_AGENT_RUNTIME__ = value ? function fixtureRuntime() {} : undefined;
      sandbox.__MT_AGENT_RUNTIME_SOURCE__ = value ? "function fixtureRuntime() {}" : undefined;
    },
  };
}
