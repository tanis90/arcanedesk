// Independent assertions: does not call the builder or foundry_build_query.
const crypto=require('node:crypto');
const aliases=require('./source-aliases-v3.json');
const spellMetadata=require('./spell-metadata.json').spells;
const {extensionHp,proficiency}=require('./policy.cjs');
const keys=['str','dex','con','int','wis','cha'];
const mod=n=>Math.floor((n-10)/2);
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>!['_id','_stats','ownership','folder','sort'].includes(k)).map(k=>[k,canonical(v[k])]));return v;}
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const itemComparable=v=>{const x=structuredClone(v);if(Array.isArray(x?.system?.properties))x.system.properties=x.system.properties.filter(p=>p!=='gear');return x;};
const equalItem=(a,b)=>equal(itemComparable(a),itemComparable(b));
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function verify(plan,actual,receipt){
  const checks=[],diagnostics=[];const check=(id,priority,ok,expected,observed)=>checks.push({id,priority,ok:!!ok,expected,observed});
  if(!actual){check('actor.exists','core',false,true,false);return {caseId:plan.id,checks,corePass:false,configurationPass:false};}
  const e=actual.effective,s=actual.raw.system,items=actual.raw.items||[],base=receipt.sourceBefore;
  const alias=i=>{const a=aliases[i._stats?.compendiumSource];return a?.cls===plan.cls?a:null;};
  const find=(id,type)=>items.filter(i=>(i.system?.identifier===id||alias(i)?.identifier===id)&&(!type||i.type===type));
  check('actor.unique','core',actual.sameNameCount===1&&actual.type===(plan.source?'npc':'character'),1,actual.sameNameCount);
  check('actor.name','core',actual.name===receipt.name,receipt.name,actual.name);
  const cls=find(plan.cls,'class'),sub=find(plan.subclass,'subclass');
  check('class.level','core',cls.length===1&&cls[0].system.levels===plan.level&&e.level===plan.level,plan.level,e.level);
  check('class.subclass','core',sub.length===1&&sub[0].system.classIdentifier===plan.cls,plan.subclass,sub.map(i=>i.system.classIdentifier));
  for(const id of plan.requiredFeatures){
    if(id==='bonus-proficiency'&&plan.cls==='cleric'&&actual.type==='npc'&&sub.length===1&&sub[0].system.classIdentifier==='cleric'){check('feature.'+id,'core',true,'life domain present; native NPC armor proficiency is implicit','NPC armor default');continue;}
    if(id==='fighting-style'){const styles=['archery','defense','dueling','great-weapon-fighting','protection','two-weapon-fighting'];const choices=items.filter(i=>i.type==='feat'&&styles.includes(alias(i)?.identifier));check('feature.'+id,'core',choices.length===1,'one legal fighting style',choices.map(i=>i.name));continue;}
    if(['arcane-tradition','martial-archetype','divine-domain','roguish-archetype'].includes(id)&&sub.length===1&&sub[0].system.classIdentifier===plan.cls){check('feature.'+id,'core',true,'subclass choice materialized',sub[0].system.identifier);continue;}
    const f=find(id,'feat');
    const expected=receipt.importedSources.find(x=>x.identifier===id&&x.type==='feat');
    check('feature.'+id,'core',f.length===1&&!!expected&&(f[0]._stats?.compendiumSource===expected.uuid||alias(f[0])?.identifier===id)&&!!f[0].system.description?.value,expected?.uuid,f.map(i=>i._stats?.compendiumSource));}
  const excessive=items.filter(i=>alias(i)?.level>plan.level);check('features.level-ceiling','core',excessive.length===0,'no recognized above-level grants',excessive.map(i=>({name:i.name,level:alias(i).level})));
  const vals=keys.map(k=>e.abilities[k].value),raceBonus=plan.ancestry==='human'?[1,1,1,1,1,1]:[0,0,2,0,1,0];
  if(!base){const allowed=plan.level>=4?keys.flatMap((_,i)=>keys.slice(i).map((_,j)=>{const a=Array(6).fill(0);a[i]++;a[i+j]++;return a;})):[Array(6).fill(0)];
    const legal=allowed.some(asi=>JSON.stringify(vals.map((v,i)=>v-raceBonus[i]-asi[i]).sort((a,b)=>a-b))===JSON.stringify([8,10,12,13,14,15]));
    check('abilities.legal','important',legal,'standard array + race + legal ASI',vals);
    check('race.source','important',(find(plan.ancestry,'race').length===1||(plan.ancestry==='human'&&s.details.type?.value==='humanoid'&&['human','人类'].includes(s.details.type?.subtype?.toLowerCase()))||(plan.ancestry==='hill-dwarf'&&s.details.type?.value==='humanoid'&&['dwarf','hill dwarf','丘陵矮人','矮人'].includes(s.details.type?.subtype?.toLowerCase())&&items.some(i=>i._stats?.compendiumSource==='Compendium.arcane-dnd5e-2014-automation.racialtraits.Item.p3thQu1DkOgiNA10'))),plan.ancestry,items.filter(i=>i.type==='race').map(i=>i.system.identifier));
  }else {const diffs=keys.map((k,i)=>vals[i]-base.system.abilities[k].value),sum=diffs.reduce((a,b)=>a+b,0);
    check('abilities.increment','important',diffs.every(x=>Number.isInteger(x)&&x>=0&&x<=2)&&sum===(plan.level>=4?2:0),'only legal class ASI',diffs);}
  if(plan.id==='A1')check('abilities.requested','core',vals[3]===18,18,vals[3]);
  if(plan.id==='A3')check('abilities.requested','core',vals[4]===16,16,vals[4]);
  const con=mod(vals[2]),die={wizard:6,fighter:10,cleric:8,rogue:8}[plan.cls],fixed=die/2+1;
  const baseHd=Number(base?.system.attributes.hp.formula?.match(/(\d+)d/)?.[1]||0);
  const hp=base?extensionHp(base,plan.level,vals[2]):die+con+(plan.level-1)*(fixed+con)+(plan.ancestry==='hill-dwarf'?plan.level:0);
  check('hp.full','core',e.hp.max===hp&&e.hp.value===hp,hp,{max:e.hp.max,value:e.hp.value});
  const walk=base?base.system.attributes.movement.walk:plan.walk;
  check('movement.walk','important',Number(e.walk)===Number(walk),walk,e.walk);
  const prof=base?proficiency(base.system.details.cr,plan.level):2+Math.floor((plan.level-1)/4);
  check('proficiency.effective','important',e.prof===prof,prof,e.prof);
  const saves={wizard:['int','wis'],fighter:['str','con'],cleric:['wis','cha'],rogue:['dex','int']}[plan.cls];
  check('saves.granted','important',saves.every(k=>e.abilities[k].proficient>=1),saves,saves.map(k=>e.abilities[k].proficient));
  const pools={wizard:['arc','his','ins','inv','med','rel'],fighter:['acr','ani','ath','his','ins','itm','prc','sur'],cleric:['his','ins','med','per','rel'],rogue:['acr','ath','dec','ins','itm','inv','prc','prf','per','slt','ste']};
  const selected=pools[plan.cls].filter(k=>e.skills[k]?.value>=1);
  check('skills.selected','important',selected.length>=(plan.cls==='rogue'?4:2),'legal class skill count',selected);
  const skillAbilities={acr:'dex',ani:'wis',arc:'int',ath:'str',dec:'cha',his:'int',ins:'wis',itm:'cha',inv:'int',med:'wis',nat:'int',prc:'wis',prf:'cha',per:'cha',rel:'int',slt:'dex',ste:'dex',sur:'wis'};
  const changedSkillAbilities=Object.entries(skillAbilities).filter(([k,v])=>e.skills[k]?.ability!==(base?.system.skills?.[k]?.ability||v));
  check('skills.abilities','important',changedSkillAbilities.length===0,'default skill abilities, preserving source overrides',changedSkillAbilities.map(([k])=>({skill:k,ability:e.skills[k]?.ability})));
  if(plan.cls==='rogue')check('skills.expertise','important',Object.values(e.skills).filter(v=>v.value>=2).length+(s.tools?.thief?.value>=2?1:0)>=2,'two expertise selections',Object.entries(e.skills).filter(([k,v])=>v.value>=2).map(([k])=>k));

  if(plan.slots.length){
    check('spells.caster','core',e.spellcasting===(plan.cls==='cleric'?'wis':'int')&&e.spell.level===plan.level,plan.level,e.spell);
    check('spells.slots','core',Array.from({length:9},(_,i)=>i+1).every(n=>Number(e.slots['spell'+n]?.max||0)===(plan.slots[n-1]||0)&&Number(e.slots['spell'+n]?.value||0)===(plan.slots[n-1]||0)),plan.slots,Object.fromEntries(Object.entries(e.slots).filter(([k])=>/^spell[1-9]$/.test(k)).map(([k,v])=>[k,[v.value,v.max]])));
    const spells=items.filter(i=>i.type==='spell'),cantrips=spells.filter(i=>i.system.level===0),book=spells.filter(i=>i.system.level>0),prepared=book.filter(i=>i.system.prepared===1);
    const invalidSpells=spells.filter(i=>{const ref=spellMetadata[i.system.identifier];return ref&&(ref.level!==i.system.level||(!ref.classes.includes(plan.cls)&&!(plan.domain||[]).includes(i.system.identifier)));});check('spells.known-membership','important',invalidSpells.length===0,'known SRD spells match class and level',invalidSpells.map(i=>i.system.identifier));
    const ordinary=plan.cls==='wizard'?Math.max(1,mod(vals[3])+plan.level):mod(vals[4])+plan.level;
    check('spells.cantrips','important',cantrips.length===plan.cantrips.length&&new Set(cantrips.map(i=>i.system.identifier)).size===cantrips.length,plan.cantrips.length,cantrips.length);
    check('spells.book','important',book.length===plan.book.length&&new Set(book.map(i=>i.system.identifier)).size===book.length&&book.every(i=>i.system.level<=plan.slots.length),plan.book.length,book.length);
    if(plan.cls==='wizard'){const limits=Array.from({length:plan.slots.length-1},(_,i)=>i+2).map(r=>({ring:r,max:2*(plan.level-(2*r-1)+1),actual:book.filter(i=>i.system.level>=r).length}));diagnostics.push({id:'spells.acquisition',ok:limits.every(x=>x.actual<=x.max),expected:'normal level-up acquisition; informational, not a task failure',observed:limits});}
    const castingMod=mod(vals[plan.cls==='cleric'?4:3]);check('spells.attack-dc','important',e.spell.attack===castingMod+e.prof&&e.spell.dc===8+castingMod+e.prof,{attack:castingMod+e.prof,dc:8+castingMod+e.prof},{attack:e.spell.attack,dc:e.spell.dc});
    check('spells.prepared','important',prepared.length===ordinary,ordinary,prepared.length);
    for(const id of plan.domain||[])check('domain.'+id,'core',find(id,'spell').length===1&&find(id,'spell')[0].system.prepared===2,'always prepared',find(id,'spell')[0]?.system.prepared);
    if(plan.cls==='wizard'){const f=find('fireball','spell');const acts=Object.values(f[0]?.system.activities||{});
      check('fireball.ready','core',f.length===1&&f[0].system.prepared>0&&f[0].system.level===3&&acts.some(a=>a.type==='save'&&a.save?.ability?.includes('dex')&&a.damage?.onSave==='half'&&a.consumption?.spellSlot===true&&a.damage?.parts?.some(p=>p.number===8&&p.denomination===6&&p.types?.includes('fire'))),'prepared level3 DEX/8d6fire/half/slot',acts.map(a=>a.type));}
  }
  const resources=plan.cls==='fighter'?['second-wind','action-surge']:plan.cls==='cleric'?['channel-divinity']:plan.cls==='wizard'?['arcane-recovery']:[];
  for(const id of resources){const raw=find(id,'feat')[0];const u=e.items.find(i=>i.id===raw?._id)?.uses;check('resource.'+id,'important',Number(u?.max)===1&&Number(u?.value)===1,{max:1,value:1},u);}
  if(plan.cls==='rogue'){const v=e.scale?.rogue?.['sneak-attack'];check('scale.sneak-attack','important',v?.number===2&&v?.faces===6,'2d6',v);}
  for(const [id,q]of plan.gear){const g=find(id);check('gear.'+id,'important',g.length===1&&g[0].system.quantity===q&&(!['weapon','equipment'].includes(g[0].type)||g[0].system.equipped===true),{q,equipped:true},g.map(i=>({q:i.system.quantity,equipped:i.system.equipped})));}
  for(const [id]of plan.gear){const w=find(id,'weapon')[0];if(w){const dice={quarterstaff:6,longsword:8,'light-hammer':4,dagger:4,handaxe:6,'light-crossbow':8}[id];const acts=Object.values(w.system.activities||{}),baseDamage=w.system.damage?.base;check('weapon.activity.'+id,'important',acts.some(a=>a.type==='attack'&&(a.damage?.includeBase||a.damage?.parts?.length))&&(!dice||(baseDamage?.number===1&&baseDamage?.denomination===dice)),{attackActivity:true,baseDie:dice}, {attackActivities:acts.filter(a=>a.type==='attack').length,baseDamage});}}
  if(!base){const armor=items.filter(i=>i.type==='equipment'&&i.system.equipped&&['light','medium','heavy'].includes(i.system.type?.value)),shields=items.filter(i=>i.type==='equipment'&&i.system.equipped&&i.system.type?.value==='shield');const dex=mod(vals[1]);const ar=armor[0]?.system;const expected=(ar?Number(ar.armor.value)+Math.min(dex,ar.armor.dex??dex):10+dex)+shields.reduce((n,i)=>n+Number(i.system.armor.value),0)+(armor.length&&find('defense','feat').length?1:0);check('armor.effective','important',armor.length<=1&&shields.length<=1&&e.ac.value===expected,expected,e.ac.value);}

  if(base)check('source.cr-preserved','core',s.details.cr===base.system.details.cr,base.system.details.cr,s.details.cr);
  // Migration-neutral comparison, with explicit ownership/identity fields excluded only.
  if(base){check('source.unchanged','core',equal(receipt.sourceBefore,actual.sourceCurrent),hash(canonical(base)),hash(canonical(actual.sourceCurrent)));
    for(const old of base.items||[]){const matches=items.filter(i=>equalItem(i,old));const expectedCount=base.items.filter(i=>equalItem(i,old)).length;check('preserve.item.'+old._id,'core',matches.length===expectedCount,old.name,matches[0]?.name);}
    check('preserve.effects','core',(base.effects||[]).every(x=>(actual.raw.effects||[]).some(y=>equal(x,y))),base.effects?.length,actual.raw.effects?.length);
    for(const k of ['di','dr','dv','ci','size'])check('preserve.trait.'+k,'core',equal(s.traits?.[k],base.system.traits?.[k]),base.system.traits?.[k],s.traits?.[k]);
    check('preserve.image','important',actual.raw.img===base.img&&actual.raw.prototypeToken.texture.src===base.prototypeToken.texture.src,base.img,actual.raw.img);
  }
  // Separate automation review from verified data; no fabricated all-green combat claim.
  return {caseId:plan.id,name:actual.name,actorId:actual.id,checks,diagnostics,corePass:checks.filter(x=>x.priority==='core').every(x=>x.ok),configurationPass:checks.every(x=>x.ok),manualReview:['Class/subclass abilities actual combat execution is not certified','Starter pack consumables and optional choice quality require review','Spells outside the pinned SRD metadata and unrecognized feature sources require review'],automationCertified:false};
}
module.exports={verify,canonical};
