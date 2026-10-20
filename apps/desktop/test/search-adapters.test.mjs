import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeSearch } from "../src/main/search/index.js";
import { SearchError } from "../src/main/search/errors.js";
import { SearchRunCache } from "../src/main/search/cache.js";
import { SearchStore } from "../src/main/search/store.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

const SPARK = { apiKey: "sk-spark-9999", baseUrl: "https://llm.example/v1" };

/** 记录请求并按用例返回预设响应的 fetch 桩。 */
function stubFetch(cases) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const match = cases.shift();
    if (!match) throw new Error("unexpected fetch call");
    if (match instanceof Error) throw match;
    return new Response(match.body, { status: match.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { impl, calls };
}

function makeStore(sparkConfig) {
  const dir = mkdtempSync(join(tmpdir(), "arcane-search-adapters-"));
  const store = new SearchStore(join(dir, "search.json"), () => {}, testSecretStorage());
  if (sparkConfig) store.update(sparkConfig, SPARK);
  return store;
}

test("zai adapter speaks the zhipu web_search wire format", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({
      search_result: [
        { title: "dnd5e 5.3.4", link: "https://foundryvtt.com/a", content: " release notes ", publish_date: "2026-08-30", media: "官网" },
        { title: "", link: "https://dropped.example" }, // 缺 title 丢弃
      ],
      request_id: "req-1",
    }),
  }]);
  const store = makeStore({ mode: "byok", byokBackend: "zai", apiKey: "zai-key" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload, usage } = await executeSearch(
    { query: "foundry v13 dnd5e", count: 5, freshness: "month" },
    { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.equal(usage.backend, "zai");
  assert.equal(usage.cached, false);
  const request = JSON.parse(fetch.calls[0].init.body);
  assert.equal(request.search_engine, "search_pro"); // cn 默认引擎
  assert.equal(request.search_intent, false);
  assert.equal(request.search_query, "foundry v13 dnd5e");
  assert.equal(request.search_recency_filter, "oneMonth"); // freshness 全链路支持
  assert.equal(fetch.calls[0].url, "https://open.bigmodel.cn/api/paas/v4/web_search");

  const parsed = JSON.parse(payload);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].url, "https://foundryvtt.com/a");
  assert.equal(parsed.results[0].snippet, "release notes");
  assert.equal(parsed.results[0].publishedAt, "2026-08-30");
  // zai 契约全支持（count/freshness/domains）→ 无 warning。
  assert.equal(parsed.meta.warnings.length, 0);
});

test("spark adapter posts the arcane /v1/search contract", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({
      search_results: [{ title: "T", url: "https://x.example/1", content: "C", publish_date: "2026-09-01" }],
      requestId: "req-s",
    }),
  }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload } = await executeSearch(
    { query: "模组 兼容性", count: 5, freshness: "month", domains: ["foundryvtt.com"] },
    { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.equal(fetch.calls[0].url, "https://llm.example/v1/search");
  const request = JSON.parse(fetch.calls[0].init.body);
  assert.equal(request.query, "模组 兼容性");
  assert.equal(request.count, 5);
  assert.equal(request.freshness, "month");
  assert.deepEqual(request.domains, ["foundryvtt.com"]);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.meta.backend, "spark");
  assert.equal(parsed.meta.warnings.length, 0); // spark 契约全支持
});

test("brave adapter maps web.results and warns on domains", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example/1", description: "D" }] } }),
  }]);
  const store = makeStore({ mode: "byok", byokBackend: "brave", apiKey: "brave-key" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload } = await executeSearch(
    { query: "brave query", domains: ["example.com"] },
    { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  const url = new URL(fetch.calls[0].url);
  assert.equal(url.hostname, "api.search.brave.com");
  assert.equal(url.searchParams.get("q"), "brave query site:example.com");
  const parsed = JSON.parse(payload);
  assert.equal(parsed.meta.warnings.length, 1);
  assert.match(parsed.meta.warnings[0], /domains/);
});

test("dedupe cache short-circuits identical queries in the same run", async () => {
  const fetch = stubFetch([
    { body: JSON.stringify({ search_results: [{ title: "T", url: "https://x.example/1", content: "C" }] }) },
  ]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const first = await executeSearch({ query: "same  QUERY" }, { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} });
  const second = await executeSearch({ query: "same query" }, { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} });
  assert.equal(second.usage.cached, true);
  assert.equal(second.payload, first.payload);
  assert.equal(fetch.calls.length, 1); // 只发了一次
  assert.equal(cache.used("run"), 1);
});

