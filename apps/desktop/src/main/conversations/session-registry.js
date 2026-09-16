import { unlink } from "node:fs/promises";
import path from "node:path";
const pathKey = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const unavailable = () => Object.assign(new Error("Session is being deleted or has been deleted"), { code: "SESSION_DELETING" });

/** A mode's resident sessions. Navigation never disposes a running host. */
export class SessionRegistry {
  /** @param {{createHost: (cwd?: string) => any, cleanup?: (id: string) => any, navigation?: any, listStored?: () => Promise<any[]>}} options */
  constructor({ createHost, cleanup = () => {}, navigation, listStored }) {
    this.createHost = createHost;
    this.listStored = listStored;
    this.cleanup = cleanup; this.navigation = navigation;
    this.closing = false;
    this.hosts = new Map();
    this.activeHost = null;
    this.pending = new Map();
    this.selection = 0;
    this.deleting = new Map();
    this.evicted = new Map();
  }

  async start() {
    if (this.activeHost) return this.activeHost;
    // Losing the selection does not imply losing the resident sessions. Reuse
    // their live SDK owners before discovering history (which could reopen one).
    const resident = this.allHosts().filter(host => !host.deleting && !host.retired)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
    return this.select(resident?.describeCurrent().path ?? null, false);
  }

  allHosts() { return [...this.hosts.values()]; }
  get(id) { const host = this.hosts.get(id); if (host) host.lastUsedAt = Date.now(); return host; }
  async getOrLoad(id) {
    const current = this.get(id);
    if (current) return current;
    const file = this.evicted.get(id);
    if (!file) return null;
    await this.select(file, false, -1); // Loading a command target must not navigate the UI.
    return this.get(id) ?? null;
  }
  prune({ now = Date.now(), idleMs = 300_000, keepIdle = 4 } = {}) {
    if (this.closing) return [];
    const idle = this.allHosts().filter(host => host !== this.activeHost && host.canEvict?.())
      .sort((a, b) => (a.lastUsedAt ?? now) - (b.lastUsedAt ?? now));
    const removed = [];
    for (const host of idle.slice(0, Math.max(0, idle.length - keepIdle))) {
      if (now - (host.lastUsedAt ?? now) < idleMs) continue;
      const session = host.describeCurrent();
      try { host.persistForEviction(); } catch { continue; }
      this.evicted.set(session.id, session.path); this.hosts.delete(session.id);
      try { host.dispose(); } catch { /* state is persisted and the retired host is no longer addressable */ }
      removed.push(session.id);
    }
    return removed;
  }

  admit(host) {
    if (this.closing) return { ok: false, code: "APP_STOPPING" };
    if (host.retired || this.deleting.has(pathKey(host.describeCurrent().path))) return { ok: false, code: "SESSION_DELETING" };
    return null;
  }

  async deleteSession(sessionPath) {
    const key = pathKey(sessionPath);
    if (this.deleting.has(key)) return this.deleting.get(key);
    const target = this.allHosts().find(h => pathKey(h.describeCurrent().path) === key);
    const manager = target?.sessionManager ?? this.activeHost.openSessionManager(sessionPath);
    const sessionId = target?.describeCurrent().id ?? manager.getSessionId();
    const selectionAtDelete = this.selection;
    const wasSelected = target && this.activeHost === target;
    if (target) target.deleting = true;
    const operation = Promise.resolve().then(async () => {
      let removed = false;
      try {
        await this.pending.get(key)?.catch(error => { if (error.code !== "SESSION_DELETING") throw error; });
        if (target) {
          const stopped = await target.abort(target.task?.id);
          if (stopped?.ok === false) throw new Error(stopped.error ?? "Unable to stop session");
          target.session?.abortCompaction?.();
          await target.waitForOperations?.();
          try { target.dispose(); }
          finally {
            this.hosts.delete(sessionId);
            if (this.activeHost === target) this.activeHost = null;
          }
        }
        try { await unlink(sessionPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
        removed = true;
        this.evicted.delete(sessionId);
        let warning;
        try { await this.cleanup(sessionId); } catch (error) { warning = error.message; }
        if (wasSelected && !this.activeHost && this.selection === selectionAtDelete) {
          const selection = ++this.selection;
          const next = await this.select(null, true, selection);
          if (next && selection === this.selection) next.emit({ type: "session_switched", ...next.currentPayload() });
        }
        return { ok: true, ...(warning ? { warning } : {}) };
      } catch (error) {
        if (removed) return { ok: true, warning: error.message };
        if (target && !target.retired) target.deleting = false;
        return { ok: false, error: error.message };
      } finally { this.deleting.delete(key); }
    });
    this.deleting.set(key, operation);
    return operation;
  }

  async select(sessionPath, fresh = false, selection = ++this.selection, cwd = undefined) {
    if (this.closing) throw Object.assign(new Error("Application is stopping"), { code: "APP_STOPPING" });
    const requestedKey = sessionPath ? pathKey(sessionPath) : null;
    if (requestedKey && (this.deleting.has(requestedKey))) throw unavailable();
    let host = requestedKey ? this.allHosts().find(h => pathKey(h.describeCurrent().path) === requestedKey) : null;
    if (!host) {
      const key = requestedKey ?? (fresh ? Symbol("new") : "initial");
      let pending = this.pending.get(key);
      if (!pending) {
        pending = (async () => {
          const created = this.createHost(cwd);
          created.navigation = this.navigation;
          created.registry = this;
          try {
            await created.start({ sessionPath, fresh });
            if (this.closing) throw Object.assign(new Error("Application is stopping"), { code: "APP_STOPPING" });
            if (requestedKey && (this.deleting.has(requestedKey))) throw unavailable();
            const id = created.describeCurrent()?.id;
            this.hosts.set(id, created);
            this.evicted.delete(id);
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
    // A shared load can settle just before another caller starts deleting its host.
    if (host.deleting || host.retired) throw unavailable();
    if (selection !== this.selection) return this.activeHost;
    this.activeHost = host;
    host.lastUsedAt = Date.now();
    return host;
  }

  async listSessions() {
    const stored = this.listStored ? await this.listStored() : await this.activeHost?.listSessions() ?? [];
    const rows = new Map(stored.map(row => [row.id, { ...row, active: false }]));
    for (const host of this.allHosts()) {
      const session = host.describeCurrent();
      if (this.listStored && !rows.has(session.id)) continue;
      const row = rows.get(session.id) ?? { ...session, firstMessage: "", messageCount: host.session?.messages?.length ?? 0 };
      // The SDK may buffer the first turn before flushing the session file.
      // Resident metadata comes from its native journal, including all branches.
      const entries = host.sessionManager?.getEntries?.();
      let live = {};
      if (entries) {
        const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
        const firstMessage = messages.filter(message => message.role === "user").map(message =>
          typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join(" "))
          .find(text => text.trim());
        live = { name: session.name, messageCount: messages.length,
          firstMessage: (firstMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
          firstMessageI18n: messages.length ? null : "sessions.unsaved" };
      }
      rows.set(session.id, { ...row, ...live, busy: host.busy, deleting: Boolean(host.deleting), task: host.task, active: host === this.activeHost });
    }
    return [...rows.values()].map(row => ({ ...row, ...this.navigation?.get(row.id), name: this.navigation?.get(row.id).customTitle ?? row.name }));
  }
}
