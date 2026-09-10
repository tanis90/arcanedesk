// Experimental model tools. No Document writes or package modifications.
const { queryBuild } = require('./prep-build-query.cjs');

async function queryCatalog(mode, args, build) {
  const a = args;
  const fail = (code, message) => { throw new Error(`${code}: ${message}`); };
  const values = x => Array.from(x?.values?.() ?? x ?? []);
  const norm = x => String(x ?? '').trim().toLowerCase();
  if (!['world', 'compendium'].includes(a.scope)) fail('INVALID_SCOPE', 'world instances or compendium sources required');
  const page = a.page ?? 1, pageSize = a.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('INVALID_PAGE', 'page >= 1, pageSize 1..100');
  const paginate = (items, extra = {}) => {
    items.sort((x, y) => String(x.uuid).localeCompare(String(y.uuid)));
    return {page, pageSize, total: items.length, hasNextPage: page * pageSize < items.length,
      items: items.slice((page - 1) * pageSize, page * pageSize), ...extra};
  };
  const ref = d => ({uuid: d.uuid, name: d.name, type: norm(d.documentName),
    itemType: d.documentName === 'Item' ? d.type : undefined,
    packId: d.pack, entryId: d.pack ? d.id : undefined, identifier: d.system?.identifier});
  const read = async uuid => {
    const d = await fromUuid(uuid);
    if (!d) fail('NOT_FOUND', uuid);
    const scope = d.pack || uuid.startsWith('Compendium.') ? 'compendium' : 'world';
    if (scope !== a.scope) fail('SCOPE_MISMATCH', `${uuid} belongs to ${scope}`);
    return d;
  };
  const matches = d => !a.query || [d.name, d.system?.identifier, d._source?.name]
    .some(x => norm(x).includes(norm(a.query)));
  if (mode === 'detail') {
    const d = await read(a.uuid), document = d.toObject();
    return {...ref(d), type: d.documentName, source: {scope: a.scope, packId: d.pack, entryId: d.id},
      summary: {identifier: d.system?.identifier, level: d.system?.level, source: d.system?.source}, document};
  }
  if (a.packIds && a.scope !== 'compendium') fail('INVALID_FILTER', 'packIds requires compendium');
  const packs = values(game.packs).filter(p => !a.packIds || a.packIds.includes(p.collection));
  const fields = ['system.identifier', 'system.level', 'system.source.rules', 'system.type', '_stats.compendiumSource', 'flags'];
  const indexed = async (type) => {
    if (a.scope === 'world') return values({actor: game.actors, item: game.items, scene: game.scenes}[type]);
    const out = [];
    for (const p of packs.filter(p => norm(p.documentName) === type)) {
      const index = await p.getIndex({fields});
      for (const e of values(index)) out.push({...e, id:e._id, pack:p.collection, documentName:p.documentName,
        uuid:`Compendium.${p.collection}.${p.documentName}.${e._id}`});
    }
    return out;
  };
  if (mode === 'search') {
    if (!['actor', 'item', 'scene'].includes(a.type)) fail('INVALID_TYPE', a.type);
    const found=(await indexed(a.type)).filter(d => matches(d) && (!a.itemType || d.type === a.itemType)
      && (!a.actorType || d.type === a.actorType)).map(ref);
    const q=norm(a.query); found.sort((x,y)=>Number(norm(x.identifier)!==q)-Number(norm(y.identifier)!==q)||String(x.uuid).localeCompare(String(y.uuid)));
    return paginate(found);
  }
  if (mode !== 'list') fail('INVALID_MODE', mode);
  if (a.type === 'classFeature') {
    if (a.scope !== 'compendium' || !a.class || !a.characterLevel) fail('INVALID_FILTER', 'classFeature progression requires compendium, class and characterLevel');
    const progression = await build({className:a.class, subclassName:a.subclass, level:a.characterLevel, rules:a.rules ?? '2014'});
    const documents = progression.documents.filter(d => matches(d));
    const roots = [progression.class, progression.subclass, progression.race].filter(Boolean);
    const advancements = roots.flatMap(r => r.advancements ?? []);
    const granted = advancements.filter(a => a.type === 'ItemGrant');
    const choices = advancements.filter(a => /choice|select/i.test(String(a.type ?? a.title ?? '')));
    const unresolved = progression.unresolved ?? [];
    const summary = advancements.map(a => ({
      type:a.type, level:a.level ?? a.configuration?.level ?? null,
      title:a.title ?? a.name ?? null,
      choices:a.choices ? Object.keys(a.choices) : undefined,
      choiceCount:a.choices ? Object.values(a.choices).reduce((n,v)=>n+(Array.isArray(v)?v.length:1),0) : undefined,
      prerequisites:a.configuration?.requirements ?? a.configuration?.prerequisites ?? undefined,
      sourceUuids:Array.isArray(a.configuration?.items) ? a.configuration.items.map(i=>i.uuid).filter(Boolean) : undefined,
      itemCount:Array.isArray(a.configuration?.items) ? a.configuration.items.length : undefined
    }));
    return paginate(documents, {progression:undefined, progressionDetail:progression,
      progressionGroups:{granted,choices,unresolved,
        classification:{granted:'derived-from-advancement-type',choices:'derived-from-advancement-type-or-name',unresolved:'source-reported'}},
      progressionSummary:summary,
      progressionContext:{documentCount:documents.length,
        note:'Progression entries include granted features and unresolved choice candidates; candidates are not selections made for the character.',
        spellAccess:progression.spellAccess ?? null,
        spellTables:progression.spellTables ?? []}});
  }
  if (a.type === 'monsterAction') {
    if (!a.actorUuid) fail('INVALID_FILTER', 'monsterAction requires actorUuid');
    const actor = await read(a.actorUuid);
    if (actor.documentName !== 'Actor') fail('INVALID_TYPE', 'actorUuid must resolve to Actor');
    return paginate(values(actor.items).filter(d => ['feat','weapon','action'].includes(d.type) && matches(d)).map(ref));
  }
  if (a.type !== 'spell') {
    if (a.class || a.subclass || a.characterLevel || a.levels || a.maxLevel) fail('INVALID_FILTER', 'progression filters only apply to spells/classFeature');
    if (!['weapon','armor','feat','item'].includes(a.type)) fail('INVALID_TYPE', a.type);
    return paginate((await indexed('item')).filter(d => matches(d) && (a.type === 'item' || d.type === a.type
      || (a.type === 'armor' && d.type === 'equipment' && ['light','medium','heavy','shield'].includes(d.system?.type?.value))))
      .map(d => ({...ref(d), category:d.system?.type})));
  }
  const worldRules = game.settings.get('dnd5e', 'rulesVersion') === 'legacy' ? '2014' : '2024';
  const rules = a.rules ?? worldRules;
  if (rules !== worldRules) fail('RULES_MISMATCH', `world is ${worldRules}, requested ${rules}`);
  const registry = game.dnd5e?.registry?.spellLists ?? globalThis.dnd5e?.registry?.spellLists;
  if (a.class && !registry?.ready) fail('REGISTRY_UNAVAILABLE', 'spell list registry is not ready');
  const list = a.class ? registry.forType('class', a.class) : null;
  if (a.class && !list) fail('LIST_UNAVAILABLE', a.class);
  // A subclass list alone does not prove automatic preparation or the unlocking class level.
  const subclassList = a.subclass ? registry?.forType('subclass', a.subclass) : null;
  const unresolved = a.subclass && !subclassList ? [{code:'SUBCLASS_LIST_UNAVAILABLE', subclass:a.subclass,
    message:'Read selected subclass progression; absence of a registry list is not proof of no additional spells.'}] : [];
  let maxLevel = a.maxLevel;
  let progression;
  if (a.characterLevel && a.class) {
    progression = await build({className:a.class, subclassName:a.subclass, level:a.characterLevel, rules});
    // Preserve the source projection; do not guess full/half/pact progression from class names.
    if (maxLevel === undefined) {
      const access = progression.spellAccess;
      maxLevel = access?.highestSpellLevel ?? access?.maxSpellLevel ?? access?.level;
      if (!Number.isInteger(maxLevel)) fail('LEVEL_UNAVAILABLE', 'progression did not provide highestSpellLevel');
    }
  }
  const available = (await indexed('item')).filter(d => d.type === 'spell');
  // A subclass list is an additive source of candidates. Keep both relationships
  // visible so the model can distinguish class access from subclass-granted access.
  const sourceRefs = list ? [...values(list.indexes), ...values(subclassList?.indexes)] : available;
  const seen = new Set(), results = [];
  for (const entry of sourceRefs) {
    const source = entry.toObject ? entry : await fromUuid(entry.uuid);
    if (!source) {unresolved.push({code:'RULE_DOCUMENT_MISSING',uuid:entry.uuid});continue;}
    const level = source.system?.level;
    if (!Number.isInteger(level)) {unresolved.push({code:'SPELL_LEVEL_MISSING',uuid:source.uuid});continue;}
    if ((maxLevel !== undefined && level > maxLevel) || (a.levels && !a.levels.includes(level))) continue;
    const identifier = source.system?.identifier;
    if (seen.has(source.uuid)) continue;
    seen.add(source.uuid);
    const candidates = available.filter(d => d.uuid !== source.uuid && d.system?.level === level
      && (!d.system?.source?.rules || d.system.source.rules === rules)
      && (d._stats?.compendiumSource === source.uuid || Object.values(d.flags ?? {}).some(f=>f?.sourceUuid === source.uuid)
        || (identifier && d.system?.identifier === identifier)));
    const arcane = candidates.filter(d => d.pack?.startsWith('arcane-dnd5e-2014-automation.')
      || Object.values(d.flags ?? {}).some(f => f?.sourceUuid === source.uuid));
    const selected = arcane.length === 1 ? arcane[0] : source;
    if (!matches(source) && !matches(selected)) continue;
    results.push({...ref(selected), level, school:source.system?.school,
      classEligible:list ? list.identifiers?.has(identifier) ?? true : null,
      subclassGranted:subclassList ? subclassList.identifiers?.has(identifier) ?? false : null,
      optionalExpansion:null, levelEligible:true,
      eligibilityReason:list ? 'member of configured native class spell list' : 'no class eligibility requested',
      rule:{uuid:source.uuid, identifier, rules, list:list?.metadata ?? null},
      implementation:{status:arcane.length === 1 ? 'matched' : arcane.length > 1 ? 'ambiguous' : 'native-fallback',
        uuid:selected.uuid, candidates:arcane.length > 1 ? arcane.map(ref) : undefined,
        automation:'not-execution-tested'},
      subclassListMember:subclassList ? subclassList.identifiers.has(identifier) : null});
  }
  const byLevel = Object.fromEntries([...new Set(results.map(x=>x.level))].sort((a,b)=>a-b)
    .map(level=>[String(level),results.filter(x=>x.level===level).length]));
  return paginate(results,{rules,sourceKind:list ? 'dnd5e-spell-list-registry' : 'documents',unresolved,
    selectionContext:{candidateCount:results.length,countsByLevel:byLevel,
      classList:list?.metadata ?? null,subclassList:subclassList?.metadata ?? null,
      note:'Candidates are source-accessible spells; they are not automatically prepared or granted unless explicitly marked.'},
    spellAccess:progression?.spellAccess,spellTables:progression?.spellTables});
}

