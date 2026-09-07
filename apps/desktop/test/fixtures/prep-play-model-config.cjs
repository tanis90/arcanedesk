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
  let secret = process.env.ARCANE_QA_KIMI_KEY;
  delete process.env.ARCANE_QA_KIMI_KEY;
  const { ProviderStore } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/providers.js")));
  const { SecretStorage } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/secret-storage.js")));
  mkdirSync(path.join(root, "config"), { recursive: true });
  const store = new ProviderStore(path.join(root, "config/providers.json"), () => {}, {}, new SecretStorage(safeStorage));
  const result = secret ? store.upsertProvider({ id: "qa-kimi-coding", name: "Kimi 编程套餐 QA", api: "openai-completions",
    baseUrl: "https://api.kimi.com/coding/v1", apiKey: secret,
    models: [{ id: "kimi-for-coding-highspeed", name: "Kimi K2.7 Code HighSpeed", reasoning: true, vision: true, contextWindow: 262144, maxTokens: 8192 }] }) : { ok: true };
  if (!result.ok) throw Error("QA provider configuration failed");
  store.setDefaultModel("qa-kimi-coding", "kimi-for-coding-highspeed");
  secret = store.data.providers.find(provider => provider.id === "qa-kimi-coding")?.apiKey;
  if (!secret) throw Error("QA provider key is required");
  const response = await fetch("https://api.kimi.com/coding/v1/models", {
    headers: { Authorization: `Bearer ${secret}`, "User-Agent": "ArcaneDesk/0.4.3 (QA; Pi coding agent)" }, signal: AbortSignal.timeout(30000)
  });
  const data = await response.json();
  const probe = { configured: true, status: response.status, model: "kimi-for-coding-highspeed",
    available: Array.isArray(data.data) && data.data.some(model => model.id === "kimi-for-coding-highspeed") };
  writeFileSync(path.join(root, "provider-probe.json"), JSON.stringify(probe));
  console.log(JSON.stringify(probe));
  app.exit(response.ok ? 0 : 1);
}).catch(() => { console.error("QA provider bootstrap failed; credentials omitted"); app.exit(1); });
