// Small real-provider probe; never logs credentials, headers, or reasoning text.
const { app, safeStorage } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const { pathToFileURL } = require("node:url");
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = option("qa-root");
if (!root) throw Error("--qa-root required");
app.setPath("userData", root);
app.whenReady().then(async () => {
  const repo = path.resolve(__dirname, "../../../..");
  const load = file => import(pathToFileURL(path.join(repo, file)));
  const { ProviderStore } = await load("apps/desktop/src/main/providers.js");
  const { SecretStorage } = await load("apps/desktop/src/main/secret-storage.js");
  const { streamSimple } = await load("node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js");
  const store = new ProviderStore(path.join(root, "config/providers.json"), () => {}, {}, new SecretStorage(safeStorage));
  const selected = store.effectiveModel();
  if (selected.modelId !== "qwen3.7-plus") throw Error("Expected selected Qwen model");
  let registered;
  store.applyToRuntime({ registerProvider(id, config) { if (id === selected.providerId) registered = config; } });
  const credential = store.credentialForProvider(selected.providerId);
  if (!credential || !registered) throw Error("Configured provider unavailable");
  const model = { ...registered.models.find(m => m.id === selected.modelId),
    provider: selected.providerId, api: registered.api, baseUrl: registered.baseUrl };
  const report = { model: model.id, provider: model.provider, compat: model.compat,
    reasoningCapability: model.reasoning, trials: [] };
  for (const thinking of ["off", "low"]) {
    const trial = { thinking }; report.trials.push(trial);
    const start = performance.now();
    const stream = streamSimple(model, { messages: [{ role: "user", content: "Reply with exactly OK.", timestamp: Date.now() }] }, {
      apiKey: credential.apiKey, reasoning: thinking, maxTokens: 128, signal: AbortSignal.timeout(30000),
      onPayload(payload) { trial.sent = { enable_thinking: payload.enable_thinking ?? "omitted", reasoning_effort: payload.reasoning_effort ?? "omitted" }; },
    });
    const result = await stream.result();
    trial.ms = performance.now() - start;
    trial.stopReason = result.stopReason;
    trial.usage = result.usage;
    trial.text = result.content.filter(c => c.type === "text").map(c => c.text).join("");
    trial.hasThinkingBlock = result.content.some(c => c.type === "thinking" && c.thinking?.length);
    trial.error = result.errorMessage ? "provider_error" : null;
  }
  const output = path.join(root, `qwen-thinking-probe-${Date.now()}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
  app.exit(report.trials.some(t => t.error) ? 1 : 0);
}).catch(error => { console.error(JSON.stringify({ error: error.name, message: "Probe failed; inspect configuration locally" })); app.exit(1); });
