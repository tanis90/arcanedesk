import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool as definePiTool } from "@earendil-works/pi-coding-agent";

/** @template {import("typebox").TProperties} P @param {P} properties */
const exact = properties => Type.Object(properties, { additionalProperties: false });
const ref = () => Type.String({ minLength: 1, maxLength: 256 });
const source = Type.Union([
  exact({ kind: Type.Literal("actor"), actorUuid: ref() }),
  exact({ kind: Type.Literal("token"), tokenUuid: ref() }),
  exact({ kind: Type.Literal("selected") }),
  exact({ kind: Type.Literal("name"), name: ref(), scope: Type.Union([Type.Literal("focus"), Type.Literal("actors")]) }),
]);
const textResult = data => ({ content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(data) }], details: data });

// Some providers require an object root and reject root-level anyOf even when
// type=object is present. Keep the exact union as a pre-dispatch validator and
// publish its fields as an object; the caller-facing argument shape is unchanged.
function defineTool(definition) {
  const contract = definition.parameters;
  if (!Array.isArray(contract.anyOf)) return definePiTool(definition);
  const branches = /** @type {import("typebox").TObject[]} */ (contract.anyOf);
  const properties = /** @type {import("typebox").TProperties} */ ({});
  for (const key of new Set(branches.flatMap(branch => Object.keys(branch.properties)))) {
    const variants = [...new Map(branches.filter(branch => key in branch.properties)
      .map(branch => { const schema = Type.Required(exact({ value: branch.properties[key] })).properties.value; return [JSON.stringify(schema), schema]; })).values()];
    const schema = variants.length === 1 ? variants[0] : Type.Union(variants);
    properties[key] = branches.every(branch => branch.required?.includes(key)) ? schema : Type.Optional(schema);
  }
  return definePiTool({ ...definition, parameters: exact(properties), execute: async (id, params, signal, update, context) => {
    if (!Value.Check(contract, params)) return textResult({ status: "rejected", code: "INPUT_INVALID", message: "Arguments do not match a supported parameter combination; no action was dispatched." });
    return definition.execute(id, params, signal, update, context);
  } });
}
const activityInput = exact({
  spellLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })),
  attackRollMode: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("advantage"), Type.Literal("disadvantage")])),
  selections: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), Type.Union([ref(), Type.Number(), Type.Boolean()]))),
  allocation: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100 })),
  declaredRiders: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 20 })),
  targetSpec: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const actionFields = { actionRef: ref(), targetTokenUuids: Type.Optional(Type.Array(ref(), { maxItems: 100 })), input: Type.Optional(activityInput) };
const grant = exact({ uuid: Type.Optional(ref()), packId: Type.Optional(ref()), entryId: Type.Optional(ref()), expectedName: Type.Optional(ref()), expectedType: Type.Optional(ref()),
  quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 999 })), equipped: Type.Optional(Type.Boolean()) });
const dataImage = Type.Union([exact({ dataPath: Type.String({ minLength: 1, maxLength: 4096 }) }),
  exact({ sourcePath: Type.String({ minLength: 1, maxLength: 4096 }) })]);
const placementFields = { x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), name: Type.Optional(ref()),
  hidden: Type.Optional(Type.Boolean()), disposition: Type.Optional(Type.Union([Type.Literal(-1), Type.Literal(0), Type.Literal(1)])),
  width: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), height: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), elevation: Type.Optional(Type.Number()) };
const tokenLayout = exact({
  create: Type.Optional(Type.Array(exact({ ...placementFields, actorUuid: ref(), x: Type.Number(), y: Type.Number(), actorLink: Type.Optional(Type.Boolean()) }), { maxItems: 100 })),
  update: Type.Optional(Type.Array(exact({ tokenId: ref(), changes: exact(placementFields) }), { maxItems: 100 })),
  deleteIds: Type.Optional(Type.Array(ref(), { maxItems: 100, uniqueItems: true })),
});
const sceneFields = { name: Type.Optional(ref()), active: Type.Optional(Type.Boolean()), background: Type.Optional(dataImage),
  width: Type.Optional(Type.Integer({ minimum: 1 })), height: Type.Optional(Type.Integer({ minimum: 1 })),
  grid: Type.Optional(exact({ type: Type.Optional(Type.Integer()), size: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    distance: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), units: Type.Optional(Type.String({ maxLength: 256 })) })) };
