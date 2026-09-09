import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {queryBuild}=createRequire(import.meta.url)('./fixtures/prep-build-query.cjs');
function fixture(){
 const docs=new Map();
 const doc=(id,name,type,pack,system={})=>{const d={uuid:id,name,type,pack,system:{source:{rules:'2014'},...system},toObject(){return {name,type,system:structuredClone(this.system),effects:[]};}};docs.set(id,d);return d;};
 doc('native-feature','Power','feat','dnd5e.classfeatures',{identifier:'power',description:{value:'native power'}});
 doc('auto-feature','Power','feat','arcane-dnd5e-2014-automation.classfeatures',{identifier:'-power',description:{value:'actual automation'},activities:{a:{type:'utility'}}});
 doc('sub-feature','Sub Power','feat','dnd5e.classfeatures',{identifier:'sub-power'});
 const adv={grant:{type:'ItemGrant',level:1,configuration:{items:[{uuid:'native-feature'}]}},future:{type:'ItemGrant',level:9,configuration:{items:[{uuid:'future'}]}},scale:{type:'ScaleValue',configuration:{scale:{1:{value:1},5:{value:2},9:{value:3}}}},secondary:{type:'Trait',classRestriction:'secondary',configuration:{grants:['skills:x']}},sub:{type:'Subclass',level:2,configuration:{}}};
 doc('native-class','Wizard','class','dnd5e.classes',{identifier:'wizard',advancement:adv});
 doc('auto-class','Wizard','class','arcane-dnd5e-2014-automation.classes',{identifier:'wizard',advancement:{...adv,grant:{type:'ItemGrant',level:1,configuration:{items:[{uuid:'auto-feature'}]}}}});
 doc('native-sub','Evocation','subclass','dnd5e.subclasses',{identifier:'evocation',classIdentifier:'wizard',advancement:{grant:{type:'ItemGrant',level:2,configuration:{items:[{uuid:'sub-feature'}]}}}});
 const packs=[...new Set([...docs.values()].map(d=>d.pack))].map(collection=>({collection,documentName:'Item',getIndex:async()=>[...docs.values()].filter(d=>d.pack===collection).map(d=>({_id:d.uuid,name:d.name,type:d.type,system:d.system})),getDocument:async id=>docs.get(id)}));
 const execute=vm.runInNewContext('('+queryBuild.toString()+')',{game:{packs},CONFIG:{DND5E:{pactCastingProgression:{1:{slots:1,level:1},5:{slots:2,level:3}}}},fromUuid:async id=>docs.get(id)});
 return {execute,docs};
}
test('actual import sources, selected subclass and source immutability',async()=>{
 const {execute,docs}=fixture(),before=JSON.stringify([...docs.values()].map(d=>d.toObject()));
 const r=await execute({className:'wizard',subclassName:'evocation',level:5});
 assert.equal(r.class.uuid,'auto-class');
 assert.equal(r.class.advancements.find(a=>a.type==='ItemGrant').configuration.items[0].uuid,'auto-feature');
 assert.equal(r.documents.find(d=>d.uuid==='auto-feature').description,'actual automation');
 assert.equal(r.documents.find(d=>d.uuid==='auto-feature').activities[0].type,'utility');
 assert.equal(r.subclass.advancements[0].configuration.items[0].uuid,'sub-feature');
 assert.equal(r.fallbacks.length,0);assert.equal(r.unresolved.length,0);
 assert.equal(r.class.advancements.find(a=>a.type==='ScaleValue').configuration.current.value,2);
 assert.ok(!JSON.stringify(r).includes('future'));assert.ok(!JSON.stringify(r).includes('skills:x'));
 assert.equal(JSON.stringify([...docs.values()].map(d=>d.toObject())),before);
});
test('unknown subclass and wrong edition are explicit, not guessed',async()=>{
 const {execute}=fixture();
 assert.ok((await execute({className:'wizard',level:5})).unresolved.some(x=>x.kind==='subclass'));
 assert.equal((await execute({className:'wizard',level:5,rules:'2024'})).class,null);
 await assert.rejects(()=>execute({className:'wizard',level:0}),/1..20/);
});
test('selected links win even with different names and competing same-name Items',async()=>{
 const {execute,docs}=fixture();
 docs.get('auto-feature').name='Power (Wizard)';docs.get('auto-feature').system.identifier='power-wizard';
 const original=docs.get('auto-feature');docs.set('decoy',{...original,uuid:'decoy',name:'Power',system:{...original.system,identifier:'power'}});
 const r=await execute({className:'wizard',subclassName:'evocation',level:5});
 assert.equal(r.class.advancements.find(a=>a.type==='ItemGrant').configuration.items[0].uuid,'auto-feature');
 assert.ok(!r.documents.some(d=>d.uuid==='decoy'));
});
test('missing links and empty growth are explicit and never replaced with native growth',async()=>{
 const {execute,docs}=fixture();
 docs.delete('auto-feature');
 let r=await execute({className:'wizard',subclassName:'evocation',level:5});
 assert.ok(r.unresolved.some(x=>x.uuid==='auto-feature'));
 assert.ok(!r.documents.some(d=>d.uuid==='native-feature'));
 docs.get('auto-class').system.advancement={};
 r=await execute({className:'wizard',subclassName:'evocation',level:5});
 assert.equal(r.class.advancements.length,0);
 assert.ok(r.unresolved.some(x=>x.uuid==='auto-class'));
});
test('an explicitly linked native Item is not replaced by its automated namesake',async()=>{
 const {execute,docs}=fixture();
 docs.get('auto-class').system.advancement.grant.configuration.items=[{uuid:'native-feature'}];
 const r=await execute({className:'wizard',subclassName:'evocation',level:5});
 assert.equal(r.class.advancements.find(a=>a.type==='ItemGrant').configuration.items[0].uuid,'native-feature');
});

