import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VoiceStore, resolveRelayCredentials } from "../src/main/voice/voice-store.js";
import { DEFAULT_NEW_API_BASE_URL } from "../src/main/providers.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

const SPARK = { apiKey: "sk-spark-9999", baseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1" };

function tempVoiceConfig() {
  const dir = mkdtempSync(join(tmpdir(), "arcane-voice-test-"));
  return { dir, file: join(dir, "voice.json") };
}

test("new users default to enabled Arcane Spark voice", () => {
  const { file } = tempVoiceConfig();
  const store = new VoiceStore(file, () => {}, testSecretStorage());

  assert.equal(store.data.enabled, true);
  assert.equal(store.data.provider, "arcane-relay");
  assert.equal(store.data.baseUrl, "");
  const pub = store.toPublic(SPARK);
  assert.equal(pub.provider, "arcane-relay");
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keySource, "arcane-spark");
  assert.equal(pub.sparkHasKey, true);
  assert.equal(pub.hasOwnKey, false);
  assert.equal(store.usable(SPARK), true);
});

test("relay follows arcane-spark key and baseUrl when own fields are empty", () => {
  const { file } = tempVoiceConfig();
  const store = new VoiceStore(file, () => {}, testSecretStorage());
  store.update({ enabled: true, provider: "arcane-relay", apiKey: "", baseUrl: "" });

  const resolved = resolveRelayCredentials(store.data, SPARK);
  assert.equal(resolved.apiKey, "sk-spark-9999");
  assert.equal(resolved.baseUrl, "https://llm.arcanedesk.bitterbebop.cn/v1");

  assert.equal(store.usable(SPARK), true);
  assert.equal(store.usable(null), false); // 没配 Spark 时不能凭空可用

  const pub = store.toPublic(SPARK);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keySource, "arcane-spark");
  assert.equal(pub.apiKey, "••••9999");
  assert.equal(pub.baseUrl, ""); // 自己的覆盖值仍为空
  assert.equal(pub.relayBaseUrl, "https://llm.arcanedesk.bitterbebop.cn/v1");
});

test("relay explicit key/baseUrl override spark and trailing slash is normalized", () => {
  const { file } = tempVoiceConfig();
  const store = new VoiceStore(file, () => {}, testSecretStorage());
  store.update({ enabled: true, provider: "arcane-relay", apiKey: "sk-own-1234", baseUrl: "https://relay.example/v1/" });

  const resolved = resolveRelayCredentials(store.data, SPARK);
  assert.equal(resolved.apiKey, "sk-own-1234");
  assert.equal(resolved.baseUrl, "https://relay.example/v1");

  const pub = store.toPublic(SPARK);
  assert.equal(pub.keySource, "voice");
  assert.equal(pub.apiKey, "••••1234");
  assert.equal(store.usable(null), true);

  // 空/打码 apiKey 输入 = 保持原值(掩码语义同 ProviderStore)
  store.update({ enabled: true, provider: "arcane-relay", apiKey: "••••1234", baseUrl: "" });
  assert.equal(store.data.apiKey, "sk-own-1234");
});

test("relay without spark falls back to the default gateway baseUrl", () => {
  const { file } = tempVoiceConfig();
  const store = new VoiceStore(file, () => {}, testSecretStorage());
  store.update({ enabled: true, provider: "arcane-relay", apiKey: "", baseUrl: "" });

  const resolved = resolveRelayCredentials(store.data, null);
  assert.equal(resolved.apiKey, "");
  assert.equal(resolved.baseUrl, DEFAULT_NEW_API_BASE_URL);

  const pub = store.toPublic(null);
  assert.equal(pub.hasKey, false);
  assert.equal(pub.keySource, "voice");
});

test("zhipu mode never borrows the spark key", () => {
  const { file } = tempVoiceConfig();
  const store = new VoiceStore(file, () => {}, testSecretStorage());
  store.update({ enabled: true, provider: "zhipu", apiKey: "sk-zhipu-777" });

  assert.equal(store.usable(), true);
  const resolved = resolveRelayCredentials(store.data, SPARK);
  assert.equal(resolved.apiKey, "sk-zhipu-777"); // 仅供 relay 用,zhipu 模式不消费
  const pub = store.toPublic(SPARK);
  assert.equal(pub.keySource, "voice");
  assert.equal(pub.apiKey, "••••-777"); // 后 4 位 = "-777"(含连字符)
});

test("legacy voice.json without provider/baseUrl still loads and persists new fields", () => {
  const { dir, file } = tempVoiceConfig();
  writeFileSync(file, JSON.stringify({ enabled: true, apiKey: "sk-old", prompt: "p", hotwords: ["a"] }));
  const store = new VoiceStore(file, () => {}, testSecretStorage());

  assert.equal(store.data.provider, "zhipu");
  assert.equal(store.data.apiKey, "sk-old");
  assert.equal(store.data.baseUrl, "");
  assert.equal(store.data.prompt, "p");
  assert.deepEqual(store.data.hotwords, ["a"]);

  store.save();
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(persisted.provider, "zhipu");
  assert.equal(persisted.baseUrl, "");
  assert.equal(persisted.apiKey, undefined);
  assert.equal(persisted.apiKeyProtected.scheme, "electron-safe-storage-v1");
  assert.equal(readFileSync(file, "utf8").includes("sk-old"), false);
  assert.ok(dir);
});

test("unknown provider value and invalid baseUrl fall back safely", () => {
  const { file } = tempVoiceConfig();
  const store = new VoiceStore(file, () => {}, testSecretStorage());
  store.update({ enabled: true, provider: "typo-provider", apiKey: "sk-x", baseUrl: "not-a-url" });

  assert.equal(store.data.provider, "zhipu");
  assert.equal(store.data.baseUrl, ""); // 非法地址归零 = 跟随,不落脏值
});