test("no client-side cap: many distinct queries all go out", async () => {
  const fetch = stubFetch(Array.from({ length: 12 }, () => ({
    body: JSON.stringify({ search_results: [{ title: "T", url: "https://x.example/1", content: "C" }] }),
  })));
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  for (let i = 0; i < 12; i += 1) {
    const { usage } = await executeSearch({ query: `query ${i}` }, { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} });
    assert.equal(usage.used, i + 1);
  }
  assert.equal(fetch.calls.length, 12);
  assert.equal(cache.used("run"), 12);
});

test("upstream 429/401 map to quota/auth errors; empty results are not cached", async () => {
  const fetch = stubFetch([
    { status: 429, body: JSON.stringify({ error: { code: "quota_exceeded" } }) },
    { status: 401, body: JSON.stringify({ error: { code: "unauthorized" } }) },
    { body: JSON.stringify({ search_results: [] }) },
  ]);
  const store = makeStore({ mode: "spark" });

  const quota = await executeSearch({ query: "quota query" }, { store, spark: SPARK, cache: new SearchRunCache(), runKey: "r", fetchImpl: fetch.impl, log: () => {} }).catch((e) => e);
  assert.ok(quota instanceof SearchError && quota.code === "quotaExceeded");
  assert.equal(quota.toIpc().key, "err.search.quotaExceeded");

  const auth = await executeSearch({ query: "auth query" }, { store, spark: SPARK, cache: new SearchRunCache(), runKey: "r", fetchImpl: fetch.impl, log: () => {} }).catch((e) => e);
  assert.ok(auth instanceof SearchError && auth.code === "authFailed");

  const cache = new SearchRunCache();
  cache.reset("run");
  const empty = await executeSearch({ query: "empty query" }, { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} }).catch((e) => e);
  assert.ok(empty instanceof SearchError && empty.code === "empty");
  assert.equal(cache.used("run"), 0); // 空结果不计数也不进缓存
  assert.equal(cache.lookup("run", "empty query"), null);
});

test("payload keeps 5 long snippets under the 16KB cap", async () => {
  const big = "x".repeat(2000); // 截断到 1000 字符后 5 条仍在 16KB 内
  const rows = Array.from({ length: 30 }, (_, i) => ({
    title: `T${i}`,
    url: `https://x.example/${i}`,
    content: big,
  }));
  const fetch = stubFetch([{ body: JSON.stringify({ search_results: rows }) }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload } = await executeSearch(
    { query: "big query", count: 5 },
    { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.ok(Buffer.byteLength(payload, "utf8") <= 16 * 1024);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.results.length, 5); // 16KB 容得下 5 条长 snippet，不丢尾
  assert.equal(parsed.meta.truncated, false);
  assert.equal(parsed.results[0].snippet.length, 1000); // snippet 截断到 1000
});

test("payload over 16KB drops trailing results and marks meta.truncated", async () => {
  const big = "y".repeat(2000);
  const rows = Array.from({ length: 20 }, (_, i) => ({
    title: `T${i}`,
    url: `https://x.example/${i}`,
    content: big,
  }));
  const fetch = stubFetch([{ body: JSON.stringify({ search_results: rows }) }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload } = await executeSearch(
    { query: "huge query", count: 20 },
    { store, spark: SPARK, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.ok(Buffer.byteLength(payload, "utf8") <= 16 * 1024);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.meta.truncated, true);
  assert.ok(parsed.results.length > 0 && parsed.results.length < 20);
  assert.equal(parsed.results[0].title, "T0"); // 从尾部丢，头部保留
  assert.equal(parsed.results[0].snippet.length, 1000);
});

const DEEPSEEK_KEY = { deepseek: { apiKey: "sk-deepseek-user", baseUrl: "https://api.deepseek.com/v1" } };

test("deepseek adapter speaks the official /v1/tools/search contract", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({
      results: [
        {
          title: "dnd5e 5.3.4 release notes",
          url: "https://foundryvtt.com/release",
          snippet: "Release notes for dnd5e 5.3.4.",
          summary: "A long summary that should not win over snippet.",
          date: "2026-08-30",
          rerank_score: 0.93,
          authority: "official",
        },
        { title: "no url entry", snippet: "dropped" }, // 缺 url 丢弃
      ],
    }),
  }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload, usage } = await executeSearch(
    { query: "dnd5e 5.3.4 更新说明", count: 5 },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );

  // 端点与鉴权:用户自己的 key 直接发给 api.deepseek.com,不经过 Spark 中转。
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer sk-deepseek-user");
  const request = JSON.parse(fetch.calls[0].init.body);
  assert.equal(request.query, "dnd5e 5.3.4 更新说明");
  assert.equal(request.count, 5);

  assert.equal(usage.backend, "deepseek");
  const parsed = JSON.parse(payload);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].url, "https://foundryvtt.com/release");
  assert.equal(parsed.results[0].snippet, "Release notes for dnd5e 5.3.4."); // snippet 优先于 summary
  assert.equal(parsed.results[0].publishedAt, "2026-08-30");
  assert.equal(parsed.results[0].source, "official");
  assert.equal(parsed.meta.backend, "deepseek");
  assert.equal(parsed.meta.requestId, null); // 契约无 request_id
});

