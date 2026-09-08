// Read-only acceptance for the NPC intent pilot. No casts or document writes.
module.exports = (evaluate, fixture) => evaluate(`(() => {
  const f=${JSON.stringify(fixture)};
  const actors=game.actors.filter(a=>a.name===f.newName);
  const a=actors[0];
  if(!a)return {ok:false,checks:{singleNpc:false},details:{count:actors.length}};
  const data=a.toObject(),s=a.system;
  const fireballs=a.items.filter(i=>i.type==='spell'&&(i.system.identifier==='fireball'||/^(fireball|火球术)$/i.test(i.name)));
  const staff=a.items.filter(i=>i.type==='weapon'&&(i.system.identifier==='quarterstaff'||/^(quarterstaff|长棍)$/i.test(i.name)));
  const fireball=fireballs[0];
  const acts=fireball?Array.from(fireball.system.activities??[]):[];
  const validActivity=acts.some(x=>x.type==='save'&&Array.from(x.save?.ability??[]).includes('dex')&&x.consumption?.spellSlot===true&&x.damage?.onSave==='half'&&x.damage?.parts?.some(p=>p.number===8&&p.denomination===6&&Array.from(p.types??[]).includes('fire')));
  const human=/human|人类/i.test(String(s.details.type?.subtype??'')+' '+String(s.details.race??''))||a.items.some(i=>i.type==='race'&&/human|人类/i.test(i.name));
  const slotMax=[1,2,3].map(n=>s.spells['spell'+n]?.max);
  const checks={singleNpc:actors.length===1&&a.type==='npc',human:s.details.type?.value==='humanoid'&&human,intelligence:s.abilities.int.value===18,spellcasting:s.attributes.spellcasting==='int'&&s.attributes.spell.level===5,slots:JSON.stringify(slotMax)===JSON.stringify([4,3,2])&&[1,2,3].every(n=>s.spells['spell'+n].value===s.spells['spell'+n].max)&&[4,5,6,7,8,9].every(n=>!s.spells['spell'+n]?.value&&!s.spells['spell'+n]?.max),hp:Number.isFinite(s.attributes.hp.max)&&s.attributes.hp.max>0&&s.attributes.hp.value===s.attributes.hp.max,fireball:fireballs.length===1&&fireball.system.level===3&&fireball.system.method==='spell'&&Number(fireball.system.prepared)>0&&validActivity,staff:staff.length===1&&staff[0].system.equipped===true&&staff[0].system.quantity===1,noShield:!a.items.some(i=>i.type==='equipment'&&i.system.type?.value==='shield')};
  return {ok:Object.values(checks).every(Boolean),checks,manualReviewRequired:true,details:{count:actors.length,uuid:a.uuid,system:data.system,derived:{prof:s.attributes.prof,spellDC:s.attributes.spelldc,slots:s.spells},items:a.items.map(i=>i.toObject()),effects:a.effects.map(e=>e.toObject())}};
})()`);
