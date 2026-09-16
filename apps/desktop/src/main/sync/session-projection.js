import { randomUUID } from "node:crypto";

/** Recoverable UI state. This projection does not decide task terminal states. */
export class SessionProjection {
  // Sequence numbers restart when a host is reloaded, even within the same process.
  constructor({ sessionId = null, epoch = randomUUID(), now = Date.now } = {}) {
    this.sessionId = sessionId;
    this.runtimeEpoch = epoch;
    this.now = now;
    this.seq = 0;
    this.messages = new Map();
    this.tools = new Map();
    this.retry = null;
    this.taskId = null;
  }

  /** @param {any} payload */
  publish(payload) {
    // Own the data before applying it: callers and IPC recipients cannot mutate state.
    const event = structuredClone({ ...payload, sessionId: this.sessionId,
      runtimeEpoch: this.runtimeEpoch, seq: ++this.seq });
    // The switch envelope is itself the snapshot boundary, not an event to replay.
    if (event.type === "session_switched" && event.inFlight) {
      event.inFlight.runtimeEpoch = event.runtimeEpoch; event.inFlight.seq = event.seq;
    }
    switch (event.type) {
      case "agent_start":
        this.messages.clear();
        this.tools.clear();
        // The SDK emits agent_start again when a retry leaves backoff.
        // Keep that stage until auto_retry_end or a task boundary.
        break;
      case "task_state":
        if (this.taskId !== event.task?.id || !["queued", "running", "waiting_user", "stopping"].includes(event.task?.state)) this.retry = null;
        this.taskId = event.task?.id;
        break;
      case "message_delta":
        this.messages.set(event.key, { key: event.key, text: event.text ?? "", thinking: event.thinking ?? "" });
        break;
      case "message":
        this.messages.delete(event.key);
        break;
      case "tool_start":
        event.startedAt = this.now();
        this.tools.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName,
          args: event.args, state: "running", startedAt: event.startedAt });
        break;
      case "tool_end": {
        const previous = this.tools.get(event.toolCallId);
        event.startedAt = previous?.startedAt;
        event.finishedAt = this.now();
        this.tools.set(event.toolCallId, { ...previous, toolCallId: event.toolCallId,
          toolName: event.toolName, state: event.isError ? "failed" : "succeeded",
          finishedAt: event.finishedAt, result: event.result });
        break;
      }
      case "auto_retry_start":
        this.messages.clear();
        this.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts };
        break;
      case "auto_retry_end":
        this.retry = null;
        break;
    }
    // Terminal execution events intentionally preserve unresolved tools: no fake success.
    return structuredClone(event);
  }

  snapshot() {
    return structuredClone({ sessionId: this.sessionId, runtimeEpoch: this.runtimeEpoch,
      seq: this.seq, streaming: [...this.messages.values()], tools: [...this.tools.values()], retry: this.retry });
  }

}
