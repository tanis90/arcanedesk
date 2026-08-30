import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProviderStore } from "../src/main/providers.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "arcane-provider-test-"));
  return { dir, file: join(dir, "providers.json") };
}

test("creates Arcane Spark as the default provider without silently issuing a Key", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());

  assert.deepEqual(store.data.defaultModel, {
    providerId: "arcane-spark",
    modelId: "arcane-spark",
  });
  assert.deepEqual(store.data.providers[0], {
    id: "arcane-spark",
    name: "Arcane Spark",
    api: "openai-completions",
    baseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
    apiKey: "",
    models: [{ id: "arcane-spark", name: "Arcane Spark", vision: true }],
  });
  assert.deepEqual(store.missingApiKeyForDefault(), {
    providerId: "arcane-spark",
    providerName: "Arcane Spark",
    arcaneSpark: true,
  });
  assert.equal(store.toPublic().providers[0].hasKey, false);
});

test("allows Arcane Spark provisioning to be disabled explicitly", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, testSecretStorage());

  assert.deepEqual(store.data, { providers: [], defaultModel: null });
});

test("provisions Arcane Spark from an injected Key", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_API_KEY: "restricted-token" }, testSecretStorage());

  assert.equal(store.data.providers.length, 1);
  assert.deepEqual(store.data.defaultModel, {
    providerId: "arcane-spark",
    modelId: "arcane-spark",
  });
  assert.deepEqual(store.data.providers[0], {
    id: "arcane-spark",
    name: "Arcane Spark",
    api: "openai-completions",
    baseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
    apiKey: "restricted-token",
    models: [{ id: "arcane-spark", name: "Arcane Spark", vision: true }],
  });
  const persisted = readFileSync(file, "utf8");
  assert.equal(persisted.includes("restricted-token"), false);
  assert.equal(JSON.parse(persisted).providers[0].apiKey, undefined);
  assert.equal(JSON.parse(persisted).providers[0].apiKeyProtected.scheme, "electron-safe-storage-v1");
  assert.equal(store.missingApiKeyForDefault(), null);
  assert.equal(store.toPublic().providers[0].hasKey, true);
});

test("reads the restricted token from a local token file while keeping the stable model alias", () => {
  const { dir, file } = tempConfig();
  const tokenFile = join(dir, "client.token");
  writeFileSync(tokenFile, "file-token\n");

  const store = new ProviderStore(file, () => {}, {
    ARCANE_SPARK_API_KEY_FILE: tokenFile,
    ARCANE_SPARK_BASE_URL: "http://localhost:39000/v1",
    ARCANE_SPARK_MODEL: "vendor-model-must-not-leak",
  }, testSecretStorage());

  assert.equal(store.data.providers[0].apiKey, "file-token");
  assert.equal(store.data.providers[0].baseUrl, "http://localhost:39000/v1");
  assert.equal(store.data.providers[0].models[0].id, "arcane-spark");
});

test("keeps an explicit user default unless force-default is requested", () => {
  const { file } = tempConfig();
  writeFileSync(
    file,
    JSON.stringify({
      providers: [{ id: "other", name: "Other", apiKey: "other-key", models: [{ id: "other-model" }] }],
      defaultModel: { providerId: "other", modelId: "other-model" },
    }),
  );

  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_API_KEY: "restricted-token" }, testSecretStorage());
  assert.deepEqual(store.data.defaultModel, { providerId: "other", modelId: "other-model" });

  store.provisionArcaneSparkProvider({
    ARCANE_SPARK_API_KEY: "restricted-token",
    ARCANE_SPARK_FORCE_DEFAULT: "1",
  });
  assert.deepEqual(store.data.defaultModel, {
    providerId: "arcane-spark",
    modelId: "arcane-spark",
  });
});

test("migrates a legacy Arcane Spark default to the stable alias", () => {
  const { file } = tempConfig();
  writeFileSync(
    file,
    JSON.stringify({
      providers: [{
        id: "arcane-spark",
        name: "Arcane Spark",
        api: "openai-completions",
        baseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
        apiKey: "restricted-token",
        models: [{ id: "deepseek-v4-flash", name: "Arcane Spark", vision: false }],
      }],
      defaultModel: { providerId: "arcane-spark", modelId: "deepseek-v4-flash" },
    }),
  );

  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());

  assert.deepEqual(store.data.defaultModel, { providerId: "arcane-spark", modelId: "arcane-spark" });
  assert.equal(store.data.providers[0].baseUrl, "https://llm.arcanedesk.bitterbebop.cn/v1");
  assert.deepEqual(store.data.providers[0].models, [
    { id: "arcane-spark", name: "Arcane Spark", vision: true },
  ]);
  assert.equal(store.data.providers[0].apiKey, "restricted-token");
  const migrated = readFileSync(file, "utf8");
  assert.equal(migrated.includes("restricted-token"), false);
  assert.equal(JSON.parse(migrated).providers[0].apiKey, undefined);
});

test("saving the managed provider cannot replace the Arcane Spark contract", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());

  const result = store.upsertProvider({
    id: "arcane-spark",
    name: "Vendor Name",
    api: "anthropic-messages",
    baseUrl: "https://vendor.example/v1",
    apiKey: "new-restricted-token",
    models: [{ id: "vendor-model", vision: false }],
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(store.data.providers[0], {
    id: "arcane-spark",
    name: "Arcane Spark",
    api: "openai-completions",
    baseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
    apiKey: "new-restricted-token",
    models: [{ id: "arcane-spark", name: "Arcane Spark", vision: true }],
  });
});

test("registers models with a 256K context budget by default", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());
  store.upsertProvider({
    id: "custom-provider",
    name: "Custom Provider",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-key",
    models: [{ id: "custom-model", vision: false }],
  });

  const registered = new Map();
  store.applyToRuntime({
    registerProvider(id, config) {
      registered.set(id, config);
    },
  });

  assert.equal(registered.get("arcane-spark").models[0].contextWindow, 262144);
  assert.equal(registered.get("custom-provider").models[0].contextWindow, 262144);
});
