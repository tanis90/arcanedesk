// search/index.js — 搜索/抓取执行编排：去重缓存（仅搜索）→ 凭据 → adapter → 归一化截断。
// M2 的 defineTool("web_search") / M8 的 defineTool("web_fetch") 只包一层壳调用这里；
// renderer 不 import 本模块。两个工具共享凭据解析与错误面，但各有自己的结果预算。

import { isPlausibleApiKey } from "../api-key.js";
import { coerceSearchError, SearchError } from "./errors.js";
import { toToolPayload, toUnifiedResult } from "./normalize.js";
import { toFetchPayload } from "./fetch-normalize.js";
import { sanitizeFetchUrl } from "./fetch-url.js";
import { deepseekAdapter } from "./adapters/deepseek.js";
import { customAdapter, sparkAdapter } from "./adapters/spark.js";
import { zaiAdapter } from "./adapters/zai.js";

const ADAPTERS = {
  spark: sparkAdapter,
  custom: customAdapter,
  zai: zaiAdapter,
  deepseek: deepseekAdapter,
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
 * 解析本次调用用的 adapter 与凭据。两个工具共用：spark 模式优先用户自己的
 * DeepSeek key，否则走 Spark relay（接入优先级见 PRD §5.2）。
 * @param {any} store SearchStore
 * @param {any} spark
 * @param {any} ownChatKeys
 * @param {(adapter: any) => boolean} supports 该 adapter 是否具备本次能力（search/fetch）
 */
function resolveAdapter(store, spark, ownChatKeys, supports) {
  const cred = store.credentialForUse(spark, ownChatKeys);
  const adapter = ADAPTERS[cred.adapterId];
  if (!adapter || !cred.apiKey || !supports(adapter)) throw new SearchError("notConfigured");
  // 存量坏 key（非 ASCII，粘贴/IME 带入）在 fetch 层只会报 ByteString 编码错误，
  // 表现为 backendUnavailable——提前拦下，给可执行的 authFailed 指引，且不发包。
  if (!isPlausibleApiKey(cred.apiKey)) {
    throw new SearchError("authFailed", { backend: adapter.id, detail: "api key contains non-ASCII characters" });
  }
  return { cred, adapter };
}

/**
 * 一次 web_search 执行（tool execute 的内核）。
 * @param {any} rawParams 模型工具参数（query/count/freshness/domains）
 * @param {{ store: any, spark: any, ownChatKeys?: any, cache: any, runKey: string, signal?: AbortSignal, fetchImpl?: any, log?: any }} deps
 *   ownChatKeys = 用户自己的聊天 provider 凭据快照（如 { deepseek: {apiKey} }），
 *   用于 spark 模式下的 DeepSeek key 自动复用；缺省时退回纯 Spark 路径。
 * @returns {Promise<{ payload: string, usage: { used: number, backend: string, cached: boolean } }>}
 *   payload 是 toolResult 文本（≤16KB JSON）；usage 给 host.emit(search_usage)。
 */
export async function executeSearch(rawParams, { store, spark, ownChatKeys = null, cache, runKey, signal, fetchImpl, log }) {
  const params = sanitizeParams(rawParams);
  const { cred, adapter } = resolveAdapter(store, spark, ownChatKeys, (candidate) => typeof candidate.search === "function");

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

/**
 * 一次 web_fetch 执行（tool execute 的内核）。
 *
 * 与 executeSearch 的差异：
 * - URL 先过语法校验（http/https、host、禁 userinfo），file:/data: 等直接拒绝；
 * - 不做 run 级去重缓存：同一 URL 可能因站点更新而变，且抓取不产生搜索次数，
 *   缓存反而会掩盖"再抓一次拿最新正文"的需求；
 * - 结果上限 64KB（与搜索的 16KB 分离），超出按 UTF-8 字节截正文并标 truncated。
 *
 * @param {any} rawParams 模型工具参数（url）
 * @param {{ store: any, spark: any, ownChatKeys?: any, signal?: AbortSignal, fetchImpl?: any, log?: any }} deps
 * @returns {Promise<{ payload: string, usage: { backend: string, url: string } }>}
 */
export async function executeFetch(rawParams, { store, spark, ownChatKeys = null, signal, fetchImpl, log }) {
  const sanitized = sanitizeFetchUrl(rawParams?.url);
  if ("reason" in sanitized) {
    const detail = sanitized.reason === "urlScheme" || sanitized.reason === "urlInvalid"
      ? "only http(s) urls with a host are supported"
      : sanitized.reason;
    throw new SearchError("badRequest", { detail });
  }
  const { cred, adapter } = resolveAdapter(store, spark, ownChatKeys, (candidate) => typeof candidate.fetch === "function");
  const backend = adapter.id;

  let page;
  try {
    page = await adapter.fetch({ url: sanitized.url }, {
      apiKey: cred.apiKey,
      baseUrl: cred.baseUrl,
      signal,
      ...(fetchImpl ? { fetchImpl } : {}),
      log,
    });
  } catch (error) {
    throw coerceSearchError(error, backend);
  }

  const payload = toFetchPayload({
    title: page.title,
    url: page.url ?? sanitized.url,
    content: page.content,
    backend,
    requestId: page.requestId ?? null,
    truncated: Boolean(page.truncated),
  });
  return { payload, usage: { backend, url: sanitized.url } };
}

/**
 * 某个 backend 是否具备抓取能力。工具池据此决定 web_fetch 是否进池——
 * 否则只搜不抓的 backend 用户会看到一个"永远 notConfigured"的工具。
 * @param {string | null} adapterId
 */
export function backendSupportsFetch(adapterId) {
  return Boolean(ADAPTERS[adapterId]?.fetch);
}

export { SearchError };
