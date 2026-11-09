// search-fetch.test.mjs — web_fetch 的 URL 校验、结果截断与两个上游 adapter 契约。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeFetch } from "../src/main/search/index.js";
import { SearchError } from "../src/main/search/errors.js";
import { SearchStore } from "../src/main/search/store.js";
import { sanitizeFetchUrl, MAX_FETCH_URL_CHARS } from "../src/main/search/fetch-url.js";
import {
  MAX_FETCH_PAYLOAD_BYTES,
  toFetchPayload,
  truncateUtf8,
} from "../src/main/search/fetch-normalize.js";
import { deepseekHttpErrorCode } from "../src/main/search/adapters/deepseek.js";
import { relayFetchHttpErrorCode, relayErrorCodeFromBody } from "../src/main/search/adapters/spark.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

const SPARK = { apiKey: "sk-spark-9999", baseUrl: "https://llm.example/v1" };
const DEEPSEEK_KEY = { deepseek: { apiKey: "sk-deepseek-user", baseUrl: "https://api.deepseek.com/v1" } };

function stubFetch(cases) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const match = cases.shift();
    if (!match) throw new Error("unexpected fetch call");
    if (match instanceof Error) throw match;
    return new Response(match.body ?? "", {
      status: match.status ?? 200,
      headers: { "Content-Type": "application/json", ...(match.headers ?? {}) },
    });
  };
  return { impl, calls };
}

function makeStore(config = { mode: "spark" }) {
  const dir = mkdtempSync(join(tmpdir(), "arcane-search-fetch-"));
  const store = new SearchStore(join(dir, "search.json"), () => {}, testSecretStorage());
  store.update(config, SPARK);
  return store;
}

test("sanitizeFetchUrl accepts http(s) and rejects local schemes, userinfo and junk", () => {
  assert.deepEqual(sanitizeFetchUrl(" https://foundryvtt.com/releases/ "), {
    ok: true,
    url: "https://foundryvtt.com/releases/",
  });
  assert.equal(sanitizeFetchUrl("http://example.com/a").ok, true);

  for (const bad of [
    "file:///etc/passwd",
    "file://C:/Windows/win.ini",
    "data:text/html,<script>alert(1)</script>",
    "javascript:alert(1)",
    "ftp://example.com/x",
    "app://foundry/index.html",
    "not a url",
    "https://",
  ]) {
    assert.equal(sanitizeFetchUrl(bad).ok, false, `${bad} must be rejected`);
  }
  assert.equal(sanitizeFetchUrl("https://user:pass@example.com/").ok, false); // 禁 userinfo
  assert.equal(sanitizeFetchUrl("").ok, false);
  assert.equal(sanitizeFetchUrl(null).ok, false);
  assert.equal(sanitizeFetchUrl(42).ok, false);
  assert.equal(sanitizeFetchUrl(`https://example.com/${"a".repeat(MAX_FETCH_URL_CHARS)}`).ok, false);
});

test("truncateUtf8 never splits a multi-byte character", () => {
  const text = "汉".repeat(10); // 每字符 3 字节
  const cut = truncateUtf8(text, 10); // 10 字节 = 3 个完整字符 + 1 字节残片
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "汉汉汉");
  assert.equal(Buffer.byteLength(cut.text, "utf8"), 9);
  assert.equal(cut.text.includes("\ufffd"), false);

  assert.deepEqual(truncateUtf8("abc", 10), { text: "abc", truncated: false });
});

test("toFetchPayload keeps payload under 64KB and marks truncation", () => {
  const short = toFetchPayload({ title: "T", url: "https://x.example/1", content: "hello", backend: "deepseek" });
  const parsedShort = JSON.parse(short);
  assert.equal(parsedShort.content, "hello");
  assert.equal(parsedShort.meta.truncated, false);

  // 200KB 中文正文：远超 64KB，必须截断且仍是合法 JSON。
  const huge = "正".repeat(70_000);
  const payload = toFetchPayload({ title: "Big", url: "https://x.example/big", content: huge, backend: "spark" });
  assert.ok(Buffer.byteLength(payload, "utf8") <= MAX_FETCH_PAYLOAD_BYTES);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.meta.truncated, true);
  assert.ok(parsed.content.length > 0);
  assert.equal(parsed.content.includes("\ufffd"), false);
  assert.equal(parsed.title, "Big"); // 头部信息不被截掉
  assert.equal(parsed.url, "https://x.example/big");
});

