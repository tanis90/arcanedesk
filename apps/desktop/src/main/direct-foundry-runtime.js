import { FoundryRuntimeClient } from "@arcanedesk/foundry-sdk/client";
import { FOUNDRY_SDK_ERROR_CODES, FoundrySdkError } from "@arcanedesk/foundry-sdk/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

import { evaluateNavigationSafe, readFoundryPageState } from "./foundry-web.js";

/**
 * Electron transport for the transport-neutral Foundry SDK client. The
 * WebContents handle remains owned by Desktop and is reacquired for every
 * preflight poll, so navigation or panel replacement cannot leave a stale
 * execution target behind.
 */
export class WebContentsFoundryTransport {
  /**
   * @param {{
   *   getWebContents?: () => any,
   *   evaluate?: (webContents: any, expression: string, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
   *   inspectPage?: (webContents: any, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
   * }} [options]
   */
  constructor({
    getWebContents = () => null,
    evaluate = evaluateNavigationSafe,
    inspectPage = readFoundryPageState,
  } = {}) {
    if (typeof getWebContents !== "function") throw new TypeError("getWebContents must be a function");
    if (typeof evaluate !== "function") throw new TypeError("evaluate must be a function");
    if (typeof inspectPage !== "function") throw new TypeError("inspectPage must be a function");
    this.getWebContents = getWebContents;
    this.evaluatePage = evaluate;
    this.inspectPage = inspectPage;
  }

  acquire() {
    return this.getWebContents();
  }

  /** @param {any} webContents */
  isAvailable(webContents) {
    return Boolean(webContents) && !webContents.isDestroyed?.();
  }

  /** @param {any} webContents @param {{ timeoutMs: number, signal?: AbortSignal }} options */
  inspect(webContents, options) {
    return this.inspectPage(webContents, options);
  }

  /** @param {any} webContents @param {string} expression @param {{ timeoutMs: number, signal?: AbortSignal }} options */
  evaluate(webContents, expression, options) {
    return this.evaluatePage(webContents, expression, options);
  }
}

/**
 * mtcompat 档 client 的扩展 action（A3）：pageEval 是 arcaneVTT 侧 runtime 的兜底 eval
 * action，不在 SDK 的 foundry 契约（ALL_DIRECT_ACTIONS）里——只有 mtcompat client 的白
 * 名单带它，foundry 档 client 逐字不变。SDK 客户端对 action 只做字符串白名单检查
 * （Set.has），并入后即走既有队列/序列化/preflight/中断语义。
 * @typedef {"pageEval"} MtcompatRuntimeAction
 */

/**
 * Product-facing name retained for AgentHost. All protocol, preflight,
 * serialization, queueing, timeout, and indeterminate-write behavior lives in
 * @arcanedesk/foundry-sdk; Desktop supplies only the WebContents transport.
 */
export class DirectFoundryRuntime extends FoundryRuntimeClient {
  /**
   * @param {{
   *   getWebContents?: () => any,
   *   runtimeSource?: string,
   *   allowedActions?: readonly (import("@arcanedesk/foundry-sdk/contracts").DirectAction | MtcompatRuntimeAction)[],
   *   evaluate?: (webContents: any, expression: string, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
   *   inspectPage?: (webContents: any, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
   *   readyPollMs?: number,
   *   pageProfile?: import("@arcanedesk/foundry-sdk/client").FoundryPageProfileOptions,
   *   log?: (level: "warn", message: string, details?: unknown) => void,
   *   onCallResult?: (record: import("@arcanedesk/foundry-sdk/client").FoundryRuntimeCallResultRecord) => void,
   * }} [options]
   */
  constructor(options = {}) {
    const {
      getWebContents,
      runtimeSource,
      allowedActions,
      evaluate,
      inspectPage,
      readyPollMs,
      pageProfile,
      log,
      onCallResult,
    } = options;
    const transport = new WebContentsFoundryTransport({
      ...(getWebContents ? { getWebContents } : {}),
      ...(evaluate ? { evaluate } : {}),
      ...(inspectPage ? { inspectPage } : {}),
    });
    const callContext = new AsyncLocalStorage();
    super({
      transport,
      // 扩展 action 的类型层过桥：SDK 只要满白名单集，契约类型不收录 mtcompat 扩展名。
      ...(allowedActions ? { allowedActions: /** @type {readonly import("@arcanedesk/foundry-sdk/contracts").DirectAction[]} */ (allowedActions) } : {}),
      ...(runtimeSource !== undefined ? { runtimeSource } : {}),
      ...(readyPollMs !== undefined ? { readyPollMs } : {}),
      ...(pageProfile ? { pageProfile } : {}),
      ...(log ? { log } : {}),
      onCallResult: record => {
        const context = callContext.getStore();
        if (context?.telemetry) context.telemetry.foundryRuntimeResult(record, context.mode);
        else onCallResult?.(record);
      },
    });
    this.callContext = callContext;
  }

