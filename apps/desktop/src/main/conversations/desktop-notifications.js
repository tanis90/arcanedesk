import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

/** Receives only newly consumed ActivityCenter notices. No history replay or task control. */
export class DesktopNotifications {
  constructor({ file, supported, foreground, create, lookup, activate, text, log = (..._args) => {} }) {
    this.file = file; this.supported = supported; this.foreground = foreground;
    this.create = create; this.lookup = lookup; this.activate = activate; this.text = text; this.log = log;
    this.enabled = false; this.storageError = false; this.deliveryFailed = false;
    this.active = new Map(); this.pendingTarget = null;
    try { this.enabled = JSON.parse(readFileSync(file, "utf8")).enabled === true; }
    catch (error) { if (error.code !== "ENOENT") this.storageError = true; }
  }

  status() { return { enabled: this.enabled, supported: Boolean(this.supported()), storageError: this.storageError, deliveryFailed: this.deliveryFailed }; }

  setEnabled(enabled) {
    if (typeof enabled !== "boolean") return { ok: false, code: "INVALID_REQUEST", ...this.status() };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ enabled }), { encoding: "utf8", flush: true });
      renameSync(`${this.file}.tmp`, this.file);
      this.enabled = enabled;
      this.storageError = false;
      if (!enabled) { for (const key of this.active.keys()) this.close(key); this.pendingTarget = null; }
      return { ok: true, ...this.status() };
    } catch {
      this.storageError = true;
      return { ok: false, code: "SETTINGS_WRITE_FAILED", ...this.status() };
    }
  }

  relevant(notice, row) {
    if (!row || row.taskId !== notice.taskId) return false;
    if (notice.kind === "waiting_user") {
      const key = notice.attentionId ? `question:${notice.attentionId}` : `approval:${notice.approvalId}`;
      return row.attentionIds.includes(key);
    }
    return ["completed", "failed"].includes(notice.kind) && row.state === notice.kind && row.unread;
  }

  deliver(notice) {
    let deliveryKey;
    try {
      if (!this.enabled || !this.supported() || this.foreground() || !this.relevant(notice, this.lookup(notice.sessionId))) return;
      const key = notice.sessionId + ":" + notice.key;
      deliveryKey = key;
      if (this.active.has(key)) return;
      const native = this.create({ title: notice.name || "ArcaneDesk", body: this.text(notice.kind), silent: true });
      this.active.set(key, { native, notice });
      native.once("click", () => {
        if (!this.enabled) return;
        const row = this.lookup(notice.sessionId);
        if (!this.relevant(notice, row)) return;
        this.pendingTarget = { notice, row };
        try { this.activate(); } // Only an explicit click may focus/show a window.
        catch (error) { this.log("[notifications] activation failed", error.message); }
        this.close(key);
      });
      native.on("close", () => this.active.delete(key));
      native.on("failed", () => { this.deliveryFailed = true; this.active.delete(key); });
      native.show();
      while (this.active.size > 32) this.close(this.active.keys().next().value);
    } catch (error) {
      if (deliveryKey) this.close(deliveryKey);
      this.deliveryFailed = true;
      this.log("[notifications] delivery failed", error.message);
    }
  }

  reconcile(sessionId) {
    for (const [key, entry] of this.active) {
      if (entry.notice.sessionId === sessionId && !this.relevant(entry.notice, this.lookup(sessionId))) this.close(key);
    }
    if (this.pendingTarget?.notice.sessionId === sessionId && !this.lookup(sessionId)) this.pendingTarget = null;
  }

  takeTarget() {
    const target = this.pendingTarget;
    this.pendingTarget = null;
    if (!target) return null;
    const row = this.lookup(target.notice.sessionId);
    return this.relevant(target.notice, row) ? { ...target, row } : null;
  }

  close(key) {
    const entry = this.active.get(key); this.active.delete(key);
    try { entry?.native.close(); } catch { /* native notification may already be gone */ }
  }
}
