// 诊断探针:悬浮切换丸(panel-switch.html)的真实点击链路。
// 程序化层(switchPanelSurface → panel:switch)已被 md-reader-panel.cjs 覆盖;
// 这里专测切换丸自己的通道:页面 JS → arcanePanelSwitch.switch → panel-switch:switch → 控制器。
const http = require("node:http");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

module.exports = async ({ window, evaluate, ui, until, project }) => {
  const notes = path.join(project, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, "probe.md"), "# 探针笔记\n\n切换丸点击链路。\n");

  const urlOf = (view) => (view.webContents?.isDestroyed() ? "" : view.webContents.getURL());
  const pill = () => window.contentView.children.find((view) => urlOf(view).includes("panel-switch.html")) ?? null;
  const surfaces = () => window.contentView.children.filter((view) =>
    !view.webContents?.isDestroyed() && !urlOf(view).includes("panel-switch.html"));
  const reader = () => surfaces().find((view) => urlOf(view).includes("md-reader.html")) ?? null;
  const foundry = () => surfaces().find((view) => urlOf(view) !== "" && !urlOf(view).includes("md-reader.html")) ?? null;
  const order = () => window.contentView.children.map((view) => {
    const url = urlOf(view);
    return `${url.includes("panel-switch") ? "PILL" : url.includes("md-reader") ? "READER" : url ? "FOUNDRY" : "?"}:${view.getVisible() ? "V" : "h"}`;
  }).join(" ");
  const pillEval = (code) => {
    const view = pill();
    assert.ok(view, "pill view exists");
    return view.webContents.executeJavaScript(code);
  };

  const site = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>Foundry Virtual Tabletop</title><h1>Foundry test page</h1>");
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${site.address().port}/game`;
  const host = globalThis.__arcaneHosts.prep.activeHost;

  try {
    // 药丸页面健康度:preload 桥、按钮、当前状态
    assert.equal(await pillEval('typeof window.arcanePanelSwitch'), "object", "pill preload bridge must exist");
    assert.equal(await pillEval('document.querySelectorAll(".seg").length'), 2, "pill renders two segments");
    console.log("PROBE pill-ready order:", order());

    // ④ FVTT 在位
    assert.equal((await host.openFoundry(target)).ok, true);
    await until(async () => foundry()?.webContents.getURL() === target, "foundry page loads");
    await until(async () => foundry()?.getVisible() === true, "foundry visible");
    console.log("PROBE foundry-open order:", order());
    assert.equal(await pillEval("document.body.dataset.surface"), "foundry", "pill tracks foundry surface");

    // ③ 无文档时点"文档":不报空,落阅读器兜底空态页
    await pillEval('document.getElementById("seg-reader").click()');
    await until(async () => Boolean(reader()), "reader view created for the empty state");
    await until(async () => reader()?.getVisible() === true, "empty reader visible");
    assert.equal(foundry().getVisible(), false, "foundry hidden under the empty reader");
    await until(async () => (await pillEval("document.body.dataset.surface")) === "reader", "pill tracks the empty reader");
    await until(async () => {
      try {
        return await reader().webContents.executeJavaScript(
          'document.getElementById("reader-empty").hidden === false && document.querySelector("#reader-empty .empty-title").textContent.length > 0');
      } catch { return false; }
    }, "the empty fallback renders");
    const readerSegText = await pillEval('document.getElementById("seg-reader").textContent');
    assert.ok(["文档", "Docs"].includes(readerSegText), "无文档不再闪烁 deny 文案");
    console.log("PROBE empty-reader order:", order());

    // 切回 FVTT,继续后面的用例
    await pillEval('document.getElementById("seg-foundry").click()');
    await until(async () => foundry()?.getVisible() === true, "back to foundry");
    await until(async () => (await pillEval("document.body.dataset.surface")) === "foundry", "pill tracks foundry again");

    // ② 打开笔记 → READER_F
    const anchors = await evaluate(
      `(() => { const box = document.createElement("div"); box.className = "msg assistant"; box.id = "probe-note";
         messages.appendChild(box); renderMarkdown(box, "看 notes/probe.md。");
         return box.querySelectorAll("a.md-path").length; })()`,
    );
    assert.ok(anchors >= 1, "note anchor rendered");
    await evaluate('document.getElementById("probe-note").querySelector("a.md-path").click()');
    await until(async () => Boolean(reader()), "reader view created");
    await until(async () => reader()?.getVisible() === true, "reader visible");
    await until(async () => (await pillEval("document.body.dataset.surface")) === "reader", "pill tracks reader surface");
    console.log("PROBE reader-open order:", order());

    // ③ 药丸 DOM 点击 FVTT:整条页面 → IPC → 控制器链
    await pillEval('document.getElementById("seg-foundry").click()');
    await until(async () => foundry()?.getVisible() === true, "pill click switches to foundry");
    assert.equal(reader().getVisible(), false, "reader hidden under foundry");
    await until(async () => (await pillEval("document.body.dataset.surface")) === "foundry", "pill active state follows");
    console.log("PROBE click-foundry order:", order());

    // ③ 反向:药丸 DOM 点击文档
    await pillEval('document.getElementById("seg-reader").click()');
    await until(async () => reader()?.getVisible() === true, "pill click switches to reader");
    assert.equal(foundry().getVisible(), false, "foundry hidden under reader");
    console.log("PROBE click-reader order:", order());

    console.log("PASS panel switch probe: pill page clicks drive both surfaces, and a missing document lands on the empty fallback");
  } finally {
    await new Promise((resolve) => site.close(resolve));
  }
};