const abilityScores = exact({ str: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), dex: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  con: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), int: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  wis: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), cha: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) });
const actorChanges = exact({ name: Type.Optional(ref()), folderId: Type.Optional(Type.Union([ref(), Type.Null()])),
  prototypeToken: Type.Optional(exact({ name: Type.Optional(ref()), width: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })), disposition: Type.Optional(Type.Union([Type.Literal(-1), Type.Literal(0), Type.Literal(1)])) })),
  dnd5e: Type.Optional(exact({ hp: Type.Optional(exact({ value: Type.Optional(Type.Number({ minimum: 0 })),
    max: Type.Optional(Type.Number({ minimum: 0 })), temp: Type.Optional(Type.Number({ minimum: 0 })) })),
    ac: Type.Optional(exact({ flat: Type.Number() })), abilities: Type.Optional(abilityScores) })) });

/** Definitions are mode-independent; activation belongs to the host's explicit allowlist. */
export function createFoundryTools(host) {
  const actorWrite = (name, action, parameters, description) => defineTool({
    name, label: name, description, parameters, executionMode: "sequential",
    execute: async (id, params, signal) => {
      const binding = host.taskCoordinator().currentInputBinding();
      const approved = await host.maybeRequestApproval({ tool: name, summary: description.split(".")[0], args: params });
      if (!approved) return textResult({ status: "rejected", code: "DECLINED", message: "DM declined; do not retry." });
      return textResult(await host.foundryServices().writeActor(action, params, binding, id, signal));
    },
  });
  return [
    defineTool({
      name: "foundry_image", label: "Upload or Apply Foundry Image",
      description: "Upload a local PNG/JPEG/WebP from the prep directory (max 10 MiB), or use an existing Data-relative image path. Returns a reusable dataPath for any document or rich text. Optionally apply to an exact world Actor, Item (including embedded Items), or image-type JournalEntryPage UUID. Actor targets update portrait and prototype Token; syncPlacedTokens additionally updates placed Token images across scenes, preserving layout and names. Item updates img; Journal image page updates src. Omit targetUuid for upload only; text Journal pages can embed the returned path using native APIs. Never send Base64. Partial/indeterminate writes must not be replayed. Prep-only.",
      parameters: Type.Union([
        exact({ sourcePath: Type.String({ minLength: 1, maxLength: 4096 }), targetUuid: Type.Optional(ref()), syncPlacedTokens: Type.Optional(Type.Boolean()) }),
        exact({ dataPath: Type.String({ minLength: 1, maxLength: 4096 }), targetUuid: Type.Optional(ref()), syncPlacedTokens: Type.Optional(Type.Boolean()) }),
      ]),
      executionMode: "sequential",
      execute: async (id, params, signal) => {
        const binding = host.taskCoordinator().currentInputBinding();
        const approved = await host.maybeRequestApproval({ tool: "foundry_image", summary: "Upload or apply an image", args: params });
        if (!approved) return textResult({ status: "rejected", code: "DECLINED", message: "DM declined; do not retry." });
        const { targetUuid, syncPlacedTokens, ...image } = params;
        return textResult(await host.foundryServices().writeContent("imageApply", { image, targetUuid, syncPlacedTokens }, binding, id, signal));
      },
    }),
    defineTool({
      name: "foundry_scene_get", label: "Read Scene",
      description: "Read an exact Scene, including one not currently displayed. Returns compact metadata and requested placeable pages plus a session readRef. Include tokens before changing or deleting existing Tokens. Prep-only.",
      parameters: exact({ sceneUuid: ref(), include: Type.Optional(Type.Array(Type.Union([Type.Literal("tokens"), Type.Literal("walls"),
        Type.Literal("lights"), Type.Literal("tiles"), Type.Literal("notes"), Type.Literal("sounds")]), { maxItems: 6, uniqueItems: true })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(ref()) }),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().sceneRead(params, signal)),
    }),
    defineTool({
      name: "foundry_scene_apply", label: "Apply Scene",
      description: "Create or update an explicit Scene's metadata, grid, background and Token layout. At most 100 total Token operations; grouped creates/updates/deletes run in order and activation runs last. Token actorLink defaults to its Actor prototype. Background accepts a local prep image or Data-relative path, never Base64. Requires readRef for updates. Partial/indeterminate receipts must not be replayed. Prep-only.",
      parameters: Type.Union([
        exact({ operation: Type.Literal("create"), scene: exact({ ...sceneFields, name: ref() }), tokens: Type.Optional(tokenLayout) }),
        exact({ operation: Type.Literal("update"), sceneUuid: ref(), readRef: ref(), scene: Type.Optional(exact(sceneFields)), tokens: Type.Optional(tokenLayout) }),
      ]), executionMode: "sequential",
      execute: async (id, params, signal) => {
        const binding = host.taskCoordinator().currentInputBinding();
        const deletionCount = params.tokens?.deleteIds?.length ?? 0;
        const approved = await host.maybeRequestApproval({ tool: "foundry_scene_apply",
          summary: `${params.operation} Scene; create ${params.tokens?.create?.length ?? 0}, update ${params.tokens?.update?.length ?? 0}, delete ${deletionCount} Tokens`, args: params });
        if (!approved) return textResult({ status: "rejected", code: "DECLINED", message: "DM declined; do not retry." });
        return textResult(await host.foundryServices().writeScene(params, binding, id, signal));
      },
    }),
    defineTool({
      name: "foundry_actor_get", label: "Read Actor",
      description: "Read an exact Actor's compact summary and requested editing projections. Returns a session readRef required for edits/grants. Include items before grants and prototypeToken before changing its fields. Prep-only; pages do not contain full Item documents.",
      parameters: exact({ actorUuid: ref(), include: Type.Optional(Type.Array(Type.Union([Type.Literal("items"), Type.Literal("resources"), Type.Literal("prototypeToken"), Type.Literal("sceneTokens")]), { maxItems: 4, uniqueItems: true })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(ref()) }),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().actorRead(params, signal)),
    }),
    actorWrite("foundry_actor_create", "actorCreate", exact({
      source: Type.Union([exact({ kind: Type.Literal("blank"), actorType: Type.Union([Type.Literal("character"), Type.Literal("npc")]) }),
        exact({ kind: Type.Literal("compendium"), packId: ref(), entryId: ref() })]),
      name: ref(), folderId: Type.Optional(ref()), initialItems: Type.Optional(Type.Array(grant, { maxItems: 50 })),
      prototypeToken: Type.Optional(exact({ name: ref() })),
      dnd5e: Type.Optional(exact({ abilities: abilityScores })),
    }), "Create an empty or compendium Actor with an explicit name and optional initial compendium Items. Optional prototypeToken.name sets the prototype Token name in the same creation. Optional dnd5e.abilities sets base ability scores (integers 1..20) at creation — before any advancement, so racial and ASI bonuses add on top; new characters should receive their standard array here. Existing names are returned as collisions; partial creation is never retried automatically. Prep-only."),
    actorWrite("foundry_actor_update", "actorEdit", exact({ actorUuid: ref(), readRef: ref(), changes: actorChanges }),
      "Update bounded Actor name, existing folder, prototype Token fields, HP, flat AC or base ability scores (integers 1..20). Ability writes are SET semantics: after advancement they must already include racial/ASI additions, so new characters should receive base scores via foundry_actor_create instead. Requires a current readRef for touched fields; unrelated changes do not block. Use foundry_image for portraits, local uploads and Token image synchronization. Prep-only."),
    actorWrite("foundry_actor_grant_items", "actorGrantItems", exact({ actorUuid: ref(), readRef: ref(), items: Type.Array(grant, { minItems: 1, maxItems: 50 }) }),
      "Grant exact compendium Items to an Actor after reading its items projection. Existing sources are skipped, never stacked or replaced. Reports created and skipped identities. expectedName/expectedType are exact-match drift guards: copy the name verbatim from browse output or omit them entirely — a synthesized or translated name rejects the whole batch before any write. Prep-only."),
    actorWrite("foundry_actor_advance", "actorAdvance", exact({ actorUuid: ref(), readRef: ref(), classUuid: ref(), subclassUuid: Type.Optional(ref()), raceUuid: Type.Optional(ref()), targetLevel: Type.Integer({ minimum: 1, maximum: 20 }), choices: Type.Optional(exact({ bySlot: Type.Optional(Type.Record(ref(), Type.Union([Type.Array(ref(), { maxItems: 20, uniqueItems: true }), exact({ abilityScore: Type.Optional(Type.Record(ref(), Type.Integer({ minimum: 1, maximum: 2 }))), feat: Type.Optional(ref()) })]))), hp: Type.Optional(Type.Union([Type.Literal("max"), Type.Literal("avg")])) })), additionalItems: Type.Optional(Type.Array(grant, { maxItems: 50 })), fullSpellList: Type.Optional(Type.Boolean()) }),
      "Advance an existing dnd5e Character or NPC through the native AdvancementManager. Supply source UUIDs and fill choices.bySlot slot by slot: copy each key verbatim from advancement_plan choiceRequirements[].key (the plan's choicesTemplate carries one fill-in skeleton per key). Trait/pool slots take an array of native trait keys (skills:arc, languages:standard:elvish) or candidate-pool UUIDs exactly count entries long; ASI slots take { abilityScore: { str: 2 } } floating picks and race fixed bonuses merge in automatically; asi-or-feat slots take either { abilityScore } or { feat: \"<uuid>\" }, never both; subclass-uuid requirements stay the top-level subclassUuid argument. Keys the plan never listed reject before any write with CHOICE_SLOT_UNKNOWN naming the valid slots. HP, class features, resources and derived values are calculated by dnd5e. Expertise slots (marked mode 'expertise' in the plan): every pick must already be proficient — on the sheet or chosen in an earlier slot of this same call — and invalid picks reject the whole advance before any write; a post-write safety net reports EXPERTISE_NOT_LANDED if dnd5e still drops one. Every other trait grant is audited after the native apply: a pick whose field does not exist on this actor type (dnd5e 5.3 NPCData has no traits.armorProf/weaponProf, so a class-extended monster silently loses class armor/weapon proficiencies natively) is reported as a TRAIT_GRANT_NOT_LANDED warning — disclose it in the deliverable rather than hand-patching. Requires a current Actor readRef. Missing or invalid choices are rejected before any world write; additionalItems are validated the same way — expectedName must be copied verbatim from browse output or omitted. When the plan's spellBudget carries fullList (prepared-list casters such as cleric, druid, paladin or artificer), pass fullSpellList true once to grant the whole annotated class spell list up to the highest slot level after advancement; other classes reject with INPUT_INVALID before any write. Fresh actors (level 0 before advancement) automatically end at full spell slots and, for characters, full HP — reported as slotFill/hpFill in the receipt; advances of experienced actors never touch current HP or slots. For NPC extensions HP uses the monster size die per native dnd5e rules, never the class die, and hpFill never fires. The receipt's verification block reports the actor end state — abilities before/after with racial and ASI decomposition, subclass, race, movement, languages, trait proficiencies (including expertise-level skills and tools), proficiency bonus, spellcasting (with per-level spell counts), AC, hit dice, initiative, class scale values, item resources, advancement-granted item identities with identifier and activity counts and preserved pre-existing item count; NPC extensions additionally report preservation.changed — a before/after diff of monster-innate families (damage resistances/immunities/vulnerabilities, condition immunities, senses, size, languages, creature type, movement), empty means the original sheet survived untouched — reconcile against it directly without follow-up reads. Prep-only."),
    defineTool({
      name: "foundry_content_search", label: "Search Foundry Content",
      description: "Search world Actors/Scenes or compendium Actors/Items by name; Items also match their system identifier across translated names. documentType is case-sensitive: Actor, Item, or Scene. Returns exact UUIDs and source pack references in bounded pages. Use these references to avoid guessing identities or duplicate content. Prep-only.",
      parameters: exact({ scope: Type.Union([Type.Literal("world"), Type.Literal("compendium")]),
        documentType: Type.Union([Type.Literal("Actor"), Type.Literal("Item"), Type.Literal("Scene")]),
        query: Type.String({ maxLength: 256 }), packIds: Type.Optional(Type.Array(ref(), { maxItems: 20 })),
        actorType: Type.Optional(ref()), itemType: Type.Optional(ref()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(ref()) }),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().contentSearch(params, signal)),
    }),
    defineTool({
      name: "foundry_compendium_browse", label: "Browse Compendium",
      description: "Enumerate compendium candidates by type and filters, or read full documents by UUID. type=class/subclass/race returns the deduplicated discovery catalog (entries carry uuid, identifier, packId and rules label; subclass filters by classUuid) so class/subclass/race identities never need fuzzy search. type=spell/item pages candidates matched by name or identifier (rules narrows 2014 vs 2024, maxLevel bounds spell level, itemType narrows to one native Item kind and equipment excludes weapons — omit itemType when resolving remembered gear names); identifier matching ignores punctuation, so 'Explorer's Pack' reaches identifier explorers-pack. candidates carry eligibility hints for classUuid. names mode batch-resolves up to 50 remembered spell/item names in one call — each entry is one single-language name or identifier, never a combined '中文 English' string — and returns per-name status unique/ambiguous/miss with candidates; ambiguous usually means both rules versions exist, so pass rules to narrow. uuids mode returns up to 20 full documents for semantic selection or reconciliation, never for discovery. Read-only. Prep-only.",
      parameters: Type.Union([
        exact({ scope: Type.Literal("compendium"),
          type: Type.Union([Type.Literal("spell"), Type.Literal("item"), Type.Literal("class"), Type.Literal("subclass"), Type.Literal("race")]),
          rules: Type.Optional(Type.Union([Type.Literal("2014"), Type.Literal("2024")])),
          classUuid: Type.Optional(ref()), maxLevel: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
          itemType: Type.Optional(Type.Union([Type.Literal("weapon"), Type.Literal("equipment"), Type.Literal("consumable"), Type.Literal("tool"), Type.Literal("loot"), Type.Literal("container"), Type.Literal("ammo")])),
          query: Type.Optional(Type.String({ maxLength: 256 })),
          names: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 50 })),
          page: Type.Optional(Type.Integer({ minimum: 1 })), pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
        exact({ scope: Type.Literal("compendium"),
          uuids: Type.Array(ref(), { minItems: 1, maxItems: 20 }) }),
      ]),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().compendiumBrowse(params, signal)),
    }),
    defineTool({
      name: "foundry_advancement_plan", label: "Advancement Plan",
      description: "Compute the native dnd5e level-up plan for an existing character or NPC (actorUuid) taking a class to characterLevel, without writing the world: steps dnd5e grants automatically (including HP — max hit die at level 1 for characters, fixed average later and for every NPC extension level, never a choice; NPC extensions roll the monster size die, never the class die), the choices a caller must supply (each with its candidate pool, value format and key — copy key verbatim into foundry_actor_advance choices.bySlot, while subclass-uuid requirements keep key 'subclassUuid', the top-level argument; race trait choices such as bonus languages appear the same way; expertise trait slots are marked mode 'expertise' with a note — their picks must be already-proficient traits, on the sheet or from earlier slots of the same advance call), choicesTemplate (one fill-in skeleton per bySlot key), race movement (race items carry speed directly, not as advancement steps), uncovered native steps, spellBudget (hardcoded rules-table spellcasting totals; prepared-list casters receive their full class spell list instead), and actorAdvanceArgs to pass straight into foundry_actor_advance. Call once without subclassUuid to get the subclass candidate pool, then again with subclassUuid for the final plan. rules is derived from the class document, never supplied. Read-only. Prep-only.",
      parameters: exact({
        actorUuid: ref(), classUuid: ref(),
        subclassUuid: Type.Optional(ref()), raceUuid: Type.Optional(ref()),
        characterLevel: Type.Integer({ minimum: 1, maximum: 20 }) }),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().advancementPlan(params, signal)),
    }),
    defineTool({
      name: "foundry_execute_action", label: "Execute Action",
      description: "Use a discovered action reference. Pass either actionRef for one action or actions for a combat sequence, never both. Outside combat execute one spell or attack; during combat execute only the current actor and read current turn first. Narrative records spell consumption while the DM resolves fiction. Summoning awaits auto pack support. Partial or indeterminate receipts must never be retried automatically.",
      parameters: Type.Union([
        exact({ ...actionFields, resolution: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("narrative")])), advance: Type.Optional(Type.Boolean()) }),
        exact({ actions: Type.Array(exact(actionFields), { minItems: 1, maxItems: 20 }), advance: Type.Optional(Type.Boolean()) }),
      ]),
      executionMode: "sequential",
      promptGuidelines: ["Pass attackRollMode only when advertised and explicitly requested by the DM; normal leaves the roll unforced. For a batch, scope it per action. Never infer advantage or riders."],
      execute: async (id, params, signal) => {
        const binding = host.taskCoordinator().currentInputBinding();
        const approved = await host.maybeRequestApproval({ tool: "foundry_execute_action", summary: "Execute the requested spell or attack", args: params });
        if (!approved) return textResult({ status: "rejected", code: "DECLINED", message: "DM declined; do not retry." });
        return textResult(await host.foundryServices().executeAction(params, binding, id, signal));
      },
    }),
    defineTool({
      name: "foundry_static_context", label: "Static Context",
      description: "Read the full static manual once per combat or Scene: all focused Tokens and their complete supported abilities. During combat focus is its participants; otherwise every current Scene Token. Refresh only when the scope or capability structure changes. This clears prior turn evidence: in combat read play_context(view=turn) after this, before executing.",
      parameters: exact({}),
      execute: async (_id, _params, signal) => textResult(await host.foundryServices().readStatic(signal)),
    }),
    defineTool({
      name: "foundry_play_context", label: "Play Context",
      description: "Read lightweight current HP, resources, conditions and available action IDs for the same focus as static context. Use turn before and after combat actions. Status instructions need no preliminary read. Operation view inspects a known receipt without retrying it.",
      parameters: Type.Union([
        exact({ view: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("turn")])) }),
        exact({ view: Type.Literal("operation"), operationRef: ref() }),
      ]),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().readPlay(params, signal)),
    }),
    defineTool({
      name: "foundry_conditions_set", label: "Set Conditions",
      description: 'Set or remove named system conditions, including explicitly ending concentration. Supply active true/false, never toggle. Prep Actor example: {"targets":[{"kind":"actor","actorUuid":"Actor.ID"}],"conditions":[{"key":"prone","active":true}]}. Selected means the Tokens selected when the user submitted their message. Play targets must have a Token in the current focus; actor/actors selectors are prep-only. Source-managed effects are protected.',
      parameters: exact({
        targets: Type.Array(source, { minItems: 1, maxItems: 20 }),
        conditions: Type.Array(exact({ key: ref(), active: Type.Boolean() }), { minItems: 1, maxItems: 8 }),
      }),
      executionMode: "sequential",
      execute: async (id, params, signal) => {
        // Pin the consumed input before any approval wait; later steering cannot change this command.
        const binding = host.taskCoordinator().currentInputBinding();
        const approved = await host.maybeRequestApproval({ tool: "foundry_conditions_set",
          summary: params.conditions.map(value => `${value.key}=${value.active}`).join(", "), args: params });
        if (!approved) return textResult({ status: "rejected", code: "DECLINED", message: "DM declined; do not retry." });
        return textResult(await host.foundryServices().setConditions(params, binding, id, signal));
      },
    }),
  ];
}
