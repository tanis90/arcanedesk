import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import path from "node:path";

const fail = (code, message) => Object.assign(new Error(message), { code });
export const projectKey = cwd => cwd ? (process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd)) : "";

/** Navigation metadata never owns execution. Synchronous commits share the submit admission boundary. */
export class SessionNavigation {
  constructor({ file, emit = (_event) => {} }) {
    this.file = file; this.emit = emit; this.rows = {}; this.error = null;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.schemaVersion !== 1 || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) throw new Error("Invalid navigation metadata");
      for (const [id, row] of Object.entries(data.sessions)) {
        if (!/^[\w-]{1,128}$/.test(id) || !row || typeof row !== "object"
          || (row.archivedAt != null && (!Number.isFinite(row.archivedAt) || row.pinnedOrder != null))
          || (row.pinnedOrder != null && !Number.isFinite(row.pinnedOrder))
          || (row.customTitle != null && typeof row.customTitle !== "string")
          || [row.selectedModel, row.pendingModel].some(model => model != null &&
            (typeof model.providerId !== "string" || typeof model.modelId !== "string"))) throw new Error("Invalid navigation entry");
      }
      this.rows = data.sessions;
    } catch (error) { if (error.code !== "ENOENT") this.error = error.message; }
  }
  get(id) { return { ...(this.rows[id] ?? {}) }; }
  patch(id, change) {
    if (!/^[\w-]{1,128}$/.test(id)) throw fail("INVALID_SESSION_ID", "Invalid session identity");
    const next = { ...this.rows };
    if (change === null) delete next[id]; else next[id] = { ...this.get(id), ...change };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    const fd = openSync(temporary, "w");
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, sessions: next })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.file);
    this.rows = next; this.error = null;
    this.emit({ type: "navigation_changed", sessionId: id, metadata: this.get(id) });
    return this.get(id);
  }
  mutate(id, action, value, host) {
    if (host?.deleting) throw fail("SESSION_DELETING", "Session is being deleted");
    if (host?.closing) throw fail("APP_STOPPING", "Application is stopping");
    const row = this.get(id);
    if (action === "archive") {
      if (host?.busy || host?.operations) throw fail("SESSION_BUSY", "Finish the task before archiving");
      return row.archivedAt != null ? row : this.patch(id, { archivedAt: Date.now(), pinnedOrder: undefined });
    }
    if (action === "restore") return this.patch(id, { archivedAt: undefined, pinnedOrder: undefined });
    if (action === "pin") {
      if (row.archivedAt != null) throw fail("SESSION_ARCHIVED", "Restore the session before pinning it");
      if (typeof value !== "boolean") throw fail("INVALID_PIN", "Pinned must be a boolean");
      return this.patch(id, { pinnedOrder: value ? row.pinnedOrder ?? Math.max(0, ...Object.values(this.rows).map(item => item.pinnedOrder ?? 0)) + 1 : undefined });
    }
    if (action === "rename") {
      const title = typeof value === "string" ? value.trim() : "";
      if (!title || title.length > 200) throw fail("INVALID_TITLE", "Use a title between 1 and 200 characters");
      return this.patch(id, { customTitle: title });
    }
    throw fail("INVALID_NAVIGATION_ACTION", "Unknown navigation action");
  }
}
