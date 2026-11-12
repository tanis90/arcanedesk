// MtLobbyClient — mt-compat 大厅专用通道。
//
// 与 Foundry SDK 完全分离：不碰 /game preflight，不改变 mtCompatIsReady。这里只做
// lobby 页面的受信 origin/path、__MT_AUTH__、__MT_LOBBY_SERVICE__/runtime preflight，
// 固定 action 白名单、串行队列、导航安全 evaluate，以及 job 与
// webContents.id + navigationEpoch 的绑定。页面导航/刷新/崩溃后旧 job 只会被判为
// indeterminate，绝不自动重放。
import { evaluateNavigationSafe } from "./foundry-web.js";
import {
  MT_COMPAT_AUTH_PATH_PATTERN,
  MT_COMPAT_LOBBY_PATH_PATTERN,
  MT_COMPAT_TRUSTED_ORIGINS,
} from "./page-profiles.js";
import { bindLobbyFileInput, LobbyFileError } from "./mt-lobby-file.js";

/** 契约里的全部页面动作；getFileInput 只供原生文件适配器使用。 */
export const MT_LOBBY_ACTIONS = Object.freeze([
  "getFileInput",
  "lobbyRulesetsList",
  "lobbyImportInspect",
  "lobbyImportRun",
  "lobbyImportStatus",
  "lobbyImportCancel",
  "lobbyCampaignsList",
  "lobbyPacksList",
  "lobbyPackRead",
  "lobbyPacksDeletePreview",
  "lobbyPacksDelete",
  "lobbyCampaignPacksGet",
  "lobbyCampaignPacksUpdate",
]);

const ACTION_SET = new Set(MT_LOBBY_ACTIONS);
// rulesetsList 由当前部署的 rulesets.mjs 提供，不要求 lobby service 另装同名方法。
const LOBBY_TOOL_ACTIONS = new Set(MT_LOBBY_ACTIONS.filter(name => name !== "getFileInput" && name !== "lobbyRulesetsList"));
const WRITE_ACTIONS = new Set(["lobbyImportRun", "lobbyPacksDelete", "lobbyCampaignPacksUpdate"]);
/** 兼容 compat 的 phase、未来可能的 status/state；succeeded 是 compat 的成功终态。 */
export const TERMINAL_JOB_STATES = Object.freeze([
  "succeeded", "completed", "failed", "cancelled", "canceled", "aborted", "indeterminate", "done", "rejected", "error",
]);
const TERMINAL_JOB_STATE_SET = new Set(TERMINAL_JOB_STATES);
const MAX_JOB_WAIT_MS = 25_000;
const STATUS_POLL_MS = 500;
const MAX_JOBS = 64;
const SENSITIVE_RUNTIME_CODES = new Set(["UNAUTHORIZED", "AUTH_REQUIRED", "LOGIN_REQUIRED", "SESSION_EXPIRED"]);

export class MtLobbyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "MtLobbyError";
    this.code = code;
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MtLobbyError("ABORTED", "Cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MtLobbyError("ABORTED", "Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 统一读取 job 生命周期：phase 是 compat 的权威字段；status/state 供其他服务形态使用。
 * 任一字段是 "unknown" 时继续看下一个，绝不把已有 phase 降级成 unknown。
 * @param {any} value
 */
export function jobPhaseOf(value) {
  for (const candidate of [value?.phase, value?.status, value?.state]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized && normalized.toLowerCase() !== "unknown") return normalized;
  }
  return "unknown";
}

/** 终态判定：优先 phase/status/state，其次服务显式 terminal 标记。 */
export function isTerminalJob(value) {
  if (value?.terminal === true) return true;
  return TERMINAL_JOB_STATE_SET.has(jobPhaseOf(value).toLowerCase());
}

function boundedWait(waitMs) {
  const value = Number(waitMs);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_JOB_WAIT_MS);
}

