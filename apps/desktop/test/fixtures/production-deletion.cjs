const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");

module.exports = async ({ hostA, hostB, streams, evaluate, ui, until }) => {
  const { id, path } = hostA.describeCurrent();
  // The new product flow never implicitly stops work while organizing history.
  assert.equal((await evaluate(`window.arcane.archiveSession(${JSON.stringify(id)})`)).code, "SESSION_BUSY");
  assert.ok(hostA.busy && hostB.busy && existsSync(path));
  const sdk = hostA.session, abort = sdk.abort.bind(sdk);
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  sdk.abort = async (...args) => { entered = true; await gate; return abort(...args); };
  try {
    await evaluate(`void window.arcane.abort({ ...modeContext(), sessionId:${JSON.stringify(id)}, taskId:${JSON.stringify(hostA.task.id)}, mode:'prep' })`);
    await until(() => entered, "explicit stop requests SDK cancellation");
    assert.equal(hostA.task.state, "stopping");
    assert.equal((await evaluate(`window.arcane.archiveSession(${JSON.stringify(id)})`)).code, "SESSION_BUSY");
    assert.ok(existsSync(path) && !streams.get("B").closed);
    release(); await until(() => !hostA.busy, "actual SDK stop settles");
    assert.equal((await evaluate(`window.arcane.archiveSession(${JSON.stringify(id)})`)).ok, true);
    await evaluate('refreshSessions(); navigationView.showArchives(true)');
    await ui(`!!document.querySelector('#archive-list [data-session-id="${id}"]')`);
    await evaluate(`document.querySelector('#archive-list [data-session-id="${id}"] .s-menu').click()`);
    await evaluate('document.querySelector(".session-menu [data-action=delete]").click()');
    await ui('!!document.querySelector("dialog[open]")');
    assert.equal(await evaluate('document.querySelector("dialog p").textContent'), await evaluate('t("navigation.deleteConfirm")'));
    await evaluate('document.querySelector("dialog button[type=submit]").click()');
    await until(async () => {
      const failure = await evaluate('document.getElementById("navigation-toast").hidden ? "" : document.getElementById("navigation-toast").textContent');
      if (failure.includes("操作未完成")) throw Error(failure);
      return !existsSync(path);
    }, "confirmed deletion removes archived record");
    await ui(`!navigationView.rows.has(${JSON.stringify(id)})`);
    assert.ok(hostB.busy && !streams.get("B").closed);
    await evaluate('navigationView.showArchives(false)');
    assert.ok(await evaluate(`selectedSessionId === ${JSON.stringify(hostB.describeCurrent().id)} && busy && messages.textContent.includes("B partial")`));
    streams.get("B").finish(); await ui('!busy && messages.textContent.includes("B final result")');
  } finally { release(); sdk.abort = abort; }
};
