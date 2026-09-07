const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../..");
const scratch = mkdtempSync(path.join(tmpdir(), "arcane-activity-ui-"));
app.setPath("userData", scratch);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { ActivityCenter } = await import(pathToFileURL(path.join(desktop, "src/main/conversations/activity-center.js")));
  const { SessionProjection } = await import(pathToFileURL(path.join(desktop, "src/main/sync/session-projection.js")));
  const window = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { preload: path.join(desktop, "preload.cjs"), contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const sessions = new Map([ ["A", { name: "今晚的冒险素材", mode: "prep" }], ["B", { name: "支线剧情", mode: "prep" }], ["C", { name: "战场态势", mode: "combat" }] ]);
  for (const [id, value] of sessions) Object.assign(value, { id, path: `${id}.jsonl`, history: [], task: null, attentions: [],
    projection: new SessionProjection({ sessionId: id, epoch: "activity-test" }) });
  let mode = "prep", selected = "B", generation = 0, focused = false, notices = 0;
  const emit = event => window.webContents.send("arcane:event", event);
  const center = new ActivityCenter({ file: path.join(scratch, "activity.json"), describe: id => sessions.get(id),
    emit, notify: notice => { notices++; emit({ type: "activity_notice", notice }); } });
  function snapshot(id) {
    const row = sessions.get(id);
    return { ok: true, session: { id, name: row.name, path: row.path }, mode: row.mode, generation,
      history: row.history, task: row.task, busy: row.task?.state === "running" || row.task?.state === "waiting_user",
      attentions: row.attentions, inFlight: row.projection.snapshot() };
  }
  function send(id, payload) {
    const row = sessions.get(id);
    if (payload.type === "task_state") row.task = payload.task;
    if (payload.type === "message") row.history.push({ role: payload.role, text: payload.text, ts: Number(payload.key.split(":")[1]) });
    if (payload.type === "attention") row.attentions = [payload.attention];
    const event = row.projection.publish({ ...payload, taskId: row.task?.id, mode: row.mode });
    emit(event); center.observe(event);
  }
  const channels = [...readFileSync(path.join(desktop, "preload.cjs"), "utf8").matchAll(/invoke\("([^"]+)"/g)].map(match => match[1]);
  for (const channel of new Set(channels)) ipcMain.handle(channel, (_event, input) => {
    if (channel === "activity:snapshot") return { ok: true, ...center.snapshot() };
    if (channel === "activity:read") return center.markRead(input, focused);
    if (channel === "sessions:current") return snapshot(selected);
    if (channel === "sessions:snapshot") return snapshot(input);
    if (channel === "sessions:list") return { sessions: [...sessions.values()].filter(s => s.mode === input.mode).map(s => ({ id: s.id, name: s.name, path: s.path, active: s.id === selected, messageCount: s.history.length })) };
    if (channel === "mode:set") {
      mode = input; generation++;
      if (sessions.get(selected).mode !== mode) selected = mode === "prep" ? "B" : "C";
      return snapshot(selected);
    }
    if (channel === "sessions:open") { selected = input.path.split(".")[0]; return snapshot(selected); }
    if (channel === "voice:get-config") return { enabled: false };
    if (channel === "ui:get-locale") return { pref: "zh-CN", resolved: "zh-CN" };
    if (channel === "slash:list") return { skills: [], templates: [], commands: [] };
    return {};
  });
  const evaluate = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(code + "\n" + error.message); }
  };
  async function until(code) {
    const limit = Date.now() + 8000;
    while (Date.now() < limit) {
      if (await evaluate(code)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Timed out: " + code);
  }
  async function capture(name) {
    const dir = process.env.ARCANE_SMOKE_SCREENSHOTS;
    if (!dir) return;
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    await new Promise(resolve => setTimeout(resolve, 280));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name + ".png"), (await window.webContents.capturePage()).toPNG());
  }
  const errors = [];
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  try {
    sessions.get("A").history = Array.from({ length: 40 }, (_, i) => ({ role: "user", ts: i + 10, text: `素材 ${i}：古堡、森林与失踪的商队。` }));
    send("A", { type: "task_state", task: { id: "task-A", state: "running" } });
    send("A", { type: "message", role: "assistant", key: "assistant:100", text: "正在整理素材。" });
    center.markRead({ sessionId: "A", runtimeEpoch: "activity-test", seq: 2, visible: true, atBottom: true, readKey: "assistant:100" }, true);
    await window.loadFile(path.join(desktop, "src/renderer/index.html"));
    await until('selectedSessionId === "B" && activityReady && activityView.rows.has("A")');
    assert.equal(await evaluate('document.body.classList.contains("sidebar-pinned")'), true);
    assert.equal(await evaluate('drawer.inert'), false);
    await evaluate('input.value = "B 的草稿"; input.dispatchEvent(new Event("input")); input.focus();');
    send("A", { type: "message", role: "assistant", key: "assistant:101", text: "已准备好今晚的冒险素材：古堡主线与商队支线。" });
    send("A", { type: "task_state", task: { id: "task-A", state: "completed" } });
    await until('!document.getElementById("activity-notice").hidden');
    assert.equal(await evaluate('selectedSessionId'), "B");
    assert.equal(await evaluate('input.value'), "B 的草稿");
    assert.equal(await evaluate('document.activeElement === input'), true);
    assert.equal(notices, 1);
    // Explicitly simulate trusted foreground presence; the test window stays hidden.
    focused = true;
    await evaluate('Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true }); void 0;');
    await evaluate('workspaceStore.save("A", {followLatest:false, anchor:{key:"user:15", offset:0}})');
    await evaluate('document.getElementById("activity-notice").click()');
    await until('selectedSessionId === "A" && activityReady && !followLatest');
    assert.equal(center.get("A").unread, true);
    assert.equal(await evaluate('document.getElementById("activity-jump").hidden'), false);
    assert.equal(await evaluate('document.querySelectorAll(".unread-divider").length'), 1);
    await capture("activity-wide-history");
    await evaluate('document.getElementById("activity-jump").click()');
    await until('activityView.rows.get("A").unread === false');
    assert.equal(center.get("A").state, "completed");
    assert.equal(await evaluate('document.getElementById("activity-notice").hidden'), true);
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "C" && activityReady');
    send("B", { type: "task_state", task: { id: "task-B", state: "running" } });
    send("B", { type: "attention", attention: { id: "question-B", taskId: "task-B", question: "支线发生在哪里？", options: ["森林", "村庄"], state: "pending" } });
    send("B", { type: "task_state", task: { id: "task-B", state: "waiting_user" } });
    center.flush();
    await until('activityView.rows.get("B")?.needsAttention === true');
    assert.equal(await evaluate('selectedSessionId'), "C");
    await evaluate('document.querySelector(".activity-item[data-session-id=B]").click()');
    await until('selectedSessionId === "B" && !!document.querySelector("[data-attention-id=question-B] textarea")');
    assert.equal(await evaluate('currentMode'), "prep");
    assert.equal(await evaluate('input.value'), "B 的草稿");
    await capture("activity-wide-question");
    window.setSize(480, 820);
    await until('!document.body.classList.contains("sidebar-pinned")');
    assert.equal(await evaluate('document.getElementById("activity-toggle").getBoundingClientRect().right <= document.body.clientWidth'), true);
    await evaluate('document.getElementById("activity-toggle").click()');
    await until('drawer.classList.contains("open")');
    await capture("activity-narrow");
    await evaluate('setDrawer(false)');
    assert.equal(await evaluate('drawer.inert'), true);
    await capture("activity-narrow-question");
    await evaluate('document.documentElement.dataset.theme = "dark"');
    await capture("activity-dark-question");
    const countBeforeReload = notices;
    const reloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await reloaded;
    await until('selectedSessionId === "B" && activityView.rows.has("B") && activityReady');
    assert.equal(notices, countBeforeReload);
    assert.equal(await evaluate('document.getElementById("activity-notice").hidden'), true);
    assert.equal(await evaluate('activityView.rows.get("B").needsAttention'), true);
    // Gap in the independent activity stream recovers the full summary snapshot.
    await evaluate('activityView.seq -= 3');
    send("A", { type: "task_state", task: { id: "task-A2", state: "running" } });
    center.flush();
    await until('activityView.rows.get("A").taskId === "task-A2" && !activityView.loading');
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS Electron activity: foreground isolation, unread boundary, cross-mode question, wide/narrow navigation, reload and gap recovery");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture("activity-failure");
    app.exit(1);
  }
});
