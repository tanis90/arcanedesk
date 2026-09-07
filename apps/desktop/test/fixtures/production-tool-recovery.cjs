const assert = require("node:assert/strict");
const path = require("node:path");
const { readFileSync } = require("node:fs");
const artifactName = "confirmed-tool-artifact.txt";
exports.respond = ({ data, entry, write, res, scratch, psLiteral }) => {
  const failed = data.messages.find(row => row.role === "tool" && row.tool_call_id === "failed-shell");
  const saved = data.messages.find(row => row.role === "tool" && row.tool_call_id === "saved-artifact");
  const call = (id, command) => {
    write({ tool_calls: [{ index: 0, id, type: "function", function: { name: "powershell", arguments: JSON.stringify({ command, timeout: 30 }) } }] });
    write({}, "tool_calls"); res.end("data: [DONE]\n\n");
  };
  if (saved) { assert.ok(JSON.stringify(saved.content).includes("ARTIFACT SAVED")); return; }
  if (failed) {
    assert.ok(JSON.stringify(failed.content).includes("CONTROLLED TOOL FAILURE"));
    entry.recover = () => call("saved-artifact", `[IO.File]::WriteAllText(${psLiteral(path.join(scratch, artifactName))}, 'confirmed result'); Write-Output 'ARTIFACT SAVED'`);
  } else call("failed-shell", "Write-Output 'CONTROLLED TOOL FAILURE'; exit 1");
};
exports.verify = async ({ hostA, hostB, streams, scratch, window, evaluate, ui, until }) => {
  const taskId = hostB.tasks.task.id;
  await ui('toolCards.get("failed-shell")?.card.classList.contains("err")');
  await until(() => Boolean(streams.get("B").recover), "SDK receives actual failed shell result");
  assert.equal(hostB.tasks.task.state, "running");
  assert.ok(await evaluate('busy && displayedTask.state === "running"'));
  streams.get("B").recover();
  await ui('toolCards.get("saved-artifact")?.card.classList.contains("ok")');
  await until(() => !streams.get("B").closed && !streams.get("B").recover, "SDK continues after successful recovery tool");
  assert.equal(hostB.tasks.task.id, taskId);
  assert.equal(readFileSync(path.join(scratch, artifactName), "utf8"), "confirmed result");
  let heldPage;
  if (process.argv.includes("--slow-stop")) {
    const { WebContentsView } = require("electron");
    const { pathToFileURL } = require("node:url");
    const { evaluateNavigationSafe } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/foundry-web.js")));
    heldPage = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
    await heldPage.webContents.loadURL("data:text/html,<title>Isolated pending operation</title>");
    const result = await hostB.resources.run(["foundry:page"], { sessionId: hostB.describeCurrent().id, taskId }, null, () => {}, () =>
      evaluateNavigationSafe(heldPage.webContents, "new Promise(resolve => { window.finishOperation = () => { document.body.textContent = 'operation finished'; resolve(true); }; })", { timeoutMs: 30 }));
    assert.equal(result.status, "timeout");
  }
  await evaluate('stop.click()');
  if (heldPage) {
    await ui('busy && displayedTask.state === "stopping" && taskIndicator.textContent === t("chat.task.stoppingOperation", {resource:"Foundry"})');
    assert.equal(hostB.tasks.task.state, "stopping");
    const restored = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
    window.reload(); await restored;
    await ui('busy && displayedTask?.state === "stopping" && taskIndicator.textContent === t("chat.task.stoppingOperation", {resource:"Foundry"})');
    assert.ok(hostA.busy && !streams.get("A").closed);
    await heldPage.webContents.executeJavaScript("finishOperation(); true");
    assert.equal(await heldPage.webContents.executeJavaScript("document.body.textContent"), "operation finished");
    heldPage.webContents.close();
    console.log("PASS production slow stop: actual pending page operation, resource explanation and reload before release");
  }
  await ui('!busy && displayedTask.state === "stopped"');
  assert.ok(hostA.busy && !streams.get("A").closed);
  assert.equal(readFileSync(path.join(scratch, artifactName), "utf8"), "confirmed result");
  const loaded = new Promise(resolve => window.webContents.once("did-finish-load", resolve));
  window.reload(); await loaded;
  await ui('displayedTask?.state === "stopped" && toolCards.get("failed-shell")?.card.classList.contains("err") && toolCards.get("saved-artifact")?.card.classList.contains("ok")');
  assert.equal(readFileSync(path.join(scratch, artifactName), "utf8"), "confirmed result");
  streams.get("A").finish();
  await until(() => !hostA.busy, "independent A completes");
};
