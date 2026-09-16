// Opt-in real SDK acceptance against the user-assigned, disposable QA-A world.
// Never retries a dispatched write. The JSON report preserves receipts on failure.
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeFunction, runtimeHash } from "../../../packages/foundry-sdk/dist/runtime.js";
import { readFoundryImage } from "../src/main/foundry-assets.js";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
assert.ok(args.includes("--origin") && args.includes("--cdp-port") && args.includes("--world"));
const origin = option("--origin"), port = Number(option("--cdp-port")), worldId = option("--world");
assert.equal(origin, "http://127.0.0.1:30101");
assert.equal(port, 9231);
assert.equal(worldId, "cos-a");
const runId = `prep-play-${Date.now()}`;
const reportPath = join(tmpdir(), `${runId}.json`);
const report = { runId, origin, port, worldId, runtimeHash, checks: [], fixtures: {}, status: "running" };
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter(t => t.type === "page" && t.url === `${origin}/game`);
assert.equal(pages.length, 1, "exactly one QA-A game tab must be open");
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data), request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timer);
  if (message.error || message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
  else request.resolve(message.result?.result?.value);
});
const evaluate = expression => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: outcome unknown; do not retry write")); }, 60000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
});
const guard = `if(location.origin!==${JSON.stringify(origin)}||game.world.id!==${JSON.stringify(worldId)}||!game.ready||!game.user.isGM)throw Error("QA-A identity/GM guard failed");`;
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
async function call(action, input = {}) {
  const check = { action, started: new Date().toISOString(), state: "dispatched" };
  report.checks.push(check); await save();
  const start = performance.now();
  const result = await evaluate(`(async()=>{${guard}return await globalThis.__arcanePrepPlayQA(${JSON.stringify(action)},${JSON.stringify(input)},{});})()`);
  Object.assign(check, { state: "returned", ms: performance.now() - start, result }); await save();
  return result;
}
const complete = result => assert.equal(result.status, "completed", JSON.stringify(result));
const identity = suffix => ({ world: { origin, id: worldId }, requestId: `${runId}-${suffix}` });
try {
  report.environment = await evaluate(`(()=>{${guard}return {foundry:game.version,dnd5e:game.system.version,sceneUuid:canvas.scene?.uuid,combatIds:game.combats.contents.map(c=>c.id),modules:Array.from(game.modules.values()).filter(m=>m.active).map(m=>({id:m.id,version:m.version}))};})()`);
  await evaluate(`(()=>{${guard}globalThis.__arcanePrepPlayQA=(${runtimeFunction});return true;})()`);
  const status = await call("worldInfo"); assert.ok(status);
  const monsters = await call("contentSearch", { scope: "compendium", documentType: "Actor", query: "Wolf", packIds: ["dnd5e.monsters"], limit: 5 });
  assert.ok(monsters.entries.length);
  const source = monsters.entries.find(entry => entry.name === "Wolf"); assert.ok(source, "exact Wolf fixture");
  const created = await call("actorCreate", { ...identity("actor"), source: { kind: "compendium", packId: source.packId, entryId: source.entryId }, name: `${runId} NPC` });
  complete(created);
  const actorUuid = created.steps.find(s => s.step === "create-actor").targets[0];
  report.fixtures.actorUuid = actorUuid; await save();
  let actor = await call("actorRead", { actorUuid, include: ["items", "prototypeToken", "resources", "sceneTokens"] });
  complete(await call("actorEdit", { ...identity("rename"), actorUuid, readState: actor.readState, changes: { name: `${runId} Renamed`, prototypeToken: { name: `${runId} Token` } } }));
  const weapons = await call("contentSearch", { scope: "compendium", documentType: "Item", query: "", packIds: ["arcane-dnd5e-2014-automation.basicweapons"], limit: 5 });
  assert.ok(weapons.entries.length);
  const weapon = weapons.entries[0];
  actor = await call("actorRead", { actorUuid, include: ["items"] });
  const items = [{ packId: weapon.packId, entryId: weapon.entryId, quantity: 1, equipped: true }];
  complete(await call("actorGrantItems", { ...identity("grant"), actorUuid, readState: actor.readState, items }));
  actor = await call("actorRead", { actorUuid, include: ["items"] });
  const repeated = await call("actorGrantItems", { ...identity("grant-again"), actorUuid, readState: actor.readState, items }); complete(repeated);
  assert.equal(repeated.steps[0].skippedExisting.length, 1);
  const sceneResult = await call("sceneApply", { ...identity("scene"), operation: "create", scene: { name: runId, width: 2000, height: 1500, grid: { type: 1, size: 100, distance: 5, units: "ft" } }, tokens: { create: [{ actorUuid, x: 200, y: 200, actorLink: true }, { actorUuid, x: 400, y: 200, actorLink: false }] } });
  complete(sceneResult);
  const sceneUuid = sceneResult.steps.find(s => s.step === "create-scene").targets[0];
  report.fixtures.sceneUuid = sceneUuid; await save();
  let scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  assert.equal(scene.placeables.tokens.length, 2);
  const tokens = scene.placeables.tokens;
  complete(await call("sceneApply", { ...identity("layout"), operation: "update", sceneUuid, readState: scene.readState, tokens: { update: [{ tokenId: tokens[0].id, changes: { x: 300 } }], deleteIds: [tokens[1].id] } }));
  scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  assert.equal(scene.placeables.tokens.length, 1); assert.equal(scene.placeables.tokens[0].x, 300);
  complete(await call("sceneApply", { ...identity("activate"), operation: "update", sceneUuid, readState: scene.readState, scene: { active: true } }));
  // Viewing is QA setup; the product activation action above is separately asserted.
  await evaluate(`(async()=>{${guard}await (await fromUuid(${JSON.stringify(sceneUuid)})).view();return canvas.scene.uuid;})()`);
  const staticContext = await call("staticContext");
  assert.equal(staticContext.scope.sceneUuid, sceneUuid);
  assert.equal(staticContext.combatants.length, 1);
  const tokenUuid = scene.placeables.tokens[0].uuid;
  const conditionInput = { world: { origin, id: worldId }, mode: "combat", targets: [{ kind: "selected" }], selectedTokenUuids: [tokenUuid], conditions: [{ key: "prone", active: true }] };
  complete(await call("conditionsSet", conditionInput));
  const noop = await call("conditionsSet", conditionInput); complete(noop); assert.ok(noop.steps.every(s => s.noop));
  const dynamic = await call("playContext"); assert.equal(dynamic.contextRef, staticContext.contextRef);
  complete(await call("conditionsSet", { ...conditionInput, conditions: [{ key: "prone", active: false }] }));
  // Native fixture setup establishes known resource totals, not a product rest action.
  await evaluate(`(async()=>{${guard}const a=await fromUuid(${JSON.stringify(actorUuid)});await a.update({"system.spells.spell1.override":4,"system.spells.spell1.value":4,"system.spells.spell2.override":3,"system.spells.spell2.value":3});return true;})()`);
  actor = await call("actorRead", { actorUuid, include: ["items"] });
  complete(await call("actorGrantItems", { ...identity("spells"), actorUuid, readState: actor.readState, items: ["A3q2gTNqG6fvNGrv", "1nhIxh0DsJsntCfj"].map(entryId => ({ packId: "arcane-dnd5e-2014-automation.spells", entryId })) }));
  const spellStatic = await call("staticContext");
  for (const [pattern, pool, expectedBefore] of [["Disguise Self", "spell1", 4], ["Knock", "spell2", 3]]) {
    const caster = spellStatic.combatants.find(c => c.tokenUuid === tokenUuid);
    assert.ok(caster, "caster is in the Scene snapshot");
    const definition = caster.actions.find(a => (a.itemName ?? a.name).includes(pattern));
    assert.ok(definition, `${pattern} must be discoverable`);
    const result = await call("executeAction", { world: { origin, id: worldId }, contextRef: spellStatic.contextRef, turn: spellStatic.turn, resolution: "narrative", resolvedActions: [{ actionRef: definition.actionRef, actionId: definition.id, sourceTokenUuid: tokenUuid, actorUuid, itemId: definition.itemId, activityId: definition.activityId }] });
    complete(result);
    assert.equal(result.steps[0].pool, pool); assert.equal(result.steps[0].before, expectedBefore); assert.equal(result.steps[0].after, expectedBefore - 1);
    assert.equal((await call("playContext")).contextRef, spellStatic.contextRef);
  }
  const absent = await call("actorCreate", { ...identity("no-token"), source: { kind: "blank", actorType: "npc" }, name: `${runId} No Token` }); complete(absent);
  report.fixtures.noTokenActorUuid = absent.steps.find(s => s.step === "create-actor").targets[0]; await save();
  assert.equal((await call("staticContext")).combatants.length, 1, "world-only Actor must not enter Play scope");
  scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  complete(await call("sceneApply", { ...identity("image-unlinked"), operation: "update", sceneUuid, readState: scene.readState, tokens: { create: [{ actorUuid, x: 800, y: 600, actorLink: false, hidden: true, name: `${runId} Unlinked` }] } }));
  scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  const imageTokenUuids = scene.placeables.tokens.map(t => t.uuid);
  complete(await call("conditionsSet", { ...conditionInput, selectedTokenUuids: imageTokenUuids, conditions: [{ key: "poisoned", active: true }] }));
  complete(await call("conditionsSet", { ...conditionInput, selectedTokenUuids: imageTokenUuids, conditions: [{ key: "poisoned", active: false }] }));
  const imageLayoutBefore = await evaluate(`(async()=>{${guard}const a=await fromUuid(${JSON.stringify(actorUuid)});await a.update({"prototypeToken.ring.enabled":true});const tokens=canvas.scene.tokens.contents.filter(t=>t.actorId===a.id);for(const t of tokens)await t.update({"ring.enabled":true},{animate:false});return tokens.map(t=>({uuid:t.uuid,x:t.x,y:t.y,name:t.name,hidden:t.hidden,actorLink:t.actorLink}));})()`);
  // Generate an actual PNG, read through the host fence/decoder, then use FilePicker upload.
  const pngBase64 = await evaluate(`(()=>{${guard}const c=document.createElement("canvas");c.width=64;c.height=64;const x=c.getContext("2d");x.fillStyle="#385a7c";x.fillRect(0,0,64,64);return c.toDataURL("image/png").split(",")[1];})()`);
  const imageDir = await mkdtemp(join(tmpdir(), "prep-play-image-"));
  await writeFile(join(imageDir, "fixture.png"), Buffer.from(pngBase64, "base64"));
  const asset = await readFoundryImage({ cwd: imageDir, sourcePath: "fixture.png", decodeImage: async (bytes, mime) => evaluate(`(async()=>{${guard}const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}),c=>c.charCodeAt(0));const image=await createImageBitmap(new Blob([bytes],{type:${JSON.stringify(mime)}}));const size={width:image.width,height:image.height};image.close();return size;})()`) });
  const image = { dataPath: asset.dataPath, upload: { base64: asset.bytes.toString("base64"), hash: asset.hash, mimeType: asset.mimeType, extension: asset.extension }, syncPlacedTokens: true };
  report.fixtures.imageDataPath = image.dataPath;
  actor = await call("actorRead", { actorUuid, include: ["prototypeToken", "sceneTokens"] });
  complete(await call("actorEdit", { ...identity("image"), actorUuid, readState: actor.readState, changes: { image } }));
  actor = await call("actorRead", { actorUuid, include: ["prototypeToken", "sceneTokens"] });
  assert.equal(actor.img, image.dataPath);
  const imageReadback = await evaluate(`(()=>{${guard}return canvas.scene.tokens.contents.filter(t=>t.actorId===${JSON.stringify(actorUuid.split(".")[1])}).map(t=>({uuid:t.uuid,x:t.x,y:t.y,name:t.name,hidden:t.hidden,actorLink:t.actorLink,texture:t.toObject().texture.src,ring:t.toObject().ring.subject.texture}));})()`);
  assert.deepEqual(imageReadback.map(({texture,ring,...layout})=>layout), imageLayoutBefore);
  assert.ok(imageReadback.every(t => t.texture === image.dataPath && t.ring === image.dataPath));
  report.imageReadback = imageReadback;
  scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  complete(await call("sceneApply", { ...identity("background"), operation: "update", sceneUuid, readState: scene.readState, scene: { background: { dataPath: image.dataPath, upload: image.upload }, grid: { distance: 10 } } }));
  actor = await call("actorRead", { actorUuid, include: ["items"] });
  complete(await call("actorGrantItems", { ...identity("attack-spells"), actorUuid, readState: actor.readState, items: [
    { packId: "arcane-dnd5e-2014-automation.spells", entryId: "8dzaICjGy6mTUaUr" },
    { packId: "arcane-dnd5e-2014-automation.spells", entryId: "7buEm5KhI5lP8m1z" },
    { packId: "arcane-dnd5e-2014-automation.basicweapons", entryId: "3EE9A77945B5824F", equipped: true },
    { packId: "dnd5e.items", entryId: "3c7JXOzsv55gqJS5", quantity: 20 }
  ] }));
  report.concentrationFixture = await evaluate(`(async()=>{${guard}const a=await fromUuid(${JSON.stringify(actorUuid)});const item=a.items.find(i=>i.name.includes("Bless"));const effect=await a.beginConcentrating(item.system.activities.contents[0]);return {effectUuid:effect.uuid,before:a.concentration.effects.size};})()`);
  assert.equal(report.concentrationFixture.before, 1);
  complete(await call("conditionsSet", { ...conditionInput, conditions: [{ key: "concentrating", active: false }] }));
  assert.equal(await evaluate(`(()=>{${guard}return game.actors.get(${JSON.stringify(actorUuid.split(".")[1])}).concentration.effects.size;})()`), 0);
  const targetActor = report.fixtures.noTokenActorUuid;
  await evaluate(`(async()=>{${guard}const a=await fromUuid(${JSON.stringify(targetActor)});await a.update({"system.attributes.hp.value":500,"system.attributes.hp.max":500,"system.attributes.ac.calc":"flat","system.attributes.ac.flat":5});return true;})()`);
  scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  complete(await call("sceneApply", { ...identity("attack-target"), operation: "update", sceneUuid, readState: scene.readState, tokens: { create: [{ actorUuid: targetActor, x: 400, y: 200, actorLink: true, disposition: 1 }] }, scene: { grid: { distance: 5 } } }));
  scene = await call("sceneRead", { sceneUuid, include: ["tokens"] });
  const targetTokenUuid = scene.placeables.tokens.find(t => t.actorId === targetActor.split(".")[1]).uuid;
  const attackStatic = await call("staticContext");
  const attackSource = attackStatic.combatants.find(c => c.tokenUuid === tokenUuid);
  const bite = attackSource.actions.find(a => a.itemName === "Bite"); assert.ok(bite);
  // Grid changes redraw the canvas asynchronously; spatial QA starts after canvasReady.
  await evaluate(`(async()=>{${guard}if(!canvas.ready)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("QA canvasReady timeout")),15000);Hooks.once("canvasReady",()=>{clearTimeout(timer);resolve();});});if(!canvas.tokens.get(${JSON.stringify(tokenUuid.split(".").at(-1))}))throw Error("QA source is not rendered");return true;})()`);
  await evaluate(`(()=>{${guard}globalThis.__prepPlayAttackEvidence=[];globalThis.__prepPlayAttackHook=Hooks.on("midi-qol.RollComplete",w=>{if(w.actor?.uuid===${JSON.stringify(actorUuid)})__prepPlayAttackEvidence.push({item:w.item?.name,attackTotal:w.attackTotal,damageTotal:w.damageTotal,hits:Array.from(w.hitTargets??[]).map(t=>t.document.uuid),damageList:w.damageList?.map(d=>({tokenId:d.tokenId,oldHP:d.oldHP,newHP:d.newHP,appliedDamage:d.appliedDamage}))});});return true;})()`);
  report.attacks = [];
  for (const pattern of ["Bite", "Longbow", "Guiding Bolt"]) {
    const definition = attackSource.actions.find(a => a.itemName.includes(pattern)); assert.ok(definition, pattern);
    const before = await evaluate(`(()=>{${guard}const a=game.actors.get(${JSON.stringify(actorUuid.split(".")[1])});return {hp:game.actors.get(${JSON.stringify(targetActor.split(".")[1])}).system.attributes.hp.value,slot:a.system.spells.spell1.value,ammo:a.items.find(i=>i.name==="Arrow")?.system.quantity};})()`);
    const attackResult = await call("executeAction", { world: { origin, id: worldId }, contextRef: attackStatic.contextRef, turn: attackStatic.turn, resolvedActions: [{ actionRef: definition.actionRef, actionId: definition.id, sourceTokenUuid: tokenUuid, actorUuid, itemId: definition.itemId, activityId: definition.activityId, targetTokenUuids: [targetTokenUuid], input: { attackRollMode: "normal" } }] });
    complete(attackResult);
    const after = await evaluate(`(()=>{${guard}const a=game.actors.get(${JSON.stringify(actorUuid.split(".")[1])});return {hp:game.actors.get(${JSON.stringify(targetActor.split(".")[1])}).system.attributes.hp.value,slot:a.system.spells.spell1.value,ammo:a.items.find(i=>i.name==="Arrow")?.system.quantity,combatIds:game.combats.contents.map(c=>c.id),workflows:__prepPlayAttackEvidence};})()`);
    report.attacks.push({ pattern, before, after }); await save();
    assert.deepEqual(after.combatIds, report.environment.combatIds, "outside-combat attack must not create combat");
    assert.ok(after.workflows.length > 0, "completed requires native workflow evidence");
    const workflow = after.workflows.at(-1); assert.ok(workflow.item.includes(pattern));
    if (workflow.hits.includes(targetTokenUuid)) {
      assert.equal(after.hp, before.hp - workflow.damageTotal, "native damage matches actual target HP");
      assert.ok(workflow.damageList.some(d => d.oldHP === before.hp && d.newHP === after.hp));
    } else assert.equal(after.hp, before.hp, "miss does not change HP");
    if (pattern === "Guiding Bolt") assert.equal(after.slot, before.slot - 1);
    if (pattern === "Longbow") assert.equal(after.ammo, before.ammo - 1, "ranged attack consumes exactly one arrow");
  }
  await evaluate(`(()=>{${guard}Hooks.off("midi-qol.RollComplete",__prepPlayAttackHook);delete globalThis.__prepPlayAttackHook;return true;})()`);
  report.fixtures.combatUuid = await evaluate(`(async()=>{${guard}const c=await CONFIG.Combat.documentClass.create({scene:${JSON.stringify(sceneUuid.split(".")[1])},active:true,flags:{arcanedesk:{requestId:${JSON.stringify(runId)}}}});await c.createEmbeddedDocuments("Combatant",[{tokenId:${JSON.stringify(tokenUuid.split(".").at(-1))},actorId:${JSON.stringify(actorUuid.split(".")[1])},initiative:20},{tokenId:${JSON.stringify(targetTokenUuid.split(".").at(-1))},actorId:${JSON.stringify(targetActor.split(".")[1])},initiative:10}]);await c.startCombat();return c.uuid;})()`); await save();
  const combatStatic = await call("staticContext"); assert.equal(combatStatic.combatants.length, 2, "combat scope excludes the hidden nonparticipant");
  const combatDynamic = await call("playContext"); assert.equal(combatDynamic.contextRef, combatStatic.contextRef);
  const combatSource = combatStatic.combatants.find(c => c.tokenUuid === tokenUuid);
  const combatBite = combatSource.actions.find(a => a.itemName === "Bite");
  complete(await call("executeAction", { world: { origin, id: worldId }, contextRef: combatStatic.contextRef, turn: combatDynamic.turn, advance: true, resolvedActions: [{ actionRef: combatBite.actionRef, actionId: combatBite.id, sourceTokenUuid: tokenUuid, actorUuid, itemId: combatBite.itemId, activityId: combatBite.activityId, targetTokenUuids: [targetTokenUuid] }] }));
  const nextTurn = await call("playContext"); assert.equal(nextTurn.contextRef, combatStatic.contextRef); assert.notDeepEqual(nextTurn.turn, combatDynamic.turn);
  report.runtimeSamples = [];
  for (let n = 0; n < 10; n++) for (const action of n % 2 ? ["playContext", "turnContext"] : ["turnContext", "playContext"]) {
    const read = await call(action);
    report.runtimeSamples.push({ action, ms: report.checks.at(-1).ms, bytes: Buffer.byteLength(JSON.stringify(read)) });
  }
  report.status = "core-spells-images-concentration-attacks-passed";
} catch (error) {
  report.status = "failed"; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  try { await evaluate(`(()=>{${guard}if(globalThis.__prepPlayAttackHook!=null)Hooks.off("midi-qol.RollComplete",__prepPlayAttackHook);delete globalThis.__prepPlayAttackHook;return true;})()`); } catch { /* Preserve the original outcome; never retry a game write. */ }
  await save(); socket.close();
  console.log(JSON.stringify({ status: report.status, reportPath, fixtures: report.fixtures, error: report.error }, null, 2));
}
