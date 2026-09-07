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
function snapshot(mode) {
  const id = mode === "prep" ? "A" : "B";
  return { ok: true, mode, generation: mode === "prep" ? 2 : 1, session: { id },
    busy: id === "A" && (!finished || question?.state === "pending"),
    task: id === "A" ? { id: question?.taskId ?? "task-A", state: question?.state === "pending" ? "waiting_user" : finished ? "completed" : "running" } : null,
    attentions: id === "A" && question ? [question] : [],
    history: id === "A" ? [...Array.from({ length: 40 }, (_, i) => ({ role: "user", text: "Earlier message " + i, ts: 100 + i })),
      { role: "user", text: "Task A", ts: 1 },
      { role: "assistant", ts: 2, toolCalls: [{ id: "tool-A", name: "bash", hasResult: finished, resultText: finished ? "ok" : undefined }] },
      ...(finished ? [{ role: "assistant", ts: 3, text: "A final reply" }] : [])] : [],
    inFlight: { runtimeEpoch: id === "A" ? epochA : "test", seq: epochA !== "test" ? 0 : id === "A" && finished ? question?.state === "answered" ? 5 : 3 : 0,
      streaming: id === "A" && !finished ? [{ key: "draft-A", text: "A partial reply" }] : [],
      tools: id === "A" ? [{ toolCallId: "tool-A", toolName: "bash", state: finished ? "succeeded" : "running", startedAt }] : [] } };
}
let mode = "prep";
let generation = 0;
const submittedCommands = new Set();
let submitAttempts = 0;
const channels = [...readFileSync(path.join(desktop, "preload.cjs"), "utf8").matchAll(/invoke\("([^"]+)"/g)].map(match => match[1]);
for (const channel of new Set(channels)) ipcMain.handle(channel, (_event, input) => {
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
  if (channel === "sessions:snapshot") return snapshot(input === "A" ? "prep" : "combat");
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
    await window.loadFile(path.join(desktop, "src/renderer/index.html"));
    await until('selectedSessionId === "A" && workspaceReady.has("A") && !!document.querySelector(".streaming")');
    assert.equal(await evaluate('document.querySelector(".streaming .body").textContent'), "A partial reply");
    await evaluate('input.value = "draft A"; input.dispatchEvent(new Event("input")); pendingImages = [{data:"aGVsbG8=",mimeType:"image/png",previewUrl:"data:image/png;base64,aGVsbG8="}]; saveWorkspace();');
    await evaluate('messages.scrollTop = 200; messages.dispatchEvent(new Event("scroll")); toolCards.get("tool-A").card.classList.remove("open"); saveWorkspace();');
    const anchor = await evaluate('workspaceStore.cache.get("A").anchor');
    await evaluate('switchMode("combat")');
    await until('selectedSessionId === "B" && workspaceReady.has("B")');
    assert.equal(await evaluate('input.value'), "");
    await evaluate('input.value = "draft B"; input.dispatchEvent(new Event("input"));');
    await evaluate('switchMode("prep")');
    await until('selectedSessionId === "A" && input.value === "draft A"');
    assert.equal(await evaluate('toolCards.get("tool-A").card.classList.contains("running")'), true);
    assert.equal(await evaluate('toolCards.get("tool-A").startAt'), startedAt);
    assert.equal(await evaluate('pendingImages.length'), 1);
    assert.equal(await evaluate('followLatest'), false);
    assert.equal(await evaluate('toolCards.get("tool-A").card.classList.contains("open")'), false);
    const restoredOffset = await evaluate(`messages.querySelector('[data-item-key="${anchor.key}"]').getBoundingClientRect().top - messages.getBoundingClientRect().top`);
    assert.ok(Math.abs(restoredOffset - anchor.offset) < 3, "reading anchor preserved");
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
    console.log("PASS Electron: conversation restore, isolated drafts, stable retry, scoped answer and reloaded runtime cursor");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