  /** Context follows the caller's promise, including time spent in the SDK write queue. */
  callForSession(telemetry, mode, action, args, options) {
    return this.callContext.run({ telemetry, mode }, () => this.call(action, args, options));
  }
}

// ---------- mtcompat 页面的自定义 runtime 源(mt-agent-runtime.js) ----------

/**
 * mt-agent-runtime.js 的加载契约(页面侧 runtime 与本加载器都要遵守):
 * - 文件内容是"runtime 函数表达式"原文,SDK 会在页面里以 `(source)(action, args, options)`
 *   求值 —— 与 @arcanedesk/foundry-sdk 的 runtime-source 同构;
 * - 开头的 `export default ` 前缀可留可不留(留着时文件是合法 ES module,会被剥掉);
 * - 空文件 / 语法不成立(无法作为函数表达式解析)的文件按"缺失"处理并记日志;
 * - 优先级:userData/config/mt-agent-runtime.js(开发/热修) > 包内 runtime/mt-agent-runtime.js。
 *   这份打包拷贝只是离线兜底 —— 面板就绪后页面自持的 __MT_AGENT_RUNTIME_SOURCE__
 *   是真源,由 adoptMtcompatRuntimeFromPage 采用并换入路由(A1 PRD)。
 * @typedef {{ source: string, origin: "user" | "bundled", file: string }} RuntimeSourceFile
 */

function stripExportDefault(text) {
  return String(text).replace(/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*export\s+default\s+/, "");
}

function isFunctionExpression(source) {
  try {
    new Function(`return (${source});`);
    return true;
  } catch {
    return false;
  }
}

/**
 * runtime 源串体检(打包拷贝文件与页面真源 __MT_AGENT_RUNTIME_SOURCE__ 同构,共用这套规则):
 * 剥 `export default` 前缀、剪掉尾部的 `;`/空白(它们会破坏 `(source)(...)` 的包裹求值),
 * 再按函数表达式解析验证。失败给原因码 —— 两处调用侧的日志文案各不相同。
 * @param {unknown} raw
 * @returns {{ source: string | null, error: "empty" | "invalid" | null }}
 */
function analyzeMtRuntimeSource(raw) {
  if (typeof raw !== "string") return { source: null, error: "empty" };
  const source = stripExportDefault(raw).replace(/[\s;]+$/, "");
  if (!source.trim()) return { source: null, error: "empty" };
  if (!isFunctionExpression(source)) return { source: null, error: "invalid" };
  return { source, error: null };
}

/**
 * 解析 mtcompat runtime 源:两处约定路径都缺失/不可用时返回 null —— 此时 mtcompat
 * 调用走 PageProfileRoutedRuntime 的 TRANSPORT_UNAVAILABLE 明确报错,Foundry 档不受影响。
 * @param {{
 *   userFile?: string,
 *   bundledFile?: string,
 *   readFile?: (file: string) => string,
 *   log?: (message: string) => void,
 * }} [options]
 * @returns {RuntimeSourceFile | null}
 */
