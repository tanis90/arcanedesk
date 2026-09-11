// 右屏 Markdown 阅读器页(md-reader-spec §4.3/§5)。
//
// 这个页面不读盘、不持久化、不自己决定显示什么:内容全部由 main 侧一条
// arcane-reader:content 推送供给(§3.5 不变量 5)。F5 由 main 侧接管成 surface 感知的
// 重读文件再推送;真发生页面重载时,did-finish-load 触发 onReaderReady,main 按
// lastContent 重推一遍,内容必然回来,不需要为刷新另设通道。
//
// 与 chat 侧共用 markdown.js 的渲染管线,所以代码高亮、表格、公式、mermaid
// 的输出与气泡里完全一致,这里零再设计(§5.3)。
"use strict";

(function () {
  const t = window.ArcaneI18n.t;
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

  // ---------- N9:滚动位置回正 ----------
  // showNote 同步设的 scrollTop 会被异步增长顶歪:mermaid 围栏出图、图片晚到,
  // 视口上方的内容一长高,同一个 scrollTop 就落在别的段落上。渲染后开一个短窗
  // (2 秒,或到用户第一次滚动为止——用户滚动永远赢),文档高度一变就把保存的位置按回去。
  /** @type {{ saved: number, height: number, observer: MutationObserver, timer: ReturnType<typeof setTimeout> } | null} */
  let scrollGuard = null;

  function cancelScrollGuard() {
    if (!scrollGuard) return;
    scrollGuard.observer.disconnect();
    clearTimeout(scrollGuard.timer);
    scrollGuard = null;
  }

  function onGuardScroll() {
    // 回正只是把 scrollTop 设回 saved(值没变,不触发 scroll);事件来了就是用户滚的
    if (scrollGuard && scroll.scrollTop !== scrollGuard.saved) cancelScrollGuard();
  }

  /** @param {number} saved 要守住的 scrollTop;0(回顶)没有可守的,不开窗 */
  function guardScrollPosition(saved) {
    cancelScrollGuard();
    if (!saved) return;
    const reassert = () => {
      if (!scrollGuard || scroll.scrollHeight === scrollGuard.height) return;
      scrollGuard.height = scroll.scrollHeight;
      scroll.scrollTop = scrollGuard.saved;
    };
    const observer = new MutationObserver(() => {
      // 图片加载不改 DOM,MutationObserver 看不见,给它们补挂一次性 load
      for (const img of doc.querySelectorAll("img")) {
        if (img.dataset.scrollGuard) continue;
        img.dataset.scrollGuard = "1";
        img.addEventListener("load", reassert, { once: true });
      }
      requestAnimationFrame(reassert);
    });
    observer.observe(doc, { childList: true, subtree: true });
    scrollGuard = { saved, height: scroll.scrollHeight, observer, timer: setTimeout(cancelScrollGuard, 2000) };
  }

  scroll.addEventListener("scroll", onGuardScroll);

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
    document.title = payload.name ? `${payload.name} · ArcaneDesk` : "ArcaneDesk";
    window.arcaneMd.render(doc, payload.text ?? "");
    scroll.scrollTop = keepScroll;
    guardScrollPosition(keepScroll);
  }

  window.arcaneReader.onContent(payload => {
    cancelScrollGuard(); // 换内容(含错误页)后,旧笔记的回正窗口不再有意义
    lastPayload = payload ?? null;
    if (payload?.error) {
      shownPath = null; // 错误页不是任何一份笔记:下次真读到东西时不该当成"同一份"
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
  // 本页没有 data-i18n 节点,chrome 文案(截断提示/错误页)全是 JS 按状态
  // 派生的,按最后一次 payload 重上一遍即可,正文不碰(重渲染会丢滚动位置)。
  window.arcaneReader.onLocale(locale => {
    window.ArcaneI18n.setLocale(locale);
    if (lastPayload?.error) {
      errorText.textContent = t(ERROR_KEYS[lastPayload.error] ?? ERROR_KEYS.missing);
    } else if (lastPayload) {
      notice.textContent = lastPayload.truncated ? t("reader.truncated") : "";
    }
  });

})();
