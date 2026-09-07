// Opt-in real-world protocol checks. Fault injection is in the QA transport,
// never in the automation package, its source, or its installed world Items.
module.exports = async function edgeCases({ evaluate, sourceId, combatId, fixture, report, save, root, runId, revision, replayReport }) {
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const { FoundryServices } = await import(pathToFileURL(path.resolve(__dirname, "../../src/main/foundry-services.js")));
  const { actionIdV2, fnv1a64Hex } = await import("@arcanedesk/foundry-sdk/runtime-helpers");
  const world = { origin: "http://127.0.0.1:30101", id: "cos-a" };
  if (replayReport) {
    const previous = JSON.parse(require("node:fs").readFileSync(replayReport,"utf8"));
    assert.equal(previous.status, "edge-cases-passed"); assert.equal(previous.fixtureRun, fixture.runId);
    const context = previous.edgeCases.filter(row=>row.action === "staticContext").at(-1).result;
    const source = context.combatants.find(t=>t.actorUuid===`Actor.${sourceId}`&&!t.name.includes("Unlinked"));
    const spell = source.actions.find(a=>(a.itemName??a.name).includes("Disguise Self"));
    let dispatches = 0;
    const service = new FoundryServices({ sessionId: previous.runId, directory: path.join(root,previous.runId,"fault-operations"),mode:"combat",
      withPage:async(_signal,operation)=>operation(),call:async()=>{dispatches++;throw Error("Replay must not access Runtime");} });
    const result = await service.executeAction({ actionRef:spell.actionRef,resolution:"narrative" },
      {taskId:previous.runId,metadata:Promise.resolve({world})},"lost-reply");
    assert.equal(result.status,"indeterminate"); assert.equal(dispatches,0);
    assert.equal(await evaluate(`game.actors.get(${JSON.stringify(sourceId)}).system.spells.spell1.value`),3);
    report.afterPageReload={originalRun:previous.runId,status:result.status,dispatches,slotValue:3};
    report.status="reload-replay-passed";save();return;
  }
  report.edgeCases = [];
  const call = async (action, input = {}) => {
    const row = { action, status: "dispatched" }; report.edgeCases.push(row); save();
    const result = await evaluate(`(async()=>{return await (${revision.runtimeSource})(${JSON.stringify(action)},${JSON.stringify(input)},{});})()`);
    row.status = "returned"; row.result = result; save(); return result;
  };
  const actorUuid = `Actor.${sourceId}`;
  const read = await call("actorRead", { actorUuid, include: ["items"] });
  const granted = await call("actorGrantItems", { actorUuid, world, requestId: `${runId}-summon`, readState: read.readState,
    items: [{ packId: "arcane-dnd5e-2014-automation.spells", entryId: "exBreA0aIOBCV2hi", expectedName: "野兽召唤术 Summon Beast (TCE)", expectedType: "spell" }] });
  assert.equal(granted.status, "completed");
  const original = await evaluate(`(()=>{const c=game.combats.get(${JSON.stringify(combatId)});if(c.flags.arcanedesk?.requestId!==${JSON.stringify(fixture.runId)})throw Error("Combat ownership mismatch");return {round:c.round,turn:c.turn};})()`);
  for (const combat of [false, true]) {
    await evaluate(`(async()=>{await game.combats.get(${JSON.stringify(combatId)}).update({round:${combat ? 1 : 0},turn:${combat ? 0 : "null"}});return true;})()`);
    const context = await call("staticContext");
    const source = context.combatants.find(t=>t.actorUuid===actorUuid && !t.name.includes("Unlinked")); assert.ok(source);
    let spell = source.actions.find(a=>(a.itemName ?? a.name).includes("Summon Beast"));
    if (!spell) {
      // This frozen pack lacks a recognized nativeSummon marker, so the model
      // cannot discover the spell. Also test the SDK's explicit type gate using
      // exact native identities; do not add a marker or change the world Item.
      report.summonDiscovery = "not exposed by this installed pack";
      const native = await evaluate(`(()=>{const i=game.actors.get(${JSON.stringify(sourceId)}).items.find(i=>i.name.includes("Summon Beast"));const a=i.system.activities.contents.find(a=>a.type==="summon");return {itemId:i.id,activityId:a.id};})()`);
      const id = actionIdV2(source.actorUuid, native.itemId, native.activityId);
      spell = { ...native, id, actionRef: "play:v1:" + fnv1a64Hex(JSON.stringify([context.scope.world, context.scope.sceneUuid, source.tokenUuid, source.actorUuid, native.itemId, native.activityId, id])) };
    }
    const snapshot = () => evaluate(`(()=>{const a=game.actors.get(${JSON.stringify(sourceId)});return {slots:JSON.stringify(a.system.spells),tokens:canvas.scene.tokens.contents.map(t=>t.id),messages:game.messages.size,effects:a.effects.contents.map(e=>e.id)};})()`);
    const before = await snapshot();
    const result = await call("executeAction", { world, contextRef: context.contextRef, turn: context.turn,
      resolvedActions: [{ actionRef: spell.actionRef, actionId: spell.id, sourceTokenUuid: source.tokenUuid, actorUuid,
        itemId: spell.itemId, activityId: spell.activityId }] });
    assert.equal(result.status, "rejected"); assert.equal(result.code, "CAPABILITY_UNAVAILABLE");
    assert.deepEqual(await snapshot(), before, "summon gate must not consume, place, post chat, or add effects");
  }
  await evaluate(`(async()=>{await game.combats.get(${JSON.stringify(combatId)}).update({round:0,turn:null});await game.actors.get(${JSON.stringify(sourceId)}).update({"system.spells.spell1.value":4});return true;})()`);
  const directory = path.join(root, runId, "fault-operations");
  let dispatches = 0;
  const serviceOptions = { sessionId: runId, directory, mode: "combat", withPage: async (_signal, operation) => operation(),
    call: async (action, input) => {
      const result = await call(action, input);
      if (action === "executeAction") { dispatches++; assert.equal(result.status, "completed"); throw Error("QA transport lost reply after native world write"); }
      return result;
    } };
  let service = new FoundryServices(serviceOptions);
  const context = await service.readStatic();
  const source = context.combatants.find(t=>t.actorUuid===actorUuid && !t.name.includes("Unlinked"));
  const spell = source.actions.find(a=>(a.itemName ?? a.name).includes("Disguise Self")); assert.ok(spell);
  const binding = { taskId: runId, metadata: Promise.resolve({ world, selectedTokenUuids: [source.tokenUuid] }) };
  const params = { actionRef: spell.actionRef, resolution: "narrative" };
  const result = await service.executeAction(params, binding, "lost-reply");
  assert.equal(result.status, "indeterminate");
  const balance = () => evaluate(`game.actors.get(${JSON.stringify(sourceId)}).system.spells.spell1.value`);
  assert.equal(await balance(), 3);
  assert.deepEqual(await service.executeAction(params, binding, "lost-reply"), result);
  // Restart the session service with no transient snapshots. Durable receipt
  // lookup must win before actionRef/binding resolution and prevent a recast.
  service = new FoundryServices(serviceOptions);
  assert.deepEqual(await service.executeAction(params, binding, "lost-reply"), result);
  assert.equal((await service.readPlay({ view: "operation", operationRef: result.operationRef })).status, "indeterminate");
  assert.equal(dispatches, 1); assert.equal(await balance(), 3);
  report.lostReply = { status: result.status, dispatches, before: 4, after: 3, restartReplay: "prevented" };
  await evaluate(`(async()=>{await game.combats.get(${JSON.stringify(combatId)}).update(${JSON.stringify(original)});return true;})()`);
  report.status = "edge-cases-passed"; save();
};
