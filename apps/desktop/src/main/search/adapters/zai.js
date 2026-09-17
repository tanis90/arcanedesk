// search/adapters/zai.js — 智谱独立 Web Search API adapter。
// 线格式移植自 code-yeongyu/pi-websearch（MIT © 2026 Yeongyu）的 z-ai.ts：
//   POST {base}  {search_engine:"search-prime", search_query, count, search_domain_filter?}
//   ←  {search_result:[{title, link, content, media, publish_date}]}
// 国内默认 https://open.bigmodel.cn/api/paas/v4/web_search，国际 api.z.ai 同形状；
// baseUrl 由 SearchStore 注入（区域差异不进 adapter，见设计文档 §6）。

import { appendDomainFilters, clamp, contentHeaders, fetchJson, getArray, getObject, getString } from "./shared.js";

export const ZAI_CAPABILITIES = { count: true, freshness: false, domains: true };

export const zaiAdapter = {
  id: "zai",
  capabilities: ZAI_CAPABILITIES,
  /**
   * @param {{ query: string, count?: number, domains?: string[] }} params
   * @param {{ apiKey: string, baseUrl: string, signal?: AbortSignal, fetchImpl?: Function, log?: Function }} ctx
   * @returns {Promise<{ results: Array<{title,url,snippet,publishedAt,source}>, requestId: string | null }>}
   */
  async search(params, ctx) {
    const body = {
      search_engine: "search-prime",
      search_query: appendDomainFilters(params.query, params.domains ?? []),
      count: clamp(params.count ?? 5, 1, 50),
    };
    // z-ai 独立 API 的 search_domain_filter 只认单个域名；多个时退化为 site: 拼接。
    if (params.domains?.length === 1) {
      body.search_domain_filter = params.domains[0];
      body.search_query = String(params.query);
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
};
