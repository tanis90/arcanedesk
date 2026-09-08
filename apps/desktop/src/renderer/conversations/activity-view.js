"use strict";

(() => {
  class ActivityView {
    constructor({ api, t, getView, changed }) {
      this.api = api; this.t = t; this.getView = getView; this.changed = changed;
      this.rows = new Map();
      this.epoch = null; this.seq = 0; this.pending = []; this.loading = false;
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
      this.updateReading(); this.changed();
    }

    updateReading() {
      const view = this.getView(), row = this.rows.get(view.sessionId);
      this.jump.textContent = row?.unread && !view.atBottom ? this.t("activity.newProgress") : "↓";
      this.jump.classList.toggle("has-unread", Boolean(row?.unread && !view.atBottom));
      this.jump.title = row?.unread && !view.atBottom ? this.t("activity.newProgress") : this.t("scrollBottom.title");
      this.jump.setAttribute("aria-label", this.jump.title);
    }

    async opened(sessionId) {
      try { await this.api.activityOpened(sessionId); }
      catch { this.error.hidden = false; }
    }
  }
  /** @type {any} */ (globalThis).ArcaneActivityView = ActivityView;
})();
