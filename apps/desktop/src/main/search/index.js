// search/index.js — 搜索执行编排：去重缓存 → 凭据 → adapter → 归一化截断。
// M2 的 defineTool("web_search") 只包一层壳调用这里；renderer 不 import 本模块。

import { coerceSearchError, SearchError } from "./errors.js";
import { toToolPayload, toUnifiedResult } from "./normalize.js";
import { braveAdapter } from "./adapters/brave.js";
import { customAdapter, sparkAdapter } from "./adapters/spark.js";
import { zaiAdapter } from "./adapters/zai.js";

const ADAPTERS = {
  spark: sparkAdapter,
  custom: customAdapter,
  zai: zaiAdapter,
  brave: braveAdapter,
};

const FRESHNESS_VALUES = new Set(["day", "week", "month", "year"]);

/** params 清洗：typebox 已约束类型，这里做语义钳制（count≤20、freshness 枚举）。 */
export function sanitizeParams(raw) {
  const query = String(raw?.query ?? "").trim();
  if (query.length < 2) throw new SearchError("badRequest", { detail: "query too short" });
  const rawCount = Number(raw?.count);
  const count = Math.max(1, Math.min(20, Math.trunc(Number.isFinite(rawCount) ? rawCount : 5)));
  const domains = Array.isArray(raw?.domains)
    ? raw.domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean).slice(0, 5)
    : [];
  const freshness = FRESHNESS_VALUES.has(raw?.freshness) ? raw.freshness : null;
  return { query, count, domains, freshness };
}

/** adapter 能力 → meta.warnings（不支持的参数显式告警，不静默忽略，PRD §4）。 */
function capabilityWarnings(adapter, params) {
  const warnings = [];
  if (params.freshness && !adapter.capabilities.freshness) {
    warnings.push(`freshness="${params.freshness}" ignored by backend ${adapter.id}`);
  }
  if (params.domains.length > 0 && !adapter.capabilities.domains) {
    warnings.push(`domains not supported by backend ${adapter.id}; results may be unfiltered`);
  }
  return warnings;
}

/**
 * 一次 web_search 执行（tool execute 的内核）。
 * @param {any} rawParams 模型工具参数（query/count/freshness/domains）
 * @param {{ store: any, spark: any, cache: any, runKey: string, signal?: AbortSignal, fetchImpl?: any, log?: any }} deps
 * @returns {Promise<{ payload: string, usage: { used: number, backend: string, cached: boolean } }>}
 *   payload 是 toolResult 文本（≤16KB JSON）；usage 给 host.emit(search_usage)。
 */
export async function executeSearch(rawParams, { store, spark, cache, runKey, signal, fetchImpl, log }) {
  const params = sanitizeParams(rawParams);
  const cred = store.credentialForUse(spark);
  const adapter = ADAPTERS[cred.adapterId];
  if (!store.usable(spark) || !adapter) throw new SearchError("notConfigured");

  // 去重缓存：同 run 同 query 直接复用，不计次、不发包。
  const cached = cache.lookup(runKey, params.query);
  if (cached != null) {
    return { payload: cached, usage: { used: cache.used(runKey), backend: adapter.id, cached: true } };
  }

  let response;
  try {
    response = await adapter.search(params, {
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      ...(cred.searchEngine ? { searchEngine: cred.searchEngine } : {}),
      signal,
      ...(fetchImpl ? { fetchImpl } : {}),
      log,
    });
  } catch (error) {
    throw coerceSearchError(error, adapter.id); // 普通 Error(.code) → SearchError
  }
  const { results, requestId } = response;
  const unified = results.map(toUnifiedResult).filter(Boolean).slice(0, params.count);
  if (unified.length === 0) {
    throw new SearchError("empty", { backend: adapter.id });
  }

  const warnings = capabilityWarnings(adapter, params);
  const payload = toToolPayload(unified, {
    backend: adapter.id,
    requestId,
    warnings,
  });
  cache.record(runKey, params.query, payload);
  return { payload, usage: { used: cache.used(runKey), backend: adapter.id, cached: false } };
}

export { SearchError };
