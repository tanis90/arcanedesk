import test from "node:test";
import assert from "node:assert/strict";
import { SessionProjection } from "../src/main/sync/session-projection.js";
import { AgentHost } from "../src/main/agent-host.js";

test("snapshot restores cumulative text, thinking and a tool's original start time", () => {
  let now = 10;
  const projection = new SessionProjection({ sessionId: "A", now: () => now });
  projection.publish({ type: "agent_start" });
  projection.publish({ type: "message_delta", key: "m", text: "half", thinking: "working" });
  projection.publish({ type: "tool_start", toolCallId: "t", toolName: "bash", args: { command: "job" } });
  now = 100;
  const snapshot = projection.snapshot();
  assert.equal(snapshot.streaming[0].text, "half");
  assert.equal(snapshot.streaming[0].thinking, "working");
  assert.equal(snapshot.tools[0].startedAt, 10);
  assert.equal(snapshot.tools[0].state, "running");
  projection.publish({ type: "agent_end" });
  assert.equal(projection.snapshot().tools[0].state, "running");
  projection.publish({ type: "tool_end", toolCallId: "t", toolName: "bash", isError: true });
  assert.equal(projection.snapshot().tools[0].state, "failed");
  assert.equal(projection.snapshot().tools[0].startedAt, 10);
});

test("retry discards failed draft; final message removes live duplicate", () => {
  const p = new SessionProjection();
  p.publish({ type: "message_delta", key: "a", text: "failed draft" });
  p.publish({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
  assert.deepEqual(p.snapshot().streaming, []);
  assert.deepEqual(p.snapshot().retry, { attempt: 1, maxAttempts: 3 });
  p.publish({ type: "auto_retry_end", success: true });
  p.publish({ type: "message_delta", key: "b", text: "good" });
  p.publish({ type: "message", key: "b", text: "good final" });
  assert.deepEqual(p.snapshot().streaming, []);
  assert.equal(p.snapshot().retry, null);
});

test("snapshot boundary supports replay; duplicates filtered and overflow requires snapshot", () => {
  const p = new SessionProjection({ epoch: "epoch", capacity: 2 });
  p.publish({ type: "message_delta", key: "m", text: "one" });
  const snapshot = p.snapshot();
  p.publish({ type: "message_delta", key: "m", text: "two" });
  p.publish({ type: "message", key: "m", text: "three" });
  const replay = p.sync({ runtimeEpoch: snapshot.runtimeEpoch, afterSeq: snapshot.seq });
  assert.equal(replay.kind, "events");
  assert.deepEqual(replay.events.map(e => e.seq), [2, 3]);
  assert.deepEqual(p.sync({ runtimeEpoch: "epoch", afterSeq: 3 }).events, []);
  assert.equal(p.sync({ runtimeEpoch: "epoch", afterSeq: 0 }).kind, "snapshot");
  assert.equal(p.sync({ runtimeEpoch: "old", afterSeq: 3 }).kind, "snapshot");
  assert.equal(p.sync({ runtimeEpoch: "epoch", afterSeq: 4 }).kind, "snapshot");
});

test("callers, delivered events and snapshot consumers cannot mutate retained state", () => {
  const p = new SessionProjection({ epoch: "epoch" });
  const args = { command: "original" };
  const delivered = p.publish({ type: "tool_start", toolCallId: "t", args });
  args.command = "mutated input";
  delivered.args.command = "mutated output";
  const snapshot = p.snapshot();
  snapshot.tools[0].args.command = "mutated snapshot";
  const replay = p.sync({ runtimeEpoch: "epoch", afterSeq: 0 });
  replay.events[0].args.command = "mutated replay";
  assert.equal(p.snapshot().tools[0].args.command, "original");
});

test("real host event translation includes recoverable in-flight text absent from history", () => {
  const events = [];
  const host = new AgentHost({ sendToRenderer: e => events.push(e), log: () => {} });
  host.session = { messages: [] };
  host.forwardEvent({ type: "agent_start" });
  host.forwardEvent({ type: "message_update", message: { role: "assistant", timestamp: 42,
    content: [{ type: "text", text: "unfinished" }] } });
  const snapshot = host.currentPayload();
  assert.deepEqual(snapshot.history, []);
  assert.equal(snapshot.inFlight.streaming[0].text, "unfinished");
  assert.equal(snapshot.inFlight.seq, events.at(-1).seq);
  assert.equal(snapshot.inFlight.runtimeEpoch, events.at(-1).runtimeEpoch);
});
