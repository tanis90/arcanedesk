import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{verify}=require('./verify-v3.cjs'),{cases}=require('./cases.cjs');
const fixture=require('./real-a1-projection.json'),a=structuredClone(fixture.actual),p={...cases[0],gear:[['quarterstaff',1]]},receipt=fixture.receipt;
const actualResult=verify(p,a,receipt);assert.deepEqual(actualResult.checks.filter(x=>!x.ok).map(x=>x.id),['skills.abilities'],'actual card has a separate skill-ability defect');
// Correct a copy only, to isolate the valid source/race representation from that real defect.
for(const k of ['arc','inv']){a.effective.skills[k].ability='int';a.raw.system.skills[k].ability='int';}
const result=verify(p,a,receipt);assert.equal(result.configurationPass,true,'alternate source/representation with corrected skill abilities should pass');
const spoof=structuredClone(a);spoof.raw.items.find(i=>i.name.includes('Sculpt Spells'))._stats.compendiumSource='Compendium.fake.Item.fake';assert.equal(verify(p,spoof,receipt).checks.find(x=>x.id==='feature.sculpt-spells').ok,false);
const high=structuredClone(a);high.raw.items.push({_id:'excess',type:'feat',name:'Empowered Evocation',system:{identifier:''},_stats:{compendiumSource:'Compendium.arcane-dnd5e-2014-automation.classfeatures.Item.SLo1i2EiMrGl2MzS'}});assert.equal(verify(p,high,receipt).checks.find(x=>x.id==='features.level-ceiling').ok,false);
const depleted=structuredClone(a);const feat=depleted.raw.items.find(i=>i.name.includes('Arcane Recovery'));depleted.effective.items.find(i=>i.id===feat._id).uses.value=0;assert.equal(verify(p,depleted,receipt).checks.find(x=>x.id==='resource.arcane-recovery').ok,false);
const excessSpell=structuredClone(a);const extraThird=excessSpell.raw.items.find(i=>i.type==='spell'&&i.system.level===1);extraThird.system.level=3;extraThird.system.identifier='fly';const relaxed=verify(p,excessSpell,receipt);assert.equal(relaxed.diagnostics.find(x=>x.id==='spells.acquisition').ok,false);assert.equal(relaxed.configurationPass,true,'extra third-level choice is diagnostic only under revised task policy');
const wrongList=structuredClone(a);wrongList.raw.items.find(i=>i.type==='spell'&&i.system.level===1).system.identifier='healing-word';assert.equal(verify(p,wrongList,receipt).checks.find(x=>x.id==='spells.known-membership').ok,false);
const wrongAbility=structuredClone(a);wrongAbility.effective.skills.prc.ability='dex';assert.equal(verify(p,wrongAbility,receipt).checks.find(x=>x.id==='skills.abilities').ok,false);
const noAttack=structuredClone(a);noAttack.raw.items.find(i=>i.system.identifier==='quarterstaff').system.activities={};assert.equal(verify(p,noAttack,receipt).checks.find(x=>x.id==='weapon.activity.quarterstaff').ok,false);
console.log('v3 regression: actual skill defect + corrected-copy positive + diagnostic-only positive + 6 invalid variants passed.');