test("toFetchPayload honors an upstream truncated flag even when content fits", () => {
  const payload = toFetchPayload({
    title: "T", url: "https://x.example/1", content: "short", backend: "spark", truncated: true,
  });
  assert.equal(JSON.parse(payload).meta.truncated, true);
});

test("deepseek fetch posts {url} and returns markdown content", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({ title: "dnd5e 5.3.4 release notes", content: "# Release\n\n- fixed A\n- fixed B" }),
  }]);
  const store = makeStore({ mode: "spark" });

  const { payload, usage } = await executeFetch(
    { url: "https://foundryvtt.com/releases/5.3.4" },
    { store, spark: null, ownChatKeys: DEEPSEEK_KEY, fetchImpl: fetch.impl, log: () => {} },
  );

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://api.deepseek.com/v1/tools/fetch");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer sk-deepseek-user");
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { url: "https://foundryvtt.com/releases/5.3.4" });

  assert.equal(usage.backend, "deepseek");
  const parsed = JSON.parse(payload);
  assert.equal(parsed.title, "dnd5e 5.3.4 release notes");
  assert.match(parsed.content, /# Release/);
  assert.equal(parsed.url, "https://foundryvtt.com/releases/5.3.4"); // 契约不回 url，用入参
  assert.equal(parsed.meta.backend, "deepseek");
  assert.equal(parsed.meta.truncated, false);
});

test("deepseek fetch maps its error surface (403/404/413/429/5xx)", () => {
  assert.equal(deepseekHttpErrorCode({ status: 401 }), "authFailed");
  assert.equal(deepseekHttpErrorCode({ status: 402 }), "quotaExceeded");
  assert.equal(deepseekHttpErrorCode({ status: 403 }), "fetchBlocked");
  assert.equal(deepseekHttpErrorCode({ status: 404 }), "fetchUnavailable");
  assert.equal(deepseekHttpErrorCode({ status: 408 }), "timeout");
  assert.equal(deepseekHttpErrorCode({ status: 413 }), "pageTooLarge");
  assert.equal(deepseekHttpErrorCode({ status: 429 }), "rateLimited");
  assert.equal(deepseekHttpErrorCode({ status: 500 }), "backendUnavailable");
  assert.equal(deepseekHttpErrorCode({ status: 503 }), "backendUnavailable");
});

test("deepseek fetch surfaces 413 as pageTooLarge and 404 as fetchUnavailable", async () => {
  const store = makeStore({ mode: "spark" });

  const tooLarge = stubFetch([{ status: 413, body: JSON.stringify({ error: { message: "too large" } }) }]);
  const large = await executeFetch(
    { url: "https://x.example/huge" },
    { store, spark: null, ownChatKeys: DEEPSEEK_KEY, fetchImpl: tooLarge.impl, log: () => {} },
  ).catch((error) => error);
  assert.ok(large instanceof SearchError && large.code === "pageTooLarge");
  assert.equal(large.toIpc().key, "err.fetch.pageTooLarge");

  const missing = stubFetch([{ status: 404, body: JSON.stringify({ error: { message: "not found" } }) }]);
  const gone = await executeFetch(
    { url: "https://x.example/missing" },
    { store, spark: null, ownChatKeys: DEEPSEEK_KEY, fetchImpl: missing.impl, log: () => {} },
  ).catch((error) => error);
  assert.ok(gone instanceof SearchError && gone.code === "fetchUnavailable");
});

test("deepseek fetch treats a 200 with empty content as fetchUnavailable", async () => {
  const fetch = stubFetch([{ body: JSON.stringify({ title: "nothing" }) }]);
  const store = makeStore({ mode: "spark" });
  const error = await executeFetch(
    { url: "https://x.example/empty" },
    { store, spark: null, ownChatKeys: DEEPSEEK_KEY, fetchImpl: fetch.impl, log: () => {} },
  ).catch((caught) => caught);
  assert.ok(error instanceof SearchError && error.code === "fetchUnavailable");
});

test("relay fetch posts to {base}/v1/fetch and passes through truncated", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({ title: "Relay page", content: "markdown body", requestId: "fch_1", truncated: true }),
  }]);
  const store = makeStore({ mode: "spark" });

  const { payload, usage } = await executeFetch(
    { url: "https://example.com/doc" },
    { store, spark: SPARK, ownChatKeys: { deepseek: null }, fetchImpl: fetch.impl, log: () => {} },
  );
  assert.equal(fetch.calls[0].url, "https://llm.example/v1/fetch");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer sk-spark-9999");
  assert.equal(usage.backend, "spark");
  const parsed = JSON.parse(payload);
  assert.equal(parsed.content, "markdown body");
  assert.equal(parsed.meta.requestId, "fch_1");
  assert.equal(parsed.meta.truncated, true);
});

