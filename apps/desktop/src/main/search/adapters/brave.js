// search/adapters/brave.js — Brave Search API adapter。
// 线格式移植自 code-yeongyu/pi-websearch（MIT © 2026 Yeongyu）的 brave.ts：
//   GET {base}?q=&count=   header X-Subscription-Token
//   ←  {web:{results:[{title,url,description,age?}]}}
// 落盘条款未决前 snippet 由 normalize 层统一截断（见设计文档 §12）。

import { appendDomainFilters, clamp, fetchJson, getArray, getObject, getString } from "./shared.js";

export const BRAVE_CAPABILITIES = { count: true, freshness: false, domains: false };

export const braveAdapter = {
  id: "brave",
  capabilities: BRAVE_CAPABILITIES,
  async search(params, ctx) {
    const url = new URL(ctx.baseUrl);
    url.searchParams.set("q", appendDomainFilters(params.query, params.domains ?? []));
    url.searchParams.set("count", String(clamp(params.count ?? 5, 1, 20)));
    const data = await fetchJson(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": ctx.apiKey },
    }, { ...ctx, backend: "brave" });
    const rows = getArray(getObject(data?.web)?.results);
    const results = rows.map((raw) => {
      const item = getObject(raw) ?? {};
      return {
        title: getString(item.title),
        url: getString(item.url),
        snippet: getString(item.description),
        publishedAt: getString(item.age) || null,
        source: "brave",
      };
    }).filter((item) => item.title && item.url);
    return { results, requestId: null };
  },
};
