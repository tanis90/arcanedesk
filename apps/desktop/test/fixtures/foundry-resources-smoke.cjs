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
app.whenReady().then(async () => {
  try {
    const { evaluateNavigationSafe } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/foundry-web.js")).href);
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    const wc = window.webContents;
    await wc.loadURL(page("first"));
    await wc.executeJavaScript("window.order = []; window.writeGate = new Promise(resolve => window.releaseWrite = resolve); true");
    const result = await evaluateNavigationSafe(wc,
      "writeGate.then(() => { order.push('A'); document.body.textContent = 'written'; return true; })", { timeoutMs: 30 });
    assert.equal(result.status, "timeout");
    const next = await evaluateNavigationSafe(wc, "order.push('B'); ({ order, text: document.body.textContent })");
    assert.deepEqual(next.value, { order: ["B"], text: "first" });
    await wc.executeJavaScript("releaseWrite(); true");
    assert.deepEqual(await wc.executeJavaScript("order"), ["B", "A"]);
    assert.equal((await evaluateNavigationSafe(wc, "new Promise(() => {})", { timeoutMs: 30 })).status, "timeout");
    await wc.loadURL(page("replacement"));
    assert.equal((await evaluateNavigationSafe(wc, "document.title")).value, "replacement");
    window.destroy();
    console.log("PASS Electron Foundry direct execution: timeout does not block later calls or navigation");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
