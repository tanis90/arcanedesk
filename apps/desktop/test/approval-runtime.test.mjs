import test from "node:test";
import assert from "node:assert/strict";
process.env.ARCANE_APPROVALS = "1";
const { AgentHost } = await import("../src/main/agent-host.js");
const { ExecutionScheduler } = await import("../src/main/scheduling/execution-scheduler.js");

test("enabled write approval is recoverable and stopping denies it without a stuck task", async () => {
  const events = [];
  const scheduler = new ExecutionScheduler({ capacity: 1 });
  const host = new AgentHost({ scheduler, sendToRenderer: event => events.push(event), log() {} });
  host.sessionManager = { getSessionId: () => "approval", getSessionName: () => "test" };
  host.session = { messages: [], prompt: async () => {
    await host.maybeRequestApproval({ tool: "write", summary: "Write a file" });
  }, abort: async () => {}, clearQueue() {} };
  const ack = host.submitInput("write", [], "command");
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(host.task.state, "waiting_user");
    assert.equal(scheduler.active.size, 0);
    assert.equal(host.currentPayload().approvals[0].summary, "Write a file");
    await host.abort(ack.taskId);
    assert.equal(host.task.state, "stopped");
    assert.equal(scheduler.active.size, 0);
    assert.equal(host.currentPayload().approvals.length, 0);
    assert.equal(events.find(event => event.type === "approval_resolved").approved, false);
  } finally { for (const id of host.approvals.keys()) host.respondApproval(id, false); }
});
