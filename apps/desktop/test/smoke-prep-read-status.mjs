// Real COS/QA smoke for read tools and manual status removal not forced by model prompts.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import targetFor from "./fixtures/prep-benchmark-target.cjs";
const option = (n, fallback) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? fallback;
const target = targetFor(option("target", "qa-a"));
const fixture = JSON.parse(await readFile(option("qa-report"), "utf8"));
assert.equal(fixture.worldId, target.worldId);
const source = await readFile(new URL("../../../packages/foundry-sdk/src/runtime-source.ts", import.meta.url), "utf8");
const runtime = JSON.parse(source.match(/export const runtimeFunction: string = (.*);/)[1]);
const pages = (await (await fetch(`http://127.0.0.1:${target.port}/json/list`)).json()).filter(p => p.url === `${target.origin}/game`);
assert.equal(pages.length, 1);
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const runId = `prep-read-status-${Date.now()}`, output = join(tmpdir(), `${runId}.json`);
const report = { runId, target, status: "dispatching", fixtureRun: fixture.runId };
await writeFile(output, JSON.stringify(report, null, 2));
try {
  report.result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Smoke uncertain; inspect run-marked objects before retry")), 60000);
    ws.onmessage = event => {
      const reply = JSON.parse(event.data); if (reply.id !== 1) return;
      clearTimeout(timer);
      if (reply.error || reply.result?.exceptionDetails) reject(Error("Smoke failed; inspect run-marked objects before retry"));
      else resolve(reply.result.result.value);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true, awaitPromise: true, expression: `(async()=>{
      if(location.origin!==${JSON.stringify(target.origin)}||game.world.id!==${JSON.stringify(target.worldId)}||!game.ready||!game.user.isGM||canvas.scene?.uuid!==${JSON.stringify(fixture.fixtures.sceneUuid)})throw Error("Target changed");
      const run=${runtime}, requestId=${JSON.stringify(runId)}, scene=canvas.scene;
      const world=await run("worldInfo",{},{});
      const actor=await Actor.create({name:requestId,type:"npc",flags:{arcanedesk:{requestId}}});
      const token=await scene.createEmbeddedDocuments("Token",[(await actor.getTokenDocument({x:100,y:100,actorLink:true,flags:{arcanedesk:{requestId}}})).toObject()]);
      const light=await run("playContext",{},{}), heavy=await run("staticContext",{},{});
      const input={mode:"prep",world:{origin:location.origin,id:game.world.id},targets:[{kind:"actor",actorUuid:actor.uuid}]};
      const add=await run("conditionsSet",{...input,conditions:[{key:"prone",active:true}]},{});
      const present=actor.statuses.has("prone");
      const remove=await run("conditionsSet",{...input,conditions:[{key:"prone",active:false}]},{});
      const absent=!actor.statuses.has("prone");
      const repeat=await run("conditionsSet",{...input,conditions:[{key:"prone",active:false}]},{});
      const result={worldReady:world.ready,lightSeesToken:light.combatants?.some(t=>t.tokenUuid===token[0].uuid),sameContext:light.contextRef===heavy.contextRef,lightOmitsActions:light.combatants?.every(t=>!("actions" in t)),present,absent,add:add.status,remove:remove.status,repeat:repeat.status};
      result.ok=result.worldReady&&result.lightSeesToken&&result.sameContext&&result.lightOmitsActions&&present&&absent&&[add,remove,repeat].every(r=>r.status==="completed");
      if(token[0].flags.arcanedesk?.requestId!==requestId||actor.flags.arcanedesk?.requestId!==requestId)throw Error("Ownership changed");
      await scene.deleteEmbeddedDocuments("Token",[token[0].id]);await actor.delete();result.cleaned=true;return result;
    })()` } }));
  });
  report.status = report.result.ok ? "completed" : "failed";
  if (!report.result.ok) process.exitCode = 1;
} catch (error) { report.status = "failed"; report.error = error.message; process.exitCode = 1; }
finally { ws.close(); await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report })); }
