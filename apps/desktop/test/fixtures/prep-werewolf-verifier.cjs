// Read-only transfer acceptance. Source snapshots are evaluator-only, never model hints.
module.exports = (evaluate, fixture) => evaluate(`(async () => {
  const f=${JSON.stringify(fixture)}, src=f.werewolfSources;
  const actors=game.actors.filter(a=>a.name===f.newName), a=actors[0];
  if(!a)return {ok:false,checks:{singleNpc:false},manualReviewRequired:true};
  const plain=x=>x?.toObject?x.toObject():x;
  const normalize=x=>Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).filter(k=>k!=='_id').sort().map(k=>[k,normalize(x[k])])):x;
  const equal=(x,y)=>JSON.stringify(normalize(x))===JSON.stringify(normalize(y));
  const raw=a.toObject(), s=a.system;
  const base=(src.werewolves??[src.werewolf]).find(b=>['str','dex','con','int','wis','cha'].every(k=>s.abilities[k].value===b.system.abilities[k].value)&&s.attributes.hp.max===b.system.attributes.hp.max)??src.werewolf;
  const originals=base.items.map(i=>{const matches=a.items.filter(j=>j.name===i.name&&j.type===i.type);return {name:i.name,ok:matches.length===1&&['activities','damage','description'].every(k=>equal(matches[0].toObject().system[k],i.system[k]))};});
  const bows=a.items.filter(i=>i.type==='weapon'&&i.system.identifier==='longbow');
  const surges=a.items.filter(i=>i.type==='feat'&&i.system.identifier==='action-surge');
  const bow=bows[0], surge=surges[0];
  const surgeActs=Array.from(surge?.system.activities??[]);
  const checks={singleNpc:actors.length===1&&a.type==='npc',
    baseStats:['str','dex','con','int','wis','cha'].every(k=>s.abilities[k].value===base.system.abilities[k].value)&&s.attributes.hp.max===base.system.attributes.hp.max&&s.attributes.hp.value===s.attributes.hp.max,
    werewolfTraits:equal(raw.system.details.type,base.system.details.type)&&equal(raw.system.traits.di,base.system.traits.di),
    originalMechanics:originals.every(x=>x.ok),
    longbow:bows.some(b=>Number(b.system.quantity)>=1&&(equal(b.toObject().system.damage,src.longbow.system.damage)||base.items.some(i=>i.type==='weapon'&&i.system.identifier==='longbow'&&equal(b.toObject().system.damage,i.system.damage)))&&Array.from(b.system.activities).some(x=>x.type==='attack'&&x.attack?.type?.value==='ranged')),
    actionSurge:surges.length===1&&surgeActs.length>0&&surgeActs.some(x=>x.consumption?.targets?.some(t=>t.type==='itemUses'&&(!t.target||t.target===surge.id)&&Number(t.value)===1)),
    surgeResources:surges.length===1&&Number(surge.system.uses.max)===1&&Number(surge.system.uses.value)===1&&surge.system.uses.recovery.some(r=>r.period==='sr'&&r.type==='recoverAll')};
  return {ok:Object.values(checks).every(Boolean),checks,manualReviewRequired:true,details:{uuid:a.uuid,referenceName:base.name,originals,longbowCount:bows.length,uses:plain(surge?.system.uses),system:raw.system,items:a.items.map(i=>i.toObject())}};
})()`);
