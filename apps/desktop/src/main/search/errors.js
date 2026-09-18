// search/errors.js — 搜索错误的统一形状。
// adapter/服务端只抛 SearchError(code)；上游原始报错留在 detail 里只进日志，
// 用户可见文案全部走 err.search.* 的 IPC 结构化 key（renderer fmtIpc 本地化）。

import { err } from "../i18n-error.mjs";

/** code → i18n key。新增错误必须同步补 ss/err 双语文案。 */
const IPC_KEYS = {
  authFailed: "err.search.authFailed",
  quotaExceeded: "err.search.quotaExceeded",
  backendUnavailable: "err.search.backendUnavailable",
  timeout: "err.search.timeout",
  cancelled: "err.search.cancelled",
  budgetExhausted: "err.search.budgetExhausted",
  consentRequired: "err.search.consentRequired",
  empty: "err.search.empty",
  notConfigured: "err.search.notConfigured",
  badRequest: "err.search.badRequest",
};

export class SearchError extends Error {
  /**
   * @param {keyof typeof IPC_KEYS} code
   * @param {{ detail?: string, backend?: string, used?: number | string }} meta
   */
  constructor(code, meta = {}) {
    super(`search:${code}${meta.detail ? ` (${meta.detail})` : ""}`);
    this.name = "SearchError";
    this.code = code;
    this.meta = meta;
  }

  /** IPC 出口：{ key, params }，renderer 用 t(key, params) 渲染。 */
  toIpc() {
    return err(IPC_KEYS[this.code] ?? "err.search.backendUnavailable", {
      ...(this.meta?.backend ? { backend: this.meta.backend } : {}),
      ...(this.meta?.used != null ? { used: String(this.meta.used) } : {}),
    });
  }
}

/** HTTP 状态 → 错误码的公共映射（z-ai/brave/spark 通用）。 */
export function statusToErrorCode(status) {
  if (status === 401 || status === 403) return "authFailed";
  if (status === 429) return "quotaExceeded";
  if (status === 402) return "quotaExceeded";
  return "backendUnavailable";
}

/** adapter/网络层抛出的普通 Error(.code) 收拢为 SearchError；未知错误归 backendUnavailable。 */
export function coerceSearchError(error, backend) {
  if (error instanceof SearchError) return error;
  const code = error?.code && Object.hasOwn(IPC_KEYS, error.code) ? error.code : "backendUnavailable";
  return new SearchError(code, {
    backend,
    ...(error?.message ? { detail: String(error.message).slice(0, 200) } : {}),
  });
}
