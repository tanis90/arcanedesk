// Experimental read-only compendium projection. No Actor Studio dependency.
async function queryBuild({ className, level, raceName, rules = '2014' }) {
  if (!Number.isInteger(level) || level < 1 || level > 20) throw Error('level must be 1..20');
  const clean = s => String(s || '').trim().toLowerCase();
  const matches = (d, name) => clean(d.system?.identifier) === clean(name)
    || clean(d.name) === clean(name) || clean(d.name).split(/\s+/).includes(clean(name));
  const find = async (name, type) => {
    const candidates = [];
    for (const p of game.packs.filter(p => p.documentName === 'Item'
      && new RegExp(type === 'class' ? 'classes' : 'races|species').test(p.collection))) {
      const index = await p.getIndex({ fields: ['system.identifier', 'system.source.rules', 'type'] });
      for (const e of index) if (matches(e, name)) {
        const d = await p.getDocument(e._id);
        if (d.type === type && d.system.source?.rules === rules) candidates.push(d);
      }
    }
    // Prefer the installed system's edition-specific source; expose alternatives.
    candidates.sort((a,b) => Number(b.pack.startsWith('dnd5e.')) - Number(a.pack.startsWith('dnd5e.')) || a.uuid.localeCompare(b.uuid));
    return { selected: candidates[0], candidates: candidates.map(d => ({ name:d.name, uuid:d.uuid })) };
  };
  const project = async d => {
    if (!d) return null;
    const s = d.toObject().system;
    const entries = Array.isArray(s.advancement) ? s.advancement : Object.values(s.advancement || {});
    const advancements = [];
    for (const a of entries) {
      if (a.level != null && a.level > level) continue;
      const c = JSON.parse(JSON.stringify(a.configuration || {}));
      if (a.type === 'ItemChoice' && c.choices) {
        c.choices = Object.fromEntries(Object.entries(c.choices).filter(([l]) => Number(l) <= level));
        if (!Object.keys(c.choices).length) continue;
      }
      if (a.type === 'ScaleValue' && c.scale) {
        const eligible = Object.keys(c.scale).map(Number).filter(l => l <= level).sort((a,b)=>b-a);
        c.current = eligible.length ? c.scale[eligible[0]] : null;
        c.scale = Object.fromEntries(Object.entries(c.scale).filter(([l]) => Number(l) <= level));
      }
      if (a.type === 'ItemGrant') c.items = await Promise.all((c.items || []).map(async ref => {
        const uuid = typeof ref === 'string' ? ref : ref.uuid;
        const item = await fromUuid(uuid);
        return { ...(typeof ref === 'object' ? ref : {}), uuid, name:item?.name || null, unresolved:!item };
      }));
      advancements.push({ level:a.level ?? null, type:a.type, title:a.title, configuration:c,
        hint:a.hint || undefined, classRestriction:a.classRestriction || undefined });
    }
    return { name:d.name, uuid:d.uuid, type:d.type, rules:s.source?.rules, identifier:s.identifier,
      hitDice:s.hd?.denomination || s.hitDice, spellcasting:s.spellcasting,
      movement:s.movement, advancements };
  };
  const cls = await find(className, 'class');
  const race = raceName ? await find(raceName, 'race') : null;
  return { level, rules, class:await project(cls.selected), race:race ? await project(race.selected) : null,
    sources:{ class:cls.candidates, race:race?.candidates || [] },
    unresolved:[...(!cls.selected ? ['class source not found'] : []), ...(race && !race.selected ? ['race source not found'] : [])],
    scope:'Source advancements only. Choices are not defaults. Subclass benefits require the selected subclass. Spell slots derive from system caster progression; this is not an NPC creation payload. No Actor Studio calls.' };
}
module.exports = { queryBuild, createTool(evaluate) {
  return { name:'foundry_build_query', label:'Query character progression',
    description:'Read installed dnd5e class/race progression through target level, grant UUIDs, choices, scaling and source defaults. Read-only; no Actor Studio. Prefer English identifiers. Does not create actors or choose options.',
    parameters:{type:'object',properties:{className:{type:'string'},level:{type:'integer',minimum:1,maximum:20},raceName:{type:'string'},rules:{type:'string',enum:['2014','2024']}},required:['className','level'],additionalProperties:false},
    async execute(id,args) { const result=await evaluate(`(${queryBuild.toString()})(${JSON.stringify(args)})`);return {content:[{type:'text',text:JSON.stringify(result)}],details:{readOnly:true}}; } };
} };
