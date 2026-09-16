// 右屏阅读器的真实窗口验收(md-reader-spec §9 smoke)。
//
// 跑的是生产 main.js + 生产 renderer:笔记走真的磁盘、锚点走 markdown.js 真的渲染、
// 点击走 chat.js 真的委托、切换走 panel-surface-controller 真的双 view 生命周期。
// 只有 Foundry 那一头是本地的假页面——smoke 要验的是 surface 切换,不是 FVTT 本身。
//
// 文案断言一律拿 chat 页的 t() 当参照,而不是写死中文:smoke 跟着系统语言跑,
// 写死中文会让英文环境下的 CI 假红(panel-ui.cjs 同一个做法)。
const { app } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

module.exports = async ({ window, evaluate, ui, until, project }) => {
  const notes = path.join(project, "notes");
  mkdirSync(notes, { recursive: true });
  const writeNote = (name, body) => writeFileSync(path.join(notes, name), body);
  writeNote("gatekeeper.md", "# 守门人\n\n石门后面站着一个不说话的人。\n");
  writeNote("second.md", "# 第二份\n\n换一份笔记。\n");
  writeNote("tall.md", `# 很长的一份\n\n${Array.from({ length: 400 }, (_unused, index) => `第 ${index} 行。`).join("\n")}\n`);
  writeNote("huge.md", `${"# 超大\n\n"}${"x".repeat(2 * 1024 * 1024 + 4096)}\n`);

  // 右屏的 surface view:按 URL 认,不靠生产代码开测试口子(spec §8 只暴露 foundryView)。
  // 悬浮切换器(panel-switch.html)是常驻 chrome,不是 surface,不算进来——否则 foundry()
  // 会把它认错(URL 非空且不含 md-reader.html),assertOneVisible 也会数出第二个可见 view。
  const views = () => window.contentView.children.filter((view) =>
    !view.webContents?.isDestroyed() && !urlOf(view).includes("panel-switch.html"));
  const urlOf = (view) => (view.webContents?.isDestroyed() ? "" : view.webContents.getURL());
  const dumpViews = () => window.contentView.children.map((view) => ({
    destroyed: view.webContents?.isDestroyed() ?? true,
    visible: view.getVisible(),
    url: urlOf(view),
    bounds: view.getBounds(),
  }));
  const reader = () => views().find((view) => urlOf(view).includes("md-reader.html")) ?? null;
  // 空 URL 的一律不算 Foundry:view 刚建出来、loadFile 还没落地时 getURL() 就是空的,
  // 不排掉就会把阅读器认成 Foundry,那些"READER_C 底下不该有 Foundry"的断言全会反过来。
  const foundry = () => views().find((view) => {
    const url = urlOf(view);
    return url !== "" && !url.includes("md-reader.html");
  }) ?? null;
  /** loadFile 是异步的,而 panelOpen 在 showReader() 里同步就翻了:先等页面真加载完。
      失败时把两个 view 的现场附在消息里——超时那一刻的状态才是有用的证据。 */
  const waitReader = async () => {
    try {
      await until(async () => Boolean(reader()), "the reader page loads");
    } catch (error) {
      throw new Error(`${error.message}; views=${JSON.stringify(dumpViews())}`);
    }
    return reader();
  };
  const readerEval = async (code) => (await waitReader()).webContents.executeJavaScript(code);
  /** 等阅读器把某一次推送渲染完。比 sleep 可靠:慢机器上 sleep 会假红,快机器上白等。 */
  const readerSettled = async (code) => {
    await until(async () => { try { return Boolean(await readerEval(code)); } catch { return false; } }, `the reader renders: ${code}`);
  };
  /** 不变量 1:任一时刻右屏最多一个 view 可见(§3.5)。
      可见性读 getVisible():这个 Electron 版本上 view 没有 visible 属性(读了得 undefined),
      写成 `visible !== false` 会把隐藏的 view 也算成可见,断言就名存实亡了。 */
  const assertOneVisible = (label) => {
    const shown = views().filter((view) => view.getVisible());
    assert.ok(shown.length <= 1, `${label}: ${shown.length} views visible at once`);
    return shown.length;
  };
  const noteTitle = () => readerEval("document.title");
  const docText = () => readerEval('document.getElementById("reader-doc").textContent');
  const errorText = () => readerEval('document.getElementById("reader-error").hidden ? null : document.querySelector("#reader-error p").textContent');
  const noticeText = () => readerEval('document.getElementById("reader-notice").hidden ? null : document.getElementById("reader-notice").textContent');

  // 在 chat 里造一条带路径的 assistant 消息:走真的 renderMarkdown,所以锚点是生产管线产出的。
  let said = 0;
  const say = async (text) => {
    const anchors = await evaluate(
      `(() => { const box = document.createElement("div"); box.className = "msg assistant"; box.id = "smoke-note-${said}";
         messages.appendChild(box); renderMarkdown(box, ${JSON.stringify(text)});
         return box.querySelectorAll("a.md-path").length; })()`,
    );
    assert.ok(anchors >= 1, `expected a clickable note path in: ${text}`);
    const index = said++;
    return async () => {
      await evaluate(`document.getElementById("smoke-note-${index}").querySelector("a.md-path").click()`);
    };
  };

  const host = globalThis.__arcaneHosts.prep.activeHost;
  const site = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Foundry Virtual Tabletop</title><h1>Foundry test page</h1>");
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = site.address().port;
  const target = `http://127.0.0.1:${port}/game`;
  const foundryLoads = () => foundry()?.webContents.getURL() ?? "";
  /** 等 Foundry 页真的落在 target 上。只等"URL 非空"不够:连不上时生产代码会把页面
      换成 foundry-unavailable.html,那也是个非空 URL,会被当成 Foundry 认下来。 */
  const waitFoundryAt = async () => {
    try {
      await until(async () => foundryLoads() === target, `the foundry view reaches ${target}`);
    } catch (error) {
      throw new Error(`${error.message}; views=${JSON.stringify(dumpViews())}`);
    }
    return foundry();
  };

  try {
    // ---------- ② 从 CLOSED 打开:落 READER_C(origin=closed) ----------
    assert.equal(await evaluate("panelOpen"), false, "panel starts closed");
    const clickGatekeeper = await say("备好了 notes/gatekeeper.md，点开看看。");
    await clickGatekeeper();
    await ui('panelOpen === true');
    await waitReader();
    assert.equal(foundry(), null, "READER_C must not have a Foundry view underneath (§3.5 invariant 3)");
    await readerSettled('document.title === "gatekeeper.md · ArcaneDesk"');
    assert.match(await docText(), /守门人/);
    assert.equal(await errorText(), null);
    assert.equal(assertOneVisible("READER_C"), 1);

    // ---------- ③ 切 FVTT:READER_C 底下没有现场,如实报空,绝不拉起加载 ----------
    const emptySwitch = await evaluate('window.arcane.switchPanelSurface("foundry")');
    assert.equal(emptySwitch?.ok, false, "READER_C 下没有可切换的 Foundry 现场");
    assert.equal(emptySwitch?.empty, "foundry");
    assert.equal(foundry(), null, "报空绝不拉起 FVTT 加载(§3.5 不变量 3)");
    assert.equal(reader().getVisible(), true, "阅读器原样保留");
    assert.equal(assertOneVisible("READER_C after empty switch"), 1);

    // ---------- ④ FVTT 打开:导航到目标地址 ----------
    assert.equal((await host.openFoundry(target)).ok, true);
    await ui('panelOpen === true');
    await waitFoundryAt();
    assert.equal(reader().getVisible(), false, "④ keeps the reader hidden and alive");

    // ---------- ② 从 FOUNDRY 打开:落 READER_F,Foundry 隐藏保活 ----------
    const clickTall = await say("长的那份在 notes/tall.md。");
    await clickTall();
    await readerSettled('document.title === "tall.md · ArcaneDesk"');
    assert.ok(foundry(), "READER_F keeps the Foundry view alive (§3.5 invariant 2)");
    assert.equal(foundry().getVisible(), false, "the hidden Foundry view must not stay visible");
    assert.equal(assertOneVisible("READER_F"), 1);

    // ---------- ③ 切 FVTT:只做显隐,绝不重载 FVTT ----------
    await evaluate('window.arcane.switchPanelSurface("foundry")');
    await until(async () => foundry()?.getVisible() === true, "the surface switch hands the pane back to Foundry");
    assert.equal(reader().getVisible(), false, "the reader stays alive under Foundry (§2)");
    assert.equal(foundryLoads(), target, "切换绝不重载 Foundry 页(§3.5 不变量 2)");
    assert.equal(await foundry().webContents.executeJavaScript('document.querySelector("h1").textContent'), "Foundry test page");
    assert.equal(assertOneVisible("FOUNDRY"), 1);

    // ---------- ④ 顶掉后 ② 唤回:同一份笔记保留滚动位置(§2) ----------
    await clickTall();
    await until(async () => reader()?.getVisible() === true, "② brings the reader back over Foundry");
    await readerEval('(() => { const el = document.getElementById("reader-scroll"); el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2); })()');
    const wantedScroll = Number(await readerEval('document.getElementById("reader-scroll").scrollTop'));
    assert.ok(wantedScroll > 0, "the note is long enough to scroll");
    assert.equal((await host.openFoundry(target)).ok, true, "④ takes the pane back");
    await until(async () => foundry()?.getVisible() === true, "④ shows Foundry again");
    assert.equal(reader().getVisible(), false, "the reader is hidden, not destroyed");
    assert.ok(!reader().webContents.isDestroyed());
    await clickTall();
    await until(async () => reader()?.getVisible() === true, "② recalls the same note");
    assert.equal(Number(await readerEval('document.getElementById("reader-scroll").scrollTop')), wantedScroll, "keep-alive restores the reading position");

    // ---------- ② 阅读中换笔记:原地换内容,滚动回顶,origin 不重置 ----------
    const clickSecond = await say("另一份是 notes/second.md。");
    await clickSecond();
    await readerSettled('document.title === "second.md · ArcaneDesk"');
    assert.match(await docText(), /第二份/);
    assert.equal(Number(await readerEval('document.getElementById("reader-scroll").scrollTop')), 0, "a different note starts at the top");

    // ---------- F5 是 surface 感知的:重读当前文件(§4.3) ----------
    writeNote("second.md", "# 第二份\n\n改过之后的正文。\n");
    const reloaded = await evaluate('window.arcane.reloadPanel()');
    assert.notEqual(reloaded?.ok, false, "reloadPanel must not silently no-op on the reader surface (R5)");
    await readerSettled('document.getElementById("reader-doc").textContent.includes("改过之后的正文")');
    assert.match(await docText(), /改过之后的正文/, "F5 re-reads the file from disk");

    // ---------- 错误页:越界路径 ----------
    // 两条错误场景按文案等,不能只等错误框可见:第二条进来时框已经是可见的,
    // 只等"可见"会拿着上一条的文案就断言,慢机器上必假红。
    const outsideWord = await evaluate('t("reader.error.outside")');
    const clickOutside = await say("这份在外面 ../outside.md。");
    await clickOutside();
    await readerSettled(`document.querySelector("#reader-error p").textContent === ${JSON.stringify(outsideWord)}`);
    assert.equal(await errorText(), outsideWord);
    assert.equal(await readerEval('document.getElementById("reader-scroll").hidden'), true, "the error page replaces the body");
    assert.equal(await noteTitle(), "ArcaneDesk", "the error page clears the document title");

    // ---------- 错误页:文件不存在 ----------
    const missingWord = await evaluate('t("reader.error.missing")');
    const clickMissing = await say("这份没了 notes/gone.md。");
    await clickMissing();
    await readerSettled(`document.querySelector("#reader-error p").textContent === ${JSON.stringify(missingWord)}`);
    assert.equal(await errorText(), missingWord);

    // ---------- 超限截断 ----------
    const truncatedWord = await evaluate('t("reader.truncated")');
    const clickHuge = await say("超大的一份 notes/huge.md。");
    await clickHuge();
    await readerSettled(`document.getElementById("reader-notice").textContent === ${JSON.stringify(truncatedWord)}`);
    assert.equal(await noticeText(), truncatedWord);
    assert.equal(await errorText(), null);
    assert.ok((await docText()).length > 0, "the truncated head is still rendered");

    // ---------- ① origin=foundry 的阅读周期被 ① 关掉:重开回 Foundry,笔记留在 chat 里(spec §3.4 修订) ----------
    await evaluate('window.arcane.closePanel()');
    await ui('panelOpen === false');
    await until(async () => views().length === 0, "① closing destroys both views");
    assert.equal(reader(), null);
    assert.equal(foundry(), null, "① closing collapses the whole right pane (§2)");
    await evaluate('window.arcane.openPanel()');
    await ui('panelOpen === true');
    // 重开回到关闭前那个 Foundry 地址(spec §3.4):不是默认地址,也不是刚才那份笔记。
    await waitFoundryAt();
    assert.equal(reader(), null, "closing over a Foundry-backed note reopens on Foundry (spec §3.4)");

    // ---------- ① origin=closed 的阅读周期被 ① 关掉:重开恢复笔记 ----------
    await evaluate('window.arcane.closePanel()');
    await ui('panelOpen === false');
    const clickHugeAgain = await say("再看一次 notes/huge.md。");
    await clickHugeAgain();
    await waitReader();
    await readerSettled('document.title === "huge.md · ArcaneDesk"');
    await evaluate('window.arcane.closePanel()');
    await ui('panelOpen === false');
    await until(async () => views().length === 0, "① closing destroys the reader view");
    await evaluate('window.arcane.openPanel()');
    await ui('panelOpen === true');
    await waitReader();
    await readerSettled('document.title === "huge.md · ArcaneDesk"');
    assert.equal(foundry(), null, "restoring a note never silently pulls up FVTT (§3.4)");

    // ---------- 回到 READER_F 现场:Foundry 在位,再蒙上笔记 ----------
    assert.equal((await host.openFoundry(target)).ok, true);
    await waitFoundryAt();

    // ---------- 阅读器页里没有它兑现不了的锚点(R5) ----------
    const clickGatekeeperAgain = await say("回到 notes/gatekeeper.md。");
    await clickGatekeeperAgain();
    await readerSettled('document.title === "gatekeeper.md · ArcaneDesk"');
    assert.equal(await readerEval('document.querySelectorAll("a.md-path").length'), 0, "the reader page offers no anchors it cannot honour");
    assert.match(await docText(), /守门人/);

    // ---------- ③ 切 FVTT:阅读器 → Foundry(显隐切换,不重载) ----------
    await evaluate('window.arcane.switchPanelSurface("foundry")');
    await until(async () => foundry()?.getVisible() === true, "the surface switch returns to Foundry");
    assert.equal(reader().getVisible(), false);
    assert.equal(foundryLoads(), target);

    await evaluate('window.arcane.closePanel()');
    await ui('panelOpen === false');
    await until(async () => views().length === 0, "the final close empties the right pane");
    assert.equal(assertOneVisible("final CLOSED"), 0);
  } finally {
    await new Promise((resolve) => site.close(resolve));
  }
};
