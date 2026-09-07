// Real production main/IPC/SDK; only the model endpoint and dialog decisions are controlled.
const { app, dialog, Tray } = require("electron");
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
const crashPhase = process.argv.find(arg => arg.startsWith("--crash-phase="))?.split("=")[1];
const longTool = process.argv.includes("--long-tool");
const scratch = process.argv.find(arg => arg.startsWith("--smoke-root="))?.slice("--smoke-root=".length)
  ?? mkdtempSync(path.join(tmpdir(), "arcane-production-smoke-"));
app.setPath("userData", scratch);
app.disableHardwareAcceleration();
for (const key of Object.keys(process.env)) {
  if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: path.join(scratch, "agent"), LOCALAPPDATA: path.join(scratch, "local"),
  APPDATA: path.join(scratch, "roaming"), USERPROFILE: scratch,
  ARCANE_SPARK_API_KEY: "smoke-only", ARCANE_SPARK_FORCE_DEFAULT: "1", ARCANE_SPARK_ENABLED: "1",
  ARCANE_SKILLS_UPDATE_BASE_URL: "http://127.0.0.1:1", ARCANE_TELEMETRY_DISABLED: "1",
});
let window, tray, menu, decision = 0, prompts = [], finalExit = false, hostB;
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (value) { tray = this; menu = value; return setContextMenu.call(this, value); };
dialog.showMessageBox = async (_window, options) => { prompts.push(options); return { response: decision }; };
app.on("browser-window-created", (_event, value) => {
  window = value;
  value.hide(); value.on("show", () => value.hide());
  value.webContents.setBackgroundThrottling(false);
});
const streams = new Map();
const requests = [];
const toolStarted = path.join(scratch, "tool-started.txt");
const toolRelease = path.join(scratch, "tool-release.txt");
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const server = http.createServer(async (req, res) => {
  if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "arcane-spark" }] })); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  const user = [...data.messages].reverse().find(row => row.role === "user");
  const tag = JSON.stringify(user?.content).match(/production-([ABC])/)?.[1];
  if (!tag) { res.writeHead(400); res.end("Unknown smoke input"); return; }
  requests.push(tag);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const write = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `smoke-${tag}`, object: "chat.completion.chunk", created: 1, model: "arcane-spark", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const entry = { closed: false, finish() { write({ content: ` ${tag} final result` }); write({}, "stop"); res.end("data: [DONE]\n\n"); } };
  res.on("close", () => { entry.closed = true; });
  streams.set(tag, entry);
  write({ role: "assistant", content: `${tag} partial` });
  if (longTool && tag === "B") {
    const toolResult = data.messages.find(row => row.role === "tool" && row.tool_call_id === "long-tool");
    if (toolResult) {
      assert.ok(JSON.stringify(toolResult.content).includes("LONG TOOL FINISHED"), "real shell result reaches the SDK model context");
      entry.finish();
    } else {
      const command = `[IO.File]::AppendAllText(${psLiteral(toolStarted)}, "started\n"); while (!(Test-Path -LiteralPath ${psLiteral(toolRelease)})) { Start-Sleep -Milliseconds 100 }; Write-Output 'LONG TOOL FINISHED'`;
      write({ tool_calls: [{ index: 0, id: "long-tool", type: "function", function: { name: "powershell", arguments: JSON.stringify({ command, timeout: 60 }) } }] });
      write({}, "tool_calls"); res.end("data: [DONE]\n\n");
    }
  }
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(40); }
  throw new Error(`Timed out: ${label}`);
}
const evaluate = code => window.webContents.executeJavaScript(code);
const ui = code => until(async () => { try { return await evaluate(code); } catch { return false; } }, code);
const openHost = host => evaluate(`(async () => { const result = await window.arcane.openSession(${JSON.stringify(host.describeCurrent().path)}, modeContext()); if (!result.ok) throw new Error(result.error); await installSnapshot(result); })()`);
app.on("will-quit", () => {
  try {
    assert.ok(finalExit, "exit must follow the stop-and-exit decision");
    if (longTool) {
      assert.equal(hostB.tasks.task.state, "completed");
      assert.equal(hostB.busy, false);
      assert.equal(readFileSync(toolStarted, "utf8"), "started\n", "the shell ran exactly once");
      assert.deepEqual(requests, ["A", "B", "B"], "only B's tool-result continuation adds a request");
      console.log("PASS production long tool: real shell, cross-mode/reload continuity, original timer and isolated stop");
      return;
    }
    assert.equal(hostB.tasks.task.state, "stopped");
    assert.equal(hostB.busy, false);
    assert.ok(tray.isDestroyed(), "native tray destroyed on normal exit");
    assert.deepEqual(requests, ["A", "B"], "navigation and reload must not replay prompts");
    console.log("PASS production main: real SDK concurrent tasks, background completion, reload, native tray callbacks and graceful stop/quit");
  } catch (error) { console.error(error); process.exitCode = 1; }
});
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.ARCANE_SPARK_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  await import(pathToFileURL(path.resolve(__dirname, "../../src/main/main.js")).href);
  await ui('typeof selectedSessionId !== "undefined" && selectedSessionId && workspaceReady.has(selectedSessionId)');
  await evaluate('switchMode("prep")');
  await ui('modeContext().mode === "prep" && workspaceReady.has(selectedSessionId)');
  if (crashPhase === "recover") {
    const saved = JSON.parse(readFileSync(path.join(scratch, "crash-checkpoint.json"), "utf8"));
    await openHost({ describeCurrent: () => saved.b });
    await ui(`selectedSessionId === ${JSON.stringify(saved.b.id)} && !busy && !!document.querySelector(".recover-task")`);
    const restoredB = globalThis.__arcaneHosts.prep.get(saved.b.id);
    assert.equal(restoredB.tasks.task.state, "interrupted");
    assert.equal(restoredB.tasks.task.id, saved.taskId);
    assert.ok(await evaluate('messages.textContent.includes("production-B")'), "accepted input remains visible");
    await evaluate('document.querySelector(".recover-task").click(); saveWorkspace()');
    assert.ok(await evaluate('input.value.includes(t("chat.recovery.prompt"))'));
    await sleep(300);
    assert.deepEqual(requests, [], "restart and recovery preparation do not replay model requests");
    await evaluate('input.value += " production-C"; submit()');
    await ui('busy && messages.textContent.includes("C partial")');
    assert.notEqual(restoredB.tasks.task.id, saved.taskId, "explicit continuation starts a new task in the same session");
    streams.get("C").finish();
    await ui('!busy && messages.textContent.includes("C final result") && !document.querySelector(".recover-task")');
    assert.equal(restoredB.tasks.task.state, "completed");
    await openHost({ describeCurrent: () => saved.a });
    await ui(`selectedSessionId === ${JSON.stringify(saved.a.id)} && !busy && messages.textContent.includes("A final result")`);
    assert.equal(globalThis.__arcaneHosts.prep.get(saved.a.id).tasks.task.state, "completed");
    await sleep(300);
    assert.deepEqual(requests, ["C"], "only the explicitly submitted continuation executes");
    console.log("PASS crash recovery: durable result, interrupted first-turn task, no automatic replay and explicit continuation");
    app.exit(0); return;
  }
  const idA = await evaluate("selectedSessionId");
  await evaluate('input.value = "production-A"; submit()');
  await ui('busy && messages.textContent.includes("A partial")');
  const hostA = globalThis.__arcaneHosts.prep.get(idA);
  assert.ok(hostA.describeCurrent().path.startsWith(scratch), "session storage is isolated");
  await evaluate('document.getElementById("session-new").click()');
  await ui(`selectedSessionId !== ${JSON.stringify(idA)} && workspaceReady.has(selectedSessionId)`);
  const idB = await evaluate("selectedSessionId");
  assert.ok(hostA.busy && !streams.get("A").closed, "navigation keeps A streaming");
  await evaluate('input.value = "production-B"; submit()');
  await ui('busy && messages.textContent.includes("B partial")');
  hostB = globalThis.__arcaneHosts.prep.get(idB);
  assert.ok(hostA.busy && hostB.busy);
  if (longTool) {
    await until(() => existsSync(toolStarted), "real PowerShell process entered its wait");
    await ui('toolCards.get("long-tool")?.card.classList.contains("running")');
    const startedAt = await evaluate('toolCards.get("long-tool").startAt');
    await evaluate('switchMode("combat")');
    await ui('modeContext().mode === "combat" && workspaceReady.has(selectedSessionId)');
    await evaluate('input.value = "combat draft during tool"; input.dispatchEvent(new Event("input"));');
    assert.ok(hostB.busy);
    await evaluate('switchMode("prep")');
    await ui(`selectedSessionId === ${JSON.stringify(idB)} && toolCards.get("long-tool")?.card.classList.contains("running")`);
    assert.equal(await evaluate('toolCards.get("long-tool").startAt'), startedAt);
    await openHost(hostA);
    await ui(`selectedSessionId === ${JSON.stringify(idA)} && busy`);
    await evaluate('stop.click(); switchMode("combat")');
    await ui('modeContext().mode === "combat" && input.value === "combat draft during tool"');
    await until(() => hostA.tasks.task.state === "stopped", "A stopped independently");
    assert.ok(hostB.busy, "stopping A cannot stop B's shell");
    await evaluate('switchMode("prep")');
    await openHost(hostB);
    await ui(`selectedSessionId === ${JSON.stringify(idB)} && toolCards.get("long-tool")?.card.classList.contains("running")`);
    const reloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await reloaded;
    await ui(`selectedSessionId === ${JSON.stringify(idB)} && toolCards.get("long-tool")?.card.classList.contains("running")`);
    assert.equal(await evaluate('toolCards.get("long-tool").startAt'), startedAt);
    assert.equal(readFileSync(toolStarted, "utf8"), "started\n");
    assert.deepEqual(requests, ["A", "B"], "switching and reload do not re-prompt or rerun the tool");
    writeFileSync(toolRelease, "release");
    await ui('!busy && messages.textContent.includes("B final result") && !toolCards.get("long-tool").card.classList.contains("running")');
    assert.equal(await evaluate('toolCards.get("long-tool").startAt'), startedAt);
    const timing = hostB.projection.snapshot().tools.find(tool => tool.toolCallId === "long-tool");
    const duration = ((timing.finishedAt - timing.startedAt) / 1000).toFixed(1) + "s";
    assert.equal(await evaluate('toolCards.get("long-tool").card.querySelector(".duration").textContent'), duration);
    const completedReload = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await completedReload;
    await ui('!busy && messages.textContent.includes("B final result") && !!toolCards.get("long-tool")');
    assert.equal(await evaluate('toolCards.get("long-tool").card.querySelector(".duration").textContent'), duration);
    finalExit = true; app.quit(); return;
  }
  await openHost(hostA);
  await ui(`selectedSessionId === ${JSON.stringify(idA)} && busy && messages.textContent.includes("A partial")`);
  assert.equal(await evaluate('document.querySelectorAll(".streaming").length'), 1);
  await openHost(hostB);
  await ui(`selectedSessionId === ${JSON.stringify(idB)} && busy && messages.textContent.includes("B partial")`);
  await evaluate('switchMode("combat")');
  await ui('modeContext().mode === "combat" && workspaceReady.has(selectedSessionId)');
  await evaluate('input.value = "combat draft"; input.dispatchEvent(new Event("input"));');
  streams.get("A").finish();
  await until(() => hostA.tasks.task.state === "completed", "background A completed");
  assert.equal(await evaluate("input.value"), "combat draft");
  await evaluate('switchMode("prep")');
  await ui(`selectedSessionId === ${JSON.stringify(idB)} && messages.textContent.includes("B partial")`);
  await openHost(hostA);
  await ui(`selectedSessionId === ${JSON.stringify(idA)} && !busy && messages.textContent.includes("A final result")`);
  assert.ok(hostB.busy);
  const reloaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
  window.reload(); await reloaded;
  await ui(`selectedSessionId === ${JSON.stringify(idA)} && messages.textContent.includes("A final result")`);
  assert.ok(hostB.busy && !streams.get("B").closed, "renderer reload preserves B execution");
  if (crashPhase === "seed") {
    writeFileSync(path.join(scratch, "crash-checkpoint.json"), JSON.stringify({ a: hostA.describeCurrent(), b: hostB.describeCurrent(), taskId: hostB.tasks.task.id }));
    console.log("READY FOR FORCED TERMINATION");
    return; // The runner kills this exact child while B's SDK stream remains active.
  }
  const prepRegistry = globalThis.__arcaneHosts.prep;
  const createHost = prepRegistry.createHost;
  prepRegistry.createHost = () => ({ start: async () => { throw new Error("injected replacement failure"); }, dispose() {} });
  try {
    const deleted = await evaluate(`window.arcane.deleteSession(${JSON.stringify(hostA.describeCurrent().path)}, modeContext())`);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.warning, "injected replacement failure");
  } finally { prepRegistry.createHost = createHost; }
  await evaluate('(async () => { const snapshot = await window.arcane.currentSession(); await installSnapshot(snapshot); })()');
  await ui(`selectedSessionId === ${JSON.stringify(idB)} && busy && messages.textContent.includes("B partial")`);
  assert.equal(prepRegistry.get(idB), hostB, "recovery must reuse the live background B, not overwrite it with a second SDK session");
  assert.ok(hostB.busy && !streams.get("B").closed);
  window.close();
  await until(() => prompts.length === 1, "cancel close prompt");
  await sleep(50);
  assert.ok(!window.isDestroyed() && hostB.busy);
  decision = 2; window.close();
  await until(() => prompts.length === 2, "background close prompt");
  await sleep(50);
  assert.equal(prompts[1].buttons.length, 3);
  assert.ok(!tray.isDestroyed() && !window.isVisible() && hostB.busy);
  let shows = 0;
  window.on("show", () => { shows++; });
  menu.items[0].click();
  assert.equal(shows, 1, "native menu callback restores window");
  tray.emit("click");
  assert.equal(shows, 2, "tray click callback restores window");
  decision = 1; finalExit = true;
  menu.items[1].click();
})().catch(async error => {
  console.error(error);
  if (longTool) {
    writeFileSync(toolRelease, "release after test failure");
    await Promise.allSettled(Object.values(globalThis.__arcaneHosts ?? {}).flatMap(registry => registry.allHosts()).map(host => host.abort(host.task?.id)));
  }
  server.close(); app.exit(1);
});
