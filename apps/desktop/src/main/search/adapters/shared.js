// search/adapters/shared.js — adapter 公共工具。
// 线格式知识移植自 code-yeongyu/pi-websearch（MIT © 2026 Yeongyu）的
// src/websearch/providers/shared.ts；出处与许可见 THIRD_PARTY_NOTICES.md。

export function contentHeaders(extra = {}) {
  return { Accept: "application/json", "Content-Type": "application/json", ...extra };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)));
}

/** 站内过滤拼进 query（z-ai 独立 API 只认单域 filter，brave 不认参数时的兜底）。 */
export function appendDomainFilters(query, allowedDomains = [], blockedDomains = []) {
  const parts = [query];
  for (const domain of allowedDomains) parts.push(`site:${domain}`);
  for (const domain of blockedDomains) parts.push(`-site:${domain}`);
  return parts.join(" ");
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
export function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * fetch + 统一错误映射。timeoutMs 通过 AbortSignal.timeout 与调用方 signal 合流；
 * 超时判 timeout、调用方取消判 cancelled、网络错误判 backendUnavailable。
 */
export async function fetchJson(url, init, { signal = null, fetchImpl = fetch, backend, log = null }) {
  const timeoutSignal = AbortSignal.timeout(15_000);
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
    log?.(`[search:${backend}] http ${response.status}`);
    throw codedError(
      response.status === 401 || response.status === 403
        ? "authFailed"
        : response.status === 429 || response.status === 402
          ? "quotaExceeded"
          : "backendUnavailable",
      `http ${response.status}: ${detail.slice(0, 200)}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    log?.(`[search:${backend}] invalid json: ${error?.message}`);
    throw codedError("backendUnavailable", `invalid json: ${backend}`);
  }
}
