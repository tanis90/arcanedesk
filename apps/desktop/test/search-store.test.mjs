import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SearchStore } from "../src/main/search/store.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

const SPARK = { apiKey: "sk-spark-9999", baseUrl: "https://llm.example/v1" };

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "arcane-search-test-"));
  const store = new SearchStore(join(dir, "search.json"), () => {}, testSecretStorage());
  return { store, file: join(dir, "search.json") };
}

test("new users default to spark: zero requests until a spark credential exists", () => {
  const { store, file } = tempStore();
  assert.equal(store.data.mode, "spark");
  assert.equal(store.usable(SPARK), true); // 有 Spark 凭据即可用
  assert.equal(store.usable(null), false); // 没有凭据:工具不注册、零请求
  const pub = store.toPublic(SPARK);
  assert.equal(pub.mode, "spark");
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keySource, "arcane-spark");
  const pubNoSpark = store.toPublic(null);
  assert.equal(pubNoSpark.hasKey, false);
  // schema v2:不再持久化 consent 字段。
  store.update({ mode: "spark" }, SPARK); // 触发落盘
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.schemaVersion, 2);
  assert.equal("consent" in raw, false);
});

test("spark mode follows the Spark provider credential without storing a key", () => {
  const { store } = tempStore();
  store.update({ mode: "spark" }, SPARK);
  assert.equal(store.usable(SPARK), true);
  assert.equal(store.usable(null), false); // 没有 Spark provider 时不能凭空可用
  const pub = store.toPublic(SPARK);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keySource, "arcane-spark");
  assert.equal(pub.apiKey, "••••9999");
  const cred = store.credentialForUse(SPARK);
  assert.equal(cred.adapterId, "spark");
  assert.equal(cred.baseUrl, "https://llm.example/v1"); // 原样；/v1 归一化在 adapter 内
});

test("byok zai stores own key masked and binds credential target to the zhipu origin", () => {
  const { store } = tempStore();
  const result = store.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  assert.equal(result.ok, true);
  assert.equal(store.usable(null), true); // 自有 key，不依赖 Spark
  const pub = store.toPublic(SPARK);
  assert.equal(pub.keySource, "search");
  assert.equal(pub.apiKey, "••••1234");
  assert.equal(store.data.credentialTarget, "origin:https://open.bigmodel.cn");
  const cred = store.credentialForUse(null);
  assert.equal(cred.adapterId, "zai");
  assert.equal(cred.baseUrl, "https://open.bigmodel.cn/api/paas/v4/web_search");
});

test("mask reuse keeps the stored key; switching backend demands re-entry", () => {
  const { store } = tempStore();
  store.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  const keep = store.update({ mode: "byok", byokBackend: "zai", apiKey: "••••1234" }, SPARK);
  assert.equal(keep.ok, true);
  assert.equal(store.data.apiKey, "zai-key-1234");

  // 换 backend（target 变化）时掩码提交不允许带走旧 key。
  const switched = store.update({ mode: "byok", byokBackend: "brave", apiKey: "••••1234" }, SPARK);
  assert.equal(switched.ok, false);
  assert.equal(switched.code, "KEY_REENTRY_REQUIRED");
  // 显式输入新 key 才能完成切换。
  const reentered = store.update({ mode: "byok", byokBackend: "brave", apiKey: "brave-key-777" }, SPARK);
  assert.equal(reentered.ok, true);
  assert.equal(store.data.apiKey, "brave-key-777");
});

test("leaving own-key modes drops the key (never follows into another service)", () => {
  const { store } = tempStore();
  store.update({ mode: "custom", customBaseUrl: "https://search.example.com/v1", apiKey: "custom-key-42" }, SPARK);
  store.update({ mode: "spark" }, SPARK);
  assert.equal(store.data.apiKey, "");
  assert.equal(store.usable(SPARK), true);
});

test("custom endpoint requires a valid https url", () => {
  const { store } = tempStore();
  const bad = store.update({ mode: "custom", customBaseUrl: "http://insecure.example/v1", apiKey: "k" }, SPARK);
  assert.equal(bad.ok, false);
  const good = store.update({ mode: "custom", customBaseUrl: "https://search.example.com/v1", apiKey: "custom-key-42" }, SPARK);
  assert.equal(good.ok, true);
  const cred = store.credentialForUse(null);
  assert.equal(cred.adapterId, "custom");
  assert.equal(cred.baseUrl, "https://search.example.com/v1");
});

test("byok/custom stay opt-in: mode must be chosen explicitly and a key saved before usable", () => {
  const { store } = tempStore();
  // 默认 spark 落到自有 key 模式时,凭据为空 → 不可用,直到显式填写保存。
  store.update({ mode: "byok", byokBackend: "zai", apiKey: "" }, SPARK);
  assert.equal(store.data.mode, "byok");
  assert.equal(store.usable(null), false);
  store.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  assert.equal(store.usable(null), true);
});

