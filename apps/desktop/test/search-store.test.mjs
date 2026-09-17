import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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

test("new users default to off: no tool registration, no requests", () => {
  const { store } = tempStore();
  assert.equal(store.data.mode, "off");
  assert.equal(store.usable(SPARK), false);
  assert.equal(store.usable(null), false);
  const pub = store.toPublic(SPARK);
  assert.equal(pub.mode, "off");
  assert.equal(pub.hasKey, false);
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

test("consent follows the actual receiver target and must be re-confirmed on change", () => {
  const { store } = tempStore();
  store.update({ mode: "byok", byokBackend: "zai", apiKey: "zai-key-1234" }, SPARK);
  assert.equal(store.consentSatisfied(null), false);
  assert.equal(store.consentTarget(null), "origin:https://open.bigmodel.cn");
  store.recordConsent("origin:https://open.bigmodel.cn");
  assert.equal(store.consentSatisfied(null), true);
  // 切到 spark 模式：接收方变成 Spark 端点，旧 consent 不再覆盖。
  store.update({ mode: "spark" }, SPARK);
  assert.equal(store.consentTarget(SPARK), "origin:https://llm.example");
  assert.equal(store.consentSatisfied(SPARK), false);
  // 换 backend → target 变化 → 旧 consent 不再覆盖。
  store.update({ mode: "byok", byokBackend: "brave", apiKey: "brave-key-777" }, SPARK);
  assert.equal(store.consentTarget(null), "origin:https://api.search.brave.com");
  assert.equal(store.consentSatisfied(null), false);
});

test("protected key persists across reload; corrupted file falls back to off", () => {
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
