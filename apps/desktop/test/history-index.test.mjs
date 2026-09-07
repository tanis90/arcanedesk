import test from "node:test";
import assert from "node:assert/strict";
import { HistoryIndex } from "../src/main/sync/history-index.js";
import { AgentHost } from "../src/main/agent-host.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const records = count => Array.from({ length: count }, (_, i) => ({ id: String(i), message: { role: "user", timestamp: i, content: `Message ${i}` } }));

test("stable cursors walk a 10000-message history without gaps or duplicates", () => {
  const index = new HistoryIndex(records(10000));
  let page = index.page({ limit: 200 });
  assert.equal(page.history.length, 200); assert.equal(page.historyPage.hasNewer, false);
  const keys = page.history.map(row => row.key);
  while (page.historyPage.hasOlder) {
    page = index.page({ before: page.historyPage.firstKey, limit: 200 });
    keys.unshift(...page.history.map(row => row.key));
  }
  assert.deepEqual(keys, records(10000).map(record => `entry:${record.id}`));
  const next = index.page({ after: "entry:199", limit: 100 });
  assert.equal(next.history[0].key, "entry:200"); assert.equal(next.history.at(-1).key, "entry:299");
  assert.deepEqual(index.page({ before: "entry:0" }).history, []);
  assert.deepEqual(index.page({ after: "entry:9999" }).history, []);
});

test("around restores native, legacy, thinking and tool anchors; invalid or missing cursors are explicit", () => {
  const data = records(500);
  data[250] = { id: "250", message: { role: "assistant", timestamp: 250, content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] } };
  const index = new HistoryIndex(data);
  for (const around of ["entry:250", "assistant:250", "think:entry:250", "tool:t", "work:tool:t"]) {
    const page = index.page({ around, limit: 20 });
    assert.equal(page.history.length, 20); assert.equal(page.history[10].key, "entry:250");
    assert.equal(page.historyPage.hasOlder, true); assert.equal(page.historyPage.hasNewer, true);
  }
  for (const query of [null, [], "path", { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "100" }, { before: "" }, { before: "x", after: "y" }, { path: "file" }]) {
    assert.throws(() => index.page(query), { code: "INVALID_HISTORY_QUERY" });
  }
  assert.throws(() => index.page({ around: "not-on-branch" }), { code: "HISTORY_CURSOR_NOT_FOUND" });
});

test("tools retain results outside their page and reused IDs attach only to their preceding call", () => {
  const call = id => ({ id, message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: id } }] } });
  const result = text => ({ message: { role: "toolResult", toolCallId: "t", isError: false, content: [{ type: "text", text }] } });
  const index = new HistoryIndex([call("first"), result("first result"), ...records(50), call("second"), result("second result")]);
  const first = index.page({ around: "entry:first", limit: 1 });
  assert.equal(first.history[0].toolCalls[0].resultText, "first result");
  assert.equal(index.page({ limit: 1 }).history[0].toolCalls[0].resultText, "second result");
  first.history[0].toolCalls[0].args.command = "mutated";
  assert.equal(index.page({ around: "entry:first", limit: 1 }).history[0].toolCalls[0].args.command, "first");
});

test("native host caches a branch index, refreshes on append/result and rejects a cursor removed by branching", () => {
  const host = new AgentHost({ sendToRenderer() {}, log() {} });
  const manager = SessionManager.inMemory();
  host.sessionManager = manager; host.session = { messages: [] };
  const first = manager.appendMessage({ role: "user", timestamp: 1, content: "first" });
  const originalBranch = manager.getBranch.bind(manager); let reads = 0;
  manager.getBranch = (...args) => { reads++; return originalBranch(...args); };
  host.currentPayload({ limit: 1 }); host.currentPayload({ limit: 1 });
  assert.equal(reads, 1);
  const second = manager.appendMessage({ role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "running", name: "bash", arguments: {} }] });
  assert.equal(host.currentPayload({ limit: 1 }).history[0].toolCalls[0].hasResult, false);
  manager.appendMessage({ role: "toolResult", toolCallId: "running", content: [{ type: "text", text: "done" }], timestamp: 3, isError: false });
  assert.equal(host.currentPayload({ limit: 1 }).history[0].toolCalls[0].resultText, "done");
  assert.equal(reads, 3);
  manager.branch(first);
  assert.throws(() => host.currentPayload({ around: `entry:${second}` }), { code: "HISTORY_CURSOR_NOT_FOUND" });
  assert.equal(host.currentPayload({}).historyPage.total, 1);
});
