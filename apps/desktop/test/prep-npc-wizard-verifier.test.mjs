import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import verify from './fixtures/prep-npc-wizard-verifier.cjs';

function actor() {
  const activity={type:'save',save:{ability:['dex']},consumption:{spellSlot:true},damage:{onSave:'half',parts:[{number:8,denomination:6,types:['fire']}]}};
  const items=[{type:'spell',name:'火球术',system:{identifier:'fireball',level:3,method:'spell',prepared:1,activities:[activity]}},{type:'weapon',name:'长棍',system:{identifier:'quarterstaff',equipped:true,quantity:1}}];
  items.forEach(i=>i.toObject=()=>({type:i.type,name:i.name,system:i.system}));
  const system={details:{type:{value:'humanoid',subtype:'human'}},abilities:{int:{value:18}},attributes:{spellcasting:'int',spell:{level:5},hp:{value:30,max:30}},spells:Object.fromEntries([1,2,3,4,5,6,7,8,9].map(n=>['spell'+n,{value:[0,4,3,2][n]??0,max:[0,4,3,2][n]??0}]))};
  return {name:'test',type:'npc',uuid:'Actor.test',system,items,effects:[],toObject:()=>({system})};
}
async function check(a){return verify(code=>vm.runInNewContext(code,{game:{actors:[a]}}),{newName:'test'});}
test('accepts mechanically configured NPC but preserves manual review requirement',async()=>{const r=await check(actor());assert.equal(r.ok,true);assert.equal(r.manualReviewRequired,true);});
test('rejects name-only Fireball and overlevelled copied Mage slots',async()=>{const a=actor();a.items[0].system.activities=[];assert.equal((await check(a)).checks.fireball,false);a.system.spells.spell4={value:3,max:3};assert.equal((await check(a)).checks.slots,false);});
test('rejects wrong actor type, missing human identity and unequipped staff',async()=>{const a=actor();a.type='character';a.system.details.type.subtype='elf';a.items[1].system.equipped=false;const r=await check(a);assert.equal(r.checks.singleNpc,false);assert.equal(r.checks.human,false);assert.equal(r.checks.staff,false);});
