// Follow the selected documents own advancement links; never rematch linked Items by name.
async function queryBuild({className,level,raceName,subclassName,rules='2014',classRole='primary'}) {
  if(!Number.isInteger(level)||level<1||level>20)throw Error('level must be 1..20');
  if(!['2014','2024'].includes(rules)||!['primary','secondary'].includes(classRole))throw Error('Invalid rules or classRole');
  const auto='arcane-dnd5e-2014-automation.';
  const clean=s=>String(s||'').toLowerCase().trim().replace(/^[\s-]+|[\s-]+$/g,'');
  const forms=s=>[clean(s),clean(String(s||'').replace(/[^a-z0-9]+/gi,'-')),String(s||'').replace(/[^\u3400-\u9fff]/g,'')].filter(Boolean);
  const matches=(d,name)=>forms(name).some(n=>[...forms(d.name),clean(d.system?.identifier)].includes(n));
  const packs=Array.from(game.packs).filter(p=>p.documentName==='Item');
  const cache=new Map(),indexes=new Map(),unresolved=[],fallbacks=[],documents=new Map();
  const read=async uuid=>{if(!cache.has(uuid))cache.set(uuid,Promise.resolve(fromUuid(uuid)));return cache.get(uuid);};
  const index=async p=>{if(!indexes.has(p.collection))indexes.set(p.collection,p.getIndex({fields:['system.identifier','system.source.rules','system.classIdentifier','system.type','system.requirements']}));return indexes.get(p.collection);};
  const edition=d=>!d.system?.source?.rules||d.system.source.rules===rules;
  const ref=d=>({uuid:d.uuid,name:d.name,type:d.type,identifier:d.system?.identifier||''});
  const remember=d=>{
    if(!d)return null;
    if(!documents.has(d.uuid)){
      const raw=d.toObject(),s=raw.system||{};
      const description=['class','race'].includes(d.type)?'':String(s.description?.value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
      documents.set(d.uuid,{...ref(d),rules:s.source?.rules||rules,
        description:description.slice(0,900),descriptionTruncated:description.length>900,requirements:s.requirements,
        uses:s.uses,activities:Object.values(s.activities||{}).map(a=>({name:a.name,type:a.type,consumption:a.consumption,attack:a.attack,damage:a.damage,save:a.save})),
        effects:(raw.effects||[]).map(e=>({name:e.name,disabled:e.disabled,transfer:e.transfer,changes:e.changes}))});
    }return ref(d);
  };
  const roots=async(name,type,cls)=>{
    if(!name)return {selected:null,basis:null};
    const found=[];
    const suffix={class:/(^|\.)classes$/,subclass:/(^|\.)subclasses$/,race:/(^|\.)(races|species)$/}[type];
    for(const p of packs.filter(p=>suffix.test(p.collection))){
      for(const e of await index(p)){
        if(!matches(e,name))continue;
        const d=await p.getDocument(e._id);
        if(d.type!==type||d.system?.source?.rules!==rules)continue;
        if(type==='subclass'&&d.system.classIdentifier!==cls)continue;
        found.push(d);
      }
    }
    const native=found.filter(d=>d.pack?.startsWith('dnd5e.'));
    const automated=rules==='2014'?found.filter(d=>d.pack?.startsWith(auto)):[];
    const choose=list=>list.length===1?list[0]:null;
    const selected=choose(automated)||(!automated.length?choose(native):null)||(!automated.length&&!native.length?choose(found):null);
    if(!selected){unresolved.push({kind:type,query:name,reason:found.length?'ambiguous source':'source not found',candidates:found.map(ref)});return {selected:null,basis:null};}
    remember(selected);
    return {selected};
  };
  const cls=await roots(className,'class');
  const sub=await roots(subclassName,'subclass',cls.selected?.system.identifier);
  const race=await roots(raceName,'race');
  const resolve=async(uuid)=>{
    const source=await read(uuid);
    if(!source){unresolved.push({uuid,reason:'linked document missing'});return {uuid,unresolved:true};}
    if(!edition(source)){unresolved.push({uuid,reason:'linked document edition mismatch'});return {uuid,unresolved:true};}
    return remember(source);
  };
  const project=async root=>{
    if(!root.selected)return null;
    const s=root.selected.toObject().system,advancements=[];
    if(!Object.keys(s.advancement||{}).length)unresolved.push({uuid:root.selected.uuid,reason:'selected source has no advancement configuration; completeness unknown'});
    for(const a of Object.values(s.advancement||{})){
      if(a.level!=null&&a.level>level)continue;
      if(a.classRestriction&&a.classRestriction!==classRole)continue;
      const c=JSON.parse(JSON.stringify(a.configuration||{}));
      if(a.type==='ScaleValue'){
        const eligible=Object.keys(c.scale||{}).map(Number).filter(n=>n<=level).sort((a,b)=>b-a);
        if(!eligible.length)continue;
        c.current=c.scale[eligible[0]];delete c.scale;
      }
      if(a.type==='ItemChoice'){
        c.choices=Object.fromEntries(Object.entries(c.choices||{}).filter(([l])=>Number(l)<=level));
        if(!Object.keys(c.choices).length)continue;
        c.pool=await Promise.all((c.pool||[]).map(async r=>({...await resolve(typeof r==='string'?r:r.uuid)})));
      }
      if(a.type==='ItemGrant')c.items=await Promise.all((c.items||[]).map(async r=>({...await resolve(typeof r==='string'?r:r.uuid),optional:!!r.optional})));
      if(a.type==='Subclass'&&sub.selected)continue;
      if(a.type==='Subclass'&&!sub.selected)unresolved.push({kind:'subclass',reason:'select subclassName to include its cumulative grants'});
      advancements.push({id:a._id,sourceUuid:root.selected.uuid,level:a.level??null,type:a.type,title:a.title,configuration:c});
    }
    const actual=root.selected.toObject().system;
    return {...ref(root.selected),hitDice:actual.hd?.denomination||actual.hitDice,
      spellcasting:actual.spellcasting,movement:actual.movement,advancements};
  };
  const projected={class:await project(cls),subclass:await project(sub),race:await project(race)};
  return {version:3,level,rules,classRole,...projected,documents:[...documents.values()],fallbacks,unresolved,
    sourcePolicy:'Select roots with automation-pack preference; follow their exact advancement UUIDs without cross-pack replacement. Missing links are unresolved, not silently substituted.',
    scope:'Cumulative configured grants and choices from selected sources, not a completeness certification. Class and subclass contributions remain separate; no text conflict arbitration. Choices require selection. Importing class Items does not apply all advancements; write and verify normal proficiencies/resources.'};
}
module.exports={queryBuild,createTool(evaluate){return {
  name:'foundry_build_query',label:'Read character build sources',
  description:'Read actual import sources for class, selected subclass and race through a level. Returns exact linked UUIDs from the selected sources, document mechanics, grants and choices; missing links are explicit. Include subclassName when known. Read-only.',
  parameters:{type:'object',properties:{className:{type:'string'},level:{type:'integer',minimum:1,maximum:20},raceName:{type:'string'},subclassName:{type:'string'},rules:{type:'string',enum:['2014','2024']},classRole:{type:'string',enum:['primary','secondary']}},required:['className','level'],additionalProperties:false},
  async execute(id,args){const result=await evaluate(`(${queryBuild.toString()})(${JSON.stringify(args)})`);return {content:[{type:'text',text:JSON.stringify(result)}],details:{readOnly:true}};}
};}};
