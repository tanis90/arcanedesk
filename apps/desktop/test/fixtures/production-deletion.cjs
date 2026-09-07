const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");

module.exports = async ({ hostA, hostB, streams, evaluate, ui, until }) => {
  const { id, path } = hostA.describeCurrent();
  const selector = `.session-item[data-session-id="${id}"] .s-del`;
  const sdk = hostA.session;
  const abort = sdk.abort.bind(sdk);
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  // Delay actual SDK cancellation to observe the production deletion barrier.
  sdk.abort = async (...args) => { entered = true; await gate; return abort(...args); };
  try {
    await evaluate('globalThis.deletionConfirm = null; window.confirm = text => { globalThis.deletionConfirm = text; return true; }; refreshSessions();');
    await ui(`!!document.querySelector(${JSON.stringify(selector)})`);
    const expectedConfirmation = await evaluate(`t("sessions.deleteConfirm", {name:document.querySelector(${JSON.stringify(selector)}).closest(".session-item").querySelector(".s-title").textContent})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await until(() => entered, "deletion requests SDK cancellation");
    assert.equal(hostA.tasks.task.state, "stopping");
    assert.ok(hostA.busy && hostA.deleting && existsSync(path));
    assert.equal(globalThis.__arcaneHosts.prep.get(id), hostA);
    assert.equal(await evaluate('deletionConfirm'), expectedConfirmation);
    await evaluate('refreshSessions()');
    await ui(`document.querySelector(${JSON.stringify(selector)})?.disabled === true`);
    assert.ok(hostB.busy && !streams.get("B").closed);
    release();
    await until(() => !globalThis.__arcaneHosts.prep.get(id) && !existsSync(path), "stop confirmed before record removal");
    assert.equal(hostA.tasks.task.state, "stopped");
    await ui(`!document.querySelector(${JSON.stringify(selector)})`);
    assert.ok(await evaluate(`selectedSessionId === ${JSON.stringify(hostB.describeCurrent().id)} && busy && messages.textContent.includes("B partial")`));
    assert.ok(!streams.get("B").closed);
    streams.get("B").finish();
    await ui('!busy && messages.textContent.includes("B final result")');
  } finally { release(); sdk.abort = abort; }
};
