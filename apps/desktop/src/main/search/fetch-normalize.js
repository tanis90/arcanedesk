// search/fetch-normalize.js — web_fetch 的连接器与结果截断。
// 与 search 的 normalize.js 分开：搜索按条截断、上限 16KB（防上下文爆炸）；
// 抓取是单篇正文、上限 64KB（Q7 拍板）——正文的用途不同，预算也不同。
// 截断一律按 UTF-8 字节（不切碎多字节字符），并把 meta.truncated 如实透出。

export const MAX_FETCH_PAYLOAD_BYTES = 64 * 1024;
export const MAX_FETCH_TITLE_CHARS = 300;

/** 按 UTF-8 字节截断，尽量不切断多字节字符。 */
export function truncateUtf8(text, maxBytes) {
  const clean = String(text ?? "");
  if (Buffer.byteLength(clean, "utf8") <= maxBytes) return { text: clean, truncated: false };
  const buf = Buffer.from(clean, "utf8").subarray(0, maxBytes);
  // 退到最后一个完整 UTF-8 序列（0b10xxxxxx 是续字节）。
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
  // 若最后留下的首字节仍是多字节起点但序列被截断，再退一个字符。
  if (end > 0) {
    const lead = buf[end - 1];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - 1 + need > buf.length) end -= 1;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** 标题单行化并限长；缺失时回落到 URL。 */
export function normalizeFetchTitle(title, url) {
  const clean = String(title ?? "").replace(/\s+/g, " ").trim();
  const fallback = String(url ?? "").trim();
  const base = clean || fallback;
  if (base.length <= MAX_FETCH_TITLE_CHARS) return base;
  return `${base.slice(0, MAX_FETCH_TITLE_CHARS - 1)}…`;
}

/**
 * 组装 web_fetch 的 toolResult payload（JSON 字符串）。
 * 超 64KB 时按字节截正文并打 meta.truncated=true——单篇文章不丢头部信息，
 * 只截正文尾部，模型仍能拿到 title/url 与开头。
 */
export function toFetchPayload({ title, url, content, backend, requestId = null, truncated = false, warnings = [] }) {
  const limit = MAX_FETCH_PAYLOAD_BYTES;
  const meta = () => ({
    backend,
    requestId,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  const build = (body, isTruncated) => JSON.stringify({
    title: normalizeFetchTitle(title, url),
    url,
    content: body,
    meta: { ...meta(), truncated: isTruncated },
  });

  // 先按「正文 = 上限减去元数据开销」估一个安全字节数，再用实际序列化结果收敛。
  let body = String(content ?? "");
  let isTruncated = Boolean(truncated);
  let payload = build(body, isTruncated);
  if (Buffer.byteLength(payload, "utf8") > limit) {
    const overhead = Buffer.byteLength(build("", isTruncated), "utf8");
    const budget = Math.max(0, limit - overhead);
    const cut = truncateUtf8(body, budget);
    body = cut.text;
    isTruncated = isTruncated || cut.truncated;
    payload = build(body, isTruncated);
    // 估算与 JSON 转义（引号/换行）可能仍有偏差，逐步收敛到硬上限内。
    while (Buffer.byteLength(payload, "utf8") > limit && body.length > 0) {
      body = truncateUtf8(body, Math.max(0, Buffer.byteLength(body, "utf8") - 1024)).text;
      isTruncated = true;
      payload = build(body, isTruncated);
    }
  }
  return payload;
}
