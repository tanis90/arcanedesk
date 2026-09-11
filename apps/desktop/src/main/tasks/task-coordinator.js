import { createHash, randomUUID } from "node:crypto";
import { PendingInputs } from "./pending-inputs.js";
import { TaskAdmission } from "../scheduling/execution-scheduler.js";

const activeStates = new Set(["running", "stopping", "waiting_user", "queued"]);
const pendingStates = new Set(["accepted", "queued", "dispatching", "context"]);
const messageText = message => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("");

/** One owner for a session's commands and task lifecycle. No view selection state. */
export class TaskCoordinator {
  /** @param {{sessionId: string, adapter: any, emit?: (event: any) => void, pending?: PendingInputs, pendingModel?: any, saveModel?: (model: any) => void, scheduler?: any}} options */
  constructor({ sessionId, adapter, emit = () => {}, pending = new PendingInputs(), pendingModel = null, saveModel = () => {}, scheduler = null }) {
    this.scheduler = scheduler; this.admission = null;
    this.sessionId = sessionId;
    this.adapter = adapter;
    this.emit = emit;
    this.pending = pending;
    this.saveModel = saveModel;
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
    this.userWaits = 0;
    this.pendingModel = pendingModel;
    for (const input of pending.inputs) this.inputs.set(input.id, { ...input, state: "interrupted" });
  }

  get busy() { return activeStates.has(this.task?.state); }
  snapshotAttentions() { return structuredClone([...this.attentions.values()]); }
  setPendingModel(model) {
    this.saveModel(model);
    this.pendingModel = model ? { ...model } : null;
    this.emit({ type: "model_pending", model: this.pendingModel });
  }
  updateAttention(attention) {
    this.attentions.set(attention.id, attention);
    this.emit({ type: "attention", attention: structuredClone(attention) });
  }

