import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import verify from './fixtures/prep-werewolf-verifier.cjs';
function fixture(){
  const item=(name,type,system)=>({name,type,system,toObject(){return {name:this.name,type:this.type,system:this.system};}});
  const baseItem=item('Bite','weapon',{activities:[{type:'attack'}],damage:{base:{number:1,denomination:8}},description:{value:'Original bite'}});
  const bow=item('Longbow','weapon',{identifier:'longbow',quantity:1,damage:{base:{number:1,denomination:8,types:['piercing']}},activities:[{type:'attack',attack:{type:{value:'ranged'}}}]});
  const surge=item('Action Surge','feat',{identifier:'action-surge',activities:[{consumption:{targets:[{type:'itemUses',target:'',value:'1'}]}}],uses:{max:1,value:1,spent:0,recovery:[{period:'sr',type:'recoverAll'}]}});
  const system={abilities:Object.fromEntries(['str','dex','con','int','wis','cha'].map(k=>[k,{value:12}])),attributes:{hp:{max:58,value:58}},details:{type:{value:'humanoid',subtype:'Shapechanger'}},traits:{di:{value:['piercing'],bypasses:['mgc','sil']}}};
  const sources=structuredClone({werewolf:{system,items:[baseItem.toObject()]},longbow:bow.toObject()});
  const a={name:'test',type:'npc',uuid:'Actor.test',system,items:[baseItem,bow,surge],toObject(){return {system:this.system};}};
  return {a,f:{newName:'test',werewolfSources:sources}};
}
const check=({a,f})=>verify(code=>vm.runInNewContext(code,{game:{actors:[a]}}),f);
test('transfer accepts preserved base mechanics and resolved one-use resource',async()=>{const r=await check(fixture());assert.equal(r.ok,true);assert.equal(r.manualReviewRequired,true);});
test('transfer rejects unresolved class scale rather than trusting feat name',async()=>{const x=fixture();x.a.items[2].system.uses.max=0;x.a.items[2].system.uses.value=0;assert.equal((await check(x)).checks.surgeResources,false);});
test('transfer detects removed original abilities and empty longbow mechanics',async()=>{const x=fixture();x.a.items.shift();x.a.items[0].system.activities=[];const r=await check(x);assert.equal(r.checks.originalMechanics,false);assert.equal(r.checks.longbow,false);});
