// search-deepseek-e2e.test.mjs — DeepSeek 自动接入的端到端接线：
// 真 ProviderStore(写 providers.json) + 真 SearchStore + 真 AgentHost 工具装配，
// 只把 fetch 与 Spark 凭据打桩。锁定「用户自己的 DeepSeek key 直接接管搜索」这条
// 产品主路径，以及 key 不落到别的 host、删 key 后回落 Spark。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import test from "node:test";

import { AgentHost } from "../src/main/agent-host.js";
import { SearchStore } from "../src/main/search/store.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

// providers.js 在模块加载时按 regionConfig() 固化 Spark 默认 baseUrl，
// 钉住 cn 再动态导入，避免受本机构建状态污染（同 providers.test.mjs）。
process.env.ARCANE_REGION = process.env.ARCANE_REGION ?? "cn";
const { ProviderStore } = await import("../src/main/providers.js");

const scratch = mkdtempSync(path.join(os.tmpdir(), "arcane-search-deepseek-e2e-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const DEEPSEEK_BODY = JSON.stringify({
  results: [
    { title: "dnd5e 5.3.4", url: "https://foundryvtt.com/a", snippet: "notes", date: "2026-08-30", authority: "official" },
  ],
});

function stubFetch(body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { impl, calls };
}

/**
 * 按 main.js 的真实接线方式组装：ProviderStore 提供 spark + ownChatKeys，
 * SearchStore 是搜索页配置。sparkCredential 为 null 表示未登录 Spark。
 */
function buildRig({ sparkCredential = null, deepseekKey = null } = {}) {
  const dir = mkdtempSync(path.join(scratch, "rig-"));
  const secretStorage = testSecretStorage();
  const providerStore = new ProviderStore(
    path.join(dir, "providers.json"),
    () => {},
    { ARCANE_SPARK_ENABLED: "0" },
    secretStorage,
  );
  if (deepseekKey) {
    const saved = providerStore.upsertProvider({
      id: "deepseek",
      name: "DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: deepseekKey,
      models: [{ id: "deepseek-flash" }],
    });
    assert.equal(saved.ok, true);
  }
  const searchStore = new SearchStore(path.join(dir, "search.json"), () => {}, secretStorage);
  searchStore.update({ mode: "spark" }, sparkCredential);

  const events = [];
  const http = stubFetch(DEEPSEEK_BODY);
  const host = new AgentHost({
    foundryRuntime: { call: async () => ({}) },
    operationStorageDir: mkdtempSync(path.join(dir, "session-")),
    getFoundryView: () => null,
    openFoundry: async () => ({ ok: true, summary: "open" }),
    sendToRenderer: (payload) => events.push(payload),
    log: () => {},
    profile: { mode: "prep", getCwd: () => dir },
    search: {
      store: searchStore,
      spark: () => sparkCredential,
      ownChatKeys: () => ({ deepseek: providerStore.credentialForHost("api.deepseek.com") }),
      fetchImpl: http.impl,
    },
  });
  host.describeCurrent = () => ({ id: "session-e2e" });

  const tool = host.buildTools().find((candidate) => candidate.name === "web_search");
  return { host, providerStore, searchStore, tool, events, calls: http.calls };
}

test("a DeepSeek chat key configured in the model page powers web_search end to end", async () => {
  const { tool, events, calls } = buildRig({ deepseekKey: "sk-deepseek-e2e" });
  assert.ok(tool, "web_search must be available with only a DeepSeek key");

  const result = await tool.execute("call-1", { query: "dnd5e 5.3.4 更新" }, undefined);
  assert.equal(result.isError, undefined);
  // 真实发出的请求：DeepSeek 官方端点 + 用户自己的 key。
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-deepseek-e2e");
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.meta.backend, "deepseek");
  assert.equal(parsed.results[0].source, "official");
  const usage = events.find((event) => event.type === "search_usage");
  assert.equal(usage.data.backend, "deepseek");
  assert.equal(usage.data.used, 1);
});

test("the DeepSeek key never travels to the zhipu or spark endpoints", async () => {
  const { searchStore, providerStore, tool } = buildRig({ deepseekKey: "sk-deepseek-e2e" });
  const cred = searchStore.credentialForUse(null, { deepseek: providerStore.credentialForHost("api.deepseek.com") });
  assert.equal(cred.adapterId, "deepseek");
  assert.equal(new URL(cred.baseUrl).origin, "https://api.deepseek.com");
  // 搜索页自身没有存任何 key：这把 key 只从 provider store 来。
  assert.equal(searchStore.data.apiKey, "");
  assert.equal(tool.name, "web_search");
});

test("without a DeepSeek key the same rig falls back to the Spark relay", async () => {
  const spark = { apiKey: "sk-spark-e2e", baseUrl: "https://llm.example/v1" };
  const { searchStore, tool } = buildRig({ sparkCredential: spark });
  const cred = searchStore.credentialForUse(spark, { deepseek: null });
  assert.equal(cred.adapterId, "spark");
  assert.equal(cred.keySource, "arcane-spark");
  assert.ok(tool);
});

test("neither key: web_search is not registered and nothing is sent", () => {
  const { tool } = buildRig();
  assert.equal(tool, undefined);
});
