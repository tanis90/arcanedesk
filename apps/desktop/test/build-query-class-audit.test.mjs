import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const audit=JSON.parse(fs.readFileSync(new URL('../docs/prep-build-query-class-sweep-v6.json',import.meta.url)));
const cases=JSON.parse(fs.readFileSync(new URL('./fixtures/build-query-class-cases.json',import.meta.url)));
const expected={artificer:['实验性灵药','炼金术掌握'],warlock:['黑暗赐福'],bard:['诗人激励','激励之源'],ranger:['猎物','额外攻击'],cleric:['生命门徒','维持生命'],barbarian:['狂怒','快速移动'],monk:['散打技巧','震慑拳'],fighter:['精通重击','额外攻击 (战士)'],rogue:['快手','梁上君子','直觉闪避'],sorcerer:['巨龙先祖','龙族体魄'],wizard:['法术塑形'],druid:['战斗荒野形态','结社形态'],paladin:['Sacred Weapon','Turn the Unholy']};
test('snapshot matches current query and covers every fixed class once',()=>{
 assert.equal(audit.querySha256,createHash('sha256').update(fs.readFileSync(new URL('./fixtures/prep-build-query.cjs',import.meta.url))).digest('hex'));
 assert.deepEqual(audit.rows.map(r=>r.input),cases);assert.equal(new Set(cases.map(c=>c.className)).size,13);
});
for(const {input,result:r} of audit.rows)test(input.className+' selected subclass, grants, choices and level scope',()=>{
 assert.ok(r.class&&r.subclass);const docs=r.documents.map(d=>d.name).join('\n');
 for(const name of expected[input.className])assert.ok(docs.includes(name),name);
 for(const root of [r.class,r.subclass])for(const a of root.advancements){
  assert.ok(a.level==null||a.level<=5);
  if(a.type==='ItemChoice')for(const entry of a.configuration.pool){const d=r.documents.find(d=>d.uuid===entry.uuid);if(d)assert.ok(d.prerequisites?.level==null||d.prerequisites.level<=5);}
 }
 if(['artificer','ranger','paladin'].includes(input.className))assert.equal(r.spellAccess.level,2);
 if(['artificer','paladin'].includes(input.className))assert.equal(r.spellTables[0].entries.length,4);
 if(input.className==='artificer')assert.equal(r.unresolved.filter(x=>x.reason==='description list link missing').length,14);
 else if(input.className==='druid')assert.equal(r.unresolved[0].reason,'linked document edition mismatch');
 else assert.equal(r.unresolved.length,0);
 if(input.className==='bard')assert.ok(r.subclass.advancements.some(a=>a.type==='Trait'&&a.configuration.choices.some(c=>c.count===3)));
 if(input.className==='wizard')assert.ok(r.documents.find(d=>d.type==='subclass').description.includes('塑能学者'));
});
