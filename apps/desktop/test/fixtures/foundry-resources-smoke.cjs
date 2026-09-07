const { app, BrowserWindow } = require("electron");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "arcane-page-resource-")));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const page = title => `data:text/html,${encodeURIComponent(`<title>${title}</title><body>${title}</body>`)}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
app.whenReady().then(async () => {
  try {
    const { ResourceCoordinator } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/scheduling/resource-coordinator.js")).href);
    const { evaluateNavigationSafe } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/foundry-web.js")).href);
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    const wc = window.webContents, r = new ResourceCoordinator();
    await wc.loadURL(page("first"));
    await wc.executeJavaScript("window.order = []; window.writeGate = new Promise(resolve => window.releaseWrite = resolve); true");
    const result = await r.run(["foundry:page"], { taskId: "A" }, null, () => {}, () =>
      evaluateNavigationSafe(wc, "writeGate.then(() => { order.push('A'); document.body.textContent = 'written'; return true; })", { timeoutMs: 30 }));
    assert.equal(result.status, "timeout");
    let began = false;
    const next = r.run(["foundry:page"], { taskId: "B" }, null, () => {}, () => {
      began = true; return evaluateNavigationSafe(wc, "order.push('B'); ({ order, text: document.body.textContent })");
    });
    await tick(); assert.equal(began, false);
    await wc.executeJavaScript("releaseWrite(); true");
    assert.deepEqual((await next).value, { order: ["A", "B"], text: "written" });
    const hung = await r.run(["foundry:page"], { taskId: "old-page" }, null, () => {}, () =>
      evaluateNavigationSafe(wc, "new Promise(() => {})", { timeoutMs: 30 }));
    assert.equal(hung.status, "timeout"); assert.equal(r.active.size, 1);
    // Test-only external navigation proves the real Electron context replacement signal.
    await wc.loadURL(page("replacement"));
    const lease = await r.acquire(["foundry:page"], { taskId: "new-page" });
    assert.equal(await wc.executeJavaScript("document.title"), "replacement"); lease.release();
    assert.equal(r.active.size, 0);
    const { PanelCommands } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/scheduling/panel-commands.js")).href);
    await r.run(["foundry:page"], { sessionId: "A", taskId: "hung" }, null, () => {}, () =>
      evaluateNavigationSafe(wc, "new Promise(() => {})", { timeoutMs: 30 }));
    const panel = new PanelCommands({ resources: r, operations: { open: () => { throw new Error("cancelled panel request ran"); } } });
    panel.request("open"); await tick();
    let replacement, stopped = false;
    const recovered = await panel.recover({
      stopOwners(owners) { assert.equal(owners[0].taskId, "hung"); stopped = true; },
      destroyPage() { assert.equal(stopped, true); window.destroy(); },
      async reopen() {
        replacement = new BrowserWindow({ show: false });
        await replacement.webContents.loadURL(page("recovered")); return { ok: true };
      },
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(await replacement.webContents.executeJavaScript("document.title"), "recovered");
    assert.equal(r.active.size, 0); replacement.destroy();
    console.log("PASS Electron Foundry resource lifetime: timeout preserves execution order; committed navigation releases old context");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
