import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
const executable=path.resolve(process.argv[2]??"apps/desktop/dist/win-unpacked/ArcaneDesk.exe");
const output=path.resolve(process.argv[3]??"apps/desktop/docs/trial-startup.png");
const scratch=process.argv[4] ? path.resolve(process.argv[4]) : mkdtempSync(path.join(tmpdir(),"arcane-packaged-smoke-"));
const reservation=net.createServer(); await new Promise(resolve=>reservation.listen(0,"127.0.0.1",resolve));
const port=reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
const env={...process.env, ARCANE_TELEMETRY_DISABLED:"1", ARCANE_SKILLS_UPDATE_BASE_URL:"http://127.0.0.1:1"};
for(const key of Object.keys(env))if(/API_KEY|TOKEN|SECRET|PASSWORD|ELECTRON_RUN_AS_NODE/.test(key))delete env[key];
const child=spawn(executable,[`--user-data-dir=${scratch}`,`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
let appLog=""; child.stdout.on("data",chunk=>{appLog+=chunk;});child.stderr.on("data",chunk=>{appLog+=chunk;});
let exited=false;child.on("exit",()=>{exited=true;}); let socket;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await sleep(80);}throw Error("Packaged startup timed out");}
try {
 let target;
 await until(async()=>{try{target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(tab=>tab.type==="page" && tab.url.split("?")[0].endsWith("/index.html"));return Boolean(target);}catch{return false;}});
 assert.ok(decodeURI(target.url).replaceAll("/","\\").toLowerCase().includes(path.dirname(executable).toLowerCase()));
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let serial=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const pair=pending.get(message.id);pending.delete(message.id);message.error?pair.reject(Error(message.error.message)):pair.resolve(message.result);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
 await until(async()=>{try{return await evaluate('typeof selectedSessionId !== "undefined" && workspaceReady.has(selectedSessionId) && !restoringView');}catch{return false;}});
 await evaluate('switchMode("combat")');
 await evaluate('switchMode("prep")');
 await until(async()=>await evaluate('currentMode === "prep" && workspaceReady.has(selectedSessionId)'));
 assert.equal(await evaluate('!!document.getElementById("chat-input") && !document.getElementById("shutdown-status")'),true);
 assert.ok(existsSync(path.join(scratch,"config/ui.json")),"packaged app must use the isolated userData profile");
 if(process.argv[4]) {
   assert.equal(await evaluate('(async()=>{const access=await window.arcane.getModelAccess(modeContext());return access.model?.providerId === "alibaba-token-plan" && access.model?.modelId === "qwen3.7-plus" && !access.missingKey;})()'),true,"trial model and protected credential must be usable");
 }
 const shot=await call("Page.captureScreenshot",{format:"png"});writeFileSync(output,Buffer.from(shot.data,"base64"));
 socket.close();socket=null;
 const browser=(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
 const control=new WebSocket(browser);await new Promise(resolve=>{control.onopen=resolve;});
 control.send(JSON.stringify({id:1,method:"Browser.close"}));
 await until(()=>exited);control.close();
 console.log("PASS packaged startup: actual executable, isolated profile, renderer ready, prep navigation and process exit");
} catch(error) { console.error(appLog.slice(-6000));throw error; } finally {socket?.close();if(!exited)child.kill();}