  ask({ question, options = [] }, signal) {
    if (!this.busy || this.task.state === "stopping" || signal?.aborted) return Promise.resolve({ cancelled: true });
    if (typeof question !== "string" || !question.trim() || question.length > 12000) throw new Error("Invalid question");
    if (!Array.isArray(options) || options.length > 8 || options.some(option => typeof option !== "string" || option.length > 1000)) throw new Error("Invalid answer options");
    const attention = { id: randomUUID(), taskId: this.task.id, question, options: [...options], state: "pending", createdAt: Date.now() };
    this.updateAttention(attention);
    const pending = new Promise(resolve => {
      const cancel = () => this.cancelAttention(attention.id);
      this.attentionResolvers.set(attention.id, response => {
        signal?.removeEventListener("abort", cancel);
        resolve(response);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    return this.waitForUser(pending).catch(() => ({ cancelled: true }));
  }

  async waitForUser(pending) {
    this.userWaits++;
    if (!this.admission && this.busy && this.task.state !== "stopping") this.setTaskState("waiting_user");
    try { return await (this.admission ? this.admission.waitForUser(pending) : pending); }
    finally {
      this.userWaits--;
      if (!this.admission && !this.userWaits && this.task?.state === "waiting_user") this.setTaskState("running");
    }
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
    this.commands.set(commandId, record);
    this.attentions.set(attentionId, answered);
    this.emit({ type: "attention", attention: structuredClone(answered) });
    this.attentionResolvers.get(attentionId)({ response });
    this.attentionResolvers.delete(attentionId);
    return ack;
  }
  snapshotInputCommandIds() { return [...this.inputs.values()].map(input => input.commandId); }
  snapshotInputs(messageKeys = null) {
    return [...this.inputs.values()].filter(input => !messageKeys || messageKeys.has(input.messageKey)
      || !["consumed", "handled"].includes(input.state))
      .map(({ id, commandId, taskId, state, text, images, messageKey }) =>
        ({ id, commandId, taskId, state, text, images: state === "interrupted" ? images : undefined, messageKey }));
  }
  setTaskState(state, error = null) {
    this.task = { ...this.task, state, error, endedAt: activeStates.has(state) ? null : Date.now() };
    this.emit({ type: "task_state", task: { ...this.task } });
  }
  setInputState(input, state) {
    if (["consumed", "handled"].includes(state)) {
      this.pending.save([...this.inputs.values()].filter(item => item.id !== input.id));
      delete input.images; delete input.executionText; delete input.expandedText;
    }
    input.state = state;
    this.emit({ type: "input_state", inputId: input.id, commandId: input.commandId, taskId: input.taskId, state });
  }

  /** Accept synchronously after durable registration; execution is asynchronous. */
  submit({ commandId = randomUUID(), text, images = [], prepare = null, replacesInputId = null }) {
    const fingerprint = createHash("sha256").update(JSON.stringify({ text, images })).digest("hex");
    const previous = this.commands.get(commandId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, code: "COMMAND_CONFLICT", error: "Command content changed" };
      return { ...previous.ack, duplicate: true };
    }
    if (this.task?.state === "stopping") return { ok: false, code: "TASK_STOPPING", error: "Task is stopping" };
    const executionText = prepare ? prepare(text, images) : text;
    const supplement = this.busy;
    // 投递方式只在"补充且 SDK 正在流式"时存在;busy 但非流式(如等调度)时 input 停留 app 层,delivery=null。
    const streaming = supplement && Boolean(this.adapter.isStreaming?.());
    const delivery = streaming ? this.adapter.streamingDelivery?.() ?? "steer" : null;
    const task = supplement ? this.task : { id: randomUUID(), state: this.scheduler ? "queued" : "running", startedAt: Date.now(), endedAt: null, modelToApply: this.pendingModel };
    const input = { id: randomUUID(), commandId, taskId: task.id, text, executionText, images, state: "accepted", expandedText: null, delivery };
    const ack = { ok: true, status: "accepted", commandId, inputId: input.id, sessionId: this.sessionId,
      taskId: task.id, disposition: supplement ? "supplement" : "new_task", delivery };
    const record = { type: "accepted", commandId, fingerprint, input, task, ack };
    const replaced = this.inputs.get(replacesInputId);
    const replaceId = replaced?.state === "interrupted" ? replaced.id : null;
    this.pending.save([...this.inputs.values()].filter(item => item.id !== replaceId).concat(input));
    if (replaceId) this.inputs.delete(replaceId);
    this.commands.set(commandId, record);
    this.inputs.set(input.id, input);
    this.task = task;
    if (!supplement && this.scheduler) this.admission = new TaskAdmission(this.scheduler,
      { sessionId: this.sessionId, taskId: task.id }, state => {
        if (this.task?.id === task.id && this.busy && this.task.state !== "stopping" && this.task.state !== state) this.setTaskState(state);
      });
    this.emit({ type: "task_state", task: { ...task } });
    this.emit({ type: "input_state", inputId: input.id, commandId, taskId: task.id, state: "accepted" });
    if (!this.run) this.schedule();
    else if (streaming) {
      this.queueInput(input);
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
    });
    this.run.catch(() => {});
  }

  queueInput(input) {
    this.queueing = input;
    // 缺 followUp 能力的 adapter(旧 mock)回退 steer,与 streamingDelivery 的 "steer" 默认值一致。
    const deliver = input.delivery === "followUp" && this.adapter.followUp ? this.adapter.followUp : this.adapter.steer;
    let pending;
    try { pending = deliver.call(this.adapter, input.executionText ?? input.text, input.images); }
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
    if (event.type === "queue_update" && this.queueing) {
      // 两模式各只写一条队列;按本次投递方式读对应数组,取末位(刚压入的那条)。
      const queued = this.queueing.delivery === "followUp" ? event.followUp : event.steering;
      if (queued?.length) {
        this.queueing.expandedText = queued.at(-1);
        this.setInputState(this.queueing, "queued");
      }
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
