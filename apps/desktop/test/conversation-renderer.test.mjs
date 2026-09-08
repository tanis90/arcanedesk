import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const stateSource = readFileSync(new URL("../src/renderer/conversations/session-state.js", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("../src/renderer/chat.js", import.meta.url), "utf8");
function stateClasses() {
  const context = vm.createContext({ structuredClone });
  vm.runInContext(stateSource, context);
  return context.ArcaneConversationState;
}

test("snapshot events exist only during active requests and replay once in order", () => {
  const { SnapshotEvents } = stateClasses(); const inbox = new SnapshotEvents();
  inbox.record({ sessionId: "A", runtimeEpoch: "e", seq: 1 });
  assert.equal(inbox.pending.size, 0);
  const capture = inbox.begin();
  for (const seq of [3, 2, 3]) inbox.record({ sessionId: "A", runtimeEpoch: "e", seq });
  assert.equal(JSON.stringify(inbox.after(capture, "A", "e", 1).map(e => e.seq)), "[2,3]");
  assert.equal(inbox.after(capture, "A", "e", 0), null);
  inbox.end(capture); const count = capture.length;
  inbox.record({ sessionId: "A", runtimeEpoch: "e", seq: 4 });
  assert.equal(capture.length, count); assert.equal(inbox.pending.size, 0);
});

test("snapshot events from a replaced runtime require another snapshot", () => {
  const { SnapshotEvents } = stateClasses(); const inbox = new SnapshotEvents(), capture = inbox.begin();
  inbox.record({ sessionId: "A", runtimeEpoch: "old", seq: 99 });
  inbox.record({ sessionId: "A", runtimeEpoch: "new", seq: 1 });
  assert.equal(inbox.after(capture, "A", "old", 99), null);
  assert.equal(inbox.after(capture, "A", "new", 0).length, 1);
  inbox.end(capture);
});

test("an older completed write cannot discard a newer failed draft", async () => {
  const { WorkspaceStore } = stateClasses(); const store = new WorkspaceStore(null), transactions = [];
  store.open = async () => ({ transaction() {
    const tx = { objectStore: () => ({ put() {} }) }; transactions.push(tx); return tx;
  } });
  const older = store.save("A", { draft: "old" }), newer = store.save("A", { draft: "new" });
  await new Promise(resolve => setImmediate(resolve));
  transactions[0].oncomplete(); await older;
  const rejected = assert.rejects(newer); transactions[1].onerror(); await rejected;
  assert.equal((await store.load("A")).draft, "new");
});

test("completed reads are not retained, and a newer write invalidates an in-flight old read", async () => {
  const { WorkspaceStore } = stateClasses(); const store = new WorkspaceStore(null), reads = [];
  store.open = async () => ({ transaction: () => ({ objectStore: () => ({ get() { const request = {}; reads.push(request); return request; } }) }) });
  const pending = store.load("A"); await new Promise(resolve => setImmediate(resolve));
  store.revisions.set("A", 1);
  reads[0].result = { draft: "old" }; reads[0].onsuccess();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2); reads[1].result = { draft: "new" }; reads[1].onsuccess();
  assert.equal((await pending).draft, "new"); assert.equal(store.dirty.size, 0);
  const next = store.load("A"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 3); reads[2].result = { draft: "latest" }; reads[2].onsuccess();
  assert.equal((await next).draft, "latest");
});

test("workspace drafts and attachments are isolated even when persistent storage fails", async () => {
  const { WorkspaceStore } = stateClasses();
  const store = new WorkspaceStore(null);
  const value = { draft: "A", images: [{ data: "image-A" }] };
  await assert.rejects(store.save("A", value));
  await assert.rejects(store.save("B", { draft: "B", images: [] }));
  value.images[0].data = "changed";
  const a = await store.load("A");
  assert.equal(a.images[0].data, "image-A");
  a.draft = "mutated";
  assert.equal((await store.load("A")).draft, "A");
  assert.equal((await store.load("B")).draft, "B");
});

test("history restore preserves a running tool, marks missing results unknown and restores draft", () => {
  const cards = new Map();
  const finished = [];
  const bubbles = new Map();
  let restoredRetry;
  const handler = chatSource.slice(chatSource.indexOf("function renderHistory(entries"), chatSource.indexOf("let currentSessionRequest"));
  const context = vm.createContext({
    resetConversation() {}, showWelcome() {}, closeWorkBlock() {}, addMessage() {}, renderThinkingHistory() {},
    showRetry(value) { restoredRetry = value; },
    setBusy() {}, t: key => key, toolCards: cards, messages: { querySelectorAll: () => [] },
    ensureToolCard(id) {
      if (!cards.has(id)) cards.set(id, { startAt: 999, card: { classList: { remove() {} }, querySelector: () => ({ textContent: "" }) }, state: {} });
      return cards.get(id);
    },
    finishToolCard: (...args) => finished.push(args),
    streamBubble(key) { const body = {}; bubbles.set(key, body); return { querySelector: () => body }; },
    thinkBlock: () => ({ body: {} }),
  });
  vm.runInContext(handler, context);
  context.renderHistory([{ role: "assistant", ts: 1, toolCalls: [
    { id: "running", name: "bash", hasResult: false },
    { id: "unknown", name: "bash", hasResult: false },
    { id: "done", name: "bash", hasResult: true, resultText: "ok" },
  ] }], { tools: [{ toolCallId: "running", state: "running", startedAt: 42 }],
    streaming: [{ key: "m", text: "partial" }], retry: { attempt: 1, maxAttempts: 2 } }, true);
  assert.deepEqual(restoredRetry, { attempt: 1, maxAttempts: 2 });
  assert.equal(cards.get("running").startAt, 42);
  assert.equal(cards.get("unknown").state.textContent, "chat.card.unknown");
  assert.equal(finished.length, 1);
  assert.equal(finished[0][0], "done");
  assert.equal(bubbles.get("m").textContent, "partial");
});
