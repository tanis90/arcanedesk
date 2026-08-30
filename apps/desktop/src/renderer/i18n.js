// 渲染层 i18n 核心 — t() 查字典、applyI18n() 回填静态 DOM、setLocale 热切换。
// 字典在 shared/i18n/messages.js(globalThis.ARCANE_MESSAGES),index.html 里先于本文件加载。
// 供 chat.js / voice.js / keycapture.js / markdown.js 以 window.ArcaneI18n 使用
// (tsc 把各 classic script 当模块,跨文件只能走 window,同 markdown.js 约定)。
"use strict";

(function () {
  const SUPPORTED = ["zh-CN", "en-US"];
  const FALLBACK = "zh-CN";
  const MESSAGES = /** @type {Record<string, Record<string, string>>} */ (
    /** @type {any} */ (globalThis).ARCANE_MESSAGES
  );
  const listeners = [];
  let locale = document.documentElement.dataset.locale;

  function valid(value) {
    return SUPPORTED.includes(value) ? value : null;
  }

  function detectFromNavigator() {
    const langs = navigator.languages && navigator.languages.length > 0 ? navigator.languages : [navigator.language || ""];
    return /^zh/i.test(String(langs[0] ?? "")) ? "zh-CN" : "en-US";
  }

  function dict() {
    return MESSAGES[locale] ?? MESSAGES[FALLBACK] ?? {};
  }

  function t(key, params) {
    let value = dict()[key] ?? (MESSAGES[FALLBACK] ?? {})[key] ?? key;
    if (params) {
      value = value.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }
    return value;
  }

  /** 主进程 IPC 错误的统一出口:结构化 {key, params} → 本地化;其余按普通字符串透传。 */
  function fmtIpc(error) {
    if (error && typeof error === "object" && typeof error.key === "string") {
      return t(error.key, error.params);
    }
    if (error == null) return t("common.unknownError");
    return String(error);
  }

  /**
   * 全量回填静态文案。data-i18n-html 仅用于字典内自带的 <br/>(字典是我们自己写的,可信)。
   * 带 data-i18n-dynamic 的节点跳过:它们由 JS 按状态派生(如模式徽章、麦克风 title),
   * 全量回填会用通用文案覆盖具体状态文案。
   */
  function apply(root) {
    const scope = root ?? document;
    scope.querySelectorAll("[data-i18n]:not([data-i18n-dynamic])").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    scope.querySelectorAll("[data-i18n-html]").forEach((node) => { node.innerHTML = t(node.dataset.i18nHtml); });
    scope.querySelectorAll("[data-i18n-title]:not([data-i18n-dynamic])").forEach((node) => { node.title = t(node.dataset.i18nTitle); });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      // placeholder 在 HTMLInputElement/HTMLTextAreaElement 上,按 any 赋值
      /** @type {any} */ (node).placeholder = t(node.dataset.i18nPlaceholder);
    });
    scope.querySelectorAll("[data-i18n-prompt]").forEach((node) => {
      /** @type {HTMLElement} */ (node).dataset.prompt = t(node.dataset.i18nPrompt);
    });
    scope.querySelectorAll("[data-i18n-alt]").forEach((node) => {
      /** @type {HTMLElement} */ (node).setAttribute("alt", t(node.dataset.i18nAlt));
    });
  }

  function setLocale(next) {
    const resolved = valid(next) ?? detectFromNavigator();
    locale = resolved;
    document.documentElement.lang = resolved;
    document.documentElement.dataset.locale = resolved;
    apply();
    for (const fn of listeners) {
      try { fn(resolved); } catch { /* 单个刷新回调失败不阻塞其余 */ }
    }
    return resolved;
  }

  /**
   * 设置页语言下拉的落点:pref = auto | zh-CN | en-US。
   * auto 不写 localStorage(否则 dev 无 query 启动会把解析结果误当显式选择);
   * 显式选择写一份,theme-init 同款双保险。
   */
  function setLocaleForPref(pref) {
    const resolved = valid(pref) ?? detectFromNavigator();
    try {
      if (valid(pref)) localStorage.setItem("arcane-locale", pref);
      else localStorage.removeItem("arcane-locale");
    } catch { /* ignore */ }
    return setLocale(resolved);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();

  /** @type {any} */ (window).ArcaneI18n = {
    t,
    apply,
    fmtIpc,
    setLocale,
    setLocaleForPref,
    getLocale: () => locale,
    onLocaleChange: (fn) => { listeners.push(fn); },
  };
})();
