// Held-out caster transfer: evaluator reads actual source mechanics, never supplies them to the model.
module.exports=(evaluate,fixture)=>evaluate(`(async()=>{
  const f=${JSON.stringify(fixture)},matches=game.actors.filter(a=>a.name===f.newName),a=matches[0];
  if(!a)return {ok:false,checks:{singleNpc:false},manualReviewRequired:true};
  const s=a.system,blesses=a.items.filter(i=>i.type==='spell'&&i.system.identifier==='bless');
  const hammers=a.items.filter(i=>i.type==='weapon'&&i.system.identifier==='light-hammer');
  const b=blesses[0],ref=b?.toObject()._stats?.compendiumSource;
  const source=ref?await fromUuid(ref):null;
  const norm=x=>Array.isArray(x)?x.map(norm):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).filter(k=>k!=='_id'&&k!=='_stats').sort().map(k=>[k,norm(x[k])])):x;
  const eq=(x,y)=>JSON.stringify(norm(x))===JSON.stringify(norm(y));
  const raw=b?.toObject(),original=source?.toObject();
  const checks={singleNpc:matches.length===1&&a.type==='npc',
    elf:s.details.type?.value==='humanoid'&&(/elf|精灵/i.test(String(s.details.type.subtype??''))||a.items.some(i=>i.type==='race'&&/elf|精灵/i.test(i.name))),
    wisdom:s.abilities.wis.value===16,
    spellRules:b?.system.source?.rules==='2014',
    spellcasting:s.attributes.spellcasting==='wis'&&s.attributes.spell.level===3,
    slots:[1,2].every((n,i)=>s.spells['spell'+n].max===[4,2][i]&&s.spells['spell'+n].value===s.spells['spell'+n].max)&&[3,4,5,6,7,8,9].every(n=>!s.spells['spell'+n].max&&!s.spells['spell'+n].value),
    hp:Number.isFinite(s.attributes.hp.max)&&s.attributes.hp.max>0&&s.attributes.hp.value===s.attributes.hp.max,
    bless:blesses.length===1&&b.system.level===1&&b.system.method==='spell'&&Number(b.system.prepared)>0&&source?.type==='spell'&&source.system.identifier==='bless'&&eq(raw.system.activities,original.system.activities)&&eq(raw.effects,original.effects)&&Array.from(b.system.activities??[]).some(x=>x.type==='utility'&&x.duration?.concentration===true&&x.consumption?.spellSlot===true),
    hammer:hammers.length===1&&hammers[0].system.quantity===1&&hammers[0].system.equipped===true&&Array.from(hammers[0].system.activities??[]).some(x=>x.type==='attack')};
  return {ok:Object.values(checks).every(Boolean),checks,manualReviewRequired:true,details:{uuid:a.uuid,system:a.toObject().system,derived:{slots:s.spells,ac:s.attributes.ac,prof:s.attributes.prof},items:a.items.map(i=>i.toObject()),sourceRef:ref??null}};
})()`);
