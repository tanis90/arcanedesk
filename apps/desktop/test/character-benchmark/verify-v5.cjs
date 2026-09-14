// Character A-case policy; historical v3/v4 remain unchanged.
const prior=require('./verify-v4.cjs');
function verify(plan,actual,receipt){
 const result=prior.verify(plan,actual,receipt);
 if(actual && !plan.source){
  const unique=result.checks.find(c=>c.id==='actor.unique');
  unique.ok=actual.sameNameCount===1;
  result.checks.push({id:'actor.type',priority:'core',ok:actual.type==='character',expected:'character',observed:actual.type});
  const caster=result.checks.find(c=>c.id==='spells.caster');
  if(caster){const ability=plan.cls==='cleric'?'wis':'int';
   caster.ok=actual.effective.spellcasting===ability && actual.effective.level===plan.level;
   caster.expected={ability,level:plan.level};caster.observed={ability:actual.effective.spellcasting,level:actual.effective.level};}
 }
 result.corePass=result.checks.filter(c=>c.priority==='core').every(c=>c.ok);
 result.configurationPass=result.checks.every(c=>c.ok);
 return result;
}
module.exports={verify,canonical:prior.canonical};
