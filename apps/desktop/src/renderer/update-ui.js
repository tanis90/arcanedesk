// update-ui.js — 应用内更新的渲染层控制器（auto-update-design §5.3）。
// 药丸 = 常驻状态指示 + 浮层唯一入口；浮层 = 决策面板，承载全部动作。
// 交互纪律：动作点击后 ~1.5s 忙碌反馈自动收起；收起不取消下载；ready 不自动弹开。
// 状态来自 main 的 update:state IPC + update_state 事件推送，本地不持久化。
"use strict";

(function () {
  const t = (key, params) => window.ArcaneI18n.t(key, params);
  const M = 1024 * 1024;
  const fmtBytes = (n) => `${(n / M).toFixed(1)} MB`;
  const fmtSpeed = (n) => `${(n / M).toFixed(1)} MB`;

  /** @type {{ status: string, currentVersion?: string, version?: string|null, progress?: {percent:number,transferred:number,total:number,bytesPerSecond:number}|null, error?: string } | null} */
  let state = null;
  let popoverOpen = false;
  let busyTimer = null;

  function pill() { return document.getElementById("update-pill"); }
  function popover() { return document.getElementById("update-popover"); }

  function pillLabel(s) {
    switch (s.status) {
      case "available": return t("update.pill.newVersion", { version: s.version ?? "?" });
      case "downloading": return t("update.pill.downloading", { percent: Math.round(s.progress?.percent ?? 0) });
      case "ready": return t("update.pill.ready");
      case "error": return t("update.pill.error");
      default: return "";
    }
  }

  function renderPill() {
    const node = pill();
    if (!node) return;
    const visible = state && ["available", "downloading", "ready", "error"].includes(state.status);
    node.hidden = !visible;
    if (visible) {
      node.textContent = pillLabel(state);
      node.setAttribute("aria-label", pillLabel(state));
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderPopover() {
    const box = popover();
    if (!box) return;
    if (!popoverOpen || !state) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    box.appendChild(el("h4", null, t("update.popover.title")));

    if (state.status === "available" || state.status === "downloading" || state.status === "ready") {
      const versions = el("div", "update-versions");
      const current = el("span", "dim", `${t("update.popover.current")} ${state.currentVersion ?? ""}`);
      const next = el("span", null, `${t("update.popover.new")} ${state.version ?? "?"}`);
      versions.append(current, next);
      box.appendChild(versions);
    }

    if (state.status === "downloading" && state.progress) {
      const track = el("div", "update-progress-track");
      const fill = el("div", "update-progress-fill");
      fill.style.width = `${Math.min(100, state.progress.percent)}%`;
      track.appendChild(fill);
      box.appendChild(track);
      box.appendChild(el(
        "div", "update-progress-text",
        `${t("update.progress", {
          transferred: fmtBytes(state.progress.transferred),
          total: fmtBytes(state.progress.total),
          speed: fmtSpeed(state.progress.bytesPerSecond),
        })} · ${Math.round(state.progress.percent)}%`,
      ));
    }

    if (state.status === "ready") {
      box.appendChild(el("div", "update-ready-note", t("update.popover.readyNote")));
    }

    if (state.status === "error") {
      box.appendChild(el("div", "update-error", t("update.popover.errorLine", { error: state.error ?? t("common.unknownError") })));
    }

    const actions = el("div", "update-actions");
    if (state.status === "available") {
      actions.appendChild(actionButton(t("update.popover.download"), () => window.arcane.downloadUpdate()));
    } else if (state.status === "error") {
      actions.appendChild(actionButton(t("update.popover.retry"), () => window.arcane.downloadUpdate()));
      const fallback = actionButton(t("update.popover.manualFallback"), () => window.arcane.openArcaneWebsite(), "link");
      actions.appendChild(fallback);
    } else if (state.status === "ready") {
      actions.appendChild(actionButton(t("update.popover.install"), () => window.arcane.installUpdate()));
    } else if (state.status === "downloading") {
      const busy = el("button", null, t("update.popover.downloading"));
      busy.disabled = true;
      actions.appendChild(busy);
    }
    if (actions.children.length) box.appendChild(actions);
  }

  // 动作按钮：点击后 ~1.5s 忙碌反馈再收起浮层（药丸继续承载状态）。
  function actionButton(label, onClick, extraClass) {
    const btn = el("button", extraClass ?? null, label);
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = t("update.popover.downloading");
      clearTimeout(busyTimer);
      busyTimer = setTimeout(closePopover, 1500);
      try { onClick(); } catch { /* IPC 失败由状态推送兜底 */ }
    });
    return btn;
  }

  function render() {
    renderPill();
    renderPopover();
    renderSettings();
  }

  function setState(next) {
    state = next;
    render();
  }

  function openPopover() {
    popoverOpen = true;
    renderPopover();
  }

  function closePopover() {
    popoverOpen = false;
    renderPopover();
  }

  function togglePopover() {
    if (popoverOpen) closePopover(); else openPopover();
  }

  function isPopoverTarget(node) {
    return node instanceof Node && (popover()?.contains(node) || pill()?.contains(node));
  }

  // ---- settings 软件更新小节 ----
  let settingsCheckedOnce = false;
  function renderSettings() {
    const version = document.getElementById("update-settings-version");
    if (version) version.textContent = state?.currentVersion ?? "";
    // 状态行只反映手动检查的结果；状态推送不打扰设置页文本。
    if (state?.status === "disabled") {
      const status = document.getElementById("update-settings-status");
      if (status) status.textContent = "";
    }
  }

  async function manualCheck() {
    const button = document.getElementById("update-check-button");
    const status = document.getElementById("update-settings-status");
    if (!button || !status) return;
    button.disabled = true;
    status.textContent = t("update.settings.checking");
    try {
      const res = await window.arcane.checkUpdates();
      const next = res?.state ?? null;
      if (next) setState(next);
      settingsCheckedOnce = true;
      if (!res?.ok) {
        status.textContent = res?.code === "UPDATER_DISABLED" ? "" : t("update.settings.error", { error: t("common.unknownError") });
      } else if (next?.status === "available") {
        status.textContent = t("update.settings.found", { version: next.version ?? "?" });
      } else if (next?.status === "error") {
        status.textContent = t("update.settings.error", { error: next.error ?? t("common.unknownError") });
      } else {
        status.textContent = t("update.settings.upToDate");
      }
    } catch (error) {
      status.textContent = t("update.settings.error", { error: String(error?.message ?? error) });
    } finally {
      button.disabled = false;
    }
  }

  function init() {
    pill()?.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePopover();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && popoverOpen) closePopover();
    });
    document.addEventListener("pointerdown", (event) => {
      if (popoverOpen && !isPopoverTarget(event.target)) closePopover();
    });
    document.getElementById("update-check-button")?.addEventListener("click", () => { void manualCheck(); });

    window.arcane.onUpdateState?.((next) => setState(next));
    window.arcane.updateState?.()
      .then((res) => { if (res?.ok && res.state) setState(res.state); })
      .catch(() => { /* 主进程未启用时保持隐藏 */ });
    window.ArcaneI18n.onLocaleChange?.(() => render());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
