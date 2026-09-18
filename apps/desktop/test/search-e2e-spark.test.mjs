// search-e2e-spark.test.mjs — Spark 链路端到端(本地真 HTTP + 真 fetch):
// 桌面 spark adapter ⇄ Arcane /v1/search 契约,fixture 与 arcane-spark-edge
// transformSearchResponse 的输出逐字段一致(ops services/arcane-spark-edge)。
// 验证:URL 归一化(/v1 追加)、Bearer 头、请求体形状、响应解析、budget/去重缓存
// 全链路。不碰网络(spark cred 指向 127.0.0.1,store 不校验 spark 端点)。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeSearch } from "../src/main/search/index.js";
import { SearchBudget } from "../src/main/search/budget.js";
import { SearchStore } from "../src/main/search/store.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

/** ops worker 的契约输出(transformSearchResponse)样本。 */
const WORKER_RESPONSE = {
  search_results: [
    { title: "dnd5e system 5.3.4 release", url: "https://foundryvtt.com/a", content: "Release notes for dnd5e 5.3.4.", publish_date: "2026-08-30" },
    { title: "Foundry VTT v13 migration", url: "https://foundryvtt.com/b", content: "Migration guide.", publish_date: "" },
  ],
  requestId: "srch_ab12cd34ef56_abc123",
  truncated: false,
};

test("desktop spark adapter speaks the arcane-spark-edge /v1/search contract end to end", async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`${JSON.stringify(WORKER_RESPONSE)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const dir = mkdtempSync(join(tmpdir(), "arcane-e2e-spark-"));
    const store = new SearchStore(join(dir, "search.json"), () => {}, testSecretStorage());
    const spark = { apiKey: "sk-spark-e2e", baseUrl: `http://127.0.0.1:${port}/v1` };
    store.update({ mode: "spark" }, spark);

    const budget = new SearchBudget();
    budget.reset("run");
    const first = await executeSearch(
      { query: "foundry v13 dnd5e", count: 5, freshness: "month", domains: ["foundryvtt.com"] },
      { store, spark, budget, runKey: "run" },
    );
    // 真 fetch 走了网络栈:请求形状与 ops worker 期望一致。
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/v1/search");
    assert.equal(received[0].auth, "Bearer sk-spark-e2e");
    const requestBody = JSON.parse(received[0].body);
    assert.equal(requestBody.query, "foundry v13 dnd5e");
    assert.equal(requestBody.count, 5);
    assert.equal(requestBody.freshness, "month");
    assert.deepEqual(requestBody.domains, ["foundryvtt.com"]);

    // 响应解析:worker 契约字段 → 统一结果。
    const parsed = JSON.parse(first.payload);
    assert.equal(parsed.meta.backend, "spark");
    assert.equal(parsed.meta.requestId, WORKER_RESPONSE.requestId);
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].url, "https://foundryvtt.com/a");
    assert.equal(parsed.results[0].publishedAt, "2026-08-30");
    assert.equal(parsed.results[0].snippet, "Release notes for dnd5e 5.3.4.");
    assert.equal(first.usage.used, 1);

    // 同 run 重复 query:命中缓存,不再发请求(计数不变)。
    const second = await executeSearch(
      { query: "foundry v13 dnd5e" },
      { store, spark, budget, runKey: "run" },
    );
    assert.equal(second.usage.cached, true);
    assert.equal(received.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
