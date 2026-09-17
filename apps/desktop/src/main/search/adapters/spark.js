// search/adapters/spark.js — Arcane Spark /v1/search 与自定义兼容端点共用契约。
// 响应字段对齐智谱独立搜索（PRD §2：Spark adapter 与 z-ai BYOK 共享解析结构）：
//   POST {base}/v1/search   Bearer <key>
//   {"query","count","freshness","domains"}
//   ←  {"search_results":[{title,url,content,publish_date}],"requestId","truncated"}
// 服务端语义：429 quota_exceeded（预算熔断）、503 backend_unavailable、超时 ≤15s。

import { clamp, contentHeaders, fetchJson, getArray, getObject, getString } from "./shared.js";

export const SPARK_CAPABILITIES = { count: true, freshness: true, domains: true };

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
          count: clamp(params.count ?? 5, 1, 5),
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
  };
}

export const sparkAdapter = createArcaneSearchAdapter("spark");
export const customAdapter = createArcaneSearchAdapter("custom");
