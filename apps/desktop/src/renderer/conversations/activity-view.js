"use strict";

(() => {
  const activeStates = new Set(["running", "queued", "waiting_resource", "waiting_user", "stopping"]);
  const keys = { idle: "activity.idle", running: "chat.task.running", queued: "activity.queued",
    waiting_resource: "activity.waitingResource", waiting_user: "chat.task.waitingUser", stopping: "chat.task.stopping",
    completed: "chat.task.completed", failed: "chat.task.failed", stopped: "chat.task.stopped",
    interrupted: "chat.task.interrupted", cancelled: "activity.cancelled" };
  const node = (tag, className, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };

  class ActivityView {
    constructor({ api, t, getView, open, drawer, changed }) {
      this.api = api; this.t = t; this.getView = getView; this.open = open; this.changed = changed;
      this.rows = new Map(); this.items = new Map(); this.notices = new Map();
      this.epoch = null; this.seq = 0; this.pending = []; this.loading = false;
      this.frame = null; this.readPending = false; this.selected = null; this.boundary = null;
      this.list = document.getElementById("activity-list");
      this.toggle = document.getElementById("activity-toggle");
      this.noticeButton = document.getElementById("activity-notice");
      this.dismiss = document.getElementById("activity-dismiss");
      this.error = document.getElementById("activity-error");
      this.jump = document.getElementById("activity-jump");
      this.toggle?.addEventListener("click", () => drawer());
      this.noticeButton.addEventListener("click", () => {
        const notice = [...this.notices.values()].at(-1);
        if (notice) void open(this.rows.get(notice.sessionId), notice);
      });
      this.dismiss.addEventListener("click", () => { this.notices.clear(); this.renderNotice(); });
      this.error.addEventListener("click", () => { void this.load(); });
      this.jump.addEventListener("click", () => {
        const view = getView(); view.toLatest(); this.scheduleRead();
      });
    }

    stateLabel(state) { return this.t(keys[state] ?? "activity.idle"); }

    async load() {
      if (this.loading) return;
      this.loading = true;
      let gap = false;
      try {
        const result = await this.api.activitySnapshot();
        if (!result?.ok || !result.activityEpoch) throw new Error("Activity unavailable");
        this.rows = new Map(result.rows.map(row => [row.sessionId, row]));
        this.epoch = result.activityEpoch; this.seq = result.activitySeq;
        this.error.hidden = !result.storageError;
        const pending = this.pending.splice(0);
        for (const event of pending) {
          if (event.activityEpoch !== this.epoch) continue;
          if (event.activitySeq <= this.seq) continue;
          if (event.activitySeq !== this.seq + 1) { gap = true; break; }
          this.apply(event);
        }
        this.render();
      } catch { this.error.hidden = false; }
      finally { this.loading = false; }
      if (gap) void this.load();
    }

    receive(event) {
      if (event.type === "activity_notice") {
        const view = this.getView();
        if (!(view.sessionId === event.notice.sessionId && view.visible)) {
          this.notices.set(event.notice.sessionId + ":" + event.notice.key, event.notice);
          if (this.notices.size > 20) this.notices.delete(this.notices.keys().next().value);
          this.renderNotice();
        }
        return true;
      }
      if (!["activity_update", "activity_removed"].includes(event.type)) return false;
      if (this.loading || event.activityEpoch !== this.epoch || event.activitySeq > this.seq + 1) {
        this.pending.push(event);
        if (this.pending.length > 512) this.pending.shift();
        void this.load(); return true;
      }
      if (event.activitySeq <= this.seq) return true;
      this.apply(event); this.render(); return true;
    }

    apply(event) {
      this.seq = event.activitySeq;
      if (event.type === "activity_removed") this.rows.delete(event.sessionId);
      else this.rows.set(event.summary.sessionId, event.summary);
      this.error.hidden = !event.storageError;
    }

    render() {
      const view = this.getView();
      const rows = [...this.rows.values()];
      for (const [key, notice] of this.notices) {
        const row = this.rows.get(notice.sessionId);
        if (!row || (notice.kind === "waiting_user" ? !row.needsAttention : !row.unread || row.taskId !== notice.taskId)) this.notices.delete(key);
      }
      this.renderNotice(); this.updateReading(); this.changed(); this.scheduleRead();
    }

    renderNotice() {
      const notice = [...this.notices.values()].at(-1);
      this.noticeButton.hidden = !notice; this.dismiss.hidden = !notice;
      if (!notice) return;
      const title = notice.name || this.t("sessions.untitled");
      this.noticeButton.textContent = title + " · " + this.stateLabel(notice.kind)
        + (this.notices.size > 1 ? this.t("activity.more", { count: this.notices.size - 1 }) : "");
      this.noticeButton.title = this.noticeButton.textContent;
    }

    updateReading() {
      const view = this.getView(), row = this.rows.get(view.sessionId);
      if (this.selected !== view.sessionId) { this.selected = view.sessionId; this.boundary = null; }
      if (!this.boundary && row?.unread) this.boundary = { readKey: row.readKey, firstUnreadKey: row.firstUnreadKey };
      if (this.boundary && !this.boundary.firstUnreadKey && row?.firstUnreadKey) this.boundary.firstUnreadKey = row.firstUnreadKey;
      this.jump.hidden = !(row?.unread && !view.atBottom);
      const container = view.messages;
      if (!container || !view.ready || container.querySelector(".unread-divider") || !this.boundary) return;
      const key = this.boundary.readKey || this.boundary.firstUnreadKey;
      if (!key) return;
      const findKey = key => container.querySelector('[data-item-key="' + CSS.escape(key) + '"]')
        ?? container.querySelector('[data-legacy-key="' + CSS.escape(key) + '"]');
      let target = findKey(key);
      let after = Boolean(this.boundary.readKey);
      if (!target && this.boundary.firstUnreadKey) {
        target = findKey(this.boundary.firstUnreadKey);
        after = false;
      }
      if (!target) return;
      while (target.parentElement !== container) target = target.parentElement;
      const divider = node("div", "unread-divider", this.t("activity.lastRead"));
      divider.setAttribute("role", "separator");
      // Preserve the reading anchor when inserting above the viewport.
      const before = target.getBoundingClientRect().top;
      if (after) target.after(divider); else target.before(divider);
      if (!view.atBottom && before < container.getBoundingClientRect().top) container.scrollTop += divider.getBoundingClientRect().height;
      if (view.atBottom) view.toLatest();
    }

    scheduleRead() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(async () => {
        this.frame = null;
        this.updateReading();
        const view = this.getView(), row = this.rows.get(view.sessionId);
        if (this.readPending || !row?.unread || !view.ready || !view.visible || !view.atBottom || !view.runtimeEpoch) return;
        this.readPending = true;
        try {
          await this.api.markActivityRead({ sessionId: view.sessionId, runtimeEpoch: view.runtimeEpoch,
            seq: view.seq, visible: view.visible, atBottom: view.atBottom, readKey: view.readKey });
        } catch { this.error.hidden = false; }
        finally { this.readPending = false; }
      });
    }
  }
  /** @type {any} */ (globalThis).ArcaneActivityView = ActivityView;
})();
