const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

module.exports = async ({ window, evaluate }) => {
  const output = path.resolve(__dirname, "../../docs/layout-evidence");
  mkdirSync(output, { recursive: true });
  const cases = [
    { name: "minimum", width: 1080, height: 640, chat: null },
    { name: "wide", width: 1520, height: 920, chat: null },
    { name: "split", width: 1520, height: 920, chat: 456 },
    { name: "split-minimum", width: 1080, height: 640, chat: 320 },
  ];
  const report = [];
  for (const sample of cases) {
    window.setContentSize(sample.width, sample.height);
    await evaluate(`Object.assign(panelLayout, {open:${Boolean(sample.chat)},chatWidth:${sample.chat ?? sample.width},gutter:6}); applyPanelLayout(); input.value = '保留我的草稿，先核对资料再继续。'; autosize(); scrollToEnd(true);`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await evaluate(`input.focus(); for (const id of ['B','C']) activityView.receive({type:'activity_notice',notice:{sessionId:id,taskId:'task-'+id,key:'completed',kind:'completed',name:'后台素材 '+id}});`);
    // Unpinning starts a real CSS transition; capture the settled drawer, not a frame covering the chat.
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      function check() {
        const drawer = document.getElementById('session-drawer');
        if (${!sample.chat} || drawer.getBoundingClientRect().right <= 0.5) return resolve();
        if (performance.now() > deadline) return reject(new Error('drawer did not finish closing'));
        requestAnimationFrame(check);
      }
      check();
    })`);
    const layout = await evaluate(`(() => {
      const right = ${sample.chat ? sample.chat + 6 : sample.width};
      const ids=['sessions-toggle','activity-notice','conversation-task-status','chat-input','stop','send'];
      return {width:innerWidth,height:innerHeight,pinned:document.body.classList.contains('sidebar-pinned'),items:ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:!!e.getClientRects().length,within:r.left>=-1&&r.right<=right+1&&r.top>=0&&r.bottom<=innerHeight+1};})};
    })()`);
    for (const item of layout.items) assert.ok(item.visible && item.width > 0 && item.height > 0 && item.within, `${sample.name}: ${JSON.stringify(item)}`);
    assert.equal(layout.pinned, !sample.chat, `${sample.name}: sidebar adapts to chat width`);
    assert.ok(await evaluate('document.activeElement === input && input.value === "保留我的草稿，先核对资料再继续。"'), "merged progress notices preserve input focus and draft");
    assert.ok(await evaluate('activityView.notices.size === 2 && document.getElementById("activity-notice").getBoundingClientRect().bottom < input.getBoundingClientRect().top'), "merged notices stay above the input area");
    assert.ok(await evaluate('!document.getElementById("activity-toggle") && !document.getElementById("activity-list")'), "old activity navigation is removed");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    writeFileSync(path.join(output, sample.name + ".png"), (await window.webContents.capturePage()).toPNG());
    report.push({ ...sample, ...layout });
  }
  writeFileSync(path.join(output, "layout.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("PASS layout: minimum/wide/split viewports preserve visible activity, task, draft and stop/send controls");
};
