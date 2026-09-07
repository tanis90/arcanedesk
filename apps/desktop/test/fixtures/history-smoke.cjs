const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../..");
app.setPath("userData", mkdtempSync(path.join(tmpdir(), "arcane-history-smoke-")));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { AgentHost } = await import(pathToFileURL(path.join(desktop, "src/main/agent-host.js")));
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { SessionProjection } = await import(pathToFileURL(path.join(desktop, "src/main/sync/session-projection.js")));
  let window, mode = "prep", generation = 0, failPage = false, delayed = null;
  const queries = [];
  const hosts = {};
  for (const name of ["prep", "combat"]) {
    const host = new AgentHost({ profile: { mode: name }, sendToRenderer: event => window?.webContents.send("arcane:event", event), log() {} });
    host.sessionManager = SessionManager.inMemory(); host.session = { messages: [] };
    host.projection = new SessionProjection({ sessionId: host.describeCurrent().id });
    for (let i = 0; i < (name === "prep" ? 1200 : 5); i++) {
      const text = `Message ${name} ${i} — ` + "History content. ".repeat(8);
      host.sessionManager.appendMessage({ role: i % 2 ? "assistant" : "user", timestamp: i,
        arcaneMessageKey: `message:${name}-${i}`, content: i === 1001 ? [{ type: "text", text }, { type: "toolCall", id: "old-tool", name: "bash", arguments: {} }] : text });
      if (i === 1001) host.sessionManager.appendMessage({ role: "toolResult", toolCallId: "old-tool", content: [{ type: "text", text: "done" }], timestamp: i, isError: false });
    }
    hosts[name] = host;
  }
  const aId = hosts.prep.describeCurrent().id, bId = hosts.combat.describeCurrent().id;
  const payload = (host, query) => ({ ok: true, mode: host.profile.mode, generation, ...host.currentPayload(query) });
  const channels = [...readFileSync(path.join(desktop, "preload.cjs"), "utf8").matchAll(/invoke\("([^"]+)"/g)].map(match => match[1]);
  for (const channel of new Set(channels)) ipcMain.handle(channel, async (_event, input, query) => {
    if (channel === "sessions:current") return payload(hosts[mode]);
    if (channel === "mode:set") { mode = input; generation++; return payload(hosts[mode]); }
    if (channel === "sessions:snapshot") {
      queries.push(query);
      const host = Object.values(hosts).find(host => host.describeCurrent().id === input);
      if (delayed) { const gate = delayed; delayed = null; await gate.promise; }
      if (failPage) return { ok: false, code: "HISTORY_LOAD_FAILED" };
      try { return payload(host, query); } catch (error) { return { ok: false, code: error.code }; }
    }
    if (channel === "sessions:list" || channel === "sessions:navigation") return { ok: true, sessions: [] };
    if (channel === "voice:get-config") return { enabled: false };
    if (channel === "ui:get-locale") return { pref: "en-US", resolved: "en-US" };
    if (channel === "slash:list") return { skills: [], templates: [], commands: [] };
    return {};
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
    preload: path.join(desktop, "preload.cjs"), contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  const evaluate = code => window.webContents.executeJavaScript(code);
  async function until(code) {
    const limit = Date.now() + 7000;
    while (Date.now() < limit) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    const state = await evaluate('({activityReady, restoringView, historyPage, draft: input.value, saved: workspaceStore.cache.get(selectedSessionId), sync: syncIndicator.textContent})');
    throw new Error("Timed out: " + code + "\n" + JSON.stringify(state));
  }
  try {
    await window.loadFile(path.join(desktop, "src/renderer/index.html"));
    await until('activityReady && historyPage?.total === 1200');
    assert.equal(await evaluate('messages.querySelectorAll(".msg").length'), 100);
    assert.equal(await evaluate('historyPage.firstKey'), "message:prep-1100");
    await evaluate('input.value = "long history draft"; input.dispatchEvent(new Event("input")); pendingImages = [{data:"aGVsbG8=",mimeType:"image/png"}]; saveWorkspace();');
    await evaluate('document.querySelector(".history-page-button").click()');
    await until('historyPage.firstKey === "message:prep-1000" && activityReady');
    assert.equal(await evaluate('historyPage.hasNewer && !followLatest'), true);
    assert.equal(await evaluate('input.value'), "long history draft");
    assert.equal(await evaluate('pendingImages.length'), 1);
    await evaluate('toolCards.get("old-tool").card.classList.remove("open"); saveWorkspace();');
    await evaluate('messages.scrollTo({top:300,behavior:"instant"}); messages.dispatchEvent(new Event("scroll")); saveWorkspace();');
    const anchor = await evaluate('workspaceStore.cache.get(selectedSessionId).anchor');
    await evaluate('switchMode("combat")'); await until(`selectedSessionId === ${JSON.stringify(bId)} && activityReady`);
    await evaluate('switchMode("prep")'); await until(`selectedSessionId === ${JSON.stringify(aId)} && activityReady && !restoringView`);
    assert.equal(await evaluate(`!!messageNode(${JSON.stringify(anchor.key)})`), true);
    const actualOffset = await evaluate(`messageNode(${JSON.stringify(anchor.key)}).getBoundingClientRect().top - messages.getBoundingClientRect().top`);
    assert.ok(Math.abs(actualOffset - anchor.offset) < 3, JSON.stringify({ anchor, actualOffset, stored: await evaluate('workspaceStore.cache.get(selectedSessionId).anchor') }));
    assert.ok(queries.some(query => query?.around === anchor.key));
    assert.equal(await evaluate('toolCards.get("old-tool").card.classList.contains("open")'), false);
    assert.equal(await evaluate('messages.querySelectorAll(".msg").length'), 100);
    assert.equal(await evaluate('activityView.getView().atBottom'), false);
    const before = await evaluate('messages.scrollTop');
    hosts.prep.sessionManager.appendMessage({ role: "assistant", timestamp: 1201, arcaneMessageKey: "message:new-result", content: "NEW BACKGROUND RESULT" });
    hosts.prep.emit({ type: "message", role: "assistant", key: "message:new-result", text: "NEW BACKGROUND RESULT" });
    await until('viewSeq === 1');
    assert.equal(await evaluate('messages.textContent.includes("NEW BACKGROUND RESULT")'), false);
    assert.equal(await evaluate('messages.scrollTop'), before);
    await evaluate('document.getElementById("scroll-bottom").click()');
    await until('!historyPage.hasNewer && messages.textContent.includes("NEW BACKGROUND RESULT")');
    assert.equal(await evaluate('messages.querySelectorAll(".msg").length'), 100);
    failPage = true;
    const first = await evaluate('historyPage.firstKey');
    await evaluate('document.querySelector(".history-page-button").click()');
    await until('!syncIndicator.hidden');
    assert.equal(await evaluate('historyPage.firstKey'), first);
    assert.equal(await evaluate('input.value'), "long history draft");
    failPage = false;
    await evaluate('syncIndicator.click()');
    await until('historyPage.hasNewer && syncIndicator.hidden');
    assert.equal(await evaluate('toolCards.get("old-tool").card.classList.contains("open")'), false);
    await evaluate('saveWorkspace()');
    const reloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await reloaded;
    await until('activityReady && historyPage.hasNewer && input.value === "long history draft"');
    let release;
    delayed = { promise: new Promise(resolve => { release = resolve; }) };
    await evaluate('document.querySelector(".history-page-button").click()');
    await evaluate('switchMode("combat")'); await until(`selectedSessionId === ${JSON.stringify(bId)} && activityReady`);
    release(); await evaluate('new Promise(resolve => setTimeout(resolve, 80))');
    assert.equal(await evaluate('selectedSessionId'), bId);
    assert.equal(await evaluate('messages.textContent.includes("Message prep")'), false);
    await evaluate(`(async () => {
      for (let i = 0; i < 40; i++) {
        snapshotCache.set("pressure-" + i, { history: [{ text: "cached" }] });
        eventInbox.record({ sessionId: "pressure-" + i, runtimeEpoch: "pressure", seq: 1, text: "progress" });
        await workspaceStore.save("pressure-" + i, { draft: "draft-" + i, images: [{data:"image-" + i}], anchor:{key:"anchor-" + i,offset:5} });
      }
    })()`);
    assert.equal(await evaluate(`snapshotCache.has(${JSON.stringify(aId)}) || eventInbox.sessions.has(${JSON.stringify(aId)}) || workspaceStore.cache.has(${JSON.stringify(aId)})`), false);
    assert.ok(await evaluate('snapshotCache.size <= 8 && eventInbox.sessions.size <= 32 && workspaceStore.cache.size <= 16'));
    const restored = await evaluate('workspaceStore.load("pressure-0")');
    assert.equal(restored.draft, "draft-0"); assert.equal(restored.images[0].data, "image-0"); assert.equal(restored.anchor.key, "anchor-0");
    await evaluate('switchMode("prep")');
    await until(`selectedSessionId === ${JSON.stringify(aId)} && activityReady && historyPage.hasNewer && input.value === "long history draft"`);
    assert.equal(await evaluate('pendingImages.length'), 1);
    await evaluate('showHistoryPage({}, "latest")');
    await until('activityReady && !historyPage.hasNewer');
    hosts.prep.taskCoordinator().inputs.set("historic-sent", { id: "historic-sent", commandId: "historic-sent", taskId: "past-task", state: "consumed", text: "Already accepted outside this page", messageKey: "message:prep-0" });
    await evaluate(`outboxFor(selectedSessionId).set("historic-sent", { context: { sessionId: selectedSessionId, commandId: "historic-sent" }, text: "Already accepted outside this page", images: [], sending: false }); saveWorkspace(); resyncSelected();`);
    await until('activityReady && !syncingSessions.has(selectedSessionId) && outboxFor(selectedSessionId).size === 0');
    assert.equal(hosts.prep.currentPayload().inputs.length, 0);
    assert.equal(await evaluate('!!document.querySelector(".retry-input")'), false);
    const installs = await evaluate('snapshotRequest');
    hosts.prep.emit({ type: "session_switched", ...hosts.prep.currentPayload() });
    await until(`activityReady && snapshotRequest === ${installs + 1} && viewSeq === ${hosts.prep.projection.seq}`);
    console.log("PASS Electron history: bounded pages and caches, durable eviction/reload, anchors, drafts/images, background output, retry and stale page rejection");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
