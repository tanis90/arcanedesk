// search/adapters/spark.js — Arcane Spark /v1/search + /v1/fetch 与自定义兼容端点共用契约。
// 响应字段对齐智谱独立搜索（PRD §2：Spark adapter 与 z-ai BYOK 共享解析结构）：
//   POST {base}/v1/search   Bearer <key>
//   {"query","count","freshness","domains"}
//   ←  {"search_results":[{title,url,content,publish_date}],"requestId","truncated"}
//   POST {base}/v1/fetch    Bearer <key>
//   {"url"}   ← {"title","content","requestId","truncated"}
// 服务端语义：429 quota_exceeded（预算熔断）、503 backend_unavailable、超时 ≤15s；
// fetch 的 403→422 fetch_blocked、404 fetch_unavailable、413 page_too_large、
// 429→503+Retry-After（relay 刻意避开 429，见 fetch-url.js 的 RELAY_FETCH_ERROR_CODES）。

import { clamp, codedError, contentHeaders, fetchJson, getArray, getObject, getString } from "./shared.js";
import { RELAY_FETCH_ERROR_CODES } from "../fetch-url.js";

export const SPARK_CAPABILITIES = { count: true, freshness: true, domains: true };

/** fetch 比 search 慢（上游抓取 + 正文提取），与 relay 的 25s 对齐。 */
export const SPARK_FETCH_TIMEOUT_MS = 25_000;

/**
 * relay 的 HTTP 状态 → 客户端错误码。relay 未部署时是 404（普通 HTML/空体，
 * 不是 JSON）——必须映射成可恢复的 fetch_unavailable，不能崩。
 * 有 JSON 错误体时优先用业务码（fetch_blocked / page_too_large 等）。
 */
export function relayFetchHttpErrorCode({ status, body }) {
  const code = relayErrorCodeFromBody(body);
  if (code) return code;
  if (status === 401 || status === 403) return "authFailed";
  if (status === 404) return "fetchUnavailable";
  if (status === 413) return "pageTooLarge";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "quotaExceeded";
  if (status === 503) return "backendUnavailable";
  return "backendUnavailable";
}

/** relay 错误体 {error:{code:"..."}} → 客户端错误码；非 JSON 返回 null。 */
export function relayErrorCodeFromBody(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const raw = parsed?.error?.code;
  if (typeof raw !== "string") return null;
  return RELAY_FETCH_ERROR_CODES[raw] ?? null;
}

export function createArcaneSearchAdapter(id) {
  return {
    id,
    capabilities: SPARK_CAPABILITIES,
    async search(params, ctx) {
      // base 可能带 /v1（Spark provider 惯例）也可能不带：统一归一到 .../v1/search。
      const base = String(ctx.baseUrl ?? "").replace(/\/+$/, "");
      const url = base.endsWith("/v1") ? `${base}/search` : `${base}/v1/search`;
      const data = await fetchJson(url, {
        method: "POST",
        headers: contentHeaders({ Authorization: `Bearer ${ctx.apiKey}` }),
        body: JSON.stringify({
          query: params.query,
          count: clamp(params.count ?? 5, 1, 20),
          ...(params.freshness ? { freshness: params.freshness } : {}),
          domains: params.domains ?? [],
        }),
      }, { ...ctx, backend: id });
      const rows = getArray(data?.search_results);
      const results = rows.map((raw) => {
        const item = getObject(raw) ?? {};
        return {
          title: getString(item.title),
          url: getString(item.url),
          snippet: getString(item.content),
          publishedAt: getString(item.publish_date) || null,
          source: id,
        };
      }).filter((item) => item.title && item.url);
      return { results, requestId: getString(data?.requestId) || null };
    },

    /**
     * 抓取单个 URL。relay 只在 CN 区部署；未部署时 404 → fetchUnavailable
     * 的可恢复指引（模型可以改走已知摘要或本地资料）。
     * @param {{ url: string }} params
     * @param {{ apiKey: string, baseUrl: string, signal?: AbortSignal, fetchImpl?: any, log?: any }} ctx
     */
    async fetch(params, ctx) {
      const base = String(ctx.baseUrl ?? "").replace(/\/+$/, "");
      const url = base.endsWith("/v1") ? `${base}/fetch` : `${base}/v1/fetch`;
      // 404（relay 未部署）与 413/422/503 都由 relayFetchHttpErrorCode 收敛成
      // 可恢复错误码；retryAfter 由 fetchJson 从 Retry-After 头带出。
      const data = await fetchJson(url, {
        method: "POST",
        headers: contentHeaders({ Authorization: `Bearer ${ctx.apiKey}` }),
        body: JSON.stringify({ url: params.url }),
      }, {
        ...ctx,
        backend: id,
        timeoutMs: SPARK_FETCH_TIMEOUT_MS,
        mapHttpError: relayFetchHttpErrorCode,
      });
      const body = getObject(data) ?? {};
      const content = getString(body.content);
      if (!content) throw codedError("fetchUnavailable", "empty content");
      return {
        title: getString(body.title),
        url: params.url,
        content,
        requestId: getString(body.requestId) || null,
        ...(body.truncated === true ? { truncated: true } : {}),
      };
    },
  };
}

export const sparkAdapter = createArcaneSearchAdapter("spark");
export const customAdapter = createArcaneSearchAdapter("custom");

