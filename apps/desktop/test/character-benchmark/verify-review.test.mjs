// Run against real read-back artifacts; corrupt copies only, never the FVTT world.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{cases}=require('./cases.cjs');
const version=process.argv.find(x=>x.startsWith('--verifier='))?.slice(11)||'v3';
const {verify}=require('./verifier.cjs').selectVerifier(version);
const root=process.argv.find(x=>x.startsWith('--artifacts='))?.slice(12)||path.join(os.tmpdir(),'character-review-20260909-'+version);
const load=(id,suffix)=>JSON.parse(fs.readFileSync(path.join(root,`${id}-${suffix}.json`)));
const results=[];
for(const p of cases){const r=verify(p,load(p.id,'snapshot'),load(p.id,'receipt'));assert.equal(r.configurationPass,true,p.id+' positive control');results.push({id:p.id+'.positive',ok:true});}
const mutations=[
 ['A1','actor.unique',a=>a.sameNameCount=2],
 ['A1','class.level',a=>a.raw.items.find(i=>i.type==='class').system.levels=4],
 ['A1','class.subclass',a=>a.raw.items=a.raw.items.filter(i=>i.type!=='subclass')],
 ['A1','feature.sculpt-spells',a=>a.raw.items=a.raw.items.filter(i=>i.system.identifier!=='sculpt-spells')],
 ['A1','abilities.requested',a=>a.effective.abilities.int.value=16],
 ['A1','hp.full',a=>a.effective.hp.value--],
 ['A1','movement.walk',a=>a.effective.walk=0],
 ['A1','spells.slots',a=>a.effective.slots.spell4.max=1],
 ['A1','spells.book',a=>a.raw.items=a.raw.items.filter(i=>i.system.identifier!=='invisibility')],
 ['A1','fireball.ready',a=>a.raw.items.find(i=>i.system.identifier==='fireball').system.activities={}],
 ['B2','scale.sneak-attack',a=>a.effective.scale.rogue['sneak-attack'].number=1],
 ['A2','resource.action-surge',a=>a.effective.items.find(i=>i.identifier==='action-surge').uses.max=0],
 ['A2','gear.shield',a=>a.raw.items.find(i=>i.system.identifier==='shield').system.equipped=false],
 ['A2','feature.action-surge',a=>a.raw.items.find(i=>i.system.identifier==='action-surge')._stats.compendiumSource='fake'],
 ['A3','domain.bless',a=>a.raw.items=a.raw.items.filter(i=>i.system.identifier!=='bless')],
 ['B1','preserve.trait.di',a=>a.raw.system.traits.di={value:[],custom:'corrupted'}],
 ['B1','source.unchanged',a=>a.sourceCurrent.system.attributes.hp.max++],
 ['B2','skills.expertise',a=>a.effective.skills.ste.value=1],
 ['B3','preserve.image',a=>a.raw.img='wrong.png'],
];
for(const [id,expected,mutate]of mutations){const a=load(id,'snapshot');mutate(a);const r=verify(cases.find(p=>p.id===id),a,load(id,'receipt'));assert.equal(r.checks.find(c=>c.id===expected)?.ok,false,`${id}: missed ${expected}`);assert.equal(r.configurationPass,false);results.push({id:id+'.reject.'+expected,ok:true});}
for(const id of ['B1','B2','B3']){const a=load(id,'snapshot'),receipt=load(id,'receipt'),old=receipt.sourceBefore.items[0];a.raw.items=a.raw.items.filter(i=>i._id!==old._id);const r=verify(cases.find(p=>p.id===id),a,receipt);assert.equal(r.checks.find(c=>c.id==='preserve.item.'+old._id)?.ok,false);results.push({id:id+'.reject.deleted-source-item',ok:true});}
// Equivalent choices must not be rejected merely for differing from the review card.
{const a=load('A1','snapshot'),p=cases.find(p=>p.id==='A1');a.effective.skills.arc.value=0;a.effective.skills.inv.value=0;a.effective.skills.his.value=1;a.effective.skills.rel.value=1;assert.equal(verify(p,a,load('A1','receipt')).configurationPass,true);results.push({id:'A1.accept.other-legal-skills',ok:true});}
{const a=load('A2','snapshot'),p=cases.find(p=>p.id==='A2');a.effective.ac.value=17;assert.equal(verify(p,a,load('A2','receipt')).checks.find(c=>c.id==='armor.effective').ok,false);results.push({id:'A2.reject.wrong-derived-ac',ok:true});}
fs.writeFileSync(path.join(root,'verifier-tests.json'),JSON.stringify({positive:7,negative:23,results},null,2));
console.log('PASS: 6 real positive controls, 1 legal-choice variant and 23 corrupted snapshots rejected. No world writes.');
