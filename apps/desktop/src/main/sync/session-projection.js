import { randomUUID } from "node:crypto";

/** Recoverable UI state. This projection does not decide task terminal states. */
export class SessionProjection {
  // Sequence numbers restart when a host is reloaded, even within the same process.
  constructor({ sessionId = null, capacity = 256, epoch = randomUUID(), now = Date.now } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be positive");
    this.sessionId = sessionId;
    this.runtimeEpoch = epoch;
    this.capacity = capacity;
    this.now = now;
    this.seq = 0;
    this.messages = new Map();
    this.tools = new Map();
    this.retry = null;
    this.events = [];
  }

  /** @param {any} payload */
  publish(payload) {
    // Own the data before applying it: callers and IPC recipients cannot mutate state.
    const event = structuredClone({ ...payload, sessionId: this.sessionId,
      runtimeEpoch: this.runtimeEpoch, seq: ++this.seq });
    switch (event.type) {
      case "agent_start":
        this.messages.clear();
        this.tools.clear();
        this.retry = null;
        break;
      case "message_delta":
        this.messages.set(event.key, { key: event.key, text: event.text ?? "", thinking: event.thinking ?? "" });
        break;
      case "message":
        this.messages.delete(event.key);
        break;
      case "tool_start":
        this.tools.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName,
          args: event.args, state: "running", startedAt: this.now() });
        break;
      case "tool_end": {
        const previous = this.tools.get(event.toolCallId);
        this.tools.set(event.toolCallId, { ...previous, toolCallId: event.toolCallId,
          toolName: event.toolName, state: event.isError ? "failed" : "succeeded",
          finishedAt: this.now(), result: event.result });
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
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    return structuredClone(event);
  }

  snapshot() {
    return structuredClone({ sessionId: this.sessionId, runtimeEpoch: this.runtimeEpoch,
      seq: this.seq, streaming: [...this.messages.values()], tools: [...this.tools.values()], retry: this.retry });
  }

  /** @param {{ runtimeEpoch?: string, afterSeq?: number }} [cursor] */
  sync({ runtimeEpoch: epoch, afterSeq } = {}) {
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (epoch !== this.runtimeEpoch || !Number.isInteger(afterSeq) || afterSeq < oldest - 1 || afterSeq > this.seq) {
      return { kind: "snapshot", snapshot: this.snapshot() };
    }
    return { kind: "events", sessionId: this.sessionId, runtimeEpoch: this.runtimeEpoch,
      seq: this.seq, events: structuredClone(this.events.filter(event => event.seq > afterSeq)) };
  }
}
