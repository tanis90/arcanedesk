// Faults are scoped to one QA fixture Item and restored in finally. The pack,
// Item data, compiler, and installed module files are never patched.
module.exports = async function nativeFaults({ evaluate, sourceId, targetId, report, save, revision }) {
  const assert = require("node:assert/strict");
  const call = (action,input={})=>evaluate(`(async()=>{return await (${revision.runtimeSource})(${JSON.stringify(action)},${JSON.stringify(input)},{});})()`);
  const context=await call("staticContext");assert.equal(context.scope.combatId,null);
  const source=context.combatants.find(t=>t.actorUuid===`Actor.${sourceId}`&&!t.name.includes("Unlinked"));
  const target=context.combatants.find(t=>t.actorUuid===`Actor.${targetId}`);
  const spell=source.actions.find(a=>(a.itemName??a.name).includes("Guiding Bolt"));assert.ok(spell);
  const input={world:context.scope.world,contextRef:context.contextRef,turn:null,resolvedActions:[{actionRef:spell.actionRef,actionId:spell.id,
    sourceTokenUuid:source.tokenUuid,actorUuid:source.actorUuid,itemId:spell.itemId,activityId:spell.activityId,targetTokenUuids:[target.tokenUuid]}]};
  report.nativeFaults=[];
  for(const mode of ["chat-only","post-completion-error","timeout"]) {
    const row={mode,state:"dispatched"};report.nativeFaults.push(row);save();
    row.result=await evaluate(`(async()=>{
      const actor=game.actors.get(${JSON.stringify(sourceId)}),item=actor.items.get(${JSON.stringify(spell.itemId)});
      if(!actor.flags.arcanedesk?.requestId?.startsWith("prep-play-"))throw Error("Fixture ownership mismatch");
      const before={slot:actor.system.spells.spell1.value,messages:game.messages.size,hp:game.actors.get(${JSON.stringify(targetId)}).system.attributes.hp.value};
      const original=MidiQOL.completeItemUse;let invocations=0;
      MidiQOL.completeItemUse=async function(used,...args){
        if(used.id!==item.id||used.parent?.id!==actor.id)return original.call(this,used,...args);
        invocations++;
        if(${JSON.stringify(mode)}==="chat-only"){
          await ChatMessage.create({content:item.name,speaker:{actor:actor.id,token:${JSON.stringify(source.tokenUuid.split(".").at(-1))}},flags:{"midi-qol":{itemId:item.id},arcanedesk:{qaFault:"chat-only"}}});return null;
        }
        if(${JSON.stringify(mode)}==="timeout")return new Promise(()=>{});
        await original.call(this,used,...args);throw Error("QA injected post-completion failure");
      };
      if(MidiQOL.completeItemUse===original)throw Error("QA adapter not installed");
      try {
        const result=await (${revision.runtimeSource})("executeAction",${JSON.stringify(input)},{});
        return {result,invocations,before,after:{slot:actor.system.spells.spell1.value,messages:game.messages.size,hp:game.actors.get(${JSON.stringify(targetId)}).system.attributes.hp.value}};
      } finally {MidiQOL.completeItemUse=original;}
    })()`);
    row.state="returned";save();
    assert.equal(row.result.result.status,"indeterminate");assert.equal(row.result.invocations,1);
    assert.equal(row.result.after.slot,row.result.before.slot-(mode==="post-completion-error"?1:0));
    if(mode==="chat-only") {assert.equal(row.result.after.messages,row.result.before.messages+1);assert.equal(row.result.after.hp,row.result.before.hp);}
  }
  report.status="native-faults-passed";save();
};
