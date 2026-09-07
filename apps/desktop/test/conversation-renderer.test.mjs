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

test("fresh snapshots replace a reclaimed runtime even without a new event; late old events stay retired", () => {
  const { EventInbox } = stateClasses();
  const inbox = new EventInbox();
  inbox.record({ sessionId: "A", runtimeEpoch: "old", seq: 99 });
  const observed = inbox.epoch("A");
  assert.equal(inbox.acceptSnapshot("A", "new"), false, "cache cannot declare a new runtime");
  assert.equal(inbox.acceptSnapshot("A", "new", observed), true);
  assert.equal(inbox.after("A", "new", 0).length, 0);
  assert.equal(inbox.record({ sessionId: "A", runtimeEpoch: "old", seq: 100 }), false);
  assert.equal(inbox.acceptSnapshot("A", "old", "new"), false);
  inbox.record({ sessionId: "A", runtimeEpoch: "new", seq: 1 });
  assert.equal(inbox.after("A", "new", 0).length, 1);
});

test("snapshot request overtaken by another runtime cannot retire its newer events", () => {
  const { EventInbox } = stateClasses();
  const inbox = new EventInbox();
  assert.equal(inbox.acceptSnapshot("A", "old"), true);
  const observed = inbox.epoch("A");
  inbox.record({ sessionId: "A", runtimeEpoch: "newest", seq: 1 });
  assert.equal(inbox.acceptSnapshot("A", "middle", observed), false);
  assert.equal(inbox.epoch("A"), "newest");
  assert.equal(inbox.acceptSnapshot("A", "newest", observed), true);
  assert.equal(inbox.after("A", "newest", 0).length, 1);
});

test("deleted session events cannot recreate an inbox entry", () => {
  const { EventInbox } = stateClasses();
  const inbox = new EventInbox();
  inbox.record({ sessionId: "A", runtimeEpoch: "old", seq: 1 });
  inbox.remove("A"); inbox.record({ sessionId: "A", runtimeEpoch: "new", seq: 2 });
  assert.equal(inbox.sessions.has("A"), false); assert.equal(inbox.retiredEpochs.has("A"), false);
});

test("events arriving before snapshot installation replay once in order", () => {
  const { EventInbox } = stateClasses();
  const inbox = new EventInbox();
  for (const seq of [3, 2, 3, 1]) inbox.record({ sessionId: "A", runtimeEpoch: "e", seq });
  assert.equal(JSON.stringify(inbox.after("A", "e", 1).map(e => e.seq)), "[2,3]");
  assert.equal(JSON.stringify(inbox.after("A", "e", 3)), "[]");
  assert.equal(inbox.after("A", "old", 1), null);
});

test("missing or evicted events require a new snapshot, never partial replay", () => {
  const { EventInbox } = stateClasses();
  const inbox = new EventInbox(2);
  for (const seq of [1, 2, 3]) inbox.record({ sessionId: "A", runtimeEpoch: "e", seq });
  assert.equal(inbox.after("A", "e", 0), null);
  assert.equal(inbox.after("A", "e", 1).length, 2);
  inbox.record({ sessionId: "B", runtimeEpoch: "e", seq: 3 });
  assert.equal(inbox.after("B", "e", 1), null);
  assert.equal(inbox.after("A", "e", 1).length, 2);
});

test("a delayed event from a retired runtime does not replace the new epoch", () => {
  const { EventInbox } = stateClasses();
  const inbox = new EventInbox();
  inbox.record({ sessionId: "A", runtimeEpoch: "old", seq: 99 });
  inbox.record({ sessionId: "A", runtimeEpoch: "new", seq: 1 });
  inbox.record({ sessionId: "A", runtimeEpoch: "old", seq: 100 });
  assert.equal(inbox.after("A", "new", 0)[0].runtimeEpoch, "new");
});

test("workspace drafts and attachments are isolated even when persistent storage fails", async () => {
  const { WorkspaceStore } = stateClasses();
  const store = new WorkspaceStore(null);
  const value = { draft: "A", images: [{ data: "image-A" }], anchor: { key: "m1", offset: 10 } };
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
  const handler = chatSource.slice(chatSource.indexOf("function renderHistory(entries"), chatSource.indexOf("let currentSessionRequest"));
  const context = vm.createContext({
    resetConversation() {}, showWelcome() {}, closeWorkBlock() {}, addMessage() {}, renderThinkingHistory() {},
    setBusy() {}, t: key => key, toolCards: cards,
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
    streaming: [{ key: "m", text: "partial" }] }, true);
  assert.equal(cards.get("running").startAt, 42);
  assert.equal(cards.get("unknown").state.textContent, "chat.card.unknown");
  assert.equal(finished.length, 1);
  assert.equal(finished[0][0], "done");
  assert.equal(bubbles.get("m").textContent, "partial");
});
