// search/adapters/deepseek.js — DeepSeek 官方搜索工具 adapter。
// 用户自己的 DeepSeek 聊天 key 与搜索 API 共享 origin（api.deepseek.com），
// 因此同一把 key 既可跑模型也可搜索，扣用户自己的账单。
//   POST https://api.deepseek.com/v1/tools/search   Bearer <key>
//   {"query","count","need_content"?}   query ≤128 字符，count 1–50
//   ←  条目含 snippet(100–200 字) / summary(600–800 字) / date /
//      rerank_score / authority；无 request_id。
// 契约不支持 freshness 参数；domains 折叠进 query 的 site: 过滤（受 128 字符上限约束）。

import { clamp, contentHeaders, fetchJson, getArray, getObject, getString } from "./shared.js";

export const DEEPSEEK_CAPABILITIES = { count: true, freshness: false, domains: true };

/** 官方契约的 query 上限。 */
export const DEEPSEEK_MAX_QUERY_CHARS = 128;

/** 结果数组可能挂在 results / search_results / data 下，逐个兼容。 */
function resultRows(data) {
  for (const key of ["results", "search_results", "data"]) {
    const rows = getArray(data?.[key]);
    if (rows.length > 0) return rows;
  }
  return [];
}

/** authority 有的响应是标签字符串、有的是分数；只把字符串当来源，数字归 backend 名。 */
function sourceOf(item, authority) {
  const label = getString(item.media) || getString(item.source);
  if (label) return label;
  return typeof authority === "string" && authority.trim() ? authority.trim() : "deepseek";
}

export const deepseekAdapter = {
  id: "deepseek",
  capabilities: DEEPSEEK_CAPABILITIES,
  /**
   * @param {{ query: string, count?: number, freshness?: string | null, domains?: string[] }} params
   * @param {{ apiKey: string, baseUrl: string, signal?: AbortSignal, fetchImpl?: any, log?: any }} ctx
   */
  async search(params, ctx) {
    // 域名过滤拼进 query；截断时保住 site: 后缀，避免过滤静默失效。
    const suffix = (params.domains ?? []).map((domain) => `site:${domain}`).join(" ");
    const headroom = suffix ? DEEPSEEK_MAX_QUERY_CHARS - suffix.length - 1 : DEEPSEEK_MAX_QUERY_CHARS;
    const query = suffix
      ? `${params.query.slice(0, Math.max(1, headroom))} ${suffix}`.slice(0, DEEPSEEK_MAX_QUERY_CHARS)
      : params.query.slice(0, DEEPSEEK_MAX_QUERY_CHARS);
    const body = {
      query,
      count: clamp(params.count ?? 5, 1, 50),
    };

    const data = await fetchJson(ctx.baseUrl, {
      method: "POST",
      headers: contentHeaders({ Authorization: `Bearer ${ctx.apiKey}` }),
      body: JSON.stringify(body),
    }, { ...ctx, backend: "deepseek" });

    const results = resultRows(data).map((raw) => {
      const item = getObject(raw) ?? {};
      return {
        title: getString(item.title) || getString(item.name),
        url: getString(item.url) || getString(item.link),
        // snippet 优先；缺失时用 summary（契约给的 600–800 字正文摘要）。
        snippet: getString(item.snippet) || getString(item.summary) || getString(item.content),
        publishedAt: getString(item.date) || getString(item.publish_date) || null,
        source: sourceOf(item, item.authority),
      };
    }).filter((item) => item.title && item.url);
    // 契约无 request_id；meta.requestId 恒为 null，round-trip 结构保持不变。
    return { results, requestId: null };
  },
};
