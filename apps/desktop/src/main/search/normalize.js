// search/normalize.js — 统一结果形状与截断（PRD §4）。
// 上游字段在这里收敛为 {title,url,snippet,publishedAt,source}；
// snippet 500 字符、整个 toolResult payload 8KB 上限（会话 JSONL 持久化成本）。

export const MAX_SNIPPET_CHARS = 500;
export const MAX_PAYLOAD_BYTES = 8 * 1024;

/** 单条结果清洗；title+url 缺失即丢弃该条。 */
export function toUnifiedResult(raw) {
  const title = typeof raw?.title === "string" ? raw.title.trim() : "";
  const url = typeof raw?.url === "string" ? raw.url.trim() : "";
  if (!title || !url) return null;
  return {
    title,
    url,
    snippet: truncateSnippet(typeof raw?.snippet === "string" ? raw.snippet : ""),
    publishedAt: typeof raw?.publishedAt === "string" && raw.publishedAt ? raw.publishedAt : null,
    source: typeof raw?.source === "string" && raw.source ? raw.source : null,
  };
}

export function truncateSnippet(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_SNIPPET_CHARS) return clean;
  return `${clean.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

/**
 * 组装 toolResult payload（JSON 字符串）。超 8KB 时逐条从尾部丢结果并打
 * meta.truncated=true，保证 payload 恒在上限内。
 */
export function toToolPayload(results, meta = {}) {
  const kept = results.filter(Boolean);
  let current = kept;
  let truncated = false;
  let payload = JSON.stringify({ results: current, meta: { ...meta, truncated } });
  while (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES && current.length > 0) {
    current = current.slice(0, current.length - 1);
    truncated = true;
    payload = JSON.stringify({ results: current, meta: { ...meta, truncated } });
  }
  return payload;
}
