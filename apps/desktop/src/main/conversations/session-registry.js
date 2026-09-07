import { unlink } from "node:fs/promises";
import path from "node:path";
const pathKey = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const unavailable = () => Object.assign(new Error("Session is being deleted or has been deleted"), { code: "SESSION_DELETING" });

/** A mode's resident sessions. Navigation never disposes a running host. */
export class SessionRegistry {
  /** @param {{createHost: () => any}} options */
  constructor({ createHost }) {
    this.createHost = createHost;
    this.hosts = new Map();
    this.activeHost = null;
    this.pending = new Map();
    this.selection = 0;
    this.deleting = new Map(); this.deleted = new Set();
  }

  async start() {
    if (this.activeHost) return this.activeHost;
    return this.select(null, false);
  }

  allHosts() { return [...this.hosts.values()]; }
  get(id) { return this.hosts.get(id); }

  async deleteSession(sessionPath) {
    const key = pathKey(sessionPath);
    if (this.deleting.has(key)) return this.deleting.get(key);
    if (this.deleted.has(key)) return { ok: true };
    const target = this.allHosts().find(h => pathKey(h.describeCurrent().path) === key);
    // Validate ownership even for an unloaded history file.
    (target ?? this.activeHost).openSessionManager(sessionPath);
    if (target) target.deleting = true;
    const operation = Promise.resolve().then(async () => {
      try {
        const opening = this.pending.get(key);
        if (opening) await opening.catch(error => { if (error.code !== "SESSION_DELETING") throw error; });
        if (target) {
          const stopped = await target.abort(target.task?.id);
          if (stopped?.ok === false || target.busy) throw new Error("Session task has not stopped");
        }
        try { await unlink(sessionPath); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        this.deleted.add(key);
        if (target) {
          target.dispose();
          this.hosts.delete(target.describeCurrent().id);
          if (this.activeHost === target) {
            this.activeHost = null;
            const selection = ++this.selection;
            const next = await this.select(null, true, selection);
            if (next && selection === this.selection) next.emit({ type: "session_switched", ...next.currentPayload() });
          }
        }
        return { ok: true };
      } catch (error) {
        if (this.deleted.has(key)) return { ok: true, warning: error.message };
        if (target && !this.deleted.has(key)) target.deleting = false;
        return { ok: false, error: error.message };
      } finally { this.deleting.delete(key); }
    });
    this.deleting.set(key, operation);
    return operation;
  }

  async select(sessionPath, fresh = false, selection = ++this.selection) {
    const requestedKey = sessionPath ? pathKey(sessionPath) : null;
    if (requestedKey && (this.deleting.has(requestedKey) || this.deleted.has(requestedKey))) throw unavailable();
    let host = requestedKey ? this.allHosts().find(h => pathKey(h.describeCurrent().path) === requestedKey) : null;
    if (!host) {
      const key = requestedKey ?? (fresh ? Symbol("new") : "initial");
      let pending = this.pending.get(key);
      if (!pending) {
        pending = (async () => {
          const created = this.createHost();
          try {
            await created.start({ sessionPath, fresh });
            if (requestedKey && (this.deleting.has(requestedKey) || this.deleted.has(requestedKey))) throw unavailable();
            const id = created.describeCurrent()?.id;
            if (!id) throw new Error("Session has no stable identity");
            this.hosts.set(id, created);
            return created;
          } catch (error) {
            created.dispose();
            throw error;
          }
        })();
        this.pending.set(key, pending);
      }
      try { host = await pending; }
      finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
    }
    if (host?.deleting || (requestedKey && this.deleted.has(requestedKey))) throw unavailable();
    if (selection !== this.selection) return this.activeHost;
    this.activeHost = host;
    return host;
  }

  async listSessions() {
    const active = await this.start();
    const stored = await active.listSessions();
    const rows = new Map(stored.map(row => [row.id, { ...row, active: false }]));
    for (const host of this.allHosts()) {
      const session = host.describeCurrent();
      const row = rows.get(session.id) ?? { ...session, firstMessage: "", messageCount: host.session?.messages?.length ?? 0 };
      rows.set(session.id, { ...row, busy: host.busy, deleting: Boolean(host.deleting), task: host.task, active: host === this.activeHost });
    }
    return [...rows.values()];
  }
}