test("relay 404 (not deployed) becomes a recoverable fetchUnavailable, not a crash", async () => {
  // relay 尚未部署时线上就是 404 + 非 JSON 体（空体/HTML 错误页都见过）。
  for (const body of ["Not Found", "", "<html>404</html>"]) {
    const fetch = stubFetch([{ status: 404, body }]);
    const store = makeStore({ mode: "spark" });
    const error = await executeFetch(
      { url: "https://example.com/doc" },
      { store, spark: SPARK, ownChatKeys: { deepseek: null }, fetchImpl: fetch.impl, log: () => {} },
    ).catch((caught) => caught);
    assert.ok(error instanceof SearchError && error.code === "fetchUnavailable", `body=${JSON.stringify(body)}`);
    assert.equal(error.toIpc().key, "err.fetch.unavailable");
  }
});

test("relay error bodies win over generic status mapping", () => {
  assert.equal(relayErrorCodeFromBody(JSON.stringify({ error: { code: "page_too_large" } })), "pageTooLarge");
  assert.equal(relayErrorCodeFromBody(JSON.stringify({ error: { code: "fetch_blocked" } })), "fetchBlocked");
  assert.equal(relayErrorCodeFromBody(JSON.stringify({ error: { code: "upstream_rate_limited" } })), "rateLimited");
  assert.equal(relayErrorCodeFromBody("not json"), null);
  assert.equal(relayErrorCodeFromBody(""), null);

  // 413 无错误体 → pageTooLarge；relay 的 429→503 由业务码兜住。
  assert.equal(relayFetchHttpErrorCode({ status: 413, body: "" }), "pageTooLarge");
  assert.equal(relayFetchHttpErrorCode({ status: 503, body: JSON.stringify({ error: { code: "upstream_rate_limited" } }) }), "rateLimited");
  assert.equal(relayFetchHttpErrorCode({ status: 504, body: "" }), "timeout");
});

test("relay rate limiting carries Retry-After through to the error meta", async () => {
  const fetch = stubFetch([{
    status: 503,
    headers: { "Retry-After": "5" },
    body: JSON.stringify({ error: { code: "upstream_rate_limited" } }),
  }]);
  const store = makeStore({ mode: "spark" });
  const error = await executeFetch(
    { url: "https://example.com/doc" },
    { store, spark: SPARK, ownChatKeys: { deepseek: null }, fetchImpl: fetch.impl, log: () => {} },
  ).catch((caught) => caught);
  assert.ok(error instanceof SearchError && error.code === "rateLimited");
  assert.equal(error.meta.retryAfter, 5);
  assert.deepEqual(error.toIpc().params, { backend: "spark", seconds: "5" });
});

test("fetch rejects bad urls before spending a request or a credential", async () => {
  const fetch = stubFetch([]); // 任何调用都会抛 "unexpected fetch call"
  const store = makeStore({ mode: "spark" });
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/x"]) {
    const error = await executeFetch(
      { url },
      { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, fetchImpl: fetch.impl, log: () => {} },
    ).catch((caught) => caught);
    assert.ok(error instanceof SearchError && error.code === "badRequest", `${url} -> ${error?.code}`);
  }
  assert.equal(fetch.calls.length, 0);
});

test("fetch needs a configured credential, mirroring search", async () => {
  const store = makeStore({ mode: "spark" });
  const error = await executeFetch(
    { url: "https://example.com/a" },
    { store, spark: null, ownChatKeys: { deepseek: null }, fetchImpl: async () => { throw new Error("no call expected"); }, log: () => {} },
  ).catch((caught) => caught);
  assert.ok(error instanceof SearchError && error.code === "notConfigured");
});

test("off mode refuses fetch even with a DeepSeek key", async () => {
  const store = makeStore({ mode: "off" });
  const error = await executeFetch(
    { url: "https://example.com/a" },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, fetchImpl: async () => { throw new Error("no call expected"); }, log: () => {} },
  ).catch((caught) => caught);
  assert.ok(error instanceof SearchError && error.code === "notConfigured");
});
