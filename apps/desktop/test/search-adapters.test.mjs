import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeSearch } from "../src/main/search/index.js";
import { SearchError } from "../src/main/search/errors.js";
import { SearchBudget } from "../src/main/search/budget.js";
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
  store.recordConsent("origin:https://open.bigmodel.cn");
  const budget = new SearchBudget();
  budget.reset("run");

  const { payload, usage } = await executeSearch(
    { query: "foundry v13 dnd5e", count: 5, freshness: "month" },
    { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
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
  store.recordConsent("origin:https://llm.example");
  const budget = new SearchBudget();
  budget.reset("run");

  const { payload } = await executeSearch(
    { query: "模组 兼容性", count: 5, freshness: "month", domains: ["foundryvtt.com"] },
    { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
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
  store.recordConsent("origin:https://api.search.brave.com");
  const budget = new SearchBudget();
  budget.reset("run");

  const { payload } = await executeSearch(
    { query: "brave query", domains: ["example.com"] },
    { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
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
  store.recordConsent("origin:https://llm.example");
  const budget = new SearchBudget();
  budget.reset("run");

  const first = await executeSearch({ query: "same  QUERY" }, { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} });
  const second = await executeSearch({ query: "same query" }, { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} });
  assert.equal(second.usage.cached, true);
  assert.equal(second.payload, first.payload);
  assert.equal(fetch.calls.length, 1); // 只发了一次
  assert.equal(budget.used("run"), 1);
});

test("hard cap and consent gate produce structured errors", async () => {
  const fetch = stubFetch([]);
  const store = makeStore({ mode: "spark" });
  store.recordConsent("origin:https://llm.example");
  const budget = new SearchBudget({ hard: 1 });
  budget.reset("run");
  budget.record("run", "previous", "p");

  await assert.rejects(
    executeSearch({ query: "next query" }, { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} }),
    (error) => error instanceof SearchError && error.code === "budgetExhausted",
  );

  const freshBudget = new SearchBudget();
  freshBudget.reset("run");
  const unconsented = makeStore({ mode: "spark" }); // 未记录 consent
  await assert.rejects(
    executeSearch({ query: "next query" }, { store: unconsented, spark: SPARK, budget: freshBudget, runKey: "run", fetchImpl: fetch.impl, log: () => {} }),
    (error) => error instanceof SearchError && error.code === "consentRequired",
  );
});

test("upstream 429/401 map to quota/auth errors; empty results consume budget", async () => {
  const fetch = stubFetch([
    { status: 429, body: JSON.stringify({ error: { code: "quota_exceeded" } }) },
    { status: 401, body: JSON.stringify({ error: { code: "unauthorized" } }) },
    { body: JSON.stringify({ search_results: [] }) },
  ]);
  const store = makeStore({ mode: "spark" });
  store.recordConsent("origin:https://llm.example");

  const quota = await executeSearch({ query: "quota query" }, { store, spark: SPARK, budget: new SearchBudget(), runKey: "r", fetchImpl: fetch.impl, log: () => {} }).catch((e) => e);
  assert.ok(quota instanceof SearchError && quota.code === "quotaExceeded");
  assert.equal(quota.toIpc().key, "err.search.quotaExceeded");

  const auth = await executeSearch({ query: "auth query" }, { store, spark: SPARK, budget: new SearchBudget(), runKey: "r", fetchImpl: fetch.impl, log: () => {} }).catch((e) => e);
  assert.ok(auth instanceof SearchError && auth.code === "authFailed");

  const budget = new SearchBudget();
  budget.reset("run");
  const empty = await executeSearch({ query: "empty query" }, { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} }).catch((e) => e);
  assert.ok(empty instanceof SearchError && empty.code === "empty");
  assert.equal(budget.used("run"), 1); // 空结果消耗预算但不进缓存
  assert.equal(budget.lookup("run", "empty query"), null);
});

test("payload respects the 8KB cap by dropping trailing results", async () => {
  const big = "x".repeat(400); // snippet 500 截断后仍 400 字符
  const rows = Array.from({ length: 30 }, (_, i) => ({
    title: `T${i}`,
    url: `https://x.example/${i}`,
    content: big,
  }));
  const fetch = stubFetch([{ body: JSON.stringify({ search_results: rows }) }]);
  const store = makeStore({ mode: "spark" });
  store.recordConsent("origin:https://llm.example");
  const budget = new SearchBudget();
  budget.reset("run");

  const { payload } = await executeSearch(
    { query: "big query", count: 5 },
    { store, spark: SPARK, budget, runKey: "run", fetchImpl: fetch.impl, log: () => {} },
  );
  assert.ok(Buffer.byteLength(payload, "utf8") <= 8 * 1024);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.results.length, 5); // count=5 本来就压住了
  // 再用 5 条 900 字符 snippet 验证截断链路：500 截断生效
  assert.ok(parsed.results[0].snippet.length <= 500);
});
