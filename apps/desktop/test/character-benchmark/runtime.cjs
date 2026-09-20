// Browser functions invoked explicitly via arcane-fvtt debug-eval. Never used by tested models.
async function snapshot({ids,sourceUuid,worldId}) {
  if(game.world.id!==(worldId||'COS')||!game.user.isGM)throw Error('Review world guard');
  const result=[];
  for(const id of ids){const a=game.actors.get(id);if(!a)throw Error('Review Actor missing');const s=a.system;const currentSource=sourceUuid?(await fromUuid(sourceUuid))?.toObject():null;
    result.push({id:a.id,name:a.name,type:a.type,raw:a.toObject(),sameNameCount:game.actors.filter(x=>x.name===a.name).length,
      sourceCurrent:currentSource,
      effective:{level:s.details.level,prof:s.attributes.prof,hp:s.attributes.hp,ac:s.attributes.ac,walk:s.attributes.movement.walk,
        movement:s.attributes.movement,traits:s.traits,abilities:s.abilities,skills:s.skills,spellcasting:s.attributes.spellcasting,spell:s.attributes.spell,slots:s.spells,
        hd:{value:s.attributes.hd?.value,max:s.attributes.hd?.max},scale:a.getRollData().scale,items:a.items.map(i=>({id:i.id,identifier:i.system.identifier,type:i.type,uses:i.system.uses,activities:Array.from(i.system.activities||[]).map(x=>x.toObject())}))}});
  }return JSON.parse(JSON.stringify(result,(_key,value)=>value instanceof Set?[...value]:value));
}
async function build({plan,runId,folderName,worldId}) {
  if(game.world.id!==(worldId||'COS')||!game.user.isGM)throw Error('Review world guard');
  const name=`${plan.id} ${plan.title}〔验收样例 v3〕`;
  if(game.actors.some(a=>a.flags.arcanedesk?.benchReview?.runId===runId&&a.flags.arcanedesk?.benchReview?.caseId===plan.id))throw Error('Already created: inspect, do not replay');
  const cls=await fromUuid(plan.classUuid),sub=await fromUuid(plan.subclassUuid),race=plan.raceUuid?await fromUuid(plan.raceUuid):null,base=plan.sourceUuid?await fromUuid(plan.sourceUuid):null;
  if(!cls||!sub||(plan.sourceUuid&&!base)||(plan.raceUuid&&!race))throw Error('Missing frozen source');
  const sourceBefore=base?.toObject()||null;
  const sources=new Map();
  const add=d=>{if(!d)throw Error('Unresolved source');sources.set(d.uuid,d);};
  add(cls);add(sub);if(race)add(race);
  // Automatic grants only: no future grants or ItemChoice pools silently granted.
  for(const parent of [cls,sub,race].filter(Boolean))for(const a of Object.values(parent.toObject().system.advancement||{})){
    if(a.type!=='ItemGrant'||(a.level||0)>plan.level)continue;
    for(const ref of a.configuration.items||[])if(!ref.optional)add(await fromUuid(typeof ref==='string'?ref:ref.uuid));
  }
  if(plan.cls==='fighter')add(await fromUuid('Compendium.dnd5e.classfeatures.Item.hCop9uJrWhF1QPb4'));
  const lookup=async(identifier,type)=>{
    const packs=type==='spell'?['arcane-dnd5e-2014-automation.spells','dnd5e.spells']:['arcane-dnd5e-2014-automation.basicweapons','dnd5e.items'];
    for(const id of packs){const p=game.packs.get(id);if(!p)continue;const ix=await p.getIndex({fields:['system.identifier','type','system.source.rules']});
      const e=ix.find(e=>(e.system?.identifier===identifier||(e.name||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'')===identifier)&&(type!=='spell'||e.type==='spell')&&(type==='spell'||e.type!=='spell'));
      if(e){const d=await p.getDocument(e._id);if(d.system.source?.rules==='2024')continue;return d;}}
    throw Error('Missing source '+type+':'+identifier);
  };
  const gearRefs=new Map();for(const [id,q]of plan.gear){const d=await lookup(id,'gear');add(d);gearRefs.set(d.uuid,q);}
  for(const id of [...plan.cantrips,...plan.book])add(await lookup(id,'spell'));
  const copy=d=>{const x=d.toObject();delete x._id;delete x.folder;x._stats={...x._stats,compendiumSource:d.uuid};return x;};
  const imported=[...sources.values()].map(d=>{const x=copy(d),s=x.system;
    if(x.type==='class')s.levels=plan.level;
    if(x.type==='spell'){s.method='spell';s.prepared=plan.domain?.includes(s.identifier)?2:plan.prepared?.includes(s.identifier)?1:0;}
    if(gearRefs.has(d.uuid)){s.quantity=gearRefs.get(d.uuid);if(['weapon','equipment'].includes(x.type))s.equipped=true;}
    if(['arcane-recovery','second-wind'].includes(s.identifier)){s.uses={...s.uses,max:'1',spent:0,recovery:[{period:s.identifier==='arcane-recovery'?'lr':'sr',type:'recoverAll'}]};}
    return x;
  });
  let folder=game.folders.find(f=>f.type==='Actor'&&f.flags.arcanedesk?.benchReview===runId);
  if(!folder)folder=await Folder.create({name:folderName,type:'Actor',color:'#4d7caa',flags:{arcanedesk:{benchReview:runId}}});
  const data=base?base.toObject():{type:'character',system:{}};delete data._id;data.name=name;data.folder=folder.id;
  data.flags??={};data.flags.arcanedesk??={};data.flags.arcanedesk.benchReview={runId,caseId:plan.id,provisional:true};
  data.prototypeToken??={};data.prototypeToken.name=name;
  const s=data.system;s.abilities??={};for(const [i,k]of ['str','dex','con','int','wis','cha'].entries())s.abilities[k]={...s.abilities[k],value:plan.abilities[i]};
  s.attributes??={};const die={tiny:4,sm:6,med:8,lg:10,huge:12,grg:20}[base?.system.traits.size];const mod=n=>Math.floor((n-10)/2);const hp=base?base.system.attributes.hp.max+plan.level*Math.max(die/2+1+mod(plan.abilities[2]),1):plan.hp;s.attributes.hp={...s.attributes.hp,value:hp,max:hp};
  if(!base){s.attributes.hp.formula='';s.attributes.movement={walk:plan.walk,units:'ft'};s.attributes.ac={calc:plan.cls==='wizard'?'flat':'default',flat:plan.ac};s.details={...s.details,type:{value:'humanoid',subtype:plan.ancestry}};}
  s.source={...s.source,rules:'2014'};
  if(plan.slots.length){s.attributes.spellcasting=plan.cls==='cleric'?'wis':'int';s.attributes.spell={level:plan.level};s.spells??={};for(let n=1;n<=9;n++)s.spells['spell'+n]={value:plan.slots[n-1]||0,override:null};}
  s.skills??={};for(const [k,v]of Object.entries(plan.skills))s.skills[k]={...s.skills[k],ability:s.skills[k]?.ability||CONFIG.DND5E.skills[k].ability,value:Math.max(s.skills[k]?.value||0,v)};
  s.traits??={};
  const grant=t=>{const [kind,...parts]=t.split(':');const value=parts.at(-1);if(kind==='saves')s.abilities[value]={...s.abilities[value],proficient:1};
    else if(['weapon','armor','languages'].includes(kind)){const key=kind==='weapon'?'weaponProf':kind==='armor'?'armorProf':'languages';s.traits[key]??={};s.traits[key].value=[...new Set([...(s.traits[key].value||[]),value])];}};
  for(const parent of [cls,sub,race].filter(Boolean))for(const a of Object.values(parent.toObject().system.advancement||{}))if(a.type==='Trait'&&(a.level||0)<=plan.level&&a.classRestriction!=='secondary')for(const t of a.configuration.grants||[])grant(t);
  if(race){grant('languages:standard:common');grant(plan.ancestry==='hill-dwarf'?'languages:standard:dwarvish':'languages:standard:elvish');}
  if(plan.cls==='rogue')grant('languages:exotic:thievescant');
  if(plan.cls==='cleric')grant('armor:hvy');
  const description=`<h2>Benchmark 审阅样例 ${plan.id}</h2><p>2014 / ${plan.cls} ${plan.level} / ${plan.subclass}。这张卡用于DM审阅验收标准，不是模型测试产物。</p><p>职业与子职按来源导入；未稳定支持的职业自动化只验配置，不宣称实战全部自动执行。HP合并、技能选择和装备默认待DM审阅。</p>`;
  s.details??={};s.details.biography={...s.details.biography,value:(s.details.biography?.value||'')+description};
  data.items=[...(data.items||[]),...imported];
  const a=await Actor.create(data,{renderSheet:false});
  // Record created ID before subsequent changes. The CLI runner never automatically retries.
  const patch={};for(let n=1;n<=plan.slots.length;n++)patch[`system.spells.spell${n}.value`]=a.system.spells['spell'+n].max;
  if(Object.keys(patch).length)await a.update(patch);
  return {id:a.id,uuid:a.uuid,name:a.name,folderId:folder.id,sourceBefore,sourceAfter:base?.toObject()||null,
    importedSources:[...sources.values()].map(d=>({uuid:d.uuid,type:d.type,identifier:d.system.identifier,name:d.name,raw:d.toObject()}))};
}
module.exports={build,snapshot};