function createTools(evaluate) {
  const text = {type:'string',minLength:1};
  const scope = {type:'string',enum:['world','compendium']};
  const paging = {page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:100}};
  const schemas = {
    search:{scope,type:{type:'string',enum:['actor','scene','item']},query:text,
      packIds:{type:'array',items:text,maxItems:20},actorType:text,itemType:text,...paging},
    list:{scope,type:{type:'string',enum:['spell','classFeature','feat','monsterAction','weapon','armor','item']},
      rules:{type:'string',enum:['2014','2024']},class:text,subclass:text,
      characterLevel:{type:'integer',minimum:1,maximum:20},levels:{type:'array',items:{type:'integer',minimum:0,maximum:9}},
      maxLevel:{type:'integer',minimum:0,maximum:9},actorUuid:text,query:text,...paging},
    detail:{scope,uuid:text},
  };
  return ['search','list','detail'].map(mode => ({
    name:`foundry_content_${mode}`,
    parameters:{type:'object',properties:schemas[mode],required:mode==='detail'?['scope','uuid']:mode==='search'?['scope','type','query']:['scope','type'],additionalProperties:false},
    description:mode==='search' ? 'Find content by name/identifier. World means existing instances; compendium means reusable sources. Search is not eligibility evidence.'
      : mode==='detail' ? 'Read one exact native Document in full; scope must match its UUID.'
      : 'Read a bounded source-defined list, including native class spell eligibility linked to import sources. Reports ambiguity and missing source data.',
    async execute(_id,args){return {content:[{type:'text',text:JSON.stringify(await evaluate(
      `(${queryCatalog.toString()})(${JSON.stringify(mode)},${JSON.stringify(args)},${queryBuild.toString()})`))}]};}
  }));
}
module.exports={queryCatalog,createTools};
