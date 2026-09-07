import { lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { InputJournal } from "../tasks/input-journal.js";
function historyMissing(file) {
  try { lstatSync(file); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

/** Durable deletion intent bridges the history unlink and associated-data cleanup. */
export class SessionDeletions {
  constructor({ file, tasksDir }) {
    this.tasksDir = tasksDir; this.entries = new Map(); this.error = null;
    try {
      this.journal = new InputJournal(file);
      for (const record of this.journal.records) {
        if (typeof record.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.id)) throw new Error("Invalid deletion identity");
        if (!["begin", "cancel", "commit", "clean"].includes(record.type) ||
          (record.type === "begin" && (typeof record.sessionPath !== "string" || !path.isAbsolute(record.sessionPath)))) throw new Error("Invalid deletion record");
        if (record.type === "begin") this.entries.set(record.id, { id: record.id, sessionPath: record.sessionPath, deleted: false, clean: false });
        else if (record.type === "cancel") this.entries.delete(record.id);
        else if (this.entries.has(record.id)) this.entries.get(record.id)[record.type === "commit" ? "deleted" : "clean"] = true;
        else throw new Error("Deletion outcome has no intent");
      }
      // Startup only: never infer cancellation from a file still present during a live deletion.
      for (const entry of [...this.entries.values()]) {
        if (!entry.deleted && !historyMissing(entry.sessionPath)) this.cancel(entry.id);
        else this.commit(entry.id);
      }
    } catch (error) { this.error = error.message; }
  }
  append(record) {
    if (this.error) throw new Error(`Deletion storage unavailable: ${this.error}`);
    this.journal.append(record);
  }
  begin(id, sessionPath) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !path.isAbsolute(sessionPath)) throw new Error("Invalid deletion identity or path");
    if (this.entries.get(id)?.deleted) return;
    this.append({ type: "begin", id, sessionPath });
    this.entries.set(id, { id, sessionPath, deleted: false, clean: false });
  }
  cancel(id) { this.append({ type: "cancel", id }); this.entries.delete(id); }
  commit(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!entry.deleted) { this.append({ type: "commit", id }); entry.deleted = true; }
    if (!entry.clean) {
      try { unlinkSync(path.join(this.tasksDir, `${id}.jsonl`)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      this.append({ type: "clean", id }); entry.clean = true;
    }
  }
  isDeleted(sessionPath) {
    const key = process.platform === "win32" ? sessionPath.toLowerCase() : sessionPath;
    return [...this.entries.values()].some(entry => this.confirmed(entry) &&
      (process.platform === "win32" ? entry.sessionPath.toLowerCase() : entry.sessionPath) === key);
  }
  confirmed(entry) {
    if (entry.deleted) return true;
    try { return historyMissing(entry.sessionPath); }
    catch { return false; } // An unreadable path is not proof that history was removed.
  }
  snapshot() {
    return { ok: !this.error, sessionIds: [...this.entries.values()].filter(entry => this.confirmed(entry)).map(entry => entry.id), error: this.error };
  }
}
