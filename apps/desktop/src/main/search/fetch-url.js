// search/fetch-url.js — web_fetch 的 URL 入参校验（与 relay 端同一套语法规则）。
//
// 只做语法层校验：scheme 白名单 http/https、必须有 host、禁 userinfo、长度上限。
// 刻意不查私网 IP / localhost / 端口 / 重定向链——抓取发生在 DeepSeek 侧，桌面端
// 与 relay 都不解析域名、不建连目标站，这类校验在这里拦不住也防不了（见 PRD §6.2）。
// 桌面端自己必须挡的是 file:/data:/javascript: 这类本地 scheme。

export const MAX_FETCH_URL_CHARS = 8192;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * @param {any} raw
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function sanitizeFetchUrl(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "urlNotString" };
  const url = raw.trim();
  if (!url) return { ok: false, reason: "urlEmpty" };
  if (url.length > MAX_FETCH_URL_CHARS) return { ok: false, reason: "urlTooLong" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "urlInvalid" };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return { ok: false, reason: "urlScheme" };
  if (!parsed.hostname) return { ok: false, reason: "urlInvalid" };
  // user:pass@ 会把凭据带进目标站/日志；relay 同样拒绝。
  if (parsed.username || parsed.password) return { ok: false, reason: "urlUserInfo" };
  return { ok: true, url };
}

/**
 * relay 的业务错误码 → 客户端错误码。relay 未部署时是 404 Not Found（非 JSON），
 * 由 adapter 的 http 映射成 fetchUnavailable。
 */
export const RELAY_FETCH_ERROR_CODES = Object.freeze({
  bad_request: "badRequest",
  unauthorized: "authFailed",
  key_invalid: "authFailed",
  key_suspended: "authFailed",
  key_expired: "authFailed",
  model_not_allowed: "notConfigured",
  quota_store_unavailable: "backendUnavailable",
  fetch_blocked: "fetchBlocked",
  fetch_unavailable: "fetchUnavailable",
  page_too_large: "pageTooLarge",
  upstream_timeout: "timeout",
  upstream_rate_limited: "rateLimited",
  upstream_auth_failed: "backendUnavailable",
  upstream_balance_exhausted: "quotaExceeded",
  backend_unavailable: "backendUnavailable",
});
