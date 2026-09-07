import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { TaskCoordinator } from "../src/main/tasks/task-coordinator.js";

// Use the exact pi-ai copy bundled with the installed SDK, not a second version.
const { AssistantMessageEventStream } = await import(new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function sdkHarness({ ask = false } = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "arcane-sdk-task-"));
  const first = deferred(); const release = deferred(); const calls = [];
  let coordinator;
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("arcane-test", {
    api: "openai-completions", apiKey: "test-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      const index = calls.push(context.messages);
      const message = { role: "assistant", content: [{ type: "text", text: "test answer" }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (ask && index === 1) {
        message.content = [{ type: "toolCall", id: "ask-1", name: "request_user_input", arguments: { question: "Choose a scene" } }];
        message.stopReason = "toolUse";
      }
      let ended = false;
      const finish = aborted => {
        if (ended) return; ended = true;
        if (aborted) {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      };
      stream.push({ type: "start", partial: message });
      options?.signal?.addEventListener("abort", () => finish(true), { once: true });
      if (options?.signal?.aborted) finish(true);
      if (index === 1) { first.resolve(); release.promise.then(() => finish(false)); }
      else queueMicrotask(() => finish(false));
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd),
    settingsManager, resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel("arcane-test", "test"),
    tools: ask ? ["request_user_input"] : [],
    customTools: ask ? [{ name: "request_user_input", label: "Ask", description: "Ask a question",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      execute: async (_id, args, signal) => ({ content: [{ type: "text", text: JSON.stringify(await coordinator.ask(args, signal)) }] }),
    }] : [] });
  coordinator = new TaskCoordinator({ sessionId: "test", adapter: {
    prompt: (text, images) => session.prompt(text, { images }),
    steer: (text, images) => session.steer(text, images),
    clearQueue: () => session.clearQueue(), isStreaming: () => session.isStreaming,
    abort: () => session.abort(),
  } });
  session.subscribe(event => coordinator.observe(event));
  return { session, coordinator, first, release, calls };
}

test("real Pi SDK consumes steering exactly once at the next model boundary", { timeout: 15000 }, async () => {
  const h = await sdkHarness();
  try {
    const first = h.coordinator.submit({ commandId: "first", text: "first input" });
    await h.first.promise;
    const next = h.coordinator.submit({ commandId: "second", text: "second input" });
    assert.equal(next.taskId, first.taskId);
    assert.equal(h.coordinator.inputs.get(next.inputId).state, "queued");
    h.release.resolve();
    await h.coordinator.run;
    assert.equal(h.coordinator.inputs.get(next.inputId).state, "consumed");
    assert.equal(h.calls.length, 2);
    assert.equal(h.session.messages.filter(m => m.role === "user").length, 2);
    assert.equal(h.coordinator.task.state, "completed");
  } finally { await h.session.abort(); h.session.dispose(); }
});

test("real Pi abort confirms stopped and clears unconsumed steering", { timeout: 15000 }, async () => {
  const h = await sdkHarness();
  try {
    const first = h.coordinator.submit({ text: "first" });
    await h.first.promise;
    const pending = h.coordinator.submit({ text: "pending" });
    await h.coordinator.stop(first.taskId);
    assert.equal(h.coordinator.task.state, "stopped");
    assert.equal(h.coordinator.inputs.get(pending.inputId).state, "cancelled");
    assert.equal(h.session.pendingMessageCount, 0);
    assert.equal(h.calls.length, 1);
  } finally { h.release.resolve(); await h.session.abort(); h.session.dispose(); }
});

test("real Pi tool waits for a scoped answer and continues the original task", { timeout: 15000 }, async () => {
  const h = await sdkHarness({ ask: true });
  try {
    const task = h.coordinator.submit({ text: "prepare" });
    await h.first.promise; h.release.resolve();
    const deadline = Date.now() + 5000;
    while (h.coordinator.task.state !== "waiting_user" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.coordinator.task.state, "waiting_user");
    assert.equal(h.calls.length, 1);
    const attention = h.coordinator.snapshotAttentions()[0];
    assert.equal(h.coordinator.respond({ commandId: "reply", taskId: task.taskId, attentionId: attention.id, response: "Forest" }).ok, true);
    await h.coordinator.run;
    assert.equal(h.coordinator.task.state, "completed");
    assert.equal(h.coordinator.task.id, task.taskId);
    assert.equal(h.calls.length, 2);
    assert.ok(JSON.stringify(h.calls[1]).includes("Forest"));
  } finally { await h.session.abort(); h.session.dispose(); }
});
