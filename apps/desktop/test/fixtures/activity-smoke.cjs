const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const desktop = path.resolve(__dirname, "../..");
const scratch = mkdtempSync(path.join(tmpdir(), "arcane-activity-ui-"));
app.setPath("userData", scratch);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { ActivityCenter } = await import(pathToFileURL(path.join(desktop, "src/main/conversations/activity-center.js")));
  const { SessionProjection } = await import(pathToFileURL(path.join(desktop, "src/main/sync/session-projection.js")));
  const { DesktopNotifications } = await import(pathToFileURL(path.join(desktop, "src/main/conversations/desktop-notifications.js")));
  const window = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { preload: path.join(desktop, "preload.cjs"), contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const sessions = new Map([ ["A", { name: "今晚的冒险素材", mode: "prep" }], ["B", { name: "支线剧情", mode: "prep" }], ["C", { name: "战场态势", mode: "combat" }] ]);
  for (const [id, value] of sessions) Object.assign(value, { id, path: `${id}.jsonl`, history: [], task: null, attentions: [],
    projection: new SessionProjection({ sessionId: id, epoch: "activity-test" }) });
  let mode = "prep", selected = "B", generation = 0, focused = false, notices = 0;
  const emit = event => window.webContents.send("arcane:event", event);
  let panelNavigations = 0;
  const { ShutdownCoordinator } = await import(pathToFileURL(path.join(desktop, "src/main/conversations/shutdown-coordinator.js")));
  let finishExitStop, didQuit = false, exitAdmission = false;
  const exitHost = { busy: true, task: { id: "exit-test" }, async abort() {
    await new Promise(resolve => { finishExitStop = resolve; }); this.busy = false;
  } };
  const shutdown = new ShutdownCoordinator({ registries: [{ allHosts: () => [exitHost], pending: new Map() }],
    gate: value => { exitAdmission = value; }, quiesce: async () => {}, finish: () => { didQuit = true; },
    emit: state => emit({ type: "shutdown_state", ...state }) });
  const submissions = [];
  let notificationBroker;
  const nativeNotifications = [];
  const center = new ActivityCenter({ file: path.join(scratch, "activity.json"), describe: id => sessions.get(id), foreground: id => focused && selected === id,
    emit, notify: notice => { notices++; emit({ type: "activity_notice", notice }); notificationBroker?.deliver(notice); } });
  notificationBroker = new DesktopNotifications({ file: path.join(scratch, "notifications.json"),
    supported: () => true, foreground: () => focused, lookup: id => center.get(id), text: kind => kind,
    activate: () => { focused = true; emit({ type: "notification_target" }); },
    create: options => {
      const native = new EventEmitter(); native.options = options;
      native.show = () => {}; native.close = () => native.emit("close");
      nativeNotifications.push(native); return native;
    } });
  function snapshot(id) {
    const row = sessions.get(id);
    return { ok: true, session: { id, name: row.name, path: row.path }, mode: row.mode, generation,
      history: row.history, task: row.task, busy: row.task?.state === "running" || row.task?.state === "waiting_user",
      attentions: row.attentions, inputs: row.inputs ?? [], inFlight: row.projection.snapshot() };
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
    if (channel === "sessions:identities") return { ok: true, sessionIds: [...sessions.keys()] };
    if (channel === "lifecycle:get") return shutdown.snapshot();
    if (channel === "lifecycle:cancel-exit") { shutdown.cancel(); return shutdown.snapshot(); }
    if (channel === "panel:open") { panelNavigations++; return { ok: true }; }
    if (channel === "notifications:get") return { ok: true, ...notificationBroker.status() };
    if (channel === "notifications:set") return notificationBroker.setEnabled(input);
    if (channel === "notifications:take-target") return notificationBroker.takeTarget();
    if (channel === "activity:snapshot") return { ok: true, ...center.snapshot() };
    if (channel === "activity:opened") return center.opened(input);
    if (channel === "chat:prompt") {
      submissions.push(input);
      const row = sessions.get(input.sessionId);
      row.inputs = (row.inputs ?? []).filter(item => item.id !== input.replacesInputId);
      return { ok: true };
    }
    if (channel === "sessions:current") return snapshot(selected);
    if (channel === "sessions:snapshot") return snapshot(input);
    if (channel === "sessions:navigation") return { ok: true, sessions: [...sessions.values()].map(s => ({ id: s.id, name: s.name, path: s.path, mode: s.mode, projectKey: s.mode, cwd: "C:/test/" + s.mode, activity: center.get(s.id) })) };
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
    center.opened("A");
    await window.loadFile(path.join(desktop, "src/renderer/index.html"));
    await until('selectedSessionId === "B" && activityReady && activityView.rows.has("A")');
    if (process.env.ARCANE_SMOKE_INPUT_RECOVERY === "1") {
      await until('workspaceReady.has("B")');
      const recovered = { id: "pending-1", commandId: "old-1", text: "interrupted first", state: "interrupted", images: [] };
      sessions.get("B").inputs = [recovered, { ...recovered, id: "pending-2", commandId: "old-2", text: "interrupted second" }];
      await evaluate('workspaceStore.save("B", { draft: "independent draft", outbox: [{ context: { sessionId: "B", commandId: "old-1" }, text: "interrupted first", images: [] }, { context: { sessionId: "B", commandId: "old-outbox" }, text: "uncertain outbox", images: [] }] }); outboxBySession.delete("B"); workspaceReady.delete("B");');
      await evaluate('pullCurrentSession()');
      await until('messages.textContent.includes("uncertain outbox") && messages.querySelectorAll(".retry-input").length === 3');
      assert.equal(await evaluate('input.value'), "independent draft");
      assert.equal(await evaluate(`messages.querySelectorAll('[data-command-id="old-1"]').length`), 1);
      await evaluate(`messages.querySelector('[data-command-id="old-1"] .retry-input').click()`);
      await until('messages.querySelectorAll(".retry-input").length === 2');
      assert.equal(submissions.length, 1);
      assert.notEqual(submissions[0].commandId, "old-1"); assert.equal(submissions[0].replacesInputId, "pending-1");
      assert.equal(submissions[0].sessionId, "B");
      await evaluate(`messages.querySelector('[data-command-id="old-outbox"] .retry-input').click()`);
      await until('messages.querySelectorAll(".retry-input").length === 1');
      assert.equal(submissions.length, 2); assert.notEqual(submissions[1].commandId, "old-outbox");
      assert.equal(await evaluate('input.value'), "independent draft");
      console.log("PASS renderer/preload recovery: pending and outbox merged; explicit resend uses new identity; draft preserved");
      window.destroy(); app.exit(0); return;
    }
    assert.equal(await evaluate('document.body.classList.contains("sidebar-pinned")'), true);
    assert.equal(await evaluate('drawer.inert'), false);
    await evaluate('input.value = "B 的草稿"; input.dispatchEvent(new Event("input")); input.focus();');
    send("A", { type: "message", role: "assistant", key: "assistant:101", text: "已准备好今晚的冒险素材：古堡主线与商队支线。" });
    send("A", { type: "task_state", task: { id: "task-A", state: "completed" } });
    await until('activityView.rows.get("A")?.unread === true');
    assert.equal(await evaluate('selectedSessionId'), "B");
    assert.equal(await evaluate('input.value'), "B 的草稿");
    assert.equal(await evaluate('document.activeElement === input'), true);
    assert.equal(notices, 1);
    // Explicitly simulate trusted foreground presence; the test window stays hidden.
    focused = true;
    await evaluate('Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true }); void 0;');
    await evaluate('document.querySelector(".session-item[data-session-id=A] .s-body").click()');
    await until('selectedSessionId === "A" && activityReady && followLatest');
    await until('activityView.rows.get("A").unread === false');
    await capture("activity-wide-latest");
    assert.equal(center.get("A").state, "completed");
    assert.equal(await evaluate('!document.getElementById("activity-notice")'), true);
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "C" && activityReady');
    send("B", { type: "task_state", task: { id: "task-B", state: "running" } });
    send("B", { type: "attention", attention: { id: "question-B", taskId: "task-B", question: "支线发生在哪里？", options: ["森林", "村庄"], state: "pending" } });
    send("B", { type: "task_state", task: { id: "task-B", state: "waiting_user" } });
    center.flush();
    await until('activityView.rows.get("B")?.needsAttention === true');
    assert.equal(await evaluate('selectedSessionId'), "C");
    await evaluate('document.querySelector(".session-item[data-session-id=B] .s-body").click()');
    await until('selectedSessionId === "B" && !!document.querySelector("[data-attention-id=question-B] textarea")');
    assert.equal(await evaluate('currentMode'), "prep");
    assert.equal(await evaluate('input.value'), "B 的草稿");
    await capture("activity-wide-question");
    window.setSize(480, 820);
    await until('!document.body.classList.contains("sidebar-pinned")');
    assert.equal(await evaluate('document.getElementById("sessions-toggle").getBoundingClientRect().right <= document.body.clientWidth'), true);
    await evaluate('document.getElementById("sessions-toggle").click()');
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
    assert.equal(await evaluate('!document.getElementById("activity-notice")'), true);
    assert.equal(await evaluate('activityView.rows.get("B").needsAttention'), true);
    // Gap in the independent activity stream recovers the full summary snapshot.
    await evaluate('activityView.seq -= 3');
    send("A", { type: "task_state", task: { id: "task-A2", state: "running" } });
    center.flush();
    await until('activityView.rows.get("A").taskId === "task-A2" && !activityView.loading');
    await evaluate('refreshNotificationSettings()');
    assert.equal(await evaluate('notificationsSwitch.getAttribute("aria-checked")'), "false");
    await evaluate('notificationsSwitch.click()');
    await until('notificationsSwitch.getAttribute("aria-checked") === "true"');
    assert.equal(notificationBroker.enabled, true);
    focused = false;
    send("A", { type: "task_state", task: { id: "task-A2", state: "completed" } });
    assert.equal(nativeNotifications.length, 1);
    assert.equal(await evaluate('selectedSessionId'), "B");
    nativeNotifications[0].emit("click");
    await until('selectedSessionId === "A" && !openingNotification');
    assert.equal(notificationBroker.takeTarget(), null);
    focused = false;
    sessions.get("B").attentions = [];
    send("B", { type: "task_state", task: { id: "task-B-native", state: "completed" } });
    await evaluate('activityReady = false');
    nativeNotifications[1].emit("click");
    const rebuilt = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await rebuilt;
    await until('selectedSessionId === "B" && activityReady && !openingNotification');
    assert.equal(notificationBroker.takeTarget(), null);
    send("B", { type: "task_state", task: { id: "task-B-queued", state: "queued" } });
    await until('selectedTaskId === "task-B-queued" && busy');
    assert.equal(await evaluate('taskIndicator.textContent'), await evaluate('t("activity.capacityQueue")'));
    send("B", { type: "task_state", task: { id: "task-B-queued", state: "cancelled" } });
    await until('!busy && taskIndicator.textContent.startsWith(t("activity.cancelled"))');
    assert.equal(await evaluate('document.querySelector(".task-terminal-next, .recover-task")'), null);
    await evaluate(`showTaskState({ id: "error-test", state: "failed", error: '401: {"type":"invalid_authentication_error"}' })`);
    assert.equal(await evaluate('taskIndicator.querySelector(".error-summary").textContent'), await evaluate('t("chat.error.auth")'));
    assert.equal(await evaluate('taskIndicator.querySelector("details").open'), false);
    await capture("error-collapsed");
    await evaluate('taskIndicator.querySelector("summary").click()');
    assert.equal(await evaluate('taskIndicator.querySelector("details").open'), true);
    assert.ok(await evaluate('taskIndicator.querySelector("pre").textContent.includes("invalid_authentication_error")'));
    await evaluate('input.focus(); navigationView.notify("Archived", () => {}, "toast-test")');
    assert.equal(await evaluate('document.querySelectorAll("#navigation-toast button").length'), 1);
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(await evaluate('document.getElementById("navigation-toast").hidden'), true);
    assert.equal(await evaluate('document.activeElement === input'), true);
    await evaluate('showTaskState(null)');
    await evaluate('document.getElementById("toggle-panel").click()');
    assert.equal(panelNavigations, 1);
    const deletedSnapshot = snapshot("A");
    await evaluate('workspaceStore.save("A", { draft: "private draft", images: [{ data: "private image" }], outbox: [{ text: "pending" }] })');
    center.remove("A"); sessions.delete("A");
    await until('deletedSessions.has("A") && selectedSessionId !== "A"');
    const beforeDeletedInstall = await evaluate('selectedSessionId');
    await evaluate(`installSnapshot(${JSON.stringify(deletedSnapshot)})`);
    assert.equal(await evaluate('selectedSessionId'), beforeDeletedInstall);
    assert.deepEqual(await evaluate('workspaceStore.load("A")'), {});
    assert.deepEqual(await evaluate('(new ArcaneConversationState.WorkspaceStore()).load("A")'), {});
    await evaluate('Promise.all([workspaceStore.save("delete-race", { images: [{ data: "secret" }] }), workspaceStore.remove("delete-race")])');
    assert.deepEqual(await evaluate('(new ArcaneConversationState.WorkspaceStore()).load("delete-race")'), {});
    await evaluate('workspaceStore.save("offline-session", { draft: "missed deletion", images: [{ data: "secret" }] })');
    const deletionReload = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await deletionReload;
    await until('deletedSessions.has("offline-session") && selectedSessionId === "B"');
    assert.deepEqual(await evaluate('(new ArcaneConversationState.WorkspaceStore()).load("offline-session")'), {});
    const exiting = shutdown.stop();
    await until('!document.getElementById("shutdown-status").hidden');
    assert.equal(exitAdmission, true);
    const exitReload = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await exitReload;
    await until('!document.getElementById("shutdown-status").hidden');
    await evaluate('document.getElementById("cancel-exit").click()');
    await until('document.getElementById("shutdown-status").hidden');
    finishExitStop(); await exiting; assert.equal(didQuit, false); assert.equal(exitAdmission, false);
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS Electron activity: foreground isolation, coarse unread, cross-mode question, wide/narrow navigation, reload, gap recovery and notification settings/click");
    app.exit(0);
  } catch (error) {
    console.error(error);
    await capture("activity-failure");
    app.exit(1);
  }
});
