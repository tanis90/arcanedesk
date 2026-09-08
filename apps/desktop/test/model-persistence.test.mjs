import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { SessionNavigation } from "../src/main/conversations/session-navigation.js";

test("missing-key and deferred choices survive native session eviction and reattachment", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcane-model-choice-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("choice-test", { api: "openai-completions", apiKey: "unused", baseUrl: "http://127.0.0.1:1",
    models: ["old", "missing", "next"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 })) });
  const hosts = [];
  const create = () => {
    const host = new AgentHost({ profile: { getCwd: () => root }, taskStorageDir: path.join(root, "tasks"),
      providerStore: { effectiveModel: () => ({ providerId: "choice-test", modelId: "old" }),
        missingApiKeyForModel: ref => ref?.modelId === "missing" ? { providerId: "choice-test" } : null },
      sendToRenderer() {}, log() {} });
    host.modelRuntime = runtime;
    host.navigation = new SessionNavigation({ file: path.join(root, "navigation.json") });
    hosts.push(host); return host;
  };
  try {
    const first = create(); await first.attach(first.createSessionManager());
    const file = first.describeCurrent().path;
    assert.equal((await first.setCurrentModel("choice-test", "missing")).pendingKey, true);
    assert.equal(first.canEvict(), true); first.persistForEviction(); first.dispose();
    const second = create(); await second.attach(second.openSessionManager(file));
    assert.equal(second.currentModelRef().modelId, "missing");
    let release;
    second.session.prompt = () => new Promise(resolve => { release = resolve; });
    second.submitInput("work", [], "work");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await second.setCurrentModel("choice-test", "next")).deferred, true);
    release(); await second.tasks.run;
    second.persistForEviction(); second.dispose();
    const third = create(); await third.attach(third.openSessionManager(file));
    assert.equal(third.currentModelRef().modelId, "next");
    assert.equal(third.tasks.pendingModel.modelId, "next");
    assert.equal(third.tasks.run, null);
  } finally {
    for (const host of hosts) if (!host.retired) host.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
