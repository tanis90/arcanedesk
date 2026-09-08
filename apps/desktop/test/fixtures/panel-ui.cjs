const { app } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

module.exports = async ({ window, evaluate, ui }) => {
  const site = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Foundry Virtual Tabletop</title><h1>Foundry test page</h1>"); });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const port = site.address().port, target = `http://127.0.0.1:${port}/game`;
  await new Promise(resolve => site.close(resolve));
  let attempts = 0;
  const observe = (_event, contents) => {
    const load = contents.loadURL.bind(contents);
    contents.loadURL = (url, ...args) => { if (url === target) attempts++; return load(url, ...args); };
  };
  app.on("web-contents-created", observe);
  const host = globalThis.__arcaneHosts.prep.activeHost;
  try {
    const result = await host.openFoundry(target);
    assert.equal(result.ok, false); assert.equal(attempts, 2);
    const contents = host.getFoundryView().webContents;
    assert.ok(contents.getURL().includes("foundry-unavailable.html"));
    assert.equal(await contents.executeJavaScript('document.querySelector("p").textContent'), await evaluate('t("panel.connectionFailed")'));
    assert.equal(await evaluate('document.querySelector("#panel-command, #activity-bar, #activity-jump")'), null);
    const output = path.resolve(__dirname, "../../docs/interaction-evidence"); mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "foundry-failure.json"), JSON.stringify({ attempts, url: contents.getURL(), message: await contents.executeJavaScript('document.body.innerText') }, null, 2));
    await new Promise(resolve => site.listen(port, "127.0.0.1", resolve));
    // Same host entry point used by the agent; recovery replaces the failure document.
    assert.equal((await host.openFoundry(target)).ok, true);
    assert.equal(contents.getURL(), target);
    assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), "Foundry test page");
    await new Promise(resolve => site.close(resolve));
    assert.equal((await host.openFoundry(target + "?offline=1")).ok, true, "healthy same-origin page is not needlessly navigated");
    await evaluate('window.arcane.reloadPanel()');
    await ui('panelCommandSnapshot.command?.state === "failed"');
    assert.ok(contents.getURL().includes("foundry-unavailable.html"));
    await new Promise(resolve => site.listen(port, "127.0.0.1", resolve));
    await evaluate('window.arcane.reloadPanel()');
    await ui('panelCommandSnapshot.command?.state === "completed"');
    assert.equal(contents.getURL(), target, "reload uses the original URL, not the local failure page");
    assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), "Foundry test page");
  } finally { app.off("web-contents-created", observe); site.close(); }
};
