import { FoundryRuntimeClient } from "@arcanedesk/foundry-sdk/client";

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
 * Product-facing name retained for AgentHost. All protocol, preflight,
 * serialization, queueing, timeout, and indeterminate-write behavior lives in
 * @arcanedesk/foundry-sdk; Desktop supplies only the WebContents transport.
 */
export class DirectFoundryRuntime extends FoundryRuntimeClient {
  /**
   * @param {{
   *   getWebContents?: () => any,
   *   runtimeSource?: string,
   *   evaluate?: (webContents: any, expression: string, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
   *   inspectPage?: (webContents: any, options: { timeoutMs: number, signal?: AbortSignal }) => Promise<any>,
   *   readyPollMs?: number,
   *   log?: (level: "warn", message: string, details?: unknown) => void,
   *   onCallResult?: (record: import("@arcanedesk/foundry-sdk/client").FoundryRuntimeCallResultRecord) => void,
   * }} [options]
   */
  constructor(options = {}) {
    const {
      getWebContents,
      runtimeSource,
      evaluate,
      inspectPage,
      readyPollMs,
      log,
      onCallResult,
    } = options;
    const transport = new WebContentsFoundryTransport({
      ...(getWebContents ? { getWebContents } : {}),
      ...(evaluate ? { evaluate } : {}),
      ...(inspectPage ? { inspectPage } : {}),
    });
    super({
      transport,
      ...(runtimeSource !== undefined ? { runtimeSource } : {}),
      ...(readyPollMs !== undefined ? { readyPollMs } : {}),
      ...(log ? { log } : {}),
      ...(onCallResult ? { onCallResult } : {}),
    });
  }
}
