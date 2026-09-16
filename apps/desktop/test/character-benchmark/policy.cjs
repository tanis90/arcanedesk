// Frozen project policy, v2. Keep separate from model-visible source-query output.
const sizeDice={tiny:4,sm:6,med:8,lg:10,huge:12,grg:20};
const mod=n=>Math.floor((n-10)/2);
function proficiency(cr,level=0){if(!Number.isFinite(Number(cr))||Number(cr)<0)throw Error('Invalid CR');return Math.max(2,Math.ceil(Math.max(Number(cr),level,1)/4)+1);}
// Native dnd5e NPC extension: HitPointsAdvancement on an NPC rolls the monster size die (never the class die),
// "avg" rounds up per die (die/2+1), each level adds final CON mod (min 1/level), and the source HP baseline is
// never recomputed when CON changes.
function extensionHp(base,level,con){const die=sizeDice[base.system.traits.size];if(!die)throw Error('Unknown monster size');const count=Number(base.system.attributes.hp.formula?.match(/(\d+)d\d+/)?.[1]);if(!count)throw Error('Source Hit Dice count unavailable');return base.system.attributes.hp.max+level*Math.max(die/2+1+mod(con),1);}
module.exports={sizeDice,proficiency,extensionHp};
