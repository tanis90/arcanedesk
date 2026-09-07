import { createHash, randomUUID } from "node:crypto";
import { InputJournal } from "./input-journal.js";
import { TaskAdmission } from "../scheduling/execution-scheduler.js";

const activeStates = new Set(["running", "stopping", "waiting_user", "queued", "waiting_resource"]);
const pendingStates = new Set(["accepted", "queued", "dispatching", "context"]);
const messageText = message => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("");

/** One owner for a session's commands and task lifecycle. No view selection state. */
export class TaskCoordinator {
  /** @param {{sessionId: string, adapter: any, emit?: (event: any) => void, journal?: InputJournal, scheduler?: any}} options */
  constructor({ sessionId, adapter, emit = () => {}, journal = new InputJournal(), scheduler = null }) {
    this.scheduler = scheduler; this.admission = null;
    this.resourceWaits = new Map();
    this.sessionId = sessionId;
    this.adapter = adapter;
    this.emit = emit;
    this.journal = journal;
    this.commands = new Map();
    this.inputs = new Map();
    this.task = null;
    this.run = null;
    this.dispatching = null;
    this.queueing = null;
    this.normalEnd = false;
    this.aborted = false;
    this.lastError = null;
    this.queueWrites = new Set();
    this.attentions = new Map();
    this.attentionResolvers = new Map();
    this.pendingModel = null;
    for (const record of journal.records) {
      if (record.type === "checkpoint") {
        if (record.version !== 1) throw new Error("Unsupported task checkpoint");
        this.commands = new Map(record.commands);
        this.inputs = new Map(record.inputs.map(input => [input.id, input]));
        this.attentions = new Map(record.attentions.map(attention => [attention.id, attention]));
        this.task = record.task; this.pendingModel = record.pendingModel;
      } else if (record.type === "accepted") {
        this.commands.set(record.commandId, record);
        this.inputs.set(record.input.id, record.input);
        this.task = record.task;
      } else if (record.type === "input_state") {
        const input = this.inputs.get(record.inputId);
        if (input) input.state = record.state;
      } else if (record.type === "task_state") this.task = record.task;
      else if (record.type === "attention") this.attentions.set(record.attention.id, record.attention);
      else if (record.type === "response") {
        this.commands.set(record.commandId, record);
        this.attentions.set(record.attention.id, record.attention);
      } else if (record.type === "pending_model") this.pendingModel = record.model;
    }
    if (this.busy) {
      this.setTaskState("interrupted");
      for (const input of this.inputs.values()) if (pendingStates.has(input.state)) this.setInputState(input, "interrupted");
    }
    for (const attention of this.attentions.values()) {
      if (attention.state === "pending") this.updateAttention({ ...attention, state: "interrupted" });
    }
    this.compact();
  }

  get busy() { return activeStates.has(this.task?.state); }
  compact(force = false) {
    if (this.busy || typeof this.journal.compact !== "function") return false;
    const consumed = input => ["consumed", "handled"].includes(input.state);
    if (!force && this.journal.records.length < 128 && ![...this.inputs.values()].some(input => consumed(input) && input.images?.length)) return false;
    const commands = /** @type {Array<[any, any]>} */ ([...this.commands].map(([id, record]) => [id, { fingerprint: record.fingerprint, ack: record.ack }]));
    const inputs = [...this.inputs.values()].map(input => {
      if (!consumed(input)) return { ...input };
      const { images: _images, executionText: _execution, expandedText: _expanded, ...state } = input;
      return state;
    });
    try {
      this.journal.compact([{ type: "checkpoint", version: 1, commands, inputs, task: this.task,
        attentions: [...this.attentions.values()], pendingModel: this.pendingModel }]);
      this.commands = new Map(commands); this.inputs = new Map(inputs.map(input => [input.id, input]));
      this.compactionError = null; return true;
    } catch (error) { this.compactionError = error.message; return false; }
  }
  snapshotAttentions() { return structuredClone([...this.attentions.values()]); }
  setPendingModel(model) {
    this.journal.append({ type: "pending_model", model });
    this.pendingModel = model ? { ...model } : null;
    this.emit({ type: "model_pending", model: this.pendingModel });
  }
  updateAttention(attention) {
    this.journal.append({ type: "attention", attention });
    this.attentions.set(attention.id, attention);
    this.emit({ type: "attention", attention: structuredClone(attention) });
  }