test('choice filtering uses structured levels and keeps unknown item/text requirements conditional',async()=>{
 const {execute,docs}=fixture();const base=docs.get('auto-feature');
 for(const [id,prerequisites,requirements] of [['high',{level:15},''],['legal',{level:2},''],['conditional',{level:5,items:['pact-blade']},'Pact of the Blade'],['unknown',{},'Unencoded prerequisite']])
 docs.set(id,{...base,uuid:id,system:{...base.system,prerequisites,requirements}});
 docs.get('auto-class').system.advancement={choice:{type:'ItemChoice',configuration:{choices:{2:{count:2},5:{count:1},9:{count:1}},pool:['high','legal','conditional','unknown']}}};
 const r=await execute({className:'wizard',subclassName:'evocation',level:5});const c=r.class.advancements[0].configuration;
 assert.equal(c.excludedByLevel,1);assert.equal(c.pool.length,3);assert.equal(c.pool.find(x=>x.uuid==='conditional').eligibility,'conditional');
 assert.equal(c.pool.find(x=>x.uuid==='unknown').eligibility,'conditional');
 assert.ok(!r.documents.some(x=>x.uuid==='high'));assert.ok(!c.choices[9]);
});
test('spell table links after preview limit are read, filtered by system slots, and never granted',async()=>{
 const {execute,docs}=fixture();const base=docs.get('sub-feature');
 docs.get('auto-class').system.spellcasting={progression:'pact'};
 for(const [id,level] of [['spell3',3],['spell4',4]])docs.set(id,{...base,uuid:id,type:'spell',system:{...base.system,level}});
 docs.get('native-sub').system.description={value:'x'.repeat(1200)+'<table><tr><th>Spell level</th></tr><tr><td>3</td><td>@UUID[spell3]</td></tr><tr><td>4</td><td>@UUID[spell4]</td></tr></table>'};
 const r=await execute({className:'wizard',subclassName:'evocation',level:5});
 assert.equal(r.spellAccess.slots,2);assert.equal(r.spellTables[0].entries.length,1);assert.equal(r.spellTables[0].entries[0].uuid,'spell3');
 assert.equal(r.spellTables[0].interpretation,'expanded-list-candidates-not-granted');assert.ok(!r.documents.some(x=>x.uuid==='spell4'));
});