function safeRuntimeCode(code) {
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "LOBBY_ACTION_FAILED";
}

/**
 * @param {{
 *   getWebContents: () => any,
 *   evaluate?: typeof evaluateNavigationSafe,
 *   trustedOrigins?: readonly string[],
 *   lobbyPathPattern?: RegExp,
 *   isTrustedLobbyUrl?: (url: string) => boolean,
 *   protocolVersion?: number,
 *   log?: (message: string) => void,
 * }} options
 */
export class MtLobbyClient {
  constructor({
    getWebContents,
    evaluate = evaluateNavigationSafe,
    trustedOrigins = MT_COMPAT_TRUSTED_ORIGINS,
    lobbyPathPattern = MT_COMPAT_LOBBY_PATH_PATTERN,
    isTrustedLobbyUrl = null,
    protocolVersion = 1,
    log = () => {},
  } = /** @type {any} */ ({})) {
    if (typeof getWebContents !== "function") throw new TypeError("getWebContents must be a function");
    if (typeof evaluate !== "function") throw new TypeError("evaluate must be a function");
    this.getWebContents = getWebContents;
    this.evaluate = evaluate;
    this.trustedOrigins = [...trustedOrigins];
    this.lobbyPathPattern = lobbyPathPattern;
    // main 注入的 resolver 复用 resolvePanelProfile/panelProfileOverrides：
    // 只有显式运维 override 判为 mtcompat 的 URL 才能越过三 origin 白名单。
    this.isTrustedLobbyUrl = typeof isTrustedLobbyUrl === "function" ? isTrustedLobbyUrl : null;
    this.protocolVersion = protocolVersion;
    this.log = log;
    this.queue = Promise.resolve();
    this.targets = new WeakMap();
    this.jobs = new Map();
  }

  // ---- target / epoch ----

  /** 捕获工具调用开始时的页面目标。当前页面必须已经是受信 lobby。 */
  captureTarget() {
    const webContents = this.getWebContents?.();
    if (!webContents || webContents.isDestroyed?.()) {
      throw new MtLobbyError("TARGET_UNAVAILABLE", "The mt-compat lobby panel is not open");
    }
    const url = String(webContents.getURL?.() ?? "");
    const parsed = this.assertLobbyUrl(url);
    const record = this.track(webContents);
    return Object.freeze({
      webContents,
      webContentsId: webContents.id ?? null,
      navigationEpoch: record.epoch,
      url: parsed.href,
    });
  }