test("protected key persists across reload; corrupted file falls back to the spark default", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcane-search-test-"));
  const file = join(dir, "search.json");
  const first = new SearchStore(file, () => {}, testSecretStorage());
  first.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.mode, "byok");
  assert.ok(raw.apiKeyProtected);
  assert.ok(!JSON.stringify(raw).includes("zai-key-1234"));

  const reloaded = new SearchStore(file, () => {}, testSecretStorage());
  assert.equal(reloaded.usable(null), true);
  assert.equal(reloaded.data.apiKey, "zai-key-1234");
});

test("endpoint resolution is table-driven: every backend keeps its own origin", () => {
  const { store } = tempStore();
  const cases = [
    { backend: "zai", origin: "https://open.bigmodel.cn", path: "/api/paas/v4/web_search" },
    { backend: "brave", origin: "https://api.search.brave.com", path: "/res/v1/web/search" },
    { backend: "deepseek", origin: "https://api.deepseek.com", path: "/v1/tools/search" },
  ];
  for (const { backend, origin, path } of cases) {
    store.update({ mode: "byok", byokBackend: backend, apiKey: `${backend}-key-1234` }, SPARK);
    const cred = store.credentialForUse(null);
    assert.equal(cred.adapterId, backend, `${backend} adapter`);
    const url = new URL(cred.baseUrl);
    assert.equal(url.origin, origin, `${backend} must not be sent to another vendor`);
    assert.equal(url.pathname, path);
    // 凭据按 origin 绑定：同一 backend 保存后 key 可复用。
    assert.equal(cred.apiKey, `${backend}-key-1234`);
  }
});

test("an unknown byok backend resolves to no endpoint, never to zhipu", () => {
  const { store } = tempStore();
  store.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  // 绕过 update()/load() 的枚举校验，直接模拟表里没有的 backend：
  // 解析必须返回空端点，绝不能把 key 发到智谱。
  store.data.byokBackend = "unknown-vendor";
  const cred = store.credentialForUse(null);
  assert.equal(cred.adapterId, null);
  assert.equal(cred.apiKey, "");
  assert.equal(cred.baseUrl, "");
});

test("a persisted unknown backend is coerced back to a registered one on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcane-search-test-"));
  const file = join(dir, "search.json");
  const raw = new SearchStore(file, () => {}, testSecretStorage());
  raw.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  persisted.byokBackend = "unknown-vendor";
  writeFileSync(file, JSON.stringify(persisted));

  const store = new SearchStore(file, () => {}, testSecretStorage());
  assert.equal(store.data.byokBackend, "zai");
  assert.equal(store.credentialForUse(null).baseUrl, "https://open.bigmodel.cn/api/paas/v4/web_search");
});

test("spark mode prefers the user's own DeepSeek chat key over the relay", () => {
  const { store } = tempStore();
  store.update({ mode: "spark" }, SPARK);
  const deepseek = { deepseek: { apiKey: "sk-deepseek-chat", baseUrl: "https://api.deepseek.com/v1" } };

  const cred = store.credentialForUse(SPARK, deepseek);
  assert.equal(cred.adapterId, "deepseek");
  assert.equal(cred.apiKey, "sk-deepseek-chat");
  assert.equal(cred.baseUrl, "https://api.deepseek.com/v1/tools/search");
  assert.equal(cred.keySource, "deepseek-chat");

  const pub = store.toPublic(SPARK, deepseek);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keySource, "deepseek-chat");
  assert.equal(pub.deepseekHasKey, true);
  assert.equal(pub.effectiveBackend, "deepseek");
  assert.equal(pub.apiKey, "••••chat");
});

test("spark mode falls back to the relay when no DeepSeek key is configured", () => {
  const { store } = tempStore();
  store.update({ mode: "spark" }, SPARK);
  const cred = store.credentialForUse(SPARK, { deepseek: null });
  assert.equal(cred.adapterId, "spark");
  assert.equal(cred.apiKey, "sk-spark-9999");
  assert.equal(cred.keySource, "arcane-spark");
  // 只有 DeepSeek key、没有 Spark 也能用（优先级 1 独立成立）。
  const noSpark = store.credentialForUse(null, { deepseek: { apiKey: "sk-deepseek-chat" } });
  assert.equal(noSpark.adapterId, "deepseek");
  assert.equal(store.usable(null, { deepseek: { apiKey: "sk-deepseek-chat" } }), true);
});

