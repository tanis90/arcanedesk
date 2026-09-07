import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { InputJournal } from "./tasks/input-journal.js";

/** One instance per resident session. Never replay a dispatched operation after restart. */
export class FoundryOperationStore {
  constructor({ directory, sessionId }) {
    if (!directory || !/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId ?? "")) {
      throw new TypeError("An operation directory and safe session ID are required");
    }
    this.sessionId = sessionId;
    this.journal = new InputJournal(path.join(directory, `${sessionId}.jsonl`));
    this.operations = new Map();
    this.inflight = new Map();
    for (const record of this.journal.records) {
      if (record.sessionId !== sessionId || !record.key || !record.operationRef) {
        throw new Error("Invalid Foundry operation history");
      }
      if (record.kind === "dispatch") this.operations.set(record.key, record);
      else if (record.kind === "result") {
        const prior = this.operations.get(record.key);
        if (!prior || prior.operationRef !== record.operationRef) throw new Error("Orphan Foundry result");
        prior.result = record.result;
      } else throw new Error("Unknown Foundry operation record");
    }
  }

  uncertain(operationRef, message = "Execution was dispatched; its final result is unknown. Do not retry.") {
    return { status: "indeterminate", operationRef, retry: false, steps: [], message };
  }

  lookup(operationRef) {
    const record = [...this.operations.values()].find(value => value.operationRef === operationRef);
    return record ? structuredClone(record.result ?? this.uncertain(operationRef)) : null;
  }

  /** Caller admits resources and validates before invoking this dispatch boundary. */
  execute({ taskId, toolCallId, world, action, args }, dispatch) {
    if (!taskId || !toolCallId || !world?.origin || !world?.id || typeof dispatch !== "function") {
      return Promise.reject(new TypeError("Foundry writes require task, tool call and bound world identities"));
    }
    const key = JSON.stringify([taskId, toolCallId]);
    const digest = createHash("sha256").update(JSON.stringify({ world, action, args })).digest("hex");
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.digest !== digest) return Promise.reject(new Error("TOOL_CALL_CONFLICT: same call has different arguments"));
      return this.inflight.get(key) ?? Promise.resolve(structuredClone(prior.result ?? this.uncertain(prior.operationRef)));
    }
    const operationRef = randomUUID();
    const record = { kind: "dispatch", sessionId: this.sessionId, key, operationRef,
      requestId: operationRef, world, action, digest };
    // A failed append must prevent dispatch; no in-memory success can conceal a disk failure.
    try { this.journal.append(record); }
    catch (error) { return Promise.reject(error); }
    this.operations.set(key, record);
    const pending = Promise.resolve().then(async () => {
      let result;
      try {
        const value = await dispatch({ requestId: operationRef });
        if (!value || !["completed", "rejected", "partial", "indeterminate"].includes(value.status)) {
          result = this.uncertain(operationRef, "Runtime returned no valid completion receipt. Do not retry.");
        } else {
          result = { ...value, operationRef,
            ...(["partial", "indeterminate"].includes(value.status) ? { retry: false } : {}) };
        }
      } catch {
        result = this.uncertain(operationRef);
      }
      try {
        this.journal.append({ kind: "result", sessionId: this.sessionId, key, operationRef, result });
      } catch {
        // The dispatch is durable but completion is not. Recovery must stay non-replayable.
        result = this.uncertain(operationRef, "Could not persist completion. Do not retry; inspect the original operation.");
      }
      record.result = result;
      return structuredClone(result);
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }
}