  ask({ question, options = [] }, signal) {
    if (!this.busy || this.task.state === "stopping" || signal?.aborted) return Promise.resolve({ cancelled: true });
    if (typeof question !== "string" || !question.trim() || question.length > 12000) throw new Error("Invalid question");
    if (!Array.isArray(options) || options.length > 8 || options.some(option => typeof option !== "string" || option.length > 1000)) throw new Error("Invalid answer options");
    const attention = { id: randomUUID(), taskId: this.task.id, question, options: [...options], state: "pending", createdAt: Date.now() };
    this.updateAttention(attention);
    this.setTaskState("waiting_user");
    const pending = new Promise(resolve => {
      const cancel = () => this.cancelAttention(attention.id);
      this.attentionResolvers.set(attention.id, response => {
        signal?.removeEventListener("abort", cancel);
        resolve(response);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    return this.admission ? this.admission.waitForUser(pending).catch(() => ({ cancelled: true })) : pending;
  }

  cancelAttention(id) {
    const attention = this.attentions.get(id);
    if (!attention || attention.state !== "pending") return;
    this.updateAttention({ ...attention, state: "cancelled" });
    this.attentionResolvers.get(id)?.({ cancelled: true });
    this.attentionResolvers.delete(id);
  }

  respond({ commandId, taskId, attentionId, response }) {
    if (typeof commandId !== "string" || !commandId || typeof response !== "string" || !response.trim() || response.length > 20000) {
      return { ok: false, code: "INVALID_RESPONSE" };
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ taskId, attentionId, response })).digest("hex");
    const previous = this.commands.get(commandId);
    if (previous) return previous.fingerprint === fingerprint ? { ...previous.ack, duplicate: true } : { ok: false, code: "COMMAND_CONFLICT" };
    const attention = this.attentions.get(attentionId);
    if (taskId !== this.task?.id || attention?.taskId !== taskId || attention.state !== "pending" || !this.attentionResolvers.has(attentionId) || this.task.state === "stopping") {
      return { ok: false, code: "STALE_ATTENTION" };
    }
    const answered = { ...attention, state: "answered", response, answeredAt: Date.now() };
    const ack = { ok: true, commandId, sessionId: this.sessionId, taskId, attentionId };
    const record = { type: "response", commandId, fingerprint, attention: answered, ack };
    this.journal.append(record);
    this.commands.set(commandId, record);
    this.attentions.set(attentionId, answered);
    this.emit({ type: "attention", attention: structuredClone(answered) });
    if (!this.admission && ![...this.attentions.values()].some(a => a.taskId === taskId && a.state === "pending")) this.setTaskState("running");
    this.attentionResolvers.get(attentionId)({ response });
    this.attentionResolvers.delete(attentionId);
    return ack;
  }
  snapshotInputs() {
    return [...this.inputs.values()].map(({ id, commandId, taskId, state, text, messageKey }) => ({ id, commandId, taskId, state, text, messageKey }));
  }
  resourceWaiting(id, details) {
    if (details) this.resourceWaits.set(id, details); else this.resourceWaits.delete(id);
    if (!this.busy || ["stopping", "waiting_user", "queued"].includes(this.task.state)) return;
    if (this.resourceWaits.size) this.setTaskState("waiting_resource");
    else if (this.task.state === "waiting_resource") this.setTaskState("running");
  }
  setTaskState(state, error = null) {
    this.task = { ...this.task, state, error, waitingFor: state === "waiting_resource" ? this.resourceWaits.values().next().value : null,
      endedAt: activeStates.has(state) ? null : Date.now() };
    this.journal.append({ type: "task_state", task: this.task });
    this.emit({ type: "task_state", task: { ...this.task } });
  }
  setInputState(input, state) {
    this.journal.append({ type: "input_state", inputId: input.id, state });
    input.state = state;
    this.emit({ type: "input_state", inputId: input.id, commandId: input.commandId, taskId: input.taskId, state });
  }

  /** Accept synchronously after durable registration; execution is asynchronous. */
  submit({ commandId = randomUUID(), text, images = [], prepare = null }) {
    const fingerprint = createHash("sha256").update(JSON.stringify({ text, images })).digest("hex");
    const previous = this.commands.get(commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: "COMMAND_CONFLICT", error: "Command content changed" };
      return { ...previous.ack, duplicate: true };
    }
    if (this.task?.state === "stopping") return { ok: false, code: "TASK_STOPPING", error: "Task is stopping" };
    const executionText = prepare ? prepare(text, images) : text;
    const supplement = this.busy;
    const task = supplement ? this.task : { id: randomUUID(), state: this.scheduler ? "queued" : "running", startedAt: Date.now(), endedAt: null, modelToApply: this.pendingModel };
    const input = { id: randomUUID(), commandId, taskId: task.id, text, executionText, images, state: "accepted", expandedText: null };
    const ack = { ok: true, status: "accepted", commandId, inputId: input.id, sessionId: this.sessionId,
      taskId: task.id, disposition: supplement ? "supplement" : "new_task" };
    const record = { type: "accepted", commandId, fingerprint, input, task, ack };
    this.journal.append(record);
    this.commands.set(commandId, record);
    this.inputs.set(input.id, input);
    this.task = task;
    if (!supplement) this.resourceWaits.clear();
    if (!supplement && this.scheduler) this.admission = new TaskAdmission(this.scheduler,
      { sessionId: this.sessionId, taskId: task.id }, state => {
        if (this.task?.id === task.id && this.busy && this.task.state !== "stopping" && this.task.state !== state) this.setTaskState(state);
      });
    this.emit({ type: "task_state", task: { ...task } });
    this.emit({ type: "input_state", inputId: input.id, commandId, taskId: task.id, state: "accepted" });
    if (!this.run) this.schedule();
    else if (supplement && this.adapter.isStreaming?.()) {
      this.queueSteer(input);
    }
    return ack;
  }

  schedule() {
    const taskId = this.task.id;
    this.run = Promise.resolve().then(() => this.drain(taskId)).catch(error => {
      // Persistence failures must stop scheduling, not spin retrying the same write.
      this.task = { ...this.task, state: "failed", error: error.message, endedAt: Date.now() };
      this.emit({ type: "task_state", task: { ...this.task } });
    }).finally(() => {
      this.run = null;
      if (this.busy && [...this.inputs.values()].some(i => i.taskId === this.task.id && pendingStates.has(i.state))) this.schedule();
      else this.compact();
    });
    this.run.catch(() => {});
  }

  queueSteer(input) {
    this.queueing = input;
    let pending;
    try { pending = this.adapter.steer(input.executionText ?? input.text, input.images); }
    catch { pending = Promise.reject(new Error("Unable to queue input")); }
    this.queueing = null;
    const write = Promise.resolve(pending).catch(() => {
      // The app retains this input and will dispatch it after the current run.
      if (input.state === "queued") this.setInputState(input, "accepted");
    }).finally(() => this.queueWrites.delete(write));
    this.queueWrites.add(write);
  }

  observe(event) {
    if (!this.busy) return;
    if (event.type === "queue_update" && this.queueing && event.steering?.length) {
      this.queueing.expandedText = event.steering.at(-1);
      this.setInputState(this.queueing, "queued");
    }
    if (event.type === "message_start" && event.message?.role === "user") {
      const text = messageText(event.message);
      let input = [...this.inputs.values()].find(i => i.taskId === this.task.id && i.state === "queued" && i.expandedText === text);
      if (!input && this.dispatching && this.dispatching.state === "dispatching") input = this.dispatching;
      if (input) {
        input.messageKey = event.message.arcaneMessageKey ?? `user:${event.message.timestamp}`;
        this.setInputState(input, "context");
      }
    }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      // A user message can enter SDK history during abort without a model call.
      // Only an assistant stream starting proves the queued context reached a model.
      for (const input of this.inputs.values()) {
        if (input.taskId === this.task.id && input.state === "context") this.setInputState(input, "consumed");
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.aborted ||= event.message.stopReason === "aborted";
      if (event.message.errorMessage && event.message.stopReason !== "aborted") this.lastError = event.message.errorMessage;
    }
    if (event.type === "agent_end" && !event.willRetry) this.normalEnd = !this.aborted && !this.lastError;
    if (event.type === "auto_retry_start") this.normalEnd = false;
    if (event.type === "auto_retry_end" && event.success) this.lastError = null;
  }

  async drain(taskId) {
    const admission = this.admission;
    try {
      await admission?.acquire();
      if (admission?.controller.signal.aborted) throw new Error("Execution cancelled");
      if (admission) admission.started = true;
      await this.adapter.beginTask?.(this.task.modelToApply);
      while (this.task.id === taskId && this.task.state !== "stopping") {
        const input = [...this.inputs.values()].find(i => i.taskId === taskId && pendingStates.has(i.state));
        if (!input) break;
        this.adapter.clearQueue?.();
        this.normalEnd = false; this.aborted = false; this.lastError = null;
        this.dispatching = input;
        this.setInputState(input, "dispatching");
        await this.adapter.prompt(input.executionText ?? input.text, input.images);
        await this.adapter.settleTask?.(taskId);
        await Promise.all([...this.queueWrites]);
        if (input.state === "dispatching") this.setInputState(input, "handled"); // extension commands may consume input without a model message
        this.dispatching = null;
        if (this.aborted) { this.setTaskState("stopping"); break; }
        if (this.lastError) throw new Error(this.lastError);
      }
      this.adapter.clearQueue?.();
      const hasPending = [...this.inputs.values()].some(i => i.taskId === taskId && pendingStates.has(i.state));
      const state = this.task.state === "stopping" && !(this.normalEnd && !this.aborted && !hasPending) ? "stopped" : "completed";
      for (const input of this.inputs.values()) {
        if (input.taskId === taskId && pendingStates.has(input.state)) this.setInputState(input, "cancelled");
      }
      this.setTaskState(state);
    } catch (error) {
      this.adapter.clearQueue?.();
      await this.adapter.settleTask?.(taskId);
      for (const input of this.inputs.values()) {
        if (input.taskId === taskId && pendingStates.has(input.state)) this.setInputState(input, this.task.state === "stopping" ? "cancelled" : "failed");
      }
      this.setTaskState(this.task.state === "stopping" ? admission && !admission.started ? "cancelled" : "stopped" : "failed", error.message);
    } finally { this.dispatching = null; admission?.release(); }
  }

  async stop(taskId) {
    if (taskId && taskId !== this.task?.id) return { ok: false, code: "STALE_TASK" };
    if (!this.busy) return { ok: true, task: this.task };
    this.setTaskState("stopping");
    this.admission?.cancel();
    for (const id of this.attentionResolvers.keys()) this.cancelAttention(id);
    this.adapter.clearQueue?.();
    await this.adapter.abort();
    this.adapter.clearQueue?.();
    await this.run;
    return { ok: true, task: this.task };
  }
}
