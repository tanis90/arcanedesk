// 右屏 Markdown 阅读器页(md-reader-spec §4.3/§5)。
//
// 这个页面不读盘、不持久化、不自己决定显示什么:内容全部由 main 侧一条
// arcane-reader:content 推送供给(§3.5 不变量 5)。因此 Chromium 默认 F5 重载后
// did-finish-load 会再推一次,内容必然回来,不需要为刷新另设通道。
//
// 与 chat 侧共用 markdown.js 的渲染管线,所以代码高亮、表格、公式、mermaid
// 的输出与气泡里完全一致,这里零再设计(§5.3)。
"use strict";

(function () {
  const t = window.ArcaneI18n.t;
  const back = /** @type {HTMLButtonElement} */ (document.getElementById("reader-back"));
  const nameEl = document.getElementById("reader-name");
  const notice = document.getElementById("reader-notice");
  const scroll = document.getElementById("reader-scroll");
  const doc = document.getElementById("reader-doc");
  const errorBox = document.getElementById("reader-error");
  const errorText = errorBox.querySelector("p");

  // §5.5 的错误文案键:与 md-reader-note.js 的 reason 一一对应。
  // 未知 reason 落到 missing——"找不到这份笔记 + 让 agent 重新生成"对读不动的文件
  // 同样是可行动的下一步,不值得为不可达的取值多写一条文案(design-rules R3/R4)。
  const ERROR_KEYS = {
    outside: "reader.error.outside",
    missing: "reader.error.missing",
    encoding: "reader.error.encoding",
  };

  /** origin 决定 ③ 的文案与语义:foundry → 返回,closed → 关闭(§4.3"文案即语义")。 */
  function applyOrigin(origin) {
    const closing = origin !== "foundry";
    back.textContent = t(closing ? "reader.close" : "reader.back");
    back.setAttribute("aria-label", back.textContent);
    back.title = back.textContent;
  }

  function leave() {
    void window.arcaneReader.back();
  }

  function showError(key) {
    errorText.textContent = t(key);
    errorBox.hidden = false;
    scroll.hidden = true;
    notice.hidden = true;
  }

  /** 上一次渲染的笔记路径:分辨"同一份被唤回"与"换了一份"。 */
  let shownPath = null;
  /** 最后一次内容推送:语言热切换时按它重上 chrome 文案,不重渲染正文(review M2)。 */
  let lastPayload = null;

  /**
   * 渲染一份 payload。arcaneMd.render 只追加不清空,所以整段重建。
   * 滚动位置分两种情况(§2 保活范围):同一份笔记被 ④ 顶掉后又 ② 唤回,
   * 保活买的就是"接着读",位置原样留着;换了一份文件,停在上一份的位置没有意义,回顶。
   */
  function showNote(payload) {
    const sameNote = payload.path != null && payload.path === shownPath;
    const keepScroll = sameNote ? scroll.scrollTop : 0;
    shownPath = payload.path ?? null;
    errorBox.hidden = true;
    scroll.hidden = false;
    doc.textContent = "";
    notice.textContent = payload.truncated ? t("reader.truncated") : "";
    notice.hidden = !payload.truncated;
    nameEl.textContent = payload.name ?? "";
    nameEl.title = payload.name ?? "";
    document.title = payload.name ? `${payload.name} · ArcaneDesk` : "ArcaneDesk";
    window.arcaneMd.render(doc, payload.text ?? "");
    scroll.scrollTop = keepScroll;
  }

  window.arcaneReader.onContent(payload => {
    lastPayload = payload ?? null;
    applyOrigin(payload?.origin);
    if (payload?.error) {
      shownPath = null; // 错误页不是任何一份笔记:下次真读到东西时不该当成"同一份"
      nameEl.textContent = "";
      document.title = "ArcaneDesk";
      showError(ERROR_KEYS[payload.error] ?? ERROR_KEYS.missing);
      return;
    }
    showNote(payload ?? {});
  });

  // 主题与内容分开发:切主题不重读文件、不重渲染(§7 arcaneReader.onTheme)。
  window.arcaneReader.onTheme(theme => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  });

  // 语言热切换(review M2):ArcaneI18n.setLocale 会更新 <html lang> 并回填 data-i18n;
  // 本页没有 data-i18n 节点,chrome 文案(返回按钮/截断提示/错误页)全是 JS 按状态
  // 派生的,按最后一次 payload 重上一遍即可,正文不碰(重渲染会丢滚动位置)。
  window.arcaneReader.onLocale(locale => {
    window.ArcaneI18n.setLocale(locale);
    applyOrigin(lastPayload?.origin ?? null);
    if (lastPayload?.error) {
      errorText.textContent = t(ERROR_KEYS[lastPayload.error] ?? ERROR_KEYS.missing);
    } else if (lastPayload) {
      notice.textContent = lastPayload.truncated ? t("reader.truncated") : "";
    }
  });

  back.addEventListener("click", leave);
  // Esc 等价于顶栏那个按钮(§4.3)。焦点在阅读器里才生效——chat 侧的 Esc 有自己的语义。
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    leave();
  });

  // 首屏:内容与主题都在 did-finish-load 之后才推得来,这里只把按钮摆成默认形态。
  applyOrigin(null);
})();
