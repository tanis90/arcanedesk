// 首屏语言初始化:在任何渲染前同步设置 <html lang> 与 dataset.locale,与 theme-init 同款。
// 优先级:URL query ?lang=(main 进程按 ui.json 解析的权威值)> localStorage(显式选择,
// 仅 dev 无 query 时兜底)> navigator 检测 > zh-CN。i18n.js 加载时读 dataset.locale。
(function () {
  let locale = null;
  try {
    locale = new URLSearchParams(location.search).get("lang");
  } catch (e) { /* ignore */ }
  if (locale !== "zh-CN" && locale !== "en-US") {
    try {
      locale = localStorage.getItem("arcane-locale");
    } catch (e) { locale = null; }
  }
  if (locale !== "zh-CN" && locale !== "en-US") {
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || "";
    locale = /^zh/i.test(String(nav)) ? "zh-CN" : "en-US";
  }
  document.documentElement.dataset.locale = locale;
  document.documentElement.lang = locale;
})();
