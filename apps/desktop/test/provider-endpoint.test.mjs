import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fetchModels } from "../src/main/provider-catalog.js";
import { providerCredentialTarget, validateProviderBaseUrl } from "../src/main/provider-endpoint.js";

test("provider endpoints require HTTPS except for exact loopback hosts", () => {
  assert.deepEqual(validateProviderBaseUrl("https://EXAMPLE.com:443/v1///"), {
    ok: true,
    baseUrl: "https://example.com/v1",
    origin: "https://example.com",
  });
  for (const value of [
    "http://localhost:39000/v1",
    "http://127.0.0.1:39000/v1",
    "http://[::1]:39000/v1",
  ]) {
    assert.equal(validateProviderBaseUrl(value).ok, true, value);
  }
  for (const value of [
    "http://provider.example/v1",
    "http://localhost.evil.example/v1",
    "ftp://provider.example/v1",
  ]) {
    assert.equal(validateProviderBaseUrl(value).error.key, "err.provider.baseUrlHttpsRequired", value);
  }
});

test("provider endpoints reject ambiguous URL components", () => {
  for (const value of [
    "not a URL",
    "https://user:pass@provider.example/v1",
    "https://provider.example/v1?redirect=https://evil.example",
    "https://provider.example/v1#fragment",
  ]) {
    assert.equal(validateProviderBaseUrl(value).error.key, "err.provider.baseUrlInvalid", value);
  }
});

test("credential targets bind explicit URLs to origin rather than path", () => {
  assert.equal(providerCredentialTarget({
    api: "openai-completions",
    baseUrl: "https://provider.example/v1",
  }).target, "origin:https://provider.example");
  assert.equal(providerCredentialTarget({
    api: "openai-completions",
    baseUrl: "https://provider.example/v2",
  }).target, "origin:https://provider.example");
  assert.equal(providerCredentialTarget({
    api: "anthropic-messages",
    baseUrl: "",
  }).target, "default-api:anthropic-messages");
});

test("fetchModels sends a credential once to a validated endpoint and refuses redirects", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ data: [{ id: "model-b" }, { id: "model-a" }] }) };
  };

  const result = await fetchModels({
    baseUrl: "https://provider.example/v1/",
    apiKey: "request-key",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models.map((model) => model.id), ["model-a", "model-b"]);
  assert.equal(captured.url, "https://provider.example/v1/models");
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.headers.Authorization, "Bearer request-key");
  assert.equal(captured.options.redirect, "error");
});

test("fetchModels rejects an unsafe endpoint before touching the network", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not be called");
  };

  const result = await fetchModels({ baseUrl: "http://attacker.example/v1", apiKey: "secret" });
  assert.equal(result.ok, false);
  assert.equal(result.error.key, "err.provider.baseUrlHttpsRequired");
  assert.equal(called, false);
});

test("provider credential IPC handlers require the trusted chat main frame", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "src/main/main.js"), "utf8");
  for (const channel of [
    "settings:save-provider",
    "providers:fetch-models",
    "voice:save-config",
    "voice:transcribe",
  ]) {
    const start = source.indexOf(`ipcMain.handle("${channel}"`);
    const end = source.indexOf("ipcMain.handle(", start + 20);
    const handler = source.slice(start, end < 0 ? source.length : end);
    assert.ok(start >= 0, `${channel} handler missing`);
    assert.match(handler, /isTrustedChatIpc\(event\)/, `${channel} must validate the sender`);
  }
});
