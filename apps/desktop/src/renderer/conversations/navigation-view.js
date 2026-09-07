"use strict";
(() => {
  const node = (tag, cls = "", text = "") => {
    const element = /** @type {any} */ (document.createElement(tag));
    element.className = cls; element.textContent = text; return element;
  };
  const running = new Set(["running", "queued", "waiting_resource", "stopping"]);
  const basename = directory => directory?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
  class NavigationView {
    constructor({ api, t, selected, open, create, changed, removed, empty }) {
      this.api = api; this.t = t; this.selected = selected; this.open = open; this.create = create;
      this.changed = changed; this.removed = removed; this.empty = empty;
      this.rows = new Map(); this.items = new Map(); this.groups = new Map(); this.activities = new Map(); this.revision = 0; this.interaction = 0;
      this.archivePage = document.getElementById("archive-page");
      this.archiveList = document.getElementById("archive-list");
      this.list = document.getElementById("session-list");
      this.pinned = node("section", "nav-pinned");
      this.pinned.append(node("h2", "nav-section-title", t("navigation.pinned")));
      this.pinList = node("div"); this.pinned.append(this.pinList);
      this.projectList = node("section", "nav-projects");
      this.projectList.append(node("h2", "nav-section-title", t("navigation.projects")));
      this.list.replaceChildren(this.pinned, this.projectList);
      try { this.collapsed = new Set(JSON.parse(localStorage.getItem("arcane.project-collapse") ?? "[]")); } catch { this.collapsed = new Set(); }
      document.getElementById("session-archives").addEventListener("click", () => { this.showArchives(true); void this.load(); });
      document.getElementById("archive-back").addEventListener("click", () => this.showArchives(false));
      document.getElementById("archive-restore").addEventListener("click", () => { const row = this.rows.get(selected()); if (row) void this.action(row, "restore"); });
      document.getElementById("navigation-retry").addEventListener("click", () => void this.load());
      document.addEventListener("pointerdown", event => { if (this.menu && !this.menu.contains(event.target)) this.closeMenu(false); });
      document.addEventListener("keydown", event => { if (event.key === "Escape" && !document.querySelector("dialog[open]")) { if (this.menu) this.closeMenu(); else this.showArchives(false); } });
      window.addEventListener("resize", () => this.closeMenu(false));
      this.list.addEventListener("scroll", () => this.closeMenu(false));
    }
    title(row) { return row.customTitle || row.name || (row.firstMessageI18n ? this.t(row.firstMessageI18n) : row.firstMessage) || this.t("sessions.untitled"); }
    showArchives(visible) {
      this.interaction++;
      this.archivePage.hidden = !visible; document.body.classList.toggle("show-archives", visible);
      document.getElementById("session-archives").setAttribute("aria-current", String(visible));
      this.closeMenu(false);
    }
    async load() {
      const revision = ++this.revision;
      try {
        const result = await this.api.sessionNavigation();
        if (revision !== this.revision) return;
        if (!result?.ok) throw new Error(result?.error || this.t("navigation.storageFailed"));
        this.rows = new Map(result.sessions.map(row => [row.id, row]));
        document.getElementById("navigation-retry").hidden = true;
        this.render(); this.changed();
      } catch { document.getElementById("navigation-retry").hidden = false; }
    }
    status(row) {
      const activity = this.activities.get(row.id) ?? row.activity ?? row.task;
      const state = activity?.state;
      if (state === "waiting_user" || activity?.needsAttention) return { kind: "attention", label: this.t("chat.task.waitingUser") };
      if (running.has(state) || (!state && row.busy)) return { kind: "running", label: this.t(({ queued: "activity.queued", waiting_resource: "activity.waitingResource", stopping: "chat.task.stopping" })[state] ?? "chat.task.running") };
      if (state === "failed" || state === "interrupted") return { kind: "failed", label: this.t(state === "failed" ? "chat.task.failed" : "chat.task.interrupted") };
      if (activity?.unread) return { kind: "unread", label: this.t("activity.unread") };
      return { kind: "idle", label: "" };
    }
    mark(element, status) { element.setAttribute("role", "img"); element.setAttribute("aria-hidden", String(!status.label)); element.dataset.kind = status.kind; element.title = status.label; element.setAttribute("aria-label", status.label); }
    updateActivities(rows) {
      this.activities = rows;
      for (const [id, item] of this.items) {
        const row = this.rows.get(id); if (!row) continue;
        this.mark(item.querySelector(".s-state"), this.status(row));
        item.classList.toggle("active", id === this.selected());
        item.querySelector(".s-body").setAttribute("aria-current", String(id === this.selected()));
      }
      for (const group of this.groups.values()) {
        const states = [...this.rows.values()].filter(row => row.projectKey === group.key && row.archivedAt == null).map(row => this.status(row));
        this.mark(group.state, ["attention", "running", "failed", "unread"].map(kind => states.find(state => state.kind === kind)).find(Boolean) ?? { kind: "idle", label: "" });
      }
    }
    render() {
      const alreadyRendered = this.items.size > 0;
      this.pinned.querySelector("h2").textContent = this.t("navigation.pinned");
      this.projectList.querySelector("h2").textContent = this.t("navigation.projects");
      for (const [id, item] of this.items) if (!this.rows.has(id)) { item.remove(); this.items.delete(id); }
      const ordinary = [...this.rows.values()].filter(row => row.archivedAt == null);
      const keys = new Set(ordinary.filter(row => row.pinnedOrder == null).map(row => row.projectKey ?? ""));
      for (const [key, group] of this.groups) if (!keys.has(key)) { group.root.remove(); this.groups.delete(key); }
      for (const row of this.rows.values()) {
        let parent;
        if (row.archivedAt != null) parent = this.archiveList;
        else if (row.pinnedOrder != null) parent = this.pinList;
        else {
          const key = row.projectKey ?? "";
          let group = this.groups.get(key);
          if (!group) {
            const root = node("section", "nav-project"); root.dataset.project = key;
            const header = node("div", "nav-project-header");
            const toggle = node("button", "nav-project-toggle"); toggle.type = "button";
            const arrow = node("span", "nav-chevron", "›"), title = node("span", "nav-project-name"), state = node("span", "s-state");
            toggle.append(arrow, title, state); toggle.title = row.cwd ?? this.t("navigation.unknownProject");
            const add = node("button", "nav-project-new", "+"); add.type = "button"; add.title = this.t("navigation.newInProject"); add.setAttribute("aria-label", add.title);
            add.disabled = !row.cwd; add.addEventListener("click", () => void this.create(row.cwd));
            const children = node("div", "nav-project-sessions"); children.hidden = this.collapsed.has(key);
            const update = () => { toggle.setAttribute("aria-expanded", String(!children.hidden)); arrow.classList.toggle("expanded", !children.hidden); };
            toggle.addEventListener("click", () => { children.hidden = !children.hidden; if (children.hidden) this.collapsed.add(key); else this.collapsed.delete(key); this.saveCollapse(); update(); });
            update(); header.append(toggle, add); root.append(header, children); this.projectList.append(root);
            group = { key, root, children, title, state, update }; this.groups.set(key, group);
          }
          const add = group.root.querySelector(".nav-project-new");
          add.title = this.t("navigation.newInProject"); add.setAttribute("aria-label", add.title);
          const name = basename(row.cwd) || this.t("navigation.unknownProject");
          const sameName = new Set(ordinary.filter(other => basename(other.cwd) === basename(row.cwd)).map(other => other.projectKey));
          group.title.textContent = sameName.size > 1 ? (row.cwd ?? name).replace(/\\/g, "/").split("/").slice(-2).join("/") : name;
          parent = group.children;
        }
        let item = this.items.get(row.id);
        const created = !item;
        if (!item) {
          item = node("div", "session-item"); item.dataset.sessionId = row.id;
          const body = node("button", "s-body"); body.type = "button";
          body.append(node("span", "s-title"), node("span", "s-meta"));
          const state = node("span", "s-state");
          const menu = node("button", "s-menu", "⋯"); menu.type = "button"; menu.title = this.t("navigation.menu"); menu.setAttribute("aria-label", menu.title); menu.setAttribute("aria-haspopup", "menu");
          const current = () => this.rows.get(row.id);
          item.addEventListener("click", () => { this.reveal(row.id); this.showArchives(false); void this.open(current()); });
          menu.addEventListener("click", event => { event.stopPropagation(); this.openMenu(current(), menu); });
          item.addEventListener("contextmenu", event => { event.preventDefault(); this.openMenu(current(), menu, event); });
          item.append(body, state, menu); this.items.set(row.id, item);
        }
        item.querySelector(".s-menu").title = this.t("navigation.menu");
        item.querySelector(".s-menu").setAttribute("aria-label", this.t("navigation.menu"));
        item.querySelector(".s-title").textContent = this.title(row);
        item.querySelector(".s-meta").textContent = row.pinnedOrder != null || row.archivedAt != null ? basename(row.cwd) || this.t("navigation.unknownProject") : "";
        item.title = row.cwd ?? "";
        if (item.parentElement !== parent) {
          if (created && alreadyRendered && parent !== this.pinList && parent !== this.archiveList) parent.prepend(item);
          else parent.append(item);
        }
      }
      for (const [container, sort] of [[this.pinList, (a, b) => a.pinnedOrder - b.pinnedOrder], [this.archiveList, (a, b) => b.archivedAt - a.archivedAt]]) {
        const ordered = [...this.rows.values()].filter(row => this.items.get(row.id)?.parentElement === container).sort(sort);
        ordered.forEach((row, index) => { const item = this.items.get(row.id); if (container.children[index] !== item) container.insertBefore(item, container.children[index] ?? null); });
      }
      this.pinned.hidden = this.pinList.children.length === 0;
      document.getElementById("archive-empty").hidden = this.archiveList.children.length > 0;
      this.updateActivities(this.activities);
      if (this.archiveToastId && this.rows.get(this.archiveToastId)?.archivedAt == null) { document.getElementById("navigation-toast").hidden = true; this.archiveToastId = null; }
    }
    saveCollapse() { try { localStorage.setItem("arcane.project-collapse", JSON.stringify([...this.collapsed])); } catch { /* Session navigation remains usable. */ } }
    reveal(id) { const row = this.rows.get(id), group = row && this.groups.get(row.projectKey); if (group && row.pinnedOrder == null) { group.children.hidden = false; this.collapsed.delete(group.key); this.saveCollapse(); group.update(); } }
    closeMenu(focus = true) { this.menu?.remove(); this.menu = null; if (focus && this.menuTrigger?.isConnected) this.menuTrigger.focus(); }
    openMenu(row, trigger, event = null) {
      this.closeMenu(false); this.menuTrigger = trigger;
      const menu = node("div", "session-menu"); menu.setAttribute("role", "menu"); this.menu = menu;
      const actions = row.archivedAt != null ? ["restore", "delete"] : [row.pinnedOrder != null ? "unpin" : "pin", "rename", "archive"];
      for (const action of actions) {
        const button = node("button", action === "delete" ? "danger" : "", this.t("navigation." + action)); button.type = "button"; button.setAttribute("role", "menuitem"); button.dataset.action = action;
        if (action === "archive" && ["running", "attention"].includes(this.status(row).kind)) { button.disabled = true; button.title = this.t("navigation.archiveBusy"); menu.append(node("small", "menu-explanation", button.title)); }
        button.addEventListener("click", () => { this.closeMenu(); void this.action(row, action); }); menu.append(button);
      }
      document.body.append(menu);
      const rect = trigger.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(event?.clientX ?? rect.left, innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(event?.clientY ?? rect.bottom, innerHeight - menu.offsetHeight - 8)) + "px";
      menu.addEventListener("keydown", event => { if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return; if (event.key === "Tab") { this.closeMenu(); return; } event.preventDefault(); const buttons = [...menu.querySelectorAll("button:not(:disabled)")]; const index = buttons.indexOf(document.activeElement); buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus(); });
      menu.querySelector("button:not(:disabled)")?.focus();
    }
    search() {
      if (this.searchDialog?.open) { this.searchDialog.querySelector("input").focus(); return; }
      this.closeMenu(false);
      const dialog = node("dialog", "session-dialog session-search"), input = node("input"), results = node("div", "search-results");
      this.searchDialog = dialog; dialog.setAttribute("aria-label", this.t("navigation.search"));
      input.type = "search"; input.placeholder = this.t("navigation.searchPlaceholder"); input.setAttribute("aria-label", input.placeholder);
      results.setAttribute("aria-live", "polite");
      const render = () => {
        const terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        results.replaceChildren();
        const matches = [...this.rows.values()].filter(row => terms.every(term => `${this.title(row)} ${row.cwd ?? ""}`.toLocaleLowerCase().includes(term)));
        if (!matches.length) results.append(node("p", "nav-empty", this.t("navigation.searchEmpty")));
        for (const row of matches) {
          const button = node("button", "search-result"); button.type = "button";
          button.append(node("span", "s-title", this.title(row)), node("span", "s-meta", (row.cwd || this.t("navigation.unknownProject")) + (row.archivedAt != null ? " · " + this.t("navigation.archived") : "")));
          button.onclick = () => { const current = this.rows.get(row.id); if (!current) { render(); return; } dialog.close(); this.reveal(row.id); this.showArchives(false); void this.open(current); };
          results.append(button);
        }
      };
      input.oninput = render;
      dialog.addEventListener("keydown", event => {
        const buttons = [...results.querySelectorAll("button")];
        if (event.key === "Enter" && document.activeElement === input) { event.preventDefault(); buttons[0]?.click(); }
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const index = buttons.indexOf(document.activeElement); if (event.key === "ArrowUp" && index <= 0) input.focus(); else buttons[(index + 1 * (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      });
      dialog.addEventListener("click", event => { const rect = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close(); });
      dialog.onclose = () => { dialog.remove(); this.searchDialog = null; document.getElementById("session-search").focus(); };
      dialog.append(input, results); document.body.append(dialog); render(); dialog.showModal(); input.focus();
    }
    async dialog(row, rename) {
      const dialog = node("dialog", "session-dialog"), form = node("form"); form.method = "dialog";
      const title = node("h2", "", this.t(rename ? "navigation.rename" : "navigation.delete")); title.id = "session-dialog-title"; dialog.setAttribute("aria-labelledby", title.id);
      const input = node("input"); input.value = this.title(row); input.maxLength = 200; input.required = true; input.setAttribute("aria-label", this.t("navigation.renameTitle"));
      const message = node("p", "", this.t("navigation.deleteConfirm"));
      const actions = node("div", "session-dialog-actions"); const cancel = node("button", "", this.t("navigation.cancel")); cancel.type = "button";
      const submit = node("button", rename ? "primary" : "danger", this.t(rename ? "navigation.save" : "navigation.delete")); submit.type = "submit";
      actions.append(cancel, submit); form.append(title, rename ? input : message, actions); dialog.append(form); document.body.append(dialog);
      return new Promise(resolve => { let value = null; cancel.onclick = () => dialog.close(); form.onsubmit = event => { event.preventDefault(); if (rename && !input.value.trim()) return; value = rename ? input.value.trim() : true; dialog.close(); }; dialog.onclose = () => { dialog.remove(); resolve(value); }; dialog.showModal(); (rename ? input : cancel).focus(); if (rename) input.select(); });
    }
    notify(text, undo = null, sessionId = null) {
      this.archiveToastId = sessionId;
      const toast = document.getElementById("navigation-toast"); toast.replaceChildren(node("span", "", text)); toast.hidden = false;
      if (undo) { const button = node("button", "", this.t("navigation.undo")); button.onclick = () => void undo(); toast.append(button); }
      const close = node("button", "", "×"); close.setAttribute("aria-label", this.t("navigation.close")); close.onclick = () => { toast.hidden = true; }; toast.append(close);
    }
    async action(row, action) {
      const interaction = this.interaction;
      try {
        let result;
        if (action === "rename") { const title = await this.dialog(row, true); if (title == null) return; result = await this.api.renameSession(row.id, title); }
        else if (action === "delete") { if (!await this.dialog(row, false)) return; result = await this.api.deleteArchivedSession(row.id); }
        else if (action === "archive") result = await this.api.archiveSession(row.id);
        else if (action === "restore") result = await this.api.restoreSession(row.id);
        else result = await this.api.setSessionPinned(row.id, action === "pin");
        if (!result?.ok) throw new Error(result?.code === "SESSION_BUSY" ? this.t("navigation.archiveBusy") : result?.error || this.t("common.unknown"));
        if (action === "delete") this.removed(row.id);
        await this.load();
        if (action === "archive") {
          this.notify(this.t("navigation.archived"), async () => { if (await this.action(row, "restore")) document.getElementById("navigation-toast").hidden = true; }, row.id);
          if (this.interaction === interaction && this.selected() === row.id) { const next = [...this.rows.values()].find(other => other.id !== row.id && other.projectKey === row.projectKey && other.archivedAt == null); if (next) await this.open(next); else this.empty(); }
        }
        if (action === "restore") { this.reveal(row.id); this.changed(); }
        return true;
      } catch (error) { this.notify(this.t("navigation.failed", { error: error.message })); return false; }
    }
  }
  /** @type {any} */ (globalThis).ArcaneNavigationView = NavigationView;
})();
