// Opt-in QA provider bootstrap. Secret enters via the process environment and
// is persisted only through production Electron safeStorage; never logged.
const { app, safeStorage } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const rootArg = process.argv.find(value => value.startsWith("--qa-root="));
if (!rootArg) throw Error("--qa-root is required");
const root = path.resolve(rootArg.slice("--qa-root=".length));
app.setPath("userData", root);
app.whenReady().then(async () => {
  const providerId = process.env.ARCANE_QA_PROVIDER_ID || "qa-kimi-coding";
  const modelId = process.env.ARCANE_QA_MODEL_ID || "kimi-for-coding-highspeed";
  const baseUrl = process.env.ARCANE_QA_BASE_URL || "https://api.kimi.com/coding/v1";
  let secret = process.env.ARCANE_QA_PROVIDER_KEY || process.env.ARCANE_QA_KIMI_KEY;
  delete process.env.ARCANE_QA_PROVIDER_KEY;
  delete process.env.ARCANE_QA_KIMI_KEY;
  const { ProviderStore } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/providers.js")));
  const { SecretStorage } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/secret-storage.js")));
  mkdirSync(path.join(root, "config"), { recursive: true });
  const store = new ProviderStore(path.join(root, "config/providers.json"), () => {}, {}, new SecretStorage(safeStorage));
  const result = secret ? store.upsertProvider({ id: providerId, name: providerId, api: "openai-completions",
    baseUrl, apiKey: secret,
    models: [{ id: modelId, name: modelId, reasoning: true, vision: true, contextWindow: 262144, maxTokens: 8192 }] }) : { ok: true };
  if (!result.ok) throw Error("QA provider configuration failed");
  store.setDefaultModel(providerId, modelId);
  secret = store.data.providers.find(provider => provider.id === providerId)?.apiKey;
  if (!secret) throw Error("QA provider key is required");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST", body: JSON.stringify({model:modelId,messages:[{role:"user",content:"Reply OK."}],max_tokens:16}),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, "User-Agent": "ArcaneDesk/0.4.3 (QA; Pi coding agent)" }, signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  const probe = { configured: true, status: response.status, model: modelId,
    available: Array.isArray(data.choices) && data.choices.length > 0, errorCode: data.error?.code ?? null };
  writeFileSync(path.join(root, "provider-probe.json"), JSON.stringify(probe));
  console.log(JSON.stringify(probe));
  app.exit(response.ok ? 0 : 1);
}).catch(() => { console.error("QA provider bootstrap failed; credentials omitted"); app.exit(1); });
