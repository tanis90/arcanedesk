// Frozen project policy, v2. Keep separate from model-visible source-query output.
const sizeDice={tiny:4,sm:6,med:8,lg:10,huge:12,grg:20};
const mod=n=>Math.floor((n-10)/2);
function proficiency(cr,level=0){if(!Number.isFinite(Number(cr))||Number(cr)<0)throw Error('Invalid CR');return Math.max(2,Math.ceil(Math.max(Number(cr),level,1)/4)+1);}
function extensionHp(base,level,con){const die=sizeDice[base.system.traits.size];if(!die)throw Error('Unknown monster size');const count=Number(base.system.attributes.hp.formula?.match(/(\d+)d\d+/)?.[1]);if(!count)throw Error('Source Hit Dice count unavailable');return Math.floor(base.system.attributes.hp.max+level*((die+1)/2+mod(con))+count*(mod(con)-mod(base.system.abilities.con.value)));}
module.exports={sizeDice,proficiency,extensionHp};