test("deepseek adapter falls back to summary and clamps query to 128 chars", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({
      results: [{ title: "T", url: "https://x.example/1", summary: "S".repeat(700), date: "2026-09-01" }],
    }),
  }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload } = await executeSearch(
    { query: "关".repeat(300), count: 3 },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  const request = JSON.parse(fetch.calls[0].init.body);
  assert.equal([...request.query].length, 128); // 上游硬上限
  assert.equal(request.count, 3);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.results[0].snippet.length, 700); // summary 兜底,截断交给 normalize(1000)
  assert.equal(parsed.results[0].source, "deepseek"); // 无 authority 时用 backend 名
});

test("deepseek adapter folds domains into the query and warns nothing away", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({ results: [{ title: "T", url: "https://foundryvtt.com/1", snippet: "S" }] }),
  }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");

  const { payload } = await executeSearch(
    { query: "v13 migration", domains: ["foundryvtt.com"], freshness: "month" },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  const request = JSON.parse(fetch.calls[0].init.body);
  assert.equal(request.query, "v13 migration site:foundryvtt.com");
  assert.equal("freshness" in request, false); // 契约不支持该参数
  const parsed = JSON.parse(payload);
  assert.equal(parsed.meta.warnings.length, 1); // freshness 不支持要显式告警
  assert.match(parsed.meta.warnings[0], /freshness/);
});

test("deepseek upstream errors map onto the shared error surface", async () => {
  const fetch = stubFetch([
    { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) },
    { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
  ]);
  const store = makeStore({ mode: "spark" });

  const auth = await executeSearch(
    { query: "auth query" },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, cache: new SearchRunCache(), runKey: "r", fetchImpl: fetch.impl, log: () => {} },
  ).catch((error) => error);
  assert.ok(auth instanceof SearchError && auth.code === "authFailed");
  assert.equal(auth.toIpc().key, "err.search.authFailed");

  const quota = await executeSearch(
    { query: "quota query" },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, cache: new SearchRunCache(), runKey: "r", fetchImpl: fetch.impl, log: () => {} },
  ).catch((error) => error);
  assert.ok(quota instanceof SearchError && quota.code === "quotaExceeded");
});

test("deepseek key only takes over in spark mode; explicit modes keep their own backend", async () => {
  // 显式 byok(zai)时用户的 DeepSeek 聊天 key 不得抢走请求。
  const fetch = stubFetch([{
    body: JSON.stringify({ search_result: [{ title: "T", link: "https://x.example/1", content: "C" }] }),
  }]);
  const store = makeStore({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" });

  const cache = new SearchRunCache();
  cache.reset("run");
  const { usage } = await executeSearch(
    { query: "explicit byok" },
    { store, spark: SPARK, ownChatKeys: DEEPSEEK_KEY, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.equal(usage.backend, "zai");
  assert.match(fetch.calls[0].url, /bigmodel\.cn/);
  const request = JSON.parse(fetch.calls[0].init.body);
  assert.equal(request.search_query, "explicit byok");
});

test("without a deepseek key, spark mode keeps the existing relay path", async () => {
  const fetch = stubFetch([{
    body: JSON.stringify({ search_results: [{ title: "T", url: "https://x.example/1", content: "C" }], requestId: "req-1" }),
  }]);
  const store = makeStore({ mode: "spark" });

  const cache = new SearchRunCache();
  cache.reset("run");
  const { usage } = await executeSearch(
    { query: "relay query" },
    { store, spark: SPARK, ownChatKeys: { deepseek: null }, cache, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.equal(usage.backend, "spark");
  assert.equal(fetch.calls[0].url, "https://llm.example/v1/search");
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer sk-spark-9999");
});