export function resolveMtAgentRuntimeSource({
  userFile,
  bundledFile,
  readFile = file => readFileSync(file, "utf8"),
  log = () => {},
} = {}) {
  const candidates = /** @type {[("user" | "bundled"), string][]} */ ([
    ["user", userFile],
    ["bundled", bundledFile],
  ]);
  for (const [origin, file] of candidates) {
    if (!file) continue;
    let raw;
    try {
      raw = readFile(file);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        log(`[mt-runtime] cannot read ${origin} runtime at ${file}: ${error?.message ?? error}`);
      }
      continue;
    }
    // 尾部的 `;`/空白会破坏 `(source)(...)` 的包裹求值,analyze 一并剪掉。
    const analyzed = analyzeMtRuntimeSource(raw);
    if (!analyzed.source) {
      const detail = analyzed.error === "invalid" ? "is not a usable function expression" : "is empty";
      log(`[mt-runtime] ${origin} runtime at ${file} ${detail}; ignoring`);
      continue;
    }
    return { source: analyzed.source, origin, file };
  }
  return null;
}

/**
 * A1 runtime 源页面优先:面板就绪后页面里自持的 __MT_AGENT_RUNTIME_SOURCE__ 是真源,
 * 打包拷贝(包内/用户目录 mt-agent-runtime.js)只是离线兜底。SDK 在构造期钉死
 * runtimeSource(client.ts 的 #runtimeSource),所以采用页面源只能整实例重建后换入。
 *
 * 失败路径一律保持现状、只落日志:源缺席 / 页面读取失败 / 源不是可用函数表达式 /
 * 重建抛错 / 与当前源相同 —— 既有 mtcompat client(或"未安装"的报错态)继续服务,
 * 绝不因采用失败拆掉既有连接。源缺席是正常路径(Foundry 档页面、旧版页面)不落日志。
 * @param {{
 *   routed: PageProfileRoutedRuntime,
 *   currentSource?: string | null,
 *   readPageSource: () => Promise<{ ok: boolean, source?: string, reason?: string, error?: string }>,
 *   createRuntime: (source: string) => DirectFoundryRuntime | null,
 *   log?: (level: "info" | "warn", message: string) => void,
 * }} options
 * @returns {Promise<{ adopted: boolean, reason: "adopted" | "absent" | "read-failed" | "invalid" | "unchanged" | "rebuild-failed", source?: string }>}
 */
export async function adoptMtcompatRuntimeFromPage({
  routed,
  currentSource = null,
  readPageSource,
  createRuntime,
  log = () => {},
}) {
  if (!routed || typeof routed.setMtcompatRuntime !== "function") {
    throw new TypeError("a PageProfileRoutedRuntime is required");
  }
  if (typeof readPageSource !== "function") throw new TypeError("readPageSource must be a function");
  if (typeof createRuntime !== "function") throw new TypeError("createRuntime must be a function");

  let read;
  try {
    read = await readPageSource();
  } catch (error) {
    log("warn", `[mt-runtime] cannot read the page runtime source: ${error?.message ?? error}; keeping the installed runtime`);
    return { adopted: false, reason: "read-failed" };
  }
  if (!read?.ok) {
    const reason = read?.reason ?? "read-failed";
    if (reason === "absent") return { adopted: false, reason: "absent" };
    log(
      "warn",
      `[mt-runtime] the page runtime source could not be read (${read?.error ?? reason}); keeping the installed runtime`,
    );
    return { adopted: false, reason: "read-failed" };
  }

  const analyzed = analyzeMtRuntimeSource(read.source);
  if (!analyzed.source) {
    log("warn", `[mt-runtime] the page runtime source is ${analyzed.error ?? "unusable"}; keeping the installed runtime`);
    return { adopted: false, reason: "invalid" };
  }
  const source = analyzed.source;
  if (source === currentSource) return { adopted: false, reason: "unchanged" };

  let runtime;
  try {
    runtime = createRuntime(source);
  } catch (error) {
    log("warn", `[mt-runtime] rebuilding the mtcompat runtime from the page source failed: ${error?.message ?? error}; keeping the installed runtime`);
    return { adopted: false, reason: "rebuild-failed" };
  }
  if (!runtime) {
    log("warn", "[mt-runtime] rebuilding the mtcompat runtime from the page source returned nothing; keeping the installed runtime");
    return { adopted: false, reason: "rebuild-failed" };
  }

  routed.setMtcompatRuntime(runtime);
  const header = String(source).split("\n", 1)[0].trim().slice(0, 80);
  log("info", `[mt-runtime] adopted the page runtime source (${source.length} bytes; ${header})`);
  return { adopted: true, reason: "adopted", source };
}

