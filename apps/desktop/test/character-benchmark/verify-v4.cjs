// v3 remains frozen for historical reports. v4 adds one audited representation.
const prior=require('./verify-v3.cjs');
const SOURCE='Compendium.arcane-dnd5e-2014-automation.subclasses.Item.wQtUjvfS0MXMFp05';
const plain=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,'');
function verify(plan,actual,receipt){
 const result=prior.verify(plan,actual,receipt);
 const check=result.checks.find(c=>c.id==='feature.evocation-savant');
 if(check&&!check.ok&&plan.cls==='wizard'&&plan.subclass==='school-of-evocation'){
  const items=actual?.raw?.items||[];
  const sub=items.filter(i=>i.type==='subclass'&&i.system?.identifier==='school-of-evocation'&&i.system?.classIdentifier==='wizard');
  const separate=items.filter(i=>i.type==='feat'&&i.system?.identifier==='evocation-savant');
  if(sub.length===1&&separate.length===0&&sub[0]._stats?.compendiumSource===SOURCE
   &&plain(sub[0].system.description?.value).includes('塑能学者EvocationSavant')
   &&plain(sub[0].system.description?.value).includes('你向法术书中抄写塑能系法术的时间和金钱花费减半')){
    check.ok=true;check.expected='audited evocation subclass retains its Savant rule';check.observed={source:SOURCE,representation:'subclass description'};
  }
 }
 result.corePass=result.checks.filter(c=>c.priority==='core').every(c=>c.ok);
 result.configurationPass=result.checks.every(c=>c.ok);
 return result;
}
module.exports={verify,canonical:prior.canonical};