test("explicit off/byok/custom modes ignore the DeepSeek chat key", () => {
  const deepseek = { deepseek: { apiKey: "sk-deepseek-chat" } };
  const { store } = tempStore();

  store.update({ mode: "off" }, SPARK);
  assert.equal(store.usable(SPARK, deepseek), false);
  assert.equal(store.credentialForUse(SPARK, deepseek).adapterId, null);

  store.update({ mode: "byok", byokBackend: "brave", apiKey: "brave-key-777" }, SPARK);
  const byok = store.credentialForUse(SPARK, deepseek);
  assert.equal(byok.adapterId, "brave");
  assert.equal(byok.apiKey, "brave-key-777");

  store.update({ mode: "custom", customBaseUrl: "https://search.example.com/v1", apiKey: "custom-key-42" }, SPARK);
  const custom = store.credentialForUse(SPARK, deepseek);
  assert.equal(custom.adapterId, "custom");
  assert.equal(custom.apiKey, "custom-key-42");
});

test("explicit deepseek BYOK binds to the deepseek origin and persists its own key", () => {
  const { store } = tempStore();
  const result = store.update({ mode: "byok", byokBackend: "deepseek", apiKey: "sk-deepseek-search" }, null);
  assert.equal(result.ok, true);
  assert.equal(store.data.credentialTarget, "origin:https://api.deepseek.com");
  const cred = store.credentialForUse(null);
  assert.equal(cred.adapterId, "deepseek");
  assert.equal(cred.baseUrl, "https://api.deepseek.com/v1/tools/search");
  assert.equal(cred.keySource, "search");
  // 显式 BYOK 下即使模型页也有 DeepSeek key，也用搜索页自己的那把。
  const withChatKey = store.credentialForUse(null, { deepseek: { apiKey: "sk-deepseek-chat" } });
  assert.equal(withChatKey.apiKey, "sk-deepseek-search");
});

test("defaults injection covers every backend endpoint (region overlay / staging)", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcane-search-test-"));
  const store = new SearchStore(join(dir, "search.json"), () => {}, testSecretStorage(), {
    zaiBaseUrl: "https://staging.example/zai",
    zaiSearchEngine: "search-staging",
    deepseekBaseUrl: "https://staging.example/v1/tools/search",
  });
  store.update({ mode: "byok", byokBackend: "deepseek", apiKey: "deepseek-key-1234" }, null);
  assert.equal(store.credentialForUse(null).baseUrl, "https://staging.example/v1/tools/search");
  store.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, null);
  assert.equal(store.credentialForUse(null).baseUrl, "https://staging.example/zai");
  assert.equal(store.credentialForUse(null).searchEngine, "search-staging");
});

test("byok/custom reject API keys with non-ASCII characters (paste/IME artifacts)", () => {
  const { store } = tempStore();
  const byok = store.update({ mode: "byok", byokBackend: "deepseek", apiKey: "sk-零eekseek-user" }, SPARK);
  assert.equal(byok.ok, false);
  assert.equal(store.data.apiKey, "", "rejected key must not persist");

  const custom = store.update({ mode: "custom", customBaseUrl: "https://search.example.com/v1", apiKey: "sk-abc def" }, SPARK);
  assert.equal(custom.ok, false);
  assert.equal(store.data.apiKey, "");

  const good = store.update({ mode: "byok", byokBackend: "deepseek", apiKey: "sk-deepseek-user" }, SPARK);
  assert.equal(good.ok, true);
  assert.equal(store.data.apiKey, "sk-deepseek-user");
});

test("byok deepseek falls back to the chat DeepSeek key when no search key is stored", () => {
  const { store } = tempStore();
  store.update({ mode: "byok", byokBackend: "deepseek" }, SPARK);

  // 没有聊天 key：与之前一样不可用。
  assert.equal(store.usable(null, null), false);

  // 模型页有 DeepSeek key：缺省复用，不再要求搜索页重配。
  const ownChatKeys = { deepseek: { apiKey: "sk-deepseek-user" } };
  const cred = store.credentialForUse(null, ownChatKeys);
  assert.equal(cred.adapterId, "deepseek");
  assert.equal(cred.apiKey, "sk-deepseek-user");
  assert.equal(cred.keySource, "deepseek-chat");
  assert.equal(cred.baseUrl, "https://api.deepseek.com/v1/tools/search");
  assert.equal(store.usable(null, ownChatKeys), true);

  // 搜索页显式存 key 后：显式 key 优先（可以是与聊天不同的 tools-only key）。
  store.update({ mode: "byok", byokBackend: "deepseek", apiKey: "sk-search-only" }, SPARK);
  const explicit = store.credentialForUse(null, ownChatKeys);
  assert.equal(explicit.apiKey, "sk-search-only");
  assert.equal(explicit.keySource, "search");
});
