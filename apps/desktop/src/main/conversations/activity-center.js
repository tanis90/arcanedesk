import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const activeStates = new Set(["running", "queued", "waiting_resource", "waiting_user", "stopping"]);
const noticeStates = new Set(["completed", "failed"]);
const contentEvents = new Set(["message_delta", "message", "tool_start", "tool_end", "auto_retry_start", "auto_retry_end"]);

function initialRow(sessionId, mode, now) {
  return { sessionId, mode, name: "", path: null, state: "idle", taskId: null,
    revision: 0, readRevision: 0, contentCursor: null, firstUnreadKey: null, readKey: null,
    cursor: null, retiredEpochs: [], notices: [], attentionIds: [], updatedAt: now, available: true };
}

/** Derived activity only: this module never starts, stops or changes a task. */
export class ActivityCenter {
  /** @param {{file?: string, describe?: (id: string) => any, emit?: (event: any) => void,
   * notify?: (notice: any) => void, now?: () => number, delayMs?: number,
   * persist?: (data: any) => void, log?: (...args: any[]) => void}} [options] */
  constructor({ file, describe = () => null, emit = () => {}, notify = () => {}, now = Date.now,
    delayMs = 100, persist, log = () => {} } = {}) {
    this.file = file;
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
    this.persist = persist ?? (data => {
      if (!file) return;
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", flush: true });
      renameSync(temporary, file);
    });
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (data.version !== 1 || !Array.isArray(data.rows)) throw new Error("Invalid activity data");
        for (const row of data.rows) {
          if (!row || typeof row.sessionId !== "string" || !["prep", "combat"].includes(row.mode)
            || !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.readRevision)
            || !Array.isArray(row.notices) || !Array.isArray(row.retiredEpochs)) throw new Error("Invalid activity row");
          // A persisted running label is no evidence that the execution survived.
          row.available = false;
          if (activeStates.has(row.state)) { row.state = "interrupted"; row.revision++; }
          row.attentionIds = [];
          this.rows.set(row.sessionId, row);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.storageError = true;
          this.log("[activity] restore failed", error.message);
        }
      }
    }
  }

  publicRow(row) {
    const { notices, retiredEpochs, cursor, ...summary } = row;
    return structuredClone({ ...summary, unread: row.revision > row.readRevision,
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
    if (row.retiredEpochs.includes(inFlight.runtimeEpoch)) return;
    if (row.cursor?.runtimeEpoch === inFlight.runtimeEpoch && row.cursor.seq > inFlight.seq) return;
    const newEpoch = row.cursor?.runtimeEpoch !== inFlight.runtimeEpoch;
    if (row.cursor && newEpoch) row.retiredEpochs.push(row.cursor.runtimeEpoch);
    row.cursor = { runtimeEpoch: inFlight.runtimeEpoch, seq: inFlight.seq };
    if (newEpoch || !row.contentCursor) row.contentCursor = { ...row.cursor };
    const state = task?.state ?? "idle";
    if (row.taskId !== (task?.id ?? null) || row.state !== state) {
      row.revision++;
      row.updatedAt = this.now();
      row.contentCursor = { ...row.cursor };
    }
    row.taskId = task?.id ?? null;
    row.state = state;
    row.available = true;
    row.name = String(session.name ?? "");
    row.path = session.path ?? null;
    row.attentionIds = (payload.attentions ?? []).filter(a => a.state === "pending").map(a => `question:${a.id}`)
      .concat((payload.approvals ?? []).map(a => `approval:${a.approvalId}`));
    const silentKeys = [...row.attentionIds];
    if (noticeStates.has(state)) silentKeys.push(`task:${row.taskId}:${state}`);
    for (const key of silentKeys) if (!row.notices.includes(key)) row.notices.push(key);
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
    if (row.retiredEpochs.includes(runtimeEpoch)) return;
    if (row.cursor?.runtimeEpoch === runtimeEpoch && seq <= row.cursor.seq) return;
    if (row.cursor && row.cursor.runtimeEpoch !== runtimeEpoch) row.retiredEpochs.push(row.cursor.runtimeEpoch);
    row.cursor = { runtimeEpoch, seq };
    row.name = String(metadata.name ?? "");
    row.path = metadata.path ?? null;
    row.available = true;
    let meaningful = contentEvents.has(event.type) && !(event.type === "message" && event.role === "user");
    let notice = null;
    if (event.type === "task_state" && event.task) {
      meaningful = row.taskId !== event.task.id || row.state !== event.task.state;
      row.taskId = event.task.id;
      row.state = event.task.state;
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
      if (row.revision === row.readRevision) row.firstUnreadKey = event.key ?? null;
      else if (!row.firstUnreadKey && event.key) row.firstUnreadKey = event.key;
      // Revision is a read cursor, never a count displayed as unread tokens.
      row.revision++;
      row.contentCursor = { runtimeEpoch, seq };
      row.updatedAt = this.now();
    }
    this.dirty.add(sessionId);
    if (notice && !row.notices.includes(notice.key)) {
      row.notices.push(notice.key);
      // Persist consumption BEFORE dispatch, including when the current UI suppresses it.
      // A failed write keeps the activity visible but cannot cause repeat desktop alerts.
      const durable = this.flush();
      if (durable) this.notify({ ...notice, sessionId, taskId: event.taskId ?? row.taskId,
        mode: row.mode, name: row.name });
    } else this.schedule();
  }

  /** Only a focused, visible view at the latest content can acknowledge that content.
   * The supplied cursor must come from the installed view, not an activity snapshot. */
  markRead({ sessionId, runtimeEpoch, seq, visible, atBottom, readKey = null }, focused) {
    const row = this.rows.get(sessionId);
    if (!row || !focused || !visible || !atBottom) return { ok: false, code: "NOT_READING_LATEST" };
    const latest = row.contentCursor;
    if (!latest || latest.runtimeEpoch !== runtimeEpoch || !Number.isSafeInteger(seq)
      || seq < latest.seq || seq > row.cursor.seq) return { ok: false, code: "STALE_READ_CURSOR" };
    if (row.readRevision === row.revision) return { ok: true, durable: !this.storageError };
    row.readRevision = row.revision;
    row.readKey = typeof readKey === "string" ? readKey : null;
    row.firstUnreadKey = null;
    this.dirty.add(sessionId);
    return { ok: true, durable: this.flush() };
  }

  /** Remove only after the owner has actually deleted the session. */
  remove(sessionId) {
    if (!this.rows.delete(sessionId)) return;
    this.dirty.delete(sessionId);
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
    try {
      this.persist({ version: 1, rows: [...this.rows.values()] });
      this.storageError = false;
    } catch (error) {
      this.storageError = true;
      this.log("[activity] persistence failed", error.message);
    }
    const changed = [...this.dirty];
    this.dirty.clear();
    for (const id of changed) {
      const row = this.rows.get(id);
      if (row) this.publish({ type: "activity_update", summary: this.publicRow(row), storageError: this.storageError });
    }
    return !this.storageError;
  }
}
