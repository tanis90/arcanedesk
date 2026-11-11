// search/adapters/shared.js — adapter 公共工具。
// 线格式知识移植自 code-yeongyu/pi-websearch（MIT © 2026 Yeongyu）的
// src/websearch/providers/shared.ts；出处与许可见 THIRD_PARTY_NOTICES.md。

export function contentHeaders(extra = {}) {
  return { Accept: "application/json", "Content-Type": "application/json", ...extra };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)));
}

export function getObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function getArray(value) {
  return Array.isArray(value) ? value : [];
}

export function getString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** 带搜索错误码的 Error（coerceSearchError 按 .code 收拢为 SearchError）。 */
export function codedError(code, message, meta = {}) {
  return Object.assign(new Error(message), { code }, meta);
}

/** 工具 API（search/fetch）HTTP 状态 → 客户端错误码（401/402/403/404/408/413/429/5xx）。 */
export function toolHttpErrorCode({ status }) {
  if (status === 401) return "authFailed";
  if (status === 402) return "quotaExceeded";
  if (status === 403) return "fetchBlocked";
  if (status === 404) return "fetchUnavailable";
  if (status === 408 || status === 504) return "timeout";
  if (status === 413) return "pageTooLarge";
  if (status === 429) return "rateLimited";
  return "backendUnavailable";
}

/**
 * HTTP 状态 → 错误码；未提供 mapHttpError 时的默认表（搜索语义）。
 * 传输错误统一在这里收拢，避免每个 adapter 重复。
 */
function defaultHttpErrorCode(status) {
  return status === 401 || status === 403
    ? "authFailed"
    : status === 429 || status === 402
      ? "quotaExceeded"
      : "backendUnavailable";
}

/** Retry-After 只认整数秒；解析不出返回 null。 */
export function readRetryAfter(headers) {
  const raw = headers?.get?.("retry-after");
  if (raw == null) return null;
  const seconds = Number(String(raw).trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null;
}

/**
 * fetch + 统一错误映射。timeoutMs 通过 AbortSignal.timeout 与调用方 signal 合流；
 * 超时判 timeout、调用方取消判 cancelled、网络错误判 backendUnavailable。
 * mapHttpError({status, retryAfter}) 可覆盖非 2xx 的错误码（fetch 用更细的表）。
 */
export async function fetchJson(url, init, {
  signal = null,
  fetchImpl = fetch,
  backend,
  log = null,
  timeoutMs = 15_000,
  mapHttpError = null,
}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: merged });
  } catch (error) {
    if (timeoutSignal.aborted) throw codedError("timeout", `timeout: ${backend}`);
    if (signal?.aborted) throw codedError("cancelled", "cancelled");
    log?.(`[search:${backend}] network error: ${error?.message ?? error}`);
    throw codedError("backendUnavailable", `network: ${backend}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const retryAfter = readRetryAfter(response.headers);
    log?.(`[search:${backend}] http ${response.status}`);
    const code = (mapHttpError ? mapHttpError({ status: response.status, retryAfter, body: detail }) : null)
      ?? defaultHttpErrorCode(response.status);
    throw codedError(
      code,
      `http ${response.status}: ${detail.slice(0, 200)}`,
      retryAfter != null ? { retryAfter } : {},
    );
  }
  try {
    return await response.json();
  } catch (error) {
    log?.(`[search:${backend}] invalid json: ${error?.message}`);
    throw codedError("backendUnavailable", `invalid json: ${backend}`);
  }
}
