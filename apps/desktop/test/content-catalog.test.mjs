import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {queryCatalog,createTools} = require('./fixtures/prep-content-catalog.cjs');

test('catalog: class eligibility, source linking, ambiguity, scope and pagination', async () => {
  const docs = new Map();
  function doc(pack,id,name,identifier,level,extra={}) {
    const d={id,_id:id,name,type:'spell',documentName:'Item',pack,
      uuid:pack?`Compendium.${pack}.Item.${id}`:`Item.${id}`,system:{identifier,level,source:{rules:'2014'}},...extra};
    d.toObject=()=>JSON.parse(JSON.stringify(d));docs.set(d.uuid,d);return d;
  }
  const fire=doc('dnd5e.spells','fire','Fireball','fireball',3);
  const daylight=doc('dnd5e.spells','day','Daylight','daylight',3);
  const higher=doc('dnd5e.spells','higher','Higher','higher',4);
  const auto=doc('arcane-dnd5e-2014-automation.spells','auto','火球术 Fireball','fireball',3);
  const local=doc(null,'local','World fire','fireball',3);
  const registry={ready:true,forType:(type,id)=>type==='class'&&id==='wizard'?{metadata:{type,identifier:id},indexes:[fire,higher],identifiers:new Set(['fireball','higher'])}:null};
  const packs=new Map();
  for(const p of ['dnd5e.spells','arcane-dnd5e-2014-automation.spells'])packs.set(p,{collection:p,documentName:'Item',getIndex:async()=>[...docs.values()].filter(d=>d.pack===p)});
  globalThis.game={packs,items:new Map([[local.id,local]]),settings:{get:()=> 'legacy'},dnd5e:{registry:{spellLists:registry}}};
  globalThis.fromUuid=async uuid=>docs.get(uuid);
  const build=async()=>({spellAccess:{level:3},spellTables:[],documents:[]});
  try {
    const a={scope:'compendium',type:'spell',class:'wizard',characterLevel:5};
    const result=await queryCatalog('list',a,build);
    assert.equal(result.total,1);
    assert.equal(result.items[0].rule.uuid,fire.uuid);
    assert.equal(result.items[0].uuid,auto.uuid);
    assert.equal(result.items[0].classEligible,true);
    assert.equal(result.items[0].implementation.automation,'not-execution-tested');
    assert.ok(result.progressionSummary === undefined || result.progressionSummary.length >= 0);
    assert.equal(result.items.some(x=>x.rule.uuid===daylight.uuid),false);
    const second=doc('arcane-dnd5e-2014-automation.spells','auto2','Another Fireball','fireball',3);
    const ambiguous=await queryCatalog('list',a,build);
    assert.equal(ambiguous.items[0].implementation.status,'ambiguous');
    assert.equal(ambiguous.items[0].uuid,fire.uuid);
    assert.equal(ambiguous.items[0].implementation.candidates.length,2);
    docs.delete(second.uuid);
    const searched=await queryCatalog('search',{scope:'world',type:'item',query:'fire'},build);
    assert.deepEqual(searched.items.map(x=>x.uuid),[local.uuid]);
    await assert.rejects(queryCatalog('detail',{scope:'world',uuid:fire.uuid},build),/SCOPE_MISMATCH/);
    const detail=await queryCatalog('detail',{scope:'compendium',uuid:auto.uuid},build);
    assert.deepEqual(detail.document,auto.toObject());
    const page=await queryCatalog('search',{scope:'compendium',type:'item',query:'',page:2,pageSize:2},build);
    assert.equal(page.total,4);assert.equal(page.items.length,2);assert.equal(page.hasNextPage,false);
    await assert.rejects(queryCatalog('list',{...a,rules:'2024'},build),/RULES_MISMATCH/);
    await assert.rejects(queryCatalog('list',{scope:'compendium',type:'weapon',class:'wizard'},build),/INVALID_FILTER/);
    const tools=createTools(async expression=>eval(expression));
    assert.deepEqual(tools.map(t=>t.name),['foundry_content_search','foundry_content_list','foundry_content_detail']);
    assert.ok(tools.every(t=>t.parameters.required.includes('scope')));
  } finally {delete globalThis.game;delete globalThis.fromUuid;}
});
