import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{verify}=require('./verify-v4.cjs'),old=require('./verify-v3.cjs'),{cases}=require('./cases.cjs');
const fixture=require('./real-a1-projection.json');const a=structuredClone(fixture.actual),p={...cases[0],gear:[['quarterstaff',1]]};
for(const k of ['arc','inv']){a.raw.system.skills[k].ability='int';a.effective.skills[k].ability='int';}
assert.equal(verify(p,a,fixture.receipt).configurationPass,true);
a.raw.items=a.raw.items.filter(i=>i.system?.identifier!=='evocation-savant'&&!/Evocation Savant|塑能学者/.test(i.name));
const source=require('../../docs/prep-build-query-benchmark-exact.json')[0].result.documents.find(d=>d.type==='subclass');
const sub=a.raw.items.find(i=>i.type==='subclass');sub._stats.compendiumSource=source.uuid;sub.system.description={value:source.description};
assert.equal(old.verify(p,a,fixture.receipt).checks.find(c=>c.id==='feature.evocation-savant').ok,false);
assert.equal(verify(p,a,fixture.receipt).configurationPass,true,'actual queried subclass representation passes');
for(const kind of ['missing-rule','spoof-source','wrong-class','title-only','skill-defect']){
 const bad=structuredClone(a),s=bad.raw.items.find(i=>i.type==='subclass');
 if(kind==='missing-rule')s.system.description.value='';
 if(kind==='spoof-source')s._stats.compendiumSource='Compendium.fake.Item.fake';
 if(kind==='wrong-class')s.system.classIdentifier='fighter';
 if(kind==='title-only')s.system.description.value='塑能学者Evocation Savant';
 if(kind==='skill-defect')bad.effective.skills.arc.ability='dex';
 assert.equal(verify(p,bad,fixture.receipt).configurationPass,false,kind);
}
console.log('v4: both legal representations, frozen-v3 mismatch and five negative variants passed');
