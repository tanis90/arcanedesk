// search/adapters/zai.js — 智谱独立 Web Search API + 网页阅读 API adapter。
// 线格式移植自 code-yeongyu/pi-websearch（MIT © 2026 Yeongyu）的 z-ai.ts，
// 并对齐 bigmodel.cn 官方文档修正：search_engine 合法值（cn=search_pro /
// z.ai=search-prime，由 region 注入）、search_intent:false（工具直搜跳过意图识别）、
// search_recency_filter（freshness 全链路支持）、query 70 字符硬上限。
//   POST {base}  {search_engine, search_intent:false, search_query, count,
//                search_domain_filter?, search_recency_filter?}
//   ←  {request_id, search_result:[{title, link, content, media, publish_date}]}
// 网页阅读（官方 2026-10 上线）：search 端点同目录的 /reader，POST {url}
//   ←  {request_id, reader_result:{title, url, content, description?, metadata?}}

import { clamp, codedError, contentHeaders, fetchJson, getArray, getObject, getString, toolHttpErrorCode } from "./shared.js";

export const ZAI_CAPABILITIES = { count: true, freshness: true, domains: true };

/** day/week/month/year → 智谱系 oneDay/oneWeek/oneMonth/oneYear。 */
const FRESHNESS_TO_RECENCY = Object.freeze({
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
});

const UPSTREAM_MAX_QUERY_CHARS = 70;

/** fetch 比 search 慢（正文提取 + 渲染），超时放宽到 25s（与 deepseek 一致）。 */
export const ZAI_FETCH_TIMEOUT_MS = 25_000;

/**
 * 由 search 端点推出 reader 端点：默认 .../api/paas/v4/web_search，同目录换叶子
 * 即可；用户自定义代理若只给到 /v4 也兼容。绝不跨 origin。
 */
export function zaiReaderUrl(baseUrl) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (/\/web_search$/.test(base)) return base.replace(/\/web_search$/, "/reader");
  if (/\/v4$/.test(base)) return `${base}/reader`;
  return `${base}/api/paas/v4/reader`;
}

export const zaiAdapter = {
  id: "zai",
  capabilities: ZAI_CAPABILITIES,
  /**
   * @param {{ query: string, count?: number, freshness?: string | null, domains?: string[] }} params
   * @param {{ apiKey: string, baseUrl: string, searchEngine?: string, signal?: AbortSignal, fetchImpl?: any, log?: any }} ctx
   */
  async search(params, ctx) {
    const engine = ctx.searchEngine ?? "search_pro";
    const body = {
      search_engine: engine,
      search_intent: false,
      count: clamp(params.count ?? 5, 1, 50),
    };
    // 域名白名单只认单个；多余域名拼 site:，且总长仍受 70 字符硬限制。
    const [first, ...rest] = params.domains ?? [];
    if (first) body.search_domain_filter = first;
    const suffix = rest.map((domain) => `site:${domain}`).join(" ");
    const budget = suffix ? UPSTREAM_MAX_QUERY_CHARS - suffix.length - 1 : UPSTREAM_MAX_QUERY_CHARS;
    body.search_query = suffix
      ? [params.query.slice(0, Math.max(1, budget)), suffix].join(" ")
      : params.query.slice(0, UPSTREAM_MAX_QUERY_CHARS);
    if (params.freshness && FRESHNESS_TO_RECENCY[params.freshness]) {
      body.search_recency_filter = FRESHNESS_TO_RECENCY[params.freshness];
    }

    const data = await fetchJson(ctx.baseUrl, {
      method: "POST",
      headers: contentHeaders({ Authorization: `Bearer ${ctx.apiKey}` }),
      body: JSON.stringify(body),
    }, { ...ctx, backend: "zai" });
    // 独立 API 返回 search_result 数组；chat 工具通路的 web_search 数组兜底兼容。
    const rows = getArray(data?.search_result).length > 0
      ? getArray(data.search_result)
      : getArray(data?.web_search);
    const results = rows.map((raw) => {
      const item = getObject(raw) ?? {};
      return {
        title: getString(item.title),
        url: getString(item.link),
        snippet: getString(item.content),
        publishedAt: getString(item.publish_date) || null,
        source: getString(item.media) || "zhipu",
      };
    }).filter((item) => item.title && item.url);
    return { results, requestId: getString(data?.request_id) || getString(data?.id) || null };
  },

  /**
   * 抓取单个 URL 的正文（智谱网页阅读 API），返回 { title, url, content }。
   * 大小上限在 fetch-normalize 里按 64KB 统一处理，adapter 不重复截断。
   * @param {{ url: string }} params
   * @param {{ apiKey: string, baseUrl: string, signal?: AbortSignal, fetchImpl?: any, log?: any }} ctx
   */
  async fetch(params, ctx) {
    const data = await fetchJson(zaiReaderUrl(ctx.baseUrl), {
      method: "POST",
      headers: contentHeaders({ Authorization: `Bearer ${ctx.apiKey}` }),
      body: JSON.stringify({ url: params.url }),
    }, {
      ...ctx,
      backend: "zai",
      timeoutMs: ZAI_FETCH_TIMEOUT_MS,
      mapHttpError: toolHttpErrorCode,
    });
    const result = getObject(data?.reader_result);
    const content = getString(result?.content);
    if (!content) {
      // 200 但正文为空：当"无可提取正文"，与 relay 的 fetch_unavailable 同语义。
      throw codedError("fetchUnavailable", "empty content");
    }
    return {
      title: getString(result?.title),
      url: getString(result?.url) || params.url,
      content,
      requestId: getString(data?.request_id) || getString(data?.id) || null,
    };
  },
};
