// 首屏主题初始化:在任何渲染前同步设置 <html data-theme>,避免亮主题闪黑屏。
// 优先级:URL query(main 进程从 userData 读到的持久化值)> localStorage > light。
(function () {
  var theme = null;
  try {
    theme = new URLSearchParams(location.search).get("theme");
  } catch (e) { /* ignore */ }
  if (theme !== "light" && theme !== "dark") {
    try {
      theme = localStorage.getItem("arcane-theme");
    } catch (e) { theme = null; }
  }
  if (theme !== "light" && theme !== "dark") {
    theme = "light";
  }
  document.documentElement.dataset.theme = theme;
  // Win 下 main 进程用隐藏标题栏 + overlay 三键,天头要切换成可拖拽标题栏形态
  try {
    if (new URLSearchParams(location.search).get("frameless") === "1") {
      document.documentElement.dataset.frameless = "1";
    }
  } catch (e) { /* ignore */ }
})();
