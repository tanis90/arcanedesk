const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const desktop = path.resolve(__dirname, "../..");
app.setPath("userData", mkdtempSync(path.join(tmpdir(), "arcane-conversation-smoke-")));
app.disableHardwareAcceleration();
const startedAt = Date.now() - 15000;
let finished = false;
let question = null;
let lastAnswer = null;
let sendTestEvent = () => {};
let epochA = "test";
let migratedHistory = false;
let interrupted = false;
let taskOverride = null;
let overrideSeq = 0;
const abortRequests = [];
let deferSnapshots = false;
const snapshotRequests = [];
function snapshot(mode) {
  const id = mode === "prep" ? "A" : "B";
  return { ok: true, mode, generation: mode === "prep" ? 2 : 1, session: { id },
    busy: id === "A" && (taskOverride ? ["running", "stopping"].includes(taskOverride.state) : !finished || question?.state === "pending"),
    task: id === "A" ? taskOverride ?? { id: question?.taskId ?? "task-A", state: interrupted ? "interrupted" : question?.state === "pending" ? "waiting_user" : finished ? "completed" : "running" } : null,
    attentions: id === "A" && question ? [question] : [],
    history: id === "A" ? [...Array.from({ length: 40 }, (_, i) => ({ role: "user", text: "Earlier message " + i, ts: 100 + i })),
      { role: "user", text: "Task A", ts: 1 },
      { role: "assistant", ts: 2, toolCalls: [{ id: "tool-A", name: "bash", hasResult: finished, resultText: finished ? "ok" : undefined }] },
      ...(finished ? [{ role: "assistant", ts: 3, text: "A final reply" }] : [])].map(row => migratedHistory
        ? { ...row, key: `entry:${row.role}-${row.ts}`, legacyKey: `${row.role}:${row.ts}` } : row) : [],
    inFlight: { runtimeEpoch: id === "A" ? epochA : "test", seq: id === "A" && taskOverride ? overrideSeq : epochA !== "test" ? 0 : id === "A" && finished ? question?.state === "answered" ? 5 : 3 : 0,
      streaming: id === "A" && !finished ? [{ key: "draft-A", text: "A partial reply" }] : [],
      tools: id === "A" ? [{ toolCallId: "tool-A", toolName: "bash", state: finished ? "succeeded" : "running", startedAt }] : [] } };
}
let mode = "prep";
let generation = 0;
const submittedCommands = new Set();
let submitAttempts = 0;
let layoutActivity;
const channels = [...readFileSync(path.join(desktop, "preload.cjs"), "utf8").matchAll(/invoke\("([^"]+)"/g)].map(match => match[1]);
for (const channel of new Set(channels)) ipcMain.handle(channel, (_event, input) => {
  if (channel === "activity:snapshot" && layoutActivity) return { ok: true, ...layoutActivity.snapshot() };
  if (channel === "chat:abort") return new Promise(resolve => abortRequests.push({ input, resolve }));
  if (channel === "tasks:respond") {
    lastAnswer = input;
    question = { ...question, state: "answered", response: input.response };
    sendTestEvent({ type: "attention", attention: question, seq: 4 });
    sendTestEvent({ type: "task_state", task: { id: question.taskId, state: "completed" }, seq: 5 });
    return { ok: true };
  }
  if (channel === "chat:prompt") {
    submitAttempts++;
    submittedCommands.add(input.commandId);
    if (submitAttempts === 1) return { ok: false, uncertain: true };
    return { ok: true, status: "accepted", commandId: input.commandId, inputId: "accepted-input", taskId: "retry-task", sessionId: input.sessionId, duplicate: true };
  }
  if (channel === "sessions:current") return { ...snapshot(mode), generation };
  if (channel === "sessions:snapshot") {
    if (deferSnapshots) return new Promise(resolve => snapshotRequests.push({ input, resolve }));
    return snapshot(input === "A" ? "prep" : "combat");
  }
  if (channel === "mode:set") { mode = input; return { ...snapshot(mode), generation: ++generation }; }
  if (channel === "sessions:list") return { sessions: [] };
  if (channel === "voice:get-config") return { enabled: false };
  if (channel === "ui:get-locale") return { pref: "en-US", resolved: "en-US" };
  if (channel === "slash:list") return { skills: [], templates: [], commands: [] };
  return {};
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { preload: path.join(desktop, "preload.cjs"), contextIsolation: true } });
  const evaluate = code => window.webContents.executeJavaScript(code);
  sendTestEvent = event => window.webContents.send("arcane:event", { ...event, sessionId: "A", mode: "prep", runtimeEpoch: "test", taskId: question.taskId });
  async function until(code) {
    const limit = Date.now() + 7000;
    while (Date.now() < limit) {
      if (await evaluate(code)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("Timed out: " + code);
  }
  try {
    if (process.argv.includes("--layout-review")) {
      const { pathToFileURL } = require("node:url");
      const { ActivityCenter } = await import(pathToFileURL(path.join(desktop, "src/main/conversations/activity-center.js")));
      layoutActivity = new ActivityCenter();
      layoutActivity.reconcile({ ...snapshot("prep"), session: { id: "A", name: "多任务验收 · 正在整理剧本与地图" } }, "prep");
      for (const id of ["B", "C"]) layoutActivity.reconcile({ ...snapshot("prep"), session: { id, name: `后台素材 ${id}` }, task: { id: `task-${id}`, state: "completed" } }, "prep");
    }
    await window.loadFile(path.join(desktop, "src/renderer/index.html"));
    await until('selectedSessionId === "A" && workspaceReady.has("A") && !!document.querySelector(".streaming")');
    assert.equal(await evaluate('document.querySelector(".streaming .body").textContent'), "A partial reply");
    if (process.argv.includes("--layout-review")) {
      await require("./layout-review.cjs")({ window, evaluate });
      app.exit(0); return;
    }
    await evaluate('input.value = "draft A"; input.dispatchEvent(new Event("input")); pendingImages = [{data:"aGVsbG8=",mimeType:"image/png",previewUrl:"data:image/png;base64,aGVsbG8="}]; saveWorkspace();');
    await evaluate('messages.scrollTo({top:200, behavior:"instant"}); messages.dispatchEvent(new Event("scroll")); toolCards.get("tool-A").card.classList.remove("open"); saveWorkspace();');
    assert.equal(await evaluate('followLatest'), false, "fixture actually moves away from the live tail before switching");
    const anchor = await evaluate('workspaceStore.cache.get("A").anchor');
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B" && workspaceReady.has("B")');
    assert.equal(await evaluate('input.value'), "");
    await evaluate('input.value = "draft B"; input.dispatchEvent(new Event("input"));');
    migratedHistory = true;
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && input.value === "draft A"');
    assert.equal(await evaluate('toolCards.get("tool-A").card.classList.contains("running")'), true);
    assert.equal(await evaluate('toolCards.get("tool-A").startAt'), startedAt);
    assert.equal(await evaluate('pendingImages.length'), 1);
    assert.equal(await evaluate('followLatest'), false);
    assert.equal(await evaluate('toolCards.get("tool-A").card.classList.contains("open")'), false);
    const restoredOffset = await evaluate(`messageNode(${JSON.stringify(anchor.key)}).getBoundingClientRect().top - messages.getBoundingClientRect().top`);
    assert.ok(Math.abs(restoredOffset - anchor.offset) < 3, "reading anchor preserved");
    assert.ok((await evaluate(`messageNode(${JSON.stringify(anchor.key)}).dataset.itemKey`)).includes("entry:"), "legacy anchor resolves to durable message identity");
    await evaluate('workspaceStore.save(selectedSessionId, workspaceStore.cache.get(selectedSessionId))');
    const reloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload();
    await reloaded;
    await until('selectedSessionId === "A" && input.value === "draft A" && pendingImages.length === 1');
    assert.equal(await evaluate('document.querySelector(".streaming .body").textContent'), "A partial reply");
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B"');
    finished = true;
    for (const event of [
      { seq: 1, type: "tool_end", toolCallId: "tool-A", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } },
      { seq: 2, type: "message", key: "draft-A", role: "assistant", text: "A final reply" },
      { seq: 3, type: "task_state", task: { id: "task-A", state: "completed" } },
    ]) window.webContents.send("arcane:event", { ...event, sessionId: "A", taskId: "task-A", mode: "prep", runtimeEpoch: "test" });
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && !busy && document.getElementById("messages").textContent.includes("A final reply")');
    assert.equal(await evaluate('document.querySelectorAll(".streaming").length'), 0);
    assert.equal(await evaluate('[...document.querySelectorAll(".msg.assistant")].filter(e => e.textContent === "A final reply").length'), 1);
    await evaluate('input.value = "retry me"; pendingImages = []; submit()');
    await until('!!document.querySelector(".retry-input")');
    await evaluate('document.querySelector(".retry-input").click()');
    await until('outboxFor("A").size === 0');
    assert.equal(submitAttempts, 2);
    assert.equal(submittedCommands.size, 1);
    question = { id: "question-A", taskId: "task-question", state: "pending", question: "Which scene?", options: ["Forest", "City"] };
    await evaluate('resyncSelected()');
    await until('!!document.querySelector("[data-attention-id] textarea")');
    assert.equal(await evaluate('busy'), true);
    await evaluate('const answer = document.querySelector("[data-attention-id] textarea"); answer.value = "Quiet forest"; answer.dispatchEvent(new Event("input"));');
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B"');
    assert.equal(await evaluate('document.querySelectorAll("[data-attention-id]").length'), 0);
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && document.querySelector("[data-attention-id] textarea")?.value === "Quiet forest"');
    await evaluate('document.querySelector("[data-attention-id] button.primary").click()');
    await until('!document.querySelector("[data-attention-id] textarea") && document.querySelector("[data-attention-id]").textContent.includes("Quiet forest")');
    assert.equal(lastAnswer.sessionId, "A");
    assert.equal(lastAnswer.taskId, "task-question");
    assert.equal(lastAnswer.attentionId, "question-A");
    // Reclaimed host: no new event has arrived to announce its new cursor.
    epochA = "reloaded";
    await evaluate('resyncSelected()');
    await until('viewEpoch === "reloaded" && viewSeq === 0 && !syncingSessions.has("A")');
    assert.equal(await evaluate('eventInbox.epoch("A")'), "reloaded");
    window.webContents.send("arcane:event", { sessionId: "A", mode: "prep", runtimeEpoch: "test", seq: 100,
      type: "message", key: "stale", role: "assistant", text: "STALE OLD INSTANCE" });
    window.webContents.send("arcane:event", { sessionId: "A", mode: "prep", runtimeEpoch: "reloaded", seq: 1,
      type: "message", key: "new", role: "assistant", text: "Fresh instance result" });
    await until('viewSeq === 1 && messages.textContent.includes("Fresh instance result")');
    assert.equal(await evaluate('messages.textContent.includes("STALE OLD INSTANCE")'), false);
    interrupted = true;
    await evaluate('resyncSelected()');
    await until('!!document.querySelector(".recover-task")');
    await evaluate('input.value = "keep my draft"; pendingImages = [{data:"aGVsbG8=",mimeType:"image/png",previewUrl:"data:image/png;base64,aGVsbG8="}]; document.querySelector(".recover-task").click(); document.querySelector(".recover-task").click();');
    const recoveryDraft = await evaluate('input.value');
    assert.ok(recoveryDraft.startsWith("keep my draft\n\n"));
    assert.equal(recoveryDraft, "keep my draft\n\n" + await evaluate('t("chat.recovery.prompt")'), "repeat clicks do not duplicate the recovery request");
    assert.equal(await evaluate('pendingImages.length'), 1);
    assert.equal(submitAttempts, 2, "preparing recovery never submits a model request");
    await evaluate('saveWorkspace(); switchMode("combat")');
    await until('selectedSessionId === "B"');
    assert.equal(await evaluate('document.querySelector(".recover-task")'), null);
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && !!document.querySelector(".recover-task")');
    assert.equal(await evaluate('input.value'), recoveryDraft);
    assert.equal(await evaluate('pendingImages.length'), 1);
    await evaluate('saveWorkspace()');
    const recoveryReloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await recoveryReloaded;
    await until('selectedSessionId === "A" && !!document.querySelector(".recover-task") && pendingImages.length === 1');
    assert.equal(await evaluate('input.value'), recoveryDraft);
    assert.equal(submitAttempts, 2, "reloading recovery does not replay an input");
    taskOverride = { id: "stop-task", state: "running" };
    await evaluate('resyncSelected()');
    await until('selectedTaskId === "stop-task" && busy && !send.disabled');
    assert.equal(await evaluate('send.getAttribute("aria-label")'), await evaluate('t("composer.supplement")'));
    await evaluate('input.value = "keep while stopping"; input.dispatchEvent(new Event("input")); stop.click(); send.click(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); submit();');
    await until('send.disabled && stop.disabled');
    await evaluate('sendSubmission({context: {...modeContext(), commandId: "blocked-retry"}, text: "retry", images: []})');
    assert.equal(await evaluate('input.value'), "keep while stopping");
    assert.equal(await evaluate('pendingImages.length'), 1);
    assert.equal(submitAttempts, 2);
    assert.equal(abortRequests.length, 1);
    assert.equal(abortRequests[0].input.sessionId, "A");
    assert.equal(abortRequests[0].input.taskId, "stop-task");
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B" && !send.disabled');
    assert.equal(await evaluate('send.getAttribute("aria-label")'), await evaluate('t("composer.newTask")'));
    const bDraft = await evaluate('input.value');
    abortRequests[0].resolve({ ok: false, code: "STOP_FAILED" });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await evaluate('input.value'), bDraft);
    assert.equal(await evaluate('document.getElementById("composer-stop-feedback").hidden'), true);
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && !send.disabled && !document.getElementById("composer-stop-feedback").hidden');
    assert.equal(await evaluate('input.value'), "keep while stopping");
    await evaluate('stop.click()');
    await until('send.disabled');
    taskOverride.state = "stopping";
    await evaluate('saveWorkspace(); resyncSelected()');
    const stopReloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await stopReloaded;
    await until('selectedSessionId === "A" && send.disabled && pendingImages.length === 1');
    await evaluate('submit()');
    assert.equal(await evaluate('input.value'), "keep while stopping");
    assert.equal(submitAttempts, 2);
    taskOverride.state = "stopped";
    abortRequests[1].resolve({ ok: true, task: taskOverride });
    await evaluate('resyncSelected()');
    await until('!busy && !send.disabled');
    assert.equal(await evaluate('input.value'), "keep while stopping");
    assert.equal(await evaluate('send.getAttribute("aria-label")'), await evaluate('t("composer.newTask")'));
    taskOverride = { id: "finishing-stop-task", state: "running" };
    await evaluate('resyncSelected()');
    await until('selectedTaskId === "finishing-stop-task" && !stop.disabled');
    await evaluate('stop.click()');
    await until('send.disabled');
    taskOverride.state = "completed";
    await evaluate('resyncSelected()');
    await until('!send.disabled && !busy');
    taskOverride = { id: "later-task", state: "running" };
    await evaluate('resyncSelected()');
    await until('selectedTaskId === "later-task"');
    abortRequests.at(-1).resolve({ ok: false, code: "STALE_TASK" });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await evaluate('document.getElementById("composer-stop-feedback").hidden'), true);
    assert.equal(await evaluate('send.disabled'), false, "old stop receipt cannot block the next task");
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B"');
    taskOverride = { id: "later-task", state: "failed", error: "Server unavailable\nDetails: <b>timeout</b>" };
    overrideSeq = 1;
    const failedEvent = { type: "task_state", task: taskOverride, taskId: taskOverride.id, sessionId: "A", mode: "prep", runtimeEpoch: "reloaded", seq: overrideSeq };
    window.webContents.send("arcane:event", failedEvent);
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason")'), null);
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && !busy && !!document.querySelector(".task-terminal-reason")');
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason").textContent'), taskOverride.error);
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason b")'), null, "reason is plain text");
    window.webContents.send("arcane:event", failedEvent);
    await evaluate('resyncSelected()');
    assert.equal(await evaluate('document.querySelectorAll(".task-terminal-reason").length'), 1);
    await evaluate('input.value = "retain this"; document.querySelector(".recover-task").click(); saveWorkspace()');
    const failureDraft = await evaluate('input.value');
    assert.equal(failureDraft, "retain this\n\n" + await evaluate('t("chat.terminal.failedPrompt")'));
    const terminalReloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await terminalReloaded;
    await until('selectedSessionId === "A" && !!document.querySelector(".task-terminal-reason") && workspaceReady.has("A")');
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason").textContent'), taskOverride.error);
    assert.equal(await evaluate('input.value'), failureDraft);
    assert.equal(await evaluate('pendingImages.length'), 1);
    taskOverride = { id: "later-task", state: "stopped", error: "Tool stopped after its operation settled" };
    await evaluate('resyncSelected()');
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason").textContent'), taskOverride.error);
    delete taskOverride.error;
    await evaluate('resyncSelected()');
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason").textContent'), await evaluate('t("chat.terminal.stoppedReason")'));
    taskOverride = { id: "next-task", state: "running" };
    await evaluate('resyncSelected()');
    assert.equal(await evaluate('document.querySelector(".task-terminal-reason")'), null);
    assert.equal(await evaluate('document.querySelector(".recover-task")'), null);
    assert.equal(submitAttempts, 2, "terminal recovery prepares a draft without executing work");
    const lastConfirmation = await evaluate('confirmedAt.get("A")');
    await evaluate('installSnapshot(snapshotCache.get("A"), null, true)');
    assert.equal(await evaluate('confirmedAt.get("A")'), lastConfirmation, "rendering a cache is not new execution confirmation");
    assert.equal(await evaluate('syncIndicator.dataset.status'), "chat.syncCached");
    assert.equal(await evaluate('syncIndicator.hidden'), false);
    await evaluate('resyncSelected()');
    deferSnapshots = true;
    await evaluate('void resyncSelected()');
    await until('!syncIndicator.hidden && syncIndicator.dataset.status === "chat.syncing"');
    assert.equal(await evaluate('busy'), true, "sync delay does not change execution state");
    assert.ok(await evaluate('syncIndicator.textContent.includes(t("chat.syncLastConfirmed", {time: new Date(confirmedAt.get("A")).toLocaleTimeString()}))'));
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B"');
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && !restoringView');
    await evaluate('void resyncSelected()');
    await until('snapshotRequest === syncingSessions.get("A")?.token');
    assert.equal(snapshotRequests.length, 2, "return navigation may start a fresh sync while the old request is pending");
    snapshotRequests[0].resolve({ ok: false, code: "OLD_FAILURE" });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await evaluate('syncingSessions.has("A")'), true, "old completion does not unlock the new request");
    assert.notEqual(await evaluate('syncIndicator.dataset.status'), "chat.syncFailed");
    snapshotRequests[1].resolve({ ok: false, code: "NEW_FAILURE" });
    await until('syncIndicator.dataset.status === "chat.syncFailed" && !syncIndicator.hidden');
    assert.equal(await evaluate('busy'), true);
    const keptDraft = await evaluate('input.value');
    deferSnapshots = false;
    await evaluate('syncIndicator.click()');
    await until('syncIndicator.hidden && !syncingSessions.has("A")');
    assert.equal(await evaluate('input.value'), keptDraft);
    // Force only the diagnostic clock stale, then let the real interval probe.
    deferSnapshots = true;
    await evaluate('confirmedAt.set("A", Date.now() - 30000); syncAttemptAt.delete("A")');
    await until('syncingSessions.has("A")');
    assert.equal(snapshotRequests.length, 3, "silence triggers a read-only execution probe");
    // A hung invoke must not permanently keep the single-flight gate locked.
    await new Promise(resolve => setTimeout(resolve, 10500));
    assert.equal(await evaluate('syncIndicator.dataset.status'), "chat.syncFailed");
    assert.equal(await evaluate('syncingSessions.has("A")'), false);
    assert.equal(await evaluate('busy'), true);
    deferSnapshots = false;
    await evaluate('syncIndicator.click()');
    await until('syncIndicator.hidden && !syncingSessions.has("A")');
    snapshotRequests[2].resolve({ ok: false, code: "LATE_TIMEOUT_RESULT" });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await evaluate('syncIndicator.hidden'), true);
    assert.equal(submitAttempts, 2, "sync probes never submit model work");
    console.log("PASS Electron: conversation restore, scoped input, terminal details and bounded synchronization recovery");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
