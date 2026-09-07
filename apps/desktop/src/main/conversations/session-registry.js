import { unlink } from "node:fs/promises";

/** A mode's resident sessions. Navigation never disposes a running host. */
export class SessionRegistry {
  /** @param {{createHost: () => any}} options */
  constructor({ createHost }) {
    this.createHost = createHost;
    this.hosts = new Map();
    this.activeHost = null;
    this.pending = new Map();
    this.selection = 0;
  }

  async start() {
    if (this.activeHost) return this.activeHost;
    return this.select(null, false);
  }

  allHosts() { return [...this.hosts.values()]; }
  get(id) { return this.hosts.get(id); }

  async deleteSession(sessionPath) {
    const target = this.allHosts().find(h => h.describeCurrent()?.path === sessionPath);
    // Validate ownership even for an unloaded history file.
    (target ?? this.activeHost).openSessionManager(sessionPath);
    if (target) await target.abort(target.task?.id);
    try { await unlink(sessionPath); }
    catch (error) { if (error.code !== "ENOENT") return { ok: false, error: error.message }; }
    if (target) {
      target.dispose();
      this.hosts.delete(target.describeCurrent().id);
      if (this.activeHost === target) {
        this.activeHost = null;
        const next = await this.select(null, true);
        next.emit({ type: "session_switched", ...next.currentPayload() });
      }
    }
    return { ok: true };
  }

  async select(sessionPath, fresh = false) {
    const selection = ++this.selection;
    let host = sessionPath ? this.allHosts().find(h => h.describeCurrent()?.path === sessionPath) : null;
    if (!host) {
      const key = sessionPath ?? (fresh ? Symbol("new") : "initial");
      let pending = this.pending.get(key);
      if (!pending) {
        pending = (async () => {
          const created = this.createHost();
          try {
            await created.start({ sessionPath, fresh });
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
      rows.set(session.id, { ...row, busy: host.busy, task: host.task, active: host === this.activeHost });
    }
    return [...rows.values()];
  }
}
