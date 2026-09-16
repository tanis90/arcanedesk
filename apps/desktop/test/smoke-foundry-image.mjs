// Real tool -> service -> runtime smoke. Only run-marked fixtures are mutated.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { FoundryServices } from "../src/main/foundry-services.js";
import { createFoundryTools } from "../src/main/foundry-tools.js";
import targetFor from "./fixtures/prep-benchmark-target.cjs";
const target = targetFor(process.argv.find(a => a.startsWith("--target="))?.slice(9) ?? "qa-a");
const runId = `image-smoke-${Date.now()}`, directory = await mkdtemp(path.join(tmpdir(), runId));
const output = path.join(directory, "report.json"), report = { runId, target, status: "running" };
const save = () => writeFile(output, JSON.stringify(report, null, 2));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
let asset = fileURLToPath(new URL("./fixtures/prep-benchmark-assets/benchmark20260508180804.jpg", import.meta.url));
if (process.argv.includes("--fresh-image")) {
  // A new valid PNG test fixture, independent of the user's image, forces upload
  // rather than relying only on a previously stored content-addressed asset.
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const b of body) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), check = Buffer.alloc(4); length.writeUInt32BE(bytes.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(4, 0); header.writeUInt32BE(4, 4); header[8] = 8; header[9] = 6;
  const seed = createHash("sha256").update(runId).digest(), pixels = Buffer.alloc(4 * 17);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const p = y * 17 + 1 + x * 4; seed.copy(pixels, p, (x + y) * 3, (x + y) * 3 + 3); pixels[p + 3] = 255; }
  asset = path.join(directory, "fresh.png");
  await writeFile(asset, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
}
const source = await readFile(path.join(repo, "packages/foundry-sdk/src/runtime-source.ts"), "utf8");
const runtime = JSON.parse(source.match(/export const runtimeFunction: string = (.*);/)[1]);
const pages = (await (await fetch(`http://127.0.0.1:${target.port}/json/list`)).json()).filter(p => p.url === `${target.origin}/game`);
assert.equal(pages.length, 1);
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let seq = 0; const pending = new Map();
socket.onmessage = event => {
  const reply = JSON.parse(event.data), p = pending.get(reply.id); if (!p) return;
  pending.delete(reply.id); clearTimeout(p.timer);
  if (reply.error || reply.result?.exceptionDetails) p.reject(Error("Page evaluation failed; retain marked fixtures"));
  else p.resolve(reply.result.result.value);
};
const evaluate = code => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error("Uncertain page call; no replay")); }, 60000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { returnByValue: true, awaitPromise: true,
    expression: `(()=>{if(location.origin!==${JSON.stringify(target.origin)}||game.world.id!==${JSON.stringify(target.worldId)}||!game.ready||!game.user.isGM)throw Error('World guard');})();\n${code}` } }));
});
try {
  await save();
  report.fixture = await evaluate(`(async()=>{
    const name=${JSON.stringify(runId)},flags={arcanedesk:{imageSmoke:name}};
    const actor=await Actor.create({name,type:'npc',flags});
    const item=await Item.create({name,type:'weapon',flags});
    const [embedded]=await actor.createEmbeddedDocuments('Item',[{name,type:'weapon',flags}]);
    const journal=await JournalEntry.create({name,flags,pages:[{name:'Image',type:'image'},{name:'Text',type:'text',text:{content:'Keep this text'}}]});
    const scene=await Scene.create({name,flags,active:false,width:1000,height:1000,grid:{type:1,size:100}});
    await scene.createEmbeddedDocuments('Token',await Promise.all([true,false].map(async(actorLink,i)=>(await actor.getTokenDocument({actorLink,x:100+i*200,y:100,name:'Keep '+i})).toObject())));
    return {actorUuid:actor.uuid,itemUuid:item.uuid,embeddedUuid:embedded.uuid,journalUuid:journal.uuid,pageUuid:journal.pages.find(p=>p.type==='image').uuid,textUuid:journal.pages.find(p=>p.type==='text').uuid,sceneUuid:scene.uuid,originalScene:canvas.scene?.uuid,tokens:scene.tokens.map(t=>({id:t.id,name:t.name,x:t.x,y:t.y,width:t.width,height:t.height}))};
  })()`); await save();
  let locked = false, calls = 0;
  const lease = async fn => { assert.equal(locked, false); locked = true; try { return await fn(); } finally { locked = false; } };
  const service = new FoundryServices({ sessionId: runId, directory, mode: "prep", getCwd: () => path.dirname(asset),
    withPage: (_signal, fn) => lease(fn), withAssets: (_cwd, _signal, fn) => lease(fn),
    decodeImage: async (bytes, mime) => evaluate(`(async()=>{const b=Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}),c=>c.charCodeAt(0));const img=await createImageBitmap(new Blob([b],{type:${JSON.stringify(mime)}}));const out={width:img.width,height:img.height};img.close();return out;})()`),
    call: async (action, args) => { assert.equal(locked, true); calls++; return evaluate(`(${runtime})(${JSON.stringify(action)},${JSON.stringify(args)},{})`); } });
  const binding = { taskId: runId, metadata: Promise.resolve({ world: { origin: target.origin, id: target.worldId } }) };
  const tool = createFoundryTools({ taskCoordinator: () => ({ currentInputBinding: () => binding }), maybeRequestApproval: async () => true, foundryServices: () => service }).find(t => t.name === "foundry_image");
  const invoke = async (id, params) => (await tool.execute(id, params)).details;
  report.upload = await invoke("upload", { sourcePath: asset }); assert.equal(report.upload.status, "completed");
  if (process.argv.includes("--fresh-image")) assert.equal(report.upload.steps.find(s => s.step === "upload-image").reused, undefined);
  const callCount = calls;
  assert.deepEqual(await invoke("upload", { sourcePath: asset }), report.upload); assert.equal(calls, callCount);
  const dataPath = report.upload.dataPath; assert.ok(dataPath.startsWith("arcanedesk/assets/"));
  report.applied = [];
  for (const targetUuid of [report.fixture.actorUuid, report.fixture.itemUuid, report.fixture.embeddedUuid, report.fixture.pageUuid]) {
    const result = await invoke(targetUuid, { dataPath, targetUuid, ...(targetUuid === report.fixture.actorUuid ? { syncPlacedTokens: true } : {}) });
    report.applied.push(result); assert.equal(result.status, "completed");
  }
  report.textPage = await invoke("text-page", { dataPath, targetUuid: report.fixture.textUuid }); assert.equal(report.textPage.status, "rejected");
  report.verified = await evaluate(`(async()=>{const f=${JSON.stringify(report.fixture)},img=${JSON.stringify(dataPath)};
    const actor=await fromUuid(f.actorUuid),scene=await fromUuid(f.sceneUuid),item=await fromUuid(f.itemUuid),embedded=await fromUuid(f.embeddedUuid),page=await fromUuid(f.pageUuid),text=await fromUuid(f.textUuid);
    const bytes=await(await fetch(img,{cache:'no-store'})).arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
    return {hash,actor:actor.img===img&&actor.prototypeToken.texture.src===img,item:item.img===img,embedded:embedded.img===img,journal:page.src===img,textPreserved:text.text.content==='Keep this text',tokens:scene.tokens.contents.every(t=>t.toObject().texture.src===img&&f.tokens.some(p=>p.id===t.id&&['name','x','y','width','height'].every(k=>p[k]===t[k]))),sceneUnchanged:canvas.scene?.uuid===f.originalScene};})()`);
  assert.equal(report.verified.hash, createHash("sha256").update(await readFile(asset)).digest("hex"));
  assert.ok(Object.entries(report.verified).filter(([k]) => k !== "hash").every(([,v]) => v === true));
  await evaluate(`(async()=>{for(const uuid of ${JSON.stringify([report.fixture.sceneUuid, report.fixture.journalUuid, report.fixture.itemUuid, report.fixture.actorUuid])}){const d=await fromUuid(uuid);if(d?.flags.arcanedesk?.imageSmoke!==${JSON.stringify(runId)})throw Error('Ownership changed');await d.delete();}})()`);
  report.cleaned = true; report.status = "completed";
} catch (error) { report.status = "failed"; report.error = error.message; process.exitCode = 1; }
finally { await save(); socket.close(); console.log(JSON.stringify({ output, status: report.status, verified: report.verified, error: report.error })); }
