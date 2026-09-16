import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import verify from './fixtures/prep-npc-priest-verifier.cjs';
function fixture(){
  const source={type:'spell',system:{identifier:'bless',level:1,source:{rules:'2014'},activities:[{type:'utility',duration:{concentration:true},consumption:{spellSlot:true}}]},toObject(){return {system:this.system,effects:[]};}};
  const bless={name:'Bless',type:'spell',system:{...structuredClone(source.system),method:'spell',prepared:1},toObject(){return {name:this.name,type:this.type,system:this.system,effects:[],_stats:{compendiumSource:'Compendium.test.bless'}};}};
  const hammer={name:'Light Hammer',type:'weapon',system:{identifier:'light-hammer',quantity:1,equipped:true,activities:[{type:'attack'}]},toObject(){return {system:this.system};}};
  const system={details:{type:{value:'humanoid',subtype:'Elf'}},abilities:{wis:{value:16}},attributes:{spellcasting:'wis',spell:{level:3},hp:{value:18,max:18},ac:{value:12},prof:2},spells:Object.fromEntries([1,2,3,4,5,6,7,8,9].map(n=>['spell'+n,{value:[0,4,2][n]??0,max:[0,4,2][n]??0}]))};
  const a={name:'test',type:'npc',uuid:'Actor.test',system,items:[bless,hammer],toObject(){return {system:this.system};}};
  return {a,source};
}
const check=({a,source})=>verify(code=>vm.runInNewContext(code,{game:{actors:[a]},fromUuid:async()=>source}),{newName:'test'});
test('priest transfer accepts source-preserving prepared spell and requested caster data',async()=>{const r=await check(fixture());assert.equal(r.ok,true);assert.equal(r.manualReviewRequired,true);});
test('priest transfer rejects name-only spell and unready equipment',async()=>{const f=fixture();f.a.items[0].system.activities=[];f.a.items[1].system.equipped=false;const r=await check(f);assert.equal(r.checks.bless,false);assert.equal(r.checks.hammer,false);});
test('priest transfer rejects wrong ability and higher inherited slots',async()=>{const f=fixture();f.a.system.attributes.spellcasting='int';f.a.system.spells.spell3={value:2,max:2};const r=await check(f);assert.equal(r.checks.spellcasting,false);assert.equal(r.checks.slots,false);});
test('priest transfer ignores import metadata but rejects changed effect mechanics',async()=>{
  const f=fixture(),b=f.a.items[0],original=b.toObject.bind(b),sourceOriginal=f.source.toObject.bind(f.source);
  let value='1d4';
  b.toObject=()=>({...original(),effects:[{_id:'new',_stats:{systemVersion:'5.3.3'},changes:[{key:'bonus',value}]}]});
  f.source.toObject=()=>({...sourceOriginal(),effects:[{_id:'old',_stats:{systemVersion:null},changes:[{key:'bonus',value:'1d4'}]}]});
  assert.equal((await check(f)).ok,true);
  value='2d4';assert.equal((await check(f)).checks.bless,false);
});
test('priest transfer rejects a spell from the unrequested rules edition',async()=>{
  const f=fixture();f.a.items[0].system.source.rules='2024';assert.equal((await check(f)).checks.spellRules,false);
});
