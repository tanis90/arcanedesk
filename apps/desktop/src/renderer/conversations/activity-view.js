"use strict";

(() => {
  const node = (tag, className, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };

  class ActivityView {
    constructor({ api, t, getView, changed }) {
      this.api = api; this.t = t; this.getView = getView; this.changed = changed;
      this.rows = new Map();
      this.epoch = null; this.seq = 0; this.pending = []; this.loading = false;
      this.frame = null; this.readPending = false; this.selected = null; this.boundary = null;
      this.error = document.getElementById("activity-error");
      this.jump = document.getElementById("scroll-bottom");
      this.error.addEventListener("click", () => { void this.load(); });
    }

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
      if (event.type === "activity_notice") return true;
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
      this.updateReading(); this.changed(); this.scheduleRead();
    }

    updateReading() {
      const view = this.getView(), row = this.rows.get(view.sessionId);
      if (this.selected !== view.sessionId) { this.selected = view.sessionId; this.boundary = null; }
      if (!this.boundary && row?.unread) this.boundary = { readKey: row.readKey, firstUnreadKey: row.firstUnreadKey };
      if (this.boundary && !this.boundary.firstUnreadKey && row?.firstUnreadKey) this.boundary.firstUnreadKey = row.firstUnreadKey;
      this.jump.textContent = row?.unread && !view.atBottom ? this.t("activity.newProgress") : "↓";
      this.jump.classList.toggle("has-unread", Boolean(row?.unread && !view.atBottom));
      this.jump.title = row?.unread && !view.atBottom ? this.t("activity.newProgress") : this.t("scrollBottom.title");
      this.jump.setAttribute("aria-label", this.jump.title);
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
