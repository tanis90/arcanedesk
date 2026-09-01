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

test("creates Arcane Spark as the product fallback without persisting an explicit selection", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());

  assert.equal(store.data.defaultModel, null);
  assert.deepEqual(store.effectiveModel(), {
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
  assert.deepEqual(store.toPublic().effectiveModel, {
    providerId: "arcane-spark",
    modelId: "arcane-spark",
  });
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
  assert.equal(store.data.defaultModel, null);
  assert.deepEqual(store.effectiveModel(), {
    providerId: "arcane-spark",
    modelId: "arcane-spark",
  });
  assert.deepEqual(store.data.providers[0], {
    id: "arcane-spark",
    name: "Arcane Spark",
    api: "openai-completions",
    baseUrl: "https://llm.arcanedesk.bitterbebop.cn/v1",
    apiKey: "restricted-token",
    credentialTarget: "origin:https://llm.arcanedesk.bitterbebop.cn",
    models: [{ id: "arcane-spark", name: "Arcane Spark", vision: true }],
  });
  const persisted = readFileSync(file, "utf8");
  assert.equal(persisted.includes("restricted-token"), false);
  assert.equal(JSON.parse(persisted).providers[0].apiKey, undefined);
  assert.equal(JSON.parse(persisted).providers[0].apiKeyProtected.scheme, "electron-safe-storage-v1");
  const protectedPayload = testSecretStorage().reveal(JSON.parse(persisted).providers[0].apiKeyProtected);
  assert.deepEqual(JSON.parse(protectedPayload), {
    kind: "arcane-bound-credential-v1",
    secret: "restricted-token",
    target: "origin:https://llm.arcanedesk.bitterbebop.cn",
  });
  assert.equal(store.missingApiKeyForDefault(), null);
  assert.equal(store.toPublic().providers[0].hasKey, true);
});

test("configuring a provider does not select it, but an explicit model selection controls access", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());
  assert.deepEqual(store.upsertProvider({
    id: "kimi",
    name: "Kimi",
    api: "openai-completions",
    baseUrl: "https://api.kimi.example/v1",
    apiKey: "kimi-key",
    models: [{ id: "kimi-for-coding" }],
  }), { ok: true });

  assert.equal(store.data.defaultModel, null);
  assert.deepEqual(store.effectiveModel(), {
    providerId: "arcane-spark",
    modelId: "arcane-spark",
  });
  assert.equal(store.missingApiKeyForDefault().providerId, "arcane-spark");

  store.setDefaultModel("kimi", "kimi-for-coding");
  assert.deepEqual(store.effectiveModel(), {
    providerId: "kimi",
    modelId: "kimi-for-coding",
  });
  assert.equal(store.missingApiKeyForDefault(), null);

  store.setDefaultModel("", "");
  assert.equal(store.data.defaultModel, null);
  assert.equal(store.missingApiKeyForDefault().providerId, "arcane-spark");
});

test("a selected unconfigured custom provider reports itself instead of Arcane Spark", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, {}, testSecretStorage());
  store.upsertProvider({
    id: "kimi",
    name: "Kimi",
    api: "openai-completions",
    baseUrl: "https://api.kimi.example/v1",
    apiKey: "",
    models: [{ id: "kimi-for-coding" }],
  });
  store.setDefaultModel("kimi", "kimi-for-coding");

  assert.deepEqual(store.missingApiKeyForDefault(), {
    providerId: "kimi",
    providerName: "Kimi",
    arcaneSpark: false,
  });
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

test("migrates a legacy automatic Arcane Spark default into the product fallback", () => {
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

  assert.equal(store.data.defaultModel, null);
  assert.deepEqual(store.effectiveModel(), { providerId: "arcane-spark", modelId: "arcane-spark" });
  assert.equal(store.data.providers[0].baseUrl, "https://llm.arcanedesk.bitterbebop.cn/v1");
  assert.deepEqual(store.data.providers[0].models, [
    { id: "arcane-spark", name: "Arcane Spark", vision: true },
  ]);
  assert.equal(store.data.providers[0].apiKey, "restricted-token");
  const migrated = readFileSync(file, "utf8");
  assert.equal(migrated.includes("restricted-token"), false);
  const parsed = JSON.parse(migrated);
  assert.equal(parsed.providers[0].apiKey, undefined);
  assert.equal(parsed.schemaVersion, 4);
  assert.equal(parsed.selectedModel, null);
  assert.equal(parsed.defaultModel, undefined);
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
    credentialTarget: "origin:https://llm.arcanedesk.bitterbebop.cn",
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

test("reuses a stored key only within the same HTTPS origin", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, testSecretStorage());
  assert.deepEqual(store.upsertProvider({
    id: "custom",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
    apiKey: "original-key",
    models: [],
  }), { ok: true });

  assert.deepEqual(store.upsertProvider({
    id: "custom",
    api: "openai-completions",
    baseUrl: "https://provider.example/v2/",
    apiKey: "",
    models: [],
  }), { ok: true });
  assert.equal(store.data.providers[0].apiKey, "original-key");
  assert.equal(store.data.providers[0].baseUrl, "https://provider.example/v2");
  assert.equal(store.data.providers[0].credentialTarget, "origin:https://provider.example");

  assert.deepEqual(store.resolveCredentialForRequest({
    providerId: "custom",
    api: "openai-completions",
    baseUrl: "https://provider.example/models-api",
    apiKey: "",
  }), {
    ok: true,
    apiKey: "original-key",
    baseUrl: "https://provider.example/models-api",
  });
});

