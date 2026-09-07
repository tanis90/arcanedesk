import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { MessageIdentity, messageKey } from "../src/main/sync/message-identity.js";

test("stream clones, finalization and turn_end share identity; the next same-time message differs", () => {
  const identities = new MessageIdentity();
  const start = { role: "assistant", timestamp: 1, content: [] };
  identities.observe({ type: "message_start", message: start });
  for (const type of ["message_update", "message_end", "turn_end"]) {
    const clone = { role: "assistant", timestamp: 1, content: [{ type: "text", text: type }] };
    identities.observe({ type, message: clone });
    assert.equal(messageKey(clone), messageKey(start));
  }
  const next = { role: "assistant", timestamp: 1, content: [] };
  identities.observe({ type: "message_start", message: next });
  assert.notEqual(messageKey(next), messageKey(start));
});

test("legacy entry identities distinguish timestamp collisions and retain history after native compaction", () => {
  const manager = SessionManager.inMemory();
  const first = manager.appendMessage({ role: "user", timestamp: 1, content: "early" });
  const second = manager.appendMessage({ role: "user", timestamp: 1, content: "keep" });
  manager.appendCompaction("summary", second, 1000);
  const host = new AgentHost({ sendToRenderer() {}, log() {} });
  host.sessionManager = manager;
  host.session = { messages: manager.buildSessionContext().messages };
  assert.equal(host.session.messages.some(message => message.content === "early"), false);
  const history = host.buildHistory();
  assert.deepEqual(history.map(row => row.text), ["early", "keep"]);
  assert.deepEqual(history.map(row => row.key), [`entry:${first}`, `entry:${second}`]);
  assert.equal(history[0].legacyKey, "user:1");
  manager.branch(first);
  assert.deepEqual(host.buildHistory().map(row => row.key), [`entry:${first}`]);
});
