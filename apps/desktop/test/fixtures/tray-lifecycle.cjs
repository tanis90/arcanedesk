const assert = require("node:assert/strict");

module.exports = async ({ window, host, evaluate, ui, until, sleep, menu, prompts, beforeExit }) => {
  let shows = 0;
  let hides = 0;
  const hide = window.hide.bind(window);
  window.hide = () => { hides++; return hide(); };
  window.on("show", () => { shows++; });
  // The smoke harness hides windows on show; events prove each real close path
  // reached hide without depending on foreground desktop automation.
  window.close();
  await sleep(50);
  assert.equal(hides, 1, "idle close calls the real window hide operation");
  assert.ok(!window.isDestroyed() && !host.busy && menu());
  assert.equal(prompts.length, 0, "idle close does not exit or ask");
  menu().items[0].click();
  assert.equal(shows, 1);
  await evaluate('input.value = "production-A"; submit()');
  await ui('busy && messages.textContent.includes("A partial")');
  const hidesBeforeClose = hides;
  window.close();
  await sleep(50);
  assert.equal(hides, hidesBeforeClose + 1, "busy close calls hide without stopping");
  assert.ok(!window.isDestroyed() && host.busy);
  assert.equal(prompts.length, 0, "busy close also has no choice dialog");
  const sdk = host.session, abort = sdk.abort.bind(sdk);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  sdk.abort = async () => { await gate; return abort(); };
  beforeExit();
  menu().items[1].click();
  await ui('displayedTask.state === "stopping"');
  assert.equal(prompts.length, 0, "tray exit is already an explicit decision");
  await until(() => shows === 2, "slow shutdown surfaces progress after one second");
  assert.ok(host.busy && !window.isDestroyed());
  assert.ok(await evaluate('!document.getElementById("shutdown-status").hidden'));
  release();
};
