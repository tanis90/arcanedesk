// Opt-in Prep-only fixture setup. Does not run combat scenarios or edit modules.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import targetFor from "./fixtures/prep-benchmark-target.cjs";
const option = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const target = targetFor(option("target", "qa-a"));
const runId = `prep-benchmark-fixture-${Date.now()}`;
const output = join(tmpdir(), `${runId}.json`);
const report = { runId, worldId: target.worldId, origin: target.origin, port: target.port, status: "prepared", fixtures: {} };
await writeFile(output, JSON.stringify(report, null, 2));
const pages = (await (await fetch(`http://127.0.0.1:${target.port}/json/list`)).json()).filter(page => page.type === "page" && page.url === `${target.origin}/game`);
assert.equal(pages.length, 1, "Exactly one authenticated target /game tab is required");
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let serial = 0;
const evaluate = expression => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(Error("Fixture result uncertain; inspect before any retry")); }, 60000);
  const receive = event => {
    const reply = JSON.parse(event.data); if (reply.id !== id) return;
    clearTimeout(timer); socket.removeEventListener("message", receive);
    if (reply.error || reply.result?.exceptionDetails) reject(Error("Fixture execution failed; inspect marked objects before retry"));
    else resolve(reply.result.result.value);
  };
  socket.addEventListener("message", receive);
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});
const guard = `if(location.origin!==${JSON.stringify(target.origin)}||game.world.id!==${JSON.stringify(target.worldId)}||!game.ready||!game.user.isGM)throw Error("Wrong world or GM unavailable");`;
try {
  report.environment = await evaluate(`(()=>{${guard}return {foundry:game.version,system:game.system.version,world:game.world.id,originalSceneId:canvas.scene?.id??null,originalActiveSceneId:game.scenes.active?.id??null,modules:game.modules.filter(m=>m.active).map(m=>({id:m.id,version:m.version}))};})()`);
  report.status = "dispatching"; await writeFile(output, JSON.stringify(report, null, 2));
  report.fixtures = await evaluate(`(async()=>{${guard}
    const run=${JSON.stringify(runId)}, flags={arcanedesk:{requestId:run}};
    if(game.actors.some(a=>a.flags.arcanedesk?.requestId===run)||game.scenes.some(s=>s.flags.arcanedesk?.requestId===run))throw Error("Fixture already exists");
    const actor=await Actor.create({name:run+" source",type:"npc",flags});
    const target=await Actor.create({name:run+" target",type:"npc",flags});
    const scene=await Scene.create({name:run,width:2000,height:1500,active:false,flags});
    await scene.view();
    return {actorUuid:actor.uuid,noTokenActorUuid:target.uuid,sceneUuid:scene.uuid};
  })()`);
  report.status = "completed";
} catch (error) {
  report.status = "failed"; report.error = error.message; process.exitCode = 1;
} finally {
  socket.close(); await writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: report.status, output }));
}
