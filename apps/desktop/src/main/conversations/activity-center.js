import { readFileSync } from "node:fs";
import { replaceFile } from "../atomic-file.js";
import { randomUUID } from "node:crypto";

const activeStates = new Set(["running", "queued", "waiting_user", "stopping"]);
const noticeStates = new Set(["completed", "failed"]);
const contentEvents = new Set(["message_delta", "message", "tool_start", "tool_end", "auto_retry_start", "auto_retry_end"]);

function initialRow(sessionId, mode, now) {
  return { sessionId, mode, name: "", path: null, state: "idle", taskId: null,
    unread: false, cursor: null, attentionIds: [], updatedAt: now, available: true };
}

/** Derived activity only: this module never starts, stops or changes a task. */
export class ActivityCenter {
  /** @param {{file?: string, describe?: (id: string) => any, emit?: (event: any) => void,
   * notify?: (notice: any) => void, foreground?: (id: string) => boolean, now?: () => number, delayMs?: number,
   * persist?: (data: any) => void, log?: (...args: any[]) => void}} [options] */
  constructor({ file, describe = () => null, emit = () => {}, notify = () => {}, now = Date.now,
    delayMs = 100, persist, foreground = () => false, log = () => {} } = {}) {
    this.foreground = foreground;
    this.notices = new Set();
    this.savedSummary = null;
    this.describe = describe;
    this.emit = emit;
    this.notify = notify;
    this.now = now;
    this.delayMs = delayMs;
    this.log = log;
    /** @type {Map<string, any>} */
    this.rows = new Map();
    this.dirty = new Set();
    this.timer = null;
    this.storageError = false;
    this.runtimeEpoch = randomUUID();
    this.seq = 0;
    this.persist = persist ?? (data => { if (file) replaceFile(file, JSON.stringify(data)); });
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        const rows = Array.isArray(data) ? data : data.rows?.filter(row => activeStates.has(row.state) || row.state === "interrupted");
        if (!Array.isArray(rows)) throw new Error("Invalid activity summary");
        for (const saved of rows) {
          if (!saved || typeof saved.sessionId !== "string" || !["prep", "combat"].includes(saved.mode)) throw new Error("Invalid activity summary");
          const row = { ...initialRow(saved.sessionId, saved.mode, this.now()), name: String(saved.name ?? ""),
            path: saved.path ?? null, taskId: saved.taskId ?? null, state: "interrupted", unread: true, available: false };
          this.rows.set(row.sessionId, row);
        }
        this.saveSummary();
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.storageError = true;
          this.log("[activity] restore failed", error.message);
        }
      }
    }
  }

  publicRow(row) {
    const { cursor, ...summary } = row;
    return structuredClone({ ...summary,
      needsAttention: row.attentionIds.length > 0 || row.state === "waiting_user" });
  }

  snapshot() {
    return { rows: [...this.rows.values()].map(row => this.publicRow(row)), storageError: this.storageError,
      activityEpoch: this.runtimeEpoch, activitySeq: this.seq };
  }

  get(sessionId) {
    const row = this.rows.get(sessionId);
    return row ? this.publicRow(row) : null;
  }

  /** Install an authoritative live host snapshot without replaying notifications. */
  reconcile(payload, mode) {
    const { session, task, inFlight } = payload;
    if (!session?.id || !inFlight?.runtimeEpoch || !["prep", "combat"].includes(mode)) return;
    let row = this.rows.get(session.id);
    if (!row && !task) return;
    if (!row) { row = initialRow(session.id, mode, this.now()); this.rows.set(session.id, row); }
    if (row.cursor?.runtimeEpoch === inFlight.runtimeEpoch && row.cursor.seq > inFlight.seq) return;
    row.cursor = { runtimeEpoch: inFlight.runtimeEpoch, seq: inFlight.seq };
    const state = task?.state ?? (row.state === "interrupted" ? "interrupted" : "idle");
    if (row.taskId !== (task?.id ?? null) || row.state !== state) {
      row.unread ||= !this.foreground(session.id);
      row.updatedAt = this.now();
    }
    row.taskId = task?.id ?? null;
    row.state = state;
    row.waitingFor = task?.waitingFor ?? null;
    row.available = true;
    row.name = String(session.name ?? "");
    row.path = session.path ?? null;
    row.attentionIds = (payload.attentions ?? []).filter(a => a.state === "pending").map(a => `question:${a.id}`)
      .concat((payload.approvals ?? []).map(a => `approval:${a.approvalId}`));
    const silentKeys = [...row.attentionIds];
    if (noticeStates.has(state)) silentKeys.push(`task:${row.taskId}:${state}`);
    for (const key of silentKeys) this.notices.add(session.id + ":" + key);
    this.saveSummary();
    this.dirty.add(session.id);
    this.schedule();
  }

  /** Call only with live, ordered host events. Snapshot restoration never calls notify. */
  observe(event) {
    const { sessionId, runtimeEpoch, seq } = event;
    if (!sessionId || !runtimeEpoch || !Number.isSafeInteger(seq) || seq < 1) return;
    const metadata = this.describe(sessionId);
    if (!metadata || !["combat", "prep"].includes(metadata.mode)) return;
    let row = this.rows.get(sessionId);
    if (!row) {
      row = initialRow(sessionId, metadata.mode, this.now());
      this.rows.set(sessionId, row);
    }
    if (row.cursor?.runtimeEpoch === runtimeEpoch && seq <= row.cursor.seq) return;
    row.cursor = { runtimeEpoch, seq };
    row.name = String(metadata.name ?? "");
    row.path = metadata.path ?? null;
    row.available = true;
    let meaningful = contentEvents.has(event.type) && !(event.type === "message" && event.role === "user");
    let notice = null;
    if (event.type === "task_state" && event.task) {
      meaningful = row.taskId !== event.task.id || row.state !== event.task.state || JSON.stringify(row.waitingFor ?? null) !== JSON.stringify(event.task.waitingFor ?? null);
      row.taskId = event.task.id;
      row.state = event.task.state;
      row.waitingFor = event.task.waitingFor ?? null;
      if (meaningful && noticeStates.has(row.state)) notice = { key: `task:${row.taskId}:${row.state}`, kind: row.state };
      if (!activeStates.has(row.state)) row.attentionIds = [];
    } else if (event.type === "attention" && event.attention) {
      const key = `question:${event.attention.id}`;
      const pending = event.attention.state === "pending";
      meaningful = pending !== row.attentionIds.includes(key);
      row.attentionIds = row.attentionIds.filter(id => id !== key);
      if (pending) {
        row.attentionIds.push(key);
        notice = { key, kind: "waiting_user", attentionId: event.attention.id };
      }
    } else if (event.type === "approval_request") {
      const key = `approval:${event.approvalId}`;
      meaningful = !row.attentionIds.includes(key);
      if (meaningful) row.attentionIds.push(key);
      notice = { key, kind: "waiting_user", approvalId: event.approvalId };
    } else if (event.type === "approval_resolved") {
      const key = `approval:${event.approvalId}`;
      meaningful = row.attentionIds.includes(key);
      row.attentionIds = row.attentionIds.filter(id => id !== key);
    }
    if (meaningful) {
      row.unread ||= !this.foreground(sessionId);
      row.updatedAt = this.now();
    }
    this.dirty.add(sessionId);
    if (notice && !this.notices.has(sessionId + ":" + notice.key)) {
      this.notices.add(sessionId + ":" + notice.key);
      this.notify({ ...notice, sessionId, taskId: event.taskId ?? row.taskId, mode: row.mode, name: row.name });
    }
    if (event.type === "task_state") this.saveSummary();
    this.schedule();
  }

  opened(sessionId) {
    const row = this.rows.get(sessionId);
    if (row?.unread) {
      row.unread = false;
      this.dirty.add(sessionId);
      this.flush();
    }
    return { ok: true };
  }

  // Only execution-boundary changes can alter the small interruption summary.
  saveSummary() {
    const summary = [...this.rows.values()].filter(row => activeStates.has(row.state) || row.state === "interrupted")
      .map(({ sessionId, mode, name, path, taskId }) => ({ sessionId, mode, name, path, taskId }));
    const serialized = JSON.stringify(summary);
    if (serialized === this.savedSummary) return;
    try {
      this.persist(summary);
      this.savedSummary = serialized;
      this.storageError = false;
    } catch (error) {
      this.storageError = true;
      this.log("[activity] summary save failed", error.message);
    }
  }

  /** Remove only after the owner has actually deleted the session. */
  remove(sessionId) {
    this.rows.delete(sessionId);
    this.dirty.delete(sessionId);
    this.saveSummary();
    this.flush();
    this.publish({ type: "activity_removed", sessionId });
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  publish(event) {
    this.emit({ ...event, activityEpoch: this.runtimeEpoch, activitySeq: ++this.seq });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const changed = [...this.dirty];
    this.dirty.clear();
    for (const id of changed) {
      const row = this.rows.get(id);
      if (row) this.publish({ type: "activity_update", summary: this.publicRow(row), storageError: this.storageError });
    }
    return !this.storageError;
  }
}
