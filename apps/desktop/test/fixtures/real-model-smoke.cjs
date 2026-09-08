const { app } = require("electron");
const { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const sourceProfile = process.argv.find(arg => arg.startsWith("--profile="))?.slice(10);
const reportPath = process.argv.find(arg => arg.startsWith("--report="))?.slice(9);
assert.ok(sourceProfile && reportPath, "Explicit credential profile and report path required");
const scratch = mkdtempSync(path.join(tmpdir(), "arcane-real-model-"));
const config = JSON.parse(readFileSync(path.join(sourceProfile, "config/providers.json"), "utf8"));
const provider = config.providers.find(row => row.id === "alibaba-token-plan");
assert.ok(provider?.apiKeyProtected, "Configured protected Token Plan credential required");
mkdirSync(path.join(scratch, "config"));
copyFileSync(path.join(sourceProfile, "Local State"), path.join(scratch, "Local State"));
writeFileSync(path.join(scratch, "config/providers.json"), JSON.stringify({ providers:[provider], selectedModel:{providerId:provider.id, modelId:"qwen3.7-plus"} }));
writeFileSync(path.join(scratch, "config/ui.json"), JSON.stringify({mode:"prep"}));
app.setPath("userData", scratch); app.disableHardwareAcceleration();
for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)) delete process.env[key];
Object.assign(process.env, {PI_CODING_AGENT_DIR:path.join(scratch,"agent"), LOCALAPPDATA:path.join(scratch,"local"),
  APPDATA:path.join(scratch,"roaming"), USERPROFILE:scratch, ARCANE_TELEMETRY_DISABLED:"1", ARCANE_SKILLS_UPDATE_BASE_URL:"http://127.0.0.1:1"});
let window;
app.on("browser-window-created", (_event, value) => { window=value; value.hide(); value.on("show",()=>value.hide()); value.webContents.setBackgroundThrottling(false); });
const report = {startedAt:new Date().toISOString(), model:"qwen3.7-plus", provider:provider.id, endpoint:provider.baseUrl,
  scope:"Production renderer/preload/main/TaskCoordinator/Pi SDK/real provider, native read tool, DOM and conversation file", checks:[]};
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(check) {
  const end=Date.now()+90000;
  while(Date.now()<end) {if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}
  throw Error("Real model acceptance timed out");
}
(async()=>{
  await import(pathToFileURL(path.resolve(__dirname,"../../src/main/main.js")));
  await until(async()=>{try{return await evaluate('typeof selectedSessionId !== "undefined" && workspaceReady.has(selectedSessionId)');}catch{return false;}});
  await evaluate('switchMode("prep")');
  await until(async()=>await evaluate('currentMode === "prep" && workspaceReady.has(selectedSessionId) && !restoringView'));
  const host=globalThis.__arcaneHosts.prep.activeHost;
  assert.deepEqual(host.currentModelRef(),{providerId:provider.id,modelId:"qwen3.7-plus"});
  async function run(name,prompt,expected,toolRequired=false) {
    const events=[], original=host.emit;
    host.emit=function(event){events.push(event);return original.call(this,event);};
    const previous=host.task?.id, started=Date.now();
    try {
      await evaluate(`input.value=${JSON.stringify(prompt)}; pendingImages=[]; send.click();`);
      await until(()=>host.task?.id && host.task.id!==previous && !host.busy && !host.tasks.run);
      await until(async()=>await evaluate(`displayedTask?.id === ${JSON.stringify(host.task.id)} && !busy`));
      const visibleCode=`[...messages.querySelectorAll(".msg.assistant")].some(node=>node.textContent.includes(${JSON.stringify(expected)}))`;
      const renderDeadline=Date.now()+3000;
      while(Date.now()<renderDeadline && !await evaluate(visibleCode))await new Promise(resolve=>setTimeout(resolve,30));
      const records=readFileSync(host.describeCurrent().path,"utf8").trim().split("\n").map(line=>JSON.parse(line));
      const answers=records.filter(row=>row.type==="message" && row.message.role==="assistant").map(row=>row.message.content.filter(part=>part.type==="text").map(part=>part.text).join(""));
      const check={name,elapsedMs:Date.now()-started,state:host.task.state,deltas:events.filter(e=>e.type==="message_delta").length,
        toolNames:[...new Set(events.filter(e=>e.type==="tool_start").map(e=>e.toolName))],
        toolStarts:events.filter(e=>e.type==="tool_start").length,toolEnds:events.filter(e=>e.type==="tool_end").length,
        expectedVisible:await evaluate(`[...messages.querySelectorAll(".msg.assistant")].some(node=>node.textContent.includes(${JSON.stringify(expected)}))`),
        expectedInAnswer:answers.some(text=>text.includes(expected)), expectedInHistoryFile:answers.some(text=>text.includes(expected))};
      report.checks.push(check);
      assert.equal(check.state,"completed"); assert.ok(check.deltas>0 && check.expectedVisible && check.expectedInAnswer, JSON.stringify({...check, rendered:await evaluate('[...messages.querySelectorAll(".msg.assistant .body")].map(node=>node.textContent)')}));
      if(toolRequired)assert.ok(check.toolNames.includes("read") && check.toolStarts>0 && check.toolEnds>0);
    } finally {host.emit=original;}
  }
  await run("real_streamed_text","计算 19 + 23，只回复结果数字，不要调用工具。","42");
  const probe=path.join(scratch,"read-probe.txt"); writeFileSync(probe,"ARCANE_REAL_READ_7f28c1");
  await run("real_read_tool_roundtrip",`Call the read tool with path ${probe} now. The file contains a random verification token that you cannot know without the tool. Do not guess, invent, or reuse an example token. After the tool returns, reply with its exact contents only. A response without a real read tool call fails this test.`,"ARCANE_REAL_READ_7f28c1",true);
  report.actualModel=host.currentModelRef().modelId; report.actualProvider=host.currentModelRef().providerId;
  report.ok=true; report.finishedAt=new Date().toISOString();
  report.limitations=["One sample per case; elapsed time is not P95 or time-to-first-token", "No real Foundry world interaction or physical desktop clicks", "Runs in an isolated profile with copied encrypted credentials and matching Local State"];
  writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n"); console.log("PASS real qwen3.7-plus: streamed text and native read tool roundtrip"); app.quit();
})().catch(error=>{console.error(error.message);app.exit(1);});