  assertLobbyUrl(rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl));
    } catch {
      throw new MtLobbyError("PROFILE_MISMATCH", "The panel is not on a valid mt-compat URL");
    }
    const originTrusted = this.trustedOrigins.includes(parsed.origin);
    const overrideTrusted = !originTrusted && this.isTrustedLobbyUrl?.(parsed.href) === true;
    if (!originTrusted && !overrideTrusted) {
      throw new MtLobbyError("PROFILE_MISMATCH", "The panel is not on a trusted mt-compat origin");
    }
    if (this.lobbyPathPattern.test(parsed.pathname)) return parsed;
    if (MT_COMPAT_AUTH_PATH_PATTERN.test(parsed.pathname)) {
      throw new MtLobbyError("LOGIN_REQUIRED", "The panel is still in the Keycloak login flow; ask the user to sign in directly");
    }
    throw new MtLobbyError("PROFILE_MISMATCH", "Open the mt-compat lobby page (lobby.html) in the panel first");
  }

  /** 导航/刷新/崩溃/页内路由变化都推高 epoch，并把旧 job 标为 indeterminate。 */
  track(webContents) {
    let record = this.targets.get(webContents);
    if (record) return record;
    record = { epoch: 0, id: webContents.id ?? null, listeners: [] };
    const listen = (event, handler) => {
      webContents.on?.(event, handler);
      record.listeners.push([event, handler]);
    };
    listen("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame === false || isInPlace) return;
      record.epoch += 1;
      this.markJobsIndeterminate(webContents, "navigation");
    });
    listen("did-navigate-in-page", (_event, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      record.epoch += 1;
      this.markJobsIndeterminate(webContents, "navigation");
    });
    listen("render-process-gone", () => {
      record.epoch += 1;
      this.markJobsIndeterminate(webContents, "renderer-gone");
    });
    listen("destroyed", () => {
      record.epoch += 1;
      this.markJobsIndeterminate(webContents, "panel-closed");
    });
    this.targets.set(webContents, record);
    return record;
  }

  assertTarget(target) {
    if (!target?.webContents || target.webContents.isDestroyed?.()) {
      throw new MtLobbyError("TARGET_UNAVAILABLE", "The lobby panel was closed");
    }
    if (target.webContents !== this.getWebContents?.()) {
      throw new MtLobbyError("TARGET_CHANGED", "The panel changed while the call was running; no automatic replay");
    }
    if (target.webContentsId !== null && target.webContents.id !== undefined && target.webContents.id !== target.webContentsId) {
      throw new MtLobbyError("TARGET_CHANGED", "The panel target changed while the call was running; no automatic replay");
    }
    const record = this.track(target.webContents);
    if (record.epoch !== target.navigationEpoch) {
      throw new MtLobbyError("TARGET_CHANGED", "The lobby page navigated while the call was running; no automatic replay");
    }
  }

  // ---- queue / preflight ----

  /** 同一个客户端上的页面动作串行执行；失败不会毒化后续调用。 */
  runExclusive(operation) {
    const result = this.queue.then(() => operation());
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async preflight(action, target) {
    if (!ACTION_SET.has(action)) {
      throw new MtLobbyError("ACTION_UNKNOWN", `Unknown mt-compat lobby action: ${String(action).slice(0, 64)}`);
    }
    this.assertTarget(target);
    this.assertLobbyUrl(target.url);

    const outcome = await this.evaluate(target.webContents, this.preflightExpression(), {
      timeoutMs: 5_000,
    });
    if (outcome.status === "navigated") {
      throw new MtLobbyError("TARGET_CHANGED", "The lobby page navigated during preflight; no automatic replay");
    }
    if (outcome.status === "aborted") throw new MtLobbyError("ABORTED", "Cancelled during preflight");
    if (outcome.status === "timeout") {
      throw new MtLobbyError("TARGET_TIMEOUT", "The lobby page did not answer preflight in time");
    }
    if (outcome.status !== "completed") {
      throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The lobby page could not be inspected");
    }
    const state = outcome.value;
    if (!state || typeof state !== "object") {
      throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The lobby page returned no runtime state");
    }
    if (state.url) this.assertLobbyUrl(state.url);
    if (!state.auth) {
      throw new MtLobbyError("LOGIN_REQUIRED", "The mt-compat session is not signed in; ask the user to sign in directly in the panel");
    }
    if (!state.runtime) {
      throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The mt-compat page runtime is not installed");
    }
    if (!state.service) {
      throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The mt-compat lobby service is not installed on this page");
    }
    const missing = Array.isArray(state.missing) ? state.missing.filter(name => typeof name === "string") : [];
    if (missing.length > 0) {
      throw new MtLobbyError(
        "CAPABILITY_UNAVAILABLE",
        `The mt-compat lobby service is missing required actions: ${missing.slice(0, 8).join(", ")}`,
      );
    }
    if (typeof state.protocolVersion === "number" && state.protocolVersion < this.protocolVersion) {
      throw new MtLobbyError(
        "CAPABILITY_UNAVAILABLE",
        `The mt-compat lobby service protocol ${state.protocolVersion} is older than required ${this.protocolVersion}`,
      );
    }
    this.assertTarget(target);
    return { url: target.url, protocolVersion: state.protocolVersion ?? null };
  }

  preflightExpression() {
    return `(() => {
      const auth = globalThis.__MT_AUTH__;
      const service = globalThis.__MT_LOBBY_SERVICE__;
      const runtime = globalThis.__MT_AGENT_RUNTIME__;
      const runtimeSource = globalThis.__MT_AGENT_RUNTIME_SOURCE__;
      const required = ${JSON.stringify([...LOBBY_TOOL_ACTIONS])};
      const missing = service && typeof service === "object"
        ? required.filter(name => typeof service[name] !== "function")
        : required;
      return {
        url: String(location.href),
        auth: Boolean(auth),
        service: Boolean(service && typeof service === "object"),
        runtime: Boolean(
          typeof runtime === "function"
          || (runtime && (typeof runtime.call === "function" || typeof runtime.invoke === "function"))
          || (typeof runtimeSource === "string" && runtimeSource.length > 0)
        ),
        missing,
        protocolVersion: service && typeof service === "object"
          ? (typeof service.protocolVersion === "number" ? service.protocolVersion
            : typeof service.version === "number" ? service.version : null)
          : null,
      };
    })()`;
  }

  actionExpression(action, args) {
    return `(async () => {
      try {
        const name = ${JSON.stringify(action)};
        const service = globalThis.__MT_LOBBY_SERVICE__;
        if (name === "lobbyRulesetsList") {
          if (service && typeof service[name] === "function") {
            const value = await service[name]({});
            return { ok: true, value };
          }
          const { RULESETS } = await import(new URL("./rulesets.mjs", location.href).href);
          const rulesets = Object.entries(RULESETS && typeof RULESETS === "object" ? RULESETS : {}).map(([id, definition]) => ({
            id,
            label: typeof definition?.label === "string" ? definition.label : id,
            system: typeof definition?.system === "string" ? definition.system : null,
            ...(typeof definition?.supportLevel === "string" ? { supportLevel: definition.supportLevel } : {}),
          }));
          return { ok: true, value: { rulesets } };
        }
        if (!service || typeof service[name] !== "function") {
          return { ok: false, code: "CAPABILITY_UNAVAILABLE", message: "lobby service action " + name + " is unavailable" };
        }
        const value = await service[name](${JSON.stringify(args ?? {})});
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          code: error && typeof error.code === "string" ? error.code : "LOBBY_ACTION_FAILED",
          message: error && typeof error.message === "string" ? error.message : String(error),
        };
      }
    })()`;
  }

  /**
   * @param {string} action
   * @param {any} args
   * @param {any} target
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  async callLocked(action, args, target, { signal, timeoutMs = 30_000 } = {}) {
    await this.preflight(action, target);
    await this.assertTarget(target);
    const outcome = await this.evaluate(target.webContents, this.actionExpression(action, args), {
      timeoutMs,
      signal,
    });
    if (outcome.status === "navigated") {
      throw new MtLobbyError(
        WRITE_ACTIONS.has(action) ? "JOB_INDETERMINATE" : "TARGET_CHANGED",
        "The lobby page navigated during the call; no automatic replay",
      );
    }
    if (outcome.status === "aborted") throw new MtLobbyError("ABORTED", "Cancelled");
    if (outcome.status === "timeout") {
      throw new MtLobbyError(
        WRITE_ACTIONS.has(action) ? "JOB_INDETERMINATE" : "TARGET_TIMEOUT",
        "The lobby action did not complete in time; its result is uncertain and was not replayed",
      );
    }
    if (outcome.status !== "completed") {
      throw new MtLobbyError("LOBBY_ACTION_FAILED", "The lobby action failed before returning a result");
    }
    try {
      this.assertTarget(target);
    } catch (error) {
      if (WRITE_ACTIONS.has(action)) {
        throw new MtLobbyError("JOB_INDETERMINATE", "The lobby page changed after the write was sent; no automatic replay");
      }
      throw error;
    }
    const receipt = outcome.value;
    if (!receipt || typeof receipt !== "object" || receipt.ok !== true) {
      const code = safeRuntimeCode(receipt?.code);
      const message = typeof receipt?.message === "string" && receipt.message ? receipt.message : "The lobby action was rejected";
      if (SENSITIVE_RUNTIME_CODES.has(code)) throw new MtLobbyError("LOGIN_REQUIRED", message);
      throw new MtLobbyError(code, message);
    }
    return receipt.value;
  }

  /**
   * @param {string} action
   * @param {any} args
   * @param {{ target?: any, signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  async call(action, args, { target, signal, timeoutMs } = {}) {
    const pinned = target ?? this.captureTarget();
    return this.runExclusive(() => this.callLocked(action, args, pinned, { signal, timeoutMs }));
  }

  // ---- import ----

  /**
   * 同一次串行租约里完成：preflight → 固定 CDP 绑定 File → inspect。
   * 返回的 inspection 含 preparationId；调用方绝不能把 preparationId 交给模型。
   */
  /**
   * @param {any} target
   * @param {{ realPath: string, filename: string, size: number, sha256: string }} file
   * @param {{ expectedKind?: string, campaignName?: string, ruleset?: string, failurePolicy?: string }} [options]
   * @param {AbortSignal} [signal]
   */
  async inspectImportFile(target, file, options = {}, signal) {
    if (!file?.realPath) throw new LobbyFileError("FILE_INVALID", "The prepared source file is missing its resolved path");
    return this.runExclusive(async () => {
      this.assertTarget(target);
      await this.preflight("lobbyImportInspect", target);
      try {
        await bindLobbyFileInput(target.webContents, file.realPath, { signal });
      } catch (error) {
        if (error instanceof LobbyFileError) throw new MtLobbyError(error.code, error.message);
        throw new MtLobbyError("FILE_BIND_FAILED", "The native file binding failed");
      }
      await this.assertTarget(target);
      const payload = {
        filename: file.filename,
        size: file.size,
        sha256: file.sha256,
        ...(options.expectedKind ? { expectedKind: options.expectedKind } : {}),
        options: {
          ...(options.campaignName ? { campaignName: options.campaignName } : {}),
          ...(options.ruleset ? { ruleset: options.ruleset } : {}),
          ...(options.failurePolicy ? { failurePolicy: options.failurePolicy } : {}),
        },
      };
      const inspection = await this.callLocked("lobbyImportInspect", payload, target, { signal, timeoutMs: 60_000 });
      if (!inspection || typeof inspection !== "object" || typeof inspection.preparationId !== "string" || !inspection.preparationId) {
        throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The lobby service did not create an import preparation");
      }
      return inspection;
    });
  }

  /**
   * @param {any} target
   * @param {string} preparationId
   * @param {AbortSignal} [signal]
   */
  async runImport(target, preparationId, signal) {
    const result = await this.runExclusive(() => this.callLocked(
      "lobbyImportRun",
      { preparationId },
      target,
      { signal, timeoutMs: 60_000 },
    ));
    const jobId = result?.jobId;
    if (typeof jobId !== "string" || jobId === "") {
      throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The lobby service started no import job");
    }
    this.registerJob(jobId, target);
    return { jobId, plan: result.plan };
  }

  // ---- jobs ----

  registerJob(jobId, target) {
    if (this.jobs.size >= MAX_JOBS) {
      for (const [id, record] of this.jobs) {
        if (record.terminal || record.indeterminate) {
          this.jobs.delete(id);
          if (this.jobs.size < MAX_JOBS) break;
        }
      }
      if (this.jobs.size >= MAX_JOBS) {
        const oldest = this.jobs.keys().next().value;
        if (oldest !== undefined) this.jobs.delete(oldest);
      }
    }
    const record = {
      jobId,
      target,
      createdAt: Date.now(),
      status: "started",
      terminal: false,
      indeterminate: false,
      cancelRequested: false,
    };
    this.jobs.set(jobId, record);
    return record;
  }

  jobRecord(jobId) {
    const record = this.jobs.get(jobId);
    if (!record) throw new MtLobbyError("JOB_NOT_FOUND", "Unknown import job in this app session");
    return record;
  }

  assertJobTarget(record) {
    if (record.indeterminate) {
      throw new MtLobbyError(
        "JOB_INDETERMINATE",
        "The lobby page navigated, reloaded, or crashed; the job result is indeterminate and was not replayed",
      );
    }
    try {
      this.assertTarget(record.target);
    } catch (error) {
      record.indeterminate = true;
      record.status = "indeterminate";
      throw new MtLobbyError(
        "JOB_INDETERMINATE",
        "The lobby page changed while the job was running; the job result is indeterminate and was not replayed",
      );
    }
  }

  markJobsIndeterminate(webContents, reason) {
    for (const record of this.jobs.values()) {
      if (record.target.webContents !== webContents || record.terminal) continue;
      record.indeterminate = true;
      record.status = "indeterminate";
      record.reason = reason;
    }
  }

  /**
   * @param {string} jobId
   * @param {{ waitMs?: number, signal?: AbortSignal }} [options]
   */
  async statusJob(jobId, { waitMs = 0, signal } = {}) {
    const record = this.jobRecord(jobId);
    const deadline = Date.now() + boundedWait(waitMs);
    let last = null;
    for (;;) {
      this.assertJobTarget(record);
      last = await this.call("lobbyImportStatus", { jobId }, { target: record.target, signal, timeoutMs: 20_000 });
      const status = jobPhaseOf(last);
      record.status = status;
      if (last && typeof last === "object") {
        if (last.indeterminate === true || status.toLowerCase() === "indeterminate") record.indeterminate = true;
        if (isTerminalJob(last)) record.terminal = true;
      }
      if (record.terminal || record.indeterminate || Date.now() >= deadline) break;
      await delay(STATUS_POLL_MS, signal);
    }
    if (record.indeterminate) {
      throw new MtLobbyError(
        "JOB_INDETERMINATE",
        "The lobby page navigated, reloaded, or crashed; the job result is indeterminate and was not replayed",
      );
    }
    return last;
  }

  /**
   * @param {string} jobId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async cancelJob(jobId, { signal } = {}) {
    const record = this.jobRecord(jobId);
    this.assertJobTarget(record);
    const result = await this.call("lobbyImportCancel", { jobId }, { target: record.target, signal, timeoutMs: 20_000 });
    record.cancelRequested = true;
    const status = jobPhaseOf(result);
    record.status = status;
    if (isTerminalJob(result) || TERMINAL_JOB_STATE_SET.has(status.toLowerCase())) record.terminal = true;
    return result;
  }

  dispose() {
    for (const record of this.jobs.values()) {
      record.indeterminate = true;
      record.status = "indeterminate";
    }
    this.jobs.clear();
  }
}

// 供测试/适配层复用的错误类；调用方按 code 分支。
export const MT_LOBBY_ERROR_CODES = Object.freeze({
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  PROFILE_MISMATCH: "PROFILE_MISMATCH",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  JOB_INDETERMINATE: "JOB_INDETERMINATE",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  TARGET_UNAVAILABLE: "TARGET_UNAVAILABLE",
  TARGET_CHANGED: "TARGET_CHANGED",
  TARGET_TIMEOUT: "TARGET_TIMEOUT",
  ACTION_UNKNOWN: "ACTION_UNKNOWN",
  ABORTED: "ABORTED",
  INPUT_INVALID: "INPUT_INVALID",
  FILE_OUTSIDE_FENCE: "FILE_OUTSIDE_FENCE",
  FILE_CHANGED: "FILE_CHANGED",
  FILE_BIND_FAILED: "FILE_BIND_FAILED",
});
