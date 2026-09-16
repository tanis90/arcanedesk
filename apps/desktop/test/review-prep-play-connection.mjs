// Opt-in QA-A reconnect observations, separate from the warm model benchmark.
// Reloads an already authenticated QA page; this is not an empty-browser-cache
// or fresh-server benchmark, and it never starts or stops a Foundry server.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const origin = "http://127.0.0.1:30101";
assert.ok(process.argv.includes("--qa-a-reload"), "explicit --qa-a-reload is required");
const pages = (await (await fetch("http://127.0.0.1:9231/json/list")).json()).filter(p=>p.type==="page"&&p.url===`${origin}/game`);
assert.equal(pages.length, 1);
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
let sequence = 0; const pending = new Map();
socket.addEventListener("message",event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);if(m.error||m.result?.exceptionDetails)p.reject(Error("QA read unavailable during navigation"));else p.resolve(m.result?.result?.value);});
const evaluate = expression => new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error("QA CDP timed out"));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));});
const runId=`prep-play-reconnect-${Date.now()}`, output=join(tmpdir(),`${runId}.json`);
const report={runId,status:"running",origin,world:"cos-a",observations:[],kind:"authenticated page reconnect; existing browser cache; warm Docker server; no model requests"};
const save=()=>writeFile(output,JSON.stringify(report,null,2));
const ready = epoch => `(()=>{if(location.origin!==${JSON.stringify(origin)})throw Error("QA origin mismatch");return {ready:!!globalThis.game?.ready&&game.world?.id==="cos-a"&&game.user?.isGM===true&&!!globalThis.canvas?.ready&&globalThis.__qaConnectionEpoch!==${JSON.stringify(epoch)},path:location.pathname};})()`;
try {
  assert.equal((await evaluate(ready("initial"))).ready,true); await save();
  for(let i=0;i<10;i++) {
    const row={sample:i,state:"reload-dispatched"};report.observations.push(row);await save();
    const epoch=`${runId}-${i}`, start=performance.now();
    // A single navigation dispatch per sample. Poll only reads; never replay a
    // reload or game write after an ambiguous response.
    await evaluate(`(()=>{if(location.origin!==${JSON.stringify(origin)}||game.world.id!=="cos-a")throw Error("QA guard");globalThis.__qaConnectionEpoch=${JSON.stringify(epoch)};setTimeout(()=>location.reload(),0);return true;})()`);
    let connected=false;
    while(performance.now()-start<45000) {
      await new Promise(resolve=>setTimeout(resolve,250));
      try { const state=await evaluate(ready(epoch)); if(state.path==="/join")throw Error("QA login required");if(state.ready){connected=true;break;} }
      catch(error){if(error.message==="QA login required")throw error;}
    }
    assert.ok(connected,"reconnect did not reach ready GM canvas");row.reconnectMs=performance.now()-start;
    const warm=performance.now();assert.equal((await evaluate(ready(epoch))).ready,true);row.warmReadyReadMs=performance.now()-warm;
    row.state="ready";await save();
  }
  report.status="passed";
} catch(error){report.status="failed";report.error=String(error.message);process.exitCode=1;}
finally {await save();socket.close();console.log(JSON.stringify({status:report.status,output,error:report.error}));}
