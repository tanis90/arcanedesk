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
  const remember=(d,brief=false)=>{
    if(!d)return null;
    if(!documents.has(d.uuid)){
      const raw=d.toObject(),s=raw.system||{};
      const description=['class','race'].includes(d.type)?'':String(s.description?.value||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
      documents.set(d.uuid,{...ref(d),rules:s.source?.rules||rules,
        description:description.slice(0,brief?220:900),descriptionTruncated:description.length>(brief?220:900),requirements:s.requirements,prerequisites:s.prerequisites,spellLevel:s.level,
        uses:s.uses,activities:Object.values(s.activities||{}).map(a=>brief?{name:a.name,type:a.type}:({name:a.name,type:a.type,consumption:a.consumption,attack:a.attack,damage:a.damage,save:a.save})),
        mechanicsDetail:brief?'preview; import source preserves full mechanics':'activity-summary',
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
  // The system validates structured level and item prerequisites; textual requirements
  // may carry additional restrictions that the system data has not encoded.
  const candidate=async (uuid,restriction={})=>{
    const d=await read(uuid);
    if(!d||!edition(d))return {...await resolve(uuid),eligibility:'unresolved'};
    const s=d.toObject().system,p=s.prerequisites||{};
    if(d.type==='spell'&&restriction.level!==undefined&&restriction.level!==''){
      const max=restriction.level==='available'?spellAccess?.level:Number(restriction.level);
      if(Number.isFinite(max)&&(restriction.level==='available'?s.level>max:s.level!==max))return null;
    }
    if(Number.isFinite(p.level)&&p.level>level)return null;
    const text=String(s.requirements||'').trim();
    const onlyLevel=/^(?:[\u3400-\u9fff]+等级\s*\d+|[a-z -]+\s+levels?\s*\d+)$/i.test(text);
    const pending=(p.items?.length||p.items?.size)||text&&!onlyLevel;
    const knownLevel=Number.isFinite(p.level)||!text;
    remember(d,true);
    return {...ref(d),eligibility:pending?'conditional':knownLevel?'level-eligible':'review-required',
      requirements:text};
  };
  const casting=cls.selected?.system.spellcasting;
  let spellAccess=null;
  if(casting?.progression==='pact'&&typeof CONFIG!=='undefined'){
    const table=CONFIG.DND5E.pactCastingProgression||{};
    const key=Object.keys(table).map(Number).filter(n=>n<=level).sort((a,b)=>b-a)[0];
    if(key!==undefined)spellAccess={...table[key],source:'CONFIG.DND5E.pactCastingProgression',scope:'requested class only'};
  }else if(casting?.progression&&typeof CONFIG!=='undefined'){
    const prog=CONFIG.DND5E.spellcasting?.spell?.progression?.[casting.progression];
    const divisor=prog?.divisor||(casting.progression==='full'?1:null);
    const initial=divisor?(prog?.roundUp?Math.ceil:Math.floor)(level/divisor):0;
    const effective=initial&&divisor>1?Math.ceil(level/divisor):initial;
    const row=effective?CONFIG.DND5E.SPELL_SLOT_TABLE?.[effective-1]:null;
    if(row)spellAccess={level:row.length,slotsByLevel:row,source:'CONFIG.DND5E.SPELL_SLOT_TABLE',scope:'requested class only'};
  }
  // Read links before preview truncation. Only spell-labelled table rows are included;
  // descriptive links elsewhere do not become automatic grants.
  const spellTables=[];
  if(sub.selected){
    const html=String(sub.selected.system.description?.value||'');
    for(const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi)||[]){
      if(!/法术|spell/i.test(table))continue;
      const entries=[],seen=new Set();
      for(const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[]){
        for(const m of row.matchAll(/@UUID\[([^\]]+)\]/g)){
          const d=await read(m[1]);
          if(!d){unresolved.push({uuid:m[1],reason:'spell table link missing'});continue;}
          if(d.type!=='spell')continue;
          if(!edition(d)){unresolved.push({uuid:m[1],reason:'spell table edition mismatch'});continue;}
          const rank=d.system.level;
          if(!Number.isFinite(rank)){unresolved.push({uuid:d.uuid,reason:'spell level missing'});continue;}
          if(spellAccess&&rank>spellAccess.level)continue;
          if(seen.has(d.uuid))continue;seen.add(d.uuid);remember(d,true);
          entries.push({...ref(d),spellLevel:rank,eligibility:spellAccess?'level-eligible':'review-required'});
        }
      }
      if(entries.length)spellTables.push({sourceUuid:sub.selected.uuid,
        interpretation:rules==='2014'&&casting?.progression==='pact'?'expanded-list-candidates-not-granted':'linked-spells-not-assumed-granted',entries});
    }
  }
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
        let pool=c.pool||[];
        if(!pool.length&&c.type==='feat'&&c.restriction?.type&&c.restriction?.subtype){
          // Mirror the system's typed compendium picker within the selected package.
          // This expands a declared category, never rematches an explicit link.
          const namespace=root.selected.pack.slice(0,root.selected.pack.lastIndexOf('.')+1);
          const entries=[];
          for(const p of packs.filter(p=>p.collection.startsWith(namespace))){
            for(const e of await index(p))if(e.type==='feat'&&e.system?.type?.value===c.restriction.type&&e.system?.type?.subtype===c.restriction.subtype){
              const d=await p.getDocument(e._id);if(edition(d))entries.push(d.uuid);
            }
          }
          pool=[...new Set(entries)];c.poolSource={kind:'selected-package-category',namespace,restriction:c.restriction};
        }
        const originalCount=pool.length;
        c.pool=(await Promise.all(pool.map(r=>candidate(typeof r==='string'?r:r.uuid,c.restriction)))).filter(Boolean);
        c.excludedByLevel=originalCount-c.pool.length;
        if(!c.pool.length)unresolved.push({uuid:root.selected.uuid,advancementId:a._id,title:a.title,reason:'choice has no explicit eligible candidates; inspect source restriction/list configuration'});
        c.eligibilityNote='Level checked at target level; conditional requirements must be satisfied before selection. Historical acquisition is not validated.';
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
  return {version:5,level,rules,classRole,...projected,spellAccess,spellTables,documents:[...documents.values()].map(d=>{
      const prune=v=>Array.isArray(v)?v.map(prune):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,prune(x)]).filter(([k,x])=>x!==undefined&&x!==null&&x!==''&&!(typeof x==='object'&&Object.keys(x).length===0))):v;
      return prune(d);
    }),fallbacks,unresolved,
    sourcePolicy:'Select roots with automation-pack preference; follow their exact advancement UUIDs without cross-pack replacement. Missing links are unresolved, not silently substituted.',
    scope:'Cumulative configured grants and choices from selected sources, not a completeness certification. Class and subclass contributions remain separate; no text conflict arbitration. Choices require selection. Importing class Items does not apply all advancements; write and verify normal proficiencies/resources.'};
}
module.exports={queryBuild,createTool(evaluate){return {
  name:'foundry_build_query',label:'Read character build sources',
  description:'Read actual import sources for class, selected subclass and race through a level. Returns exact linked UUIDs from the selected sources, document mechanics, grants and choices; missing links are explicit. Include subclassName when known. Read-only.',
  parameters:{type:'object',properties:{className:{type:'string'},level:{type:'integer',minimum:1,maximum:20},raceName:{type:'string'},subclassName:{type:'string'},rules:{type:'string',enum:['2014','2024']},classRole:{type:'string',enum:['primary','secondary']}},required:['className','level'],additionalProperties:false},
  async execute(id,args){const result=await evaluate(`(${queryBuild.toString()})(${JSON.stringify(args)})`);return {content:[{type:'text',text:JSON.stringify(result)}],details:{readOnly:true}};}
};}};