/**
 * 按当前活动页面档位把 runtime 调用路由到对应的 client 实例。两档各持独立的
 * runtime 源与 preflight 语义(Foundry 档 = SDK 出厂行为;mtcompat 档 = 自定义
 * runtime 源 + profile 覆盖),互不串队列。档位由 main.js 依据最近打开的目标决定
 * (getActiveProfileId),页面巡检 URL 只是佐证 —— Keycloak 登录跳转期间 URL 不再
 * 匹配 play.html,路由不能跟着 URL 抖。
 */
export class PageProfileRoutedRuntime {
  /** @param {{
   *    foundry: DirectFoundryRuntime,
   *    mtcompat?: DirectFoundryRuntime | null,
   *    getActiveProfileId?: () => string,
   *    mtUnavailableMessage?: string,
   *    log?: (message: string) => void,
   *  }} options */
  constructor({ foundry, mtcompat = null, getActiveProfileId = () => "foundry", mtUnavailableMessage, log = () => {} }) {
    if (!foundry) throw new TypeError("foundry runtime is required");
    this.#foundry = foundry;
    this.#mtcompat = mtcompat;
    this.#getActiveProfileId = getActiveProfileId;
    this.#mtUnavailableMessage = mtUnavailableMessage;
    this.#log = log;
  }

  #foundry;
  #mtcompat;
  #getActiveProfileId;
  #mtUnavailableMessage;
  #log;
  #lastHandshake = null;

  /**
   * runtime 源页面优先的换入点(A1):SDK 构造期钉死 runtimeSource,采用页面真源
   * 只能整实例重建 —— 重建成功后才调这里换入;失败/缺席一律不调,既有连接原样保留。
   * 传 null 可退回"未安装"报错态(目前只有测试用得上)。
   * 换入即生效:后续 call/callForSession 走新实例;已在旧实例队列里的调用留在旧实例跑完。
   */
  setMtcompatRuntime(runtime = null) {
    this.#mtcompat = runtime;
  }

  /** 活动档位的 runtime;mtcompat 源未安装时抛稳定编码错误(调用侧以工具错误呈现)。 */
  #activeRuntime() {
    if (this.#getActiveProfileId() === "mtcompat") {
      if (!this.#mtcompat) {
        throw new FoundrySdkError(
          FOUNDRY_SDK_ERROR_CODES.TRANSPORT_UNAVAILABLE,
          this.#mtUnavailableMessage
            ?? "The mt-compat page runtime (mt-agent-runtime.js) is not installed; Foundry pages are unaffected",
        );
      }
      return this.#mtcompat;
    }
    return this.#foundry;
  }

  async call(action, args, options) {
    const value = await this.#activeRuntime().call(action, args, options);
    this.#reportHandshake(value);
    return value;
  }

  async callForSession(telemetry, mode, action, args, options) {
    const value = await this.#activeRuntime().callForSession(telemetry, mode, action, args, options);
    this.#reportHandshake(value);
    return value;
  }

  invalidate() {
    this.#foundry.invalidate();
    this.#mtcompat?.invalidate();
  }

  /** 读路径永不抛错:mtcompat 源未安装时 lastWorldInfo 就是 null(sessions:current 会高频读它)。 */
  get lastWorldInfo() {
    if (this.#getActiveProfileId() === "mtcompat") return this.#mtcompat?.lastWorldInfo ?? null;
    return this.#foundry.lastWorldInfo ?? null;
  }

  /**
   * 页面侧 runtime 的版本/协议握手:worldInfo 结果里的 runtime: {name, protocolVersion}
   * 只记录(去重),不因不匹配而硬失败 —— mtcompat runtime 是增量交付的。
   */
  #reportHandshake(value) {
    const runtime = value?.runtime;
    if (!runtime || typeof runtime !== "object") return;
    const signature = `${runtime.name ?? "unknown"}@${runtime.protocolVersion ?? "unknown"}`;
    if (this.#lastHandshake === signature) return;
    this.#lastHandshake = signature;
    this.#log(`[foundry-runtime] page runtime handshake: ${signature}`);
  }
}
