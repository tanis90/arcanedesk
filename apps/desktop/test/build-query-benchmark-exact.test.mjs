import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const rows=require('../docs/prep-build-query-benchmark-exact.json');
const {cases}=require('./character-benchmark/cases.cjs');
for(const c of cases)test(c.id+' exact benchmark query',()=>{
 const {args,result:r}=rows.find(x=>x.id===c.id);
 assert.equal(args.level,c.level);assert.equal(args.className,c.cls);assert.equal(args.subclassName,c.subclass);
 assert.equal(r.unresolved.length,0);assert.ok(r.class&&r.subclass);if(c.ancestry)assert.ok(r.race);
 for(const root of [r.class,r.subclass,r.race].filter(Boolean))for(const a of root.advancements)assert.ok(a.level==null||a.level<=c.level);
 if(c.cls==='wizard'){
  assert.deepEqual(r.spellAccess.slotsByLevel,[4,3,2]);
  assert.ok(r.documents.find(d=>d.type==='subclass').description.includes('塑能学者'));
 }
 if(c.cls==='cleric'){
  assert.deepEqual(r.spellAccess.slotsByLevel,[4,2]);assert.equal(r.spellTables[0].entries.length,4);
  assert.ok(!r.documents.some(d=>/Destroy Undead/.test(d.name)));
  assert.ok(r.subclass.advancements.some(a=>a.configuration.grants?.includes('armor:hvy')));
 }
 if(c.cls==='rogue'){
  const sneak=r.class.advancements.find(a=>a.configuration.identifier==='sneak-attack');assert.equal(sneak.configuration.current.number,2);
  assert.ok(!r.documents.some(d=>/Uncanny Dodge/.test(d.name)));
  assert.ok(r.class.advancements.some(a=>a.configuration.mode==='expertise'&&a.configuration.choices[0].count===2));
 }
 if(c.cls==='fighter')assert.ok(r.documents.some(d=>d.identifier==='extra-attack-fighter'));
});