test("rejects a saved-key reuse when scheme, host, or port changes", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, testSecretStorage());
  store.upsertProvider({
    id: "custom",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
    apiKey: "original-key",
    models: [],
  });

  for (const baseUrl of [
    "https://attacker.example/v1",
    "https://provider.example:8443/v1",
    "http://localhost:39000/v1",
  ]) {
    const before = structuredClone(store.data.providers[0]);
    const saved = store.upsertProvider({
      id: "custom",
      api: "openai-completions",
      baseUrl,
      apiKey: "",
      models: [],
    });
    assert.equal(saved.ok, false);
    assert.equal(saved.code, "KEY_REENTRY_REQUIRED");
    assert.equal(saved.error.key, "err.provider.keyReentryRequired");
    assert.deepEqual(store.data.providers[0], before);

    const fetched = store.resolveCredentialForRequest({
      providerId: "custom",
      api: "openai-completions",
      baseUrl,
      apiKey: "",
    });
    assert.equal(fetched.ok, false);
    assert.equal(fetched.code, "KEY_REENTRY_REQUIRED");
    assert.equal(JSON.stringify(fetched).includes("original-key"), false);
  }
});

test("allows an origin change only with an explicitly re-entered key", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, testSecretStorage());
  store.upsertProvider({
    id: "custom",
    api: "openai-completions",
    baseUrl: "https://old.example/v1",
    apiKey: "old-key",
    models: [],
  });

  assert.deepEqual(store.upsertProvider({
    id: "custom",
    api: "openai-completions",
    baseUrl: "https://new.example/v1",
    apiKey: "new-key",
    models: [],
  }), { ok: true });
  assert.equal(store.data.providers[0].apiKey, "new-key");
  assert.equal(store.data.providers[0].credentialTarget, "origin:https://new.example");
});

test("blocks renderer attempts to forward the managed Arcane Spark key", () => {
  const { file } = tempConfig();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_API_KEY: "spark-secret" }, testSecretStorage());

  const result = store.resolveCredentialForRequest({
    providerId: "arcane-spark",
    api: "openai-completions",
    baseUrl: "https://attacker.example/v1",
    apiKey: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "KEY_REENTRY_REQUIRED");
  assert.equal(JSON.stringify(result).includes("spark-secret"), false);
});

test("an encrypted credential target detects public-config tampering", () => {
  const { file } = tempConfig();
  const storage = testSecretStorage();
  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, storage);
  store.upsertProvider({
    id: "custom",
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
    apiKey: "bound-key",
    models: [{ id: "model" }],
  });

  const persisted = JSON.parse(readFileSync(file, "utf8"));
  persisted.providers[0].baseUrl = "https://attacker.example/v1";
  writeFileSync(file, JSON.stringify(persisted));

  const reloaded = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, storage);
  assert.equal(reloaded.toPublic().providers[0].hasKey, false);
  assert.equal(reloaded.credentialForProvider("custom"), null);
  assert.deepEqual(reloaded.missingApiKeyForDefault(), null);
  const registered = new Map();
  reloaded.applyToRuntime({ registerProvider: (id, config) => registered.set(id, config) });
  assert.equal(registered.get("custom").apiKey, undefined);
  const result = reloaded.resolveCredentialForRequest({
    providerId: "custom",
    api: "openai-completions",
    baseUrl: "https://attacker.example/v1",
    apiKey: "",
  });
  assert.equal(result.code, "KEY_REENTRY_REQUIRED");
});

test("migrates a pre-v3 protected key into a target-bound encrypted payload", () => {
  const { file } = tempConfig();
  const storage = testSecretStorage();
  writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    providers: [{
      id: "custom",
      api: "openai-completions",
      baseUrl: "https://provider.example/v1",
      apiKeyProtected: storage.protect("legacy-protected-key"),
      models: [],
    }],
    defaultModel: null,
  }));

  const store = new ProviderStore(file, () => {}, { ARCANE_SPARK_ENABLED: "0" }, storage);
  assert.equal(store.data.providers[0].apiKey, "legacy-protected-key");
  assert.equal(store.data.providers[0].credentialTarget, "origin:https://provider.example");
  const migrated = JSON.parse(storage.reveal(JSON.parse(readFileSync(file, "utf8")).providers[0].apiKeyProtected));
  assert.deepEqual(migrated, {
    kind: "arcane-bound-credential-v1",
    secret: "legacy-protected-key",
    target: "origin:https://provider.example",
  });
});
