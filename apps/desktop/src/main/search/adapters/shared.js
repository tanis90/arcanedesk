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

/**
 * fetch + 统一错误映射。timeoutMs 通过 AbortSignal.timeout 与调用方 signal 合流；
 * 超时判 timeout、调用方取消判 cancelled、网络错误判 backendUnavailable。
 */
export async function fetchJson(url, init, { signal, fetchImpl = fetch, backend, log }) {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: merged });
  } catch (error) {
    if (timeoutSignal.aborted) {
      const e = new Error(`timeout: ${backend}`);
      e.code = "timeout";
      throw e;
    }
    if (signal?.aborted) {
      const e = new Error("cancelled");
      e.code = "cancelled";
      throw e;
    }
    log?.(`[search:${backend}] network error: ${error?.message ?? error}`);
    const e = new Error(`network: ${backend}`);
    e.code = "backendUnavailable";
    throw e;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    log?.(`[search:${backend}] http ${response.status}`);
    const e = new Error(`http ${response.status}: ${detail.slice(0, 200)}`);
    e.code = response.status === 401 || response.status === 403
      ? "authFailed"
      : response.status === 429 || response.status === 402
        ? "quotaExceeded"
        : "backendUnavailable";
    throw e;
  }
  try {
    return await response.json();
  } catch (error) {
    log?.(`[search:${backend}] invalid json: ${error?.message}`);
    const e = new Error(`invalid json: ${backend}`);
    e.code = "backendUnavailable";
    throw e;
  }
}
