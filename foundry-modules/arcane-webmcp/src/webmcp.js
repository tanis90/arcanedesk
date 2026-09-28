const EMPTY_OBJECT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});

export function compileRuntime(runtimeSource, FunctionConstructor = Function) {
  if (typeof runtimeSource !== "string" || !runtimeSource.includes("async function")) {
    throw new TypeError("Arcane SDK runtimeFunction is invalid");
  }

  const factory = new FunctionConstructor(
    `"use strict"; return (${runtimeSource});`,
  );
  const runtime = factory();
  if (typeof runtime !== "function") {
    throw new TypeError("Arcane SDK runtimeFunction did not compile to a function");
  }
  return runtime;
}

function foundrySummary(gameRef) {
  return {
    ready: gameRef?.ready === true,
    foundryVersion: gameRef?.version ?? null,
    world: gameRef?.world
      ? { id: gameRef.world.id, title: gameRef.world.title }
      : null,
    system: gameRef?.system
      ? {
          id: gameRef.system.id,
          title: gameRef.system.title,
          version: gameRef.system.version,
        }
      : null,
    user: gameRef?.user
      ? {
          id: gameRef.user.id,
          name: gameRef.user.name,
          isGM: gameRef.user.isGM === true,
        }
      : null,
  };
}

const REF_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9._:-]+$",
};

const ACTIVITY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    spellLevel: {
      type: "integer",
      minimum: 1,
      maximum: 9,
      description: "Upcast spell level; only when the manual advertises it.",
    },
    attackRollMode: {
      enum: ["normal", "advantage", "disadvantage"],
      description: "Only when the manual lists input.attackRollMode and the DM explicitly declares it.",
    },
    selections: {
      type: "object",
      description: "Choice values keyed exactly as listed in the manual; never invented.",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
    allocation: {
      type: "array",
      maxItems: 100,
      items: { type: "object" },
      description: "Slot allocation entries copied from the manual's shape.",
    },
    declaredRiders: {
      type: "array",
      maxItems: 20,
      items: { type: "object" },
      description: "Only riders the manual lists and play context shows active.",
    },
    targetSpec: {
      type: "object",
      description: "Target specification when the manual requires one.",
    },
  },
  additionalProperties: false,
};

const ACTION_SPEC_SCHEMA = {
  type: "object",
  properties: {
    actionRef: { ...REF_SCHEMA, description: "Stable action reference from arcane_static_context / arcane_play_context." },
    targetTokenUuids: {
      type: "array",
      maxItems: 100,
      items: REF_SCHEMA,
      description: "Exact target Token UUIDs; native self actions take none.",
    },
    input: ACTIVITY_INPUT_SCHEMA,
  },
  required: ["actionRef"],
  additionalProperties: false,
};

const REQUEST_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:-]+$",
  description: "Unique idempotency key for this intended write.",
};

const READ_REF_SCHEMA = {
  ...REF_SCHEMA,
  description: "Session readRef returned by a prior arcane_actor_get / arcane_scene_get in this page session.",
};

// Names may contain spaces and CJK; Desktop ref() carries no charset pattern.
const NAME_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
};

const UUID_REF_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: "Exact world document UUID (never a Compendium UUID).",
};

const GRANT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    uuid: { ...REF_SCHEMA, description: "Direct compendium entry UUID." },
    packId: { ...REF_SCHEMA, description: "Compendium pack, e.g. dnd5e.items." },
    entryId: { ...REF_SCHEMA, description: "Compendium entry index/Id within the pack." },
    expectedName: { ...NAME_SCHEMA, description: "Exact name drift guard; copy verbatim from browse output or omit." },
    expectedType: { ...REF_SCHEMA, description: "Exact Item type drift guard." },
    quantity: { type: "integer", minimum: 1, maximum: 999 },
    equipped: { type: "boolean" },
  },
  additionalProperties: false,
};

const ABILITY_SCORES_SCHEMA = {
  type: "object",
  properties: {
    str: { type: "integer", minimum: 1, maximum: 20 },
    dex: { type: "integer", minimum: 1, maximum: 20 },
    con: { type: "integer", minimum: 1, maximum: 20 },
    int: { type: "integer", minimum: 1, maximum: 20 },
    wis: { type: "integer", minimum: 1, maximum: 20 },
    cha: { type: "integer", minimum: 1, maximum: 20 },
  },
  additionalProperties: false,
};

const PLACEMENT_FIELDS_PROPERTIES = {
  x: { type: "number" },
  y: { type: "number" },
  name: NAME_SCHEMA,
  hidden: { type: "boolean" },
  disposition: { type: "integer", enum: [-1, 0, 1] },
  width: { type: "number", exclusiveMinimum: 0 },
  height: { type: "number", exclusiveMinimum: 0 },
  elevation: { type: "number" },
};

const TOKEN_LAYOUT_SCHEMA = {
  type: "object",
  properties: {
    create: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          ...PLACEMENT_FIELDS_PROPERTIES,
          actorUuid: { ...UUID_REF_SCHEMA, description: "Actor to place." },
          actorLink: { type: "boolean", description: "Defaults to the Actor prototype's link setting." },
        },
        required: ["actorUuid", "x", "y"],
        additionalProperties: false,
      },
    },
    update: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          tokenId: { ...REF_SCHEMA, description: "Exact Token document ID within the Scene." },
          changes: {
            type: "object",
            properties: PLACEMENT_FIELDS_PROPERTIES,
            additionalProperties: false,
          },
        },
        required: ["tokenId", "changes"],
        additionalProperties: false,
      },
    },
    deleteIds: {
      type: "array",
      maxItems: 100,
      uniqueItems: true,
      items: { ...REF_SCHEMA, description: "Token document IDs to delete." },
    },
  },
  additionalProperties: false,
};

const DATA_IMAGE_SCHEMA = {
  type: "object",
  properties: {
    dataPath: {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      description: "Existing Data-relative PNG/JPEG/WebP path; WebMCP cannot upload local files.",
    },
  },
  required: ["dataPath"],
  additionalProperties: false,
};

const SCENE_FIELDS_PROPERTIES = {
  name: NAME_SCHEMA,
  active: { type: "boolean" },
  background: DATA_IMAGE_SCHEMA,
  width: { type: "integer", minimum: 1 },
  height: { type: "integer", minimum: 1 },
  grid: {
    type: "object",
    properties: {
      type: { type: "integer" },
      size: { type: "number", exclusiveMinimum: 0 },
      distance: { type: "number", exclusiveMinimum: 0 },
      units: { type: "string", maxLength: 256 },
    },
    additionalProperties: false,
  },
};

const ACTOR_CHANGES_SCHEMA = {
  type: "object",
  properties: {
    name: NAME_SCHEMA,
    folderId: { ...REF_SCHEMA, description: "Existing Actor folder, or null to unfolder." },
    prototypeToken: {
      type: "object",
      properties: {
        name: NAME_SCHEMA,
        width: { type: "number", exclusiveMinimum: 0, maximum: 100 },
        height: { type: "number", exclusiveMinimum: 0, maximum: 100 },
        disposition: { type: "integer", enum: [-1, 0, 1] },
      },
      additionalProperties: false,
    },
    dnd5e: {
      type: "object",
      properties: {
        hp: {
          type: "object",
          properties: {
            value: { type: "number", minimum: 0 },
            max: { type: "number", minimum: 0 },
            temp: { type: "number", minimum: 0 },
          },
          additionalProperties: false,
        },
        ac: {
          type: "object",
          properties: { flat: { type: "number" } },
          required: ["flat"],
          additionalProperties: false,
        },
        abilities: ABILITY_SCORES_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export function createToolDefinitions({
  gameRef,
  locationRef,
  runtime,
  sdkMetadata,
  moduleVersion,
  writeProbeStore,
  turnExecutor,
  playTools,
  prepTools,
  bridgeIdentity,
}) {
  return [
    {
      name: "arcane_probe",
      description:
        "Read a small diagnostic snapshot proving that Arcane WebMCP is attached to this top-level Foundry page and current session.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => ({
        ok: true,
        bridge: "arcane-webmcp-fvtt",
        bridgeSession: bridgeIdentity,
        moduleVersion,
        sdk: sdkMetadata,
        page: {
          href: locationRef?.href ?? null,
        },
        foundry: foundrySummary(gameRef),
      }),
    },
    {
      name: "arcane_world_info",
      description:
        "Read Foundry world, system, user, and key module status through the Arcane Foundry SDK runtime. Requires the current Foundry user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => runtime("worldInfo", {}, { requireGM: true }),
    },
    {
      name: "arcane_battle_context",
      description:
        "Read the active Foundry combat roster and agent-callable action catalog through Arcane Turn Protocol v2. Requires the current Foundry user to be a GM and fails when no combat is active.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => runtime("battleContext", {}, { requireGM: true }),
    },
    {
      name: "arcane_turn_context",
      description:
        "Read the current Foundry turn, active actor resources, available action IDs, and combatant state through Arcane Turn Protocol v2. Requires the current Foundry user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => runtime("turnContext", {}, { requireGM: true }),
    },
    {
      name: "arcane_static_context",
      description:
        "Read the full static manual once per combat or Scene: every focused Token with its complete supported abilities, as stable actionRef entries. During combat the focus is the combat roster; otherwise every Token on the current Scene. Refresh only when the combat/Scene scope or capability structure changes. This read clears prior turn evidence: in combat, read arcane_play_context with view=turn afterwards before executing anything. Requires the current Foundry user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => playTools.staticContext(),
    },
    {
      name: "arcane_play_context",
      description:
        "Read lightweight dynamic HP, resources, conditions, and available actionRefs for the same focus as arcane_static_context. view=turn is the mandatory read before and after every combat action (there is no still-fresh exemption); view=current reads without turn bookkeeping; view=operation plus operationRef returns one prior write receipt without retrying it. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          view: {
            enum: ["current", "turn", "operation"],
            description: "Defaults to current.",
          },
          operationRef: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "The requestId of a prior write; only valid with view=operation.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => playTools.playContext(input ?? {}),
    },
    {
      name: "arcane_write_probe_state",
      description:
        "Read the Arcane WebMCP module's private write-probe marker, revision, and bounded idempotency receipts. Requires the current Foundry user to be a GM and does not read actors, scenes, or combat state.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => writeProbeStore.read(),
    },
    {
      name: "arcane_execute_turn_receipts",
      description:
        "Read Arcane WebMCP's module-owned execute-turn receipt ledger for the current Foundry world. Use this after an interrupted call to determine whether a request completed or became indeterminate. Requires the current user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => turnExecutor.read(),
    },
    {
      name: "arcane_write_probe",
      description:
        "TEST ONLY: update the Arcane WebMCP module's private world-scoped marker. This persists only idle/armed probe state plus a bounded receipt ledger; it does not modify actors, scenes, items, chat, or combat. The write requires a GM, the exact world ID and current revision returned by arcane_write_probe_state, and a unique requestId. Retrying the same requestId with identical arguments is idempotent. simulateResponseDelayMs delays only the response after the write has committed so interrupted-call recovery can be tested.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Unique idempotency key for this intended write.",
          },
          expectedWorldId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]+$",
            description:
              "Exact current world ID returned by arcane_write_probe_state; mismatches fail closed.",
          },
          value: {
            type: "string",
            enum: ["idle", "armed"],
            description: "The test marker value to persist.",
          },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description: "Current revision returned by arcane_write_probe_state.",
          },
          simulateResponseDelayMs: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            default: 0,
            description:
              "Test-only delay after commit and before returning the receipt.",
          },
        },
        required: [
          "requestId",
          "expectedWorldId",
          "value",
          "expectedRevision",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => writeProbeStore.write(input),
    },
    {
      name: "arcane_execute_action",
      description:
        "Execute discovered play abilities by actionRef through Arcane Play Protocol v1. Pass either actionRef for one action or actions for a combat sequence of the current actor, never both. CONSEQUENCES: rolls dice, creates chat, consumes slots and resources, changes HP, applies effects; placed templates wait for the DM in Foundry. Requires arcane_static_context read once in this page session, and in combat a fresh arcane_play_context view=turn before every execution; after any combat execution the turn read is invalidated and must be repeated. resolution=narrative records spell consumption while the DM resolves fiction. advance=true only on explicit DM request, combat only. rejected receipts have no side effects and may be corrected and retried with a NEW requestId; partial/indeterminate must never be replayed — inspect the operation via arcane_play_context view=operation instead. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Unique idempotency key for this intended action.",
          },
          actionRef: { ...REF_SCHEMA, description: "Single action; mutually exclusive with actions." },
          targetTokenUuids: {
            type: "array",
            maxItems: 100,
            items: REF_SCHEMA,
            description: "Exact target Token UUIDs for a single action.",
          },
          input: ACTIVITY_INPUT_SCHEMA,
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: ACTION_SPEC_SCHEMA,
            description: "Combat sequence for the current actor; each entry carries its own targets and input.",
          },
          resolution: {
            enum: ["auto", "narrative"],
            description: "Defaults to auto; narrative only records consumption.",
          },
          advance: {
            type: "boolean",
            description: "Advance the combat turn after the sequence; only on explicit DM request.",
          },
        },
        required: ["requestId"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => playTools.executeAction(input),
    },
    {
      name: "arcane_conditions_set",
      description:
        "Set or remove named system conditions on play targets, including explicitly ending concentration (专注/concentrating). Supply active true/false, never toggle. Common Chinese condition names are accepted and mapped automatically. Targets: exact tokenUuid, name within the current focus, or selected (the canvas selection at call time — WebMCP has no message boundary, so prefer exact tokenUuid). At most 20 targets and 8 conditions per call; source-managed effects are protected. Each call needs a unique requestId; retrying the same requestId with identical arguments is idempotent. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Unique idempotency key for this intended change.",
          },
          targets: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                kind: { enum: ["token", "name", "selected"] },
                tokenUuid: { ...REF_SCHEMA, description: "Required when kind=token." },
                name: { ...REF_SCHEMA, description: "Required when kind=name; disambiguate duplicate names first." },
                scope: { enum: ["focus"], description: "Required when kind=name; WebMCP resolves names within the current focus only." },
              },
              required: ["kind"],
              additionalProperties: false,
            },
          },
          conditions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                key: { ...REF_SCHEMA, description: "System condition key, English or the common Chinese name." },
                active: { type: "boolean", description: "true sets, false removes; never toggle." },
              },
              required: ["key", "active"],
              additionalProperties: false,
            },
          },
        },
        required: ["requestId", "targets", "conditions"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => playTools.conditionsSet(input),
    },
    {
      name: "arcane_content_search",
      description:
        "Search world Actors/Scenes or compendium Actors/Items by name; Items also match their system identifier across translated names. documentType is case-sensitive: Actor, Item, or Scene. Returns exact UUIDs and source pack references in bounded pages. Use these references to avoid guessing identities or duplicate content. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { enum: ["world", "compendium"], description: "Where to search." },
          documentType: { enum: ["Actor", "Item", "Scene"] },
          query: { type: "string", maxLength: 256, description: "Name or identifier substring; empty matches page through everything." },
          packIds: {
            type: "array",
            maxItems: 20,
            items: REF_SCHEMA,
            description: "Restrict compendium scope to these packs.",
          },
          actorType: { ...REF_SCHEMA, description: "character or npc, for Actor scopes." },
          itemType: { ...REF_SCHEMA, description: "Native Item type, for Item scopes." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { ...REF_SCHEMA, description: "Next-page cursor from a prior response." },
        },
        required: ["scope", "documentType", "query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => prepTools.contentSearch(input),
    },
    {
      name: "arcane_compendium_browse",
      description:
        "Enumerate compendium candidates by type and filters, or read full documents by UUID. type=class/subclass/race returns the deduplicated discovery catalog (entries carry uuid, identifier, packId and rules label; subclass filters by classUuid) so class/subclass/race identities never need fuzzy search. type=spell/item pages candidates matched by name or identifier (rules narrows 2014 vs 2024, maxLevel bounds spell level, itemType narrows to one native Item kind and equipment excludes weapons — omit itemType when resolving remembered gear names); identifier matching ignores punctuation, so 'Explorer's Pack' reaches identifier explorers-pack. candidates carry eligibility hints for classUuid. names mode batch-resolves up to 50 remembered spell/item names in one call — each entry is one single-language name or identifier, never a combined '中文 English' string — and returns per-name status unique/ambiguous/miss with candidates; ambiguous usually means both rules versions exist, so pass rules to narrow. uuids mode returns up to 20 full documents for semantic selection or reconciliation, never for discovery. Read-only. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { enum: ["compendium"] },
          type: { enum: ["spell", "item", "class", "subclass", "race"], description: "Catalog/query mode; mutually exclusive with uuids." },
          rules: { enum: ["2014", "2024"] },
          classUuid: { ...REF_SCHEMA, description: "Subclass catalog filter or spell/item eligibility hint." },
          maxLevel: { type: "integer", minimum: 0, maximum: 9, description: "Spell level bound for spell queries." },
          itemType: { enum: ["weapon", "equipment", "consumable", "tool", "loot", "container", "ammo"] },
          query: { type: "string", maxLength: 256 },
          names: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string", maxLength: 256 },
            description: "Batch-resolve remembered spell/item names (single-language entries only).",
          },
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 50 },
          uuids: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: REF_SCHEMA,
            description: "Read full documents by exact compendium UUIDs; mutually exclusive with every query field.",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => prepTools.compendiumBrowse(input),
    },
    {
      name: "arcane_advancement_plan",
      description:
        "Compute the native dnd5e level-up plan for an existing character or NPC (actorUuid) taking a class to characterLevel, without writing the world: steps dnd5e grants automatically (including HP — max hit die at level 1 for characters, fixed average later and for every NPC extension level, never a choice; NPC extensions roll the monster size die, never the class die), the choices a caller must supply (each with its candidate pool, value format and key — copy key verbatim into arcane_actor_advance choices.bySlot, while subclass-uuid requirements keep key 'subclassUuid', the top-level argument; race trait choices such as bonus languages appear the same way; expertise trait slots are marked mode 'expertise' with a note — their picks must be already-proficient traits, on the sheet or from earlier slots of the same advance call), choicesTemplate (one fill-in skeleton per bySlot key), race movement (race items carry speed directly, not as advancement steps), uncovered native steps, spellBudget (hardcoded rules-table spellcasting totals; prepared-list casters receive their full class spell list instead), and actorAdvanceArgs to pass straight into arcane_actor_advance. Call once without subclassUuid to get the subclass candidate pool, then again with subclassUuid for the final plan. rules is derived from the class document, never supplied. Read-only. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          actorUuid: UUID_REF_SCHEMA,
          classUuid: UUID_REF_SCHEMA,
          subclassUuid: { ...UUID_REF_SCHEMA, description: "Omit once to list candidates, then pass the chosen one." },
          raceUuid: UUID_REF_SCHEMA,
          characterLevel: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["actorUuid", "classUuid", "characterLevel"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => prepTools.advancementPlan(input),
    },
    {
      name: "arcane_actor_get",
      description:
        "Read an exact Actor's compact summary and requested editing projections. Returns a session readRef required for arcane_actor_update / arcane_actor_grant_items / arcane_actor_advance. Include items before grants and prototypeToken before changing its fields. Pages do not contain full Item documents. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          actorUuid: UUID_REF_SCHEMA,
          include: {
            type: "array",
            maxItems: 4,
            uniqueItems: true,
            items: { enum: ["items", "resources", "prototypeToken", "sceneTokens"] },
            description: "Projections to include; items before grants, prototypeToken/sceneTokens before image sync.",
          },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { ...REF_SCHEMA, description: "Next-page cursor from a prior response." },
        },
        required: ["actorUuid"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => prepTools.actorGet(input),
    },
    {
      name: "arcane_scene_get",
      description:
        "Read an exact Scene, including one not currently displayed. Returns compact metadata and requested placeable pages plus a session readRef required for arcane_scene_apply updates. Include tokens before changing or deleting existing Tokens. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          sceneUuid: UUID_REF_SCHEMA,
          include: {
            type: "array",
            maxItems: 6,
            uniqueItems: true,
            items: { enum: ["tokens", "walls", "lights", "tiles", "notes", "sounds"] },
          },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { ...REF_SCHEMA, description: "Next-page cursor from a prior response." },
        },
        required: ["sceneUuid"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => prepTools.sceneGet(input),
    },
    {
      name: "arcane_actor_create",
      description:
        "Create an empty or compendium Actor with an explicit name and optional initial compendium Items. Optional prototypeToken.name sets the prototype Token name in the same creation. Optional dnd5e.abilities sets base ability scores (integers 1..20) at creation — before any advancement, so racial and ASI bonuses add on top; new characters should receive their standard array here. Existing names are returned as collisions; partial creation is never retried automatically. Each call needs a unique requestId; retrying the same requestId with identical arguments is idempotent. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: REQUEST_ID_SCHEMA,
          source: {
            type: "object",
            properties: {
              kind: { enum: ["blank", "compendium"] },
              actorType: { enum: ["character", "npc"], description: "Required when kind=blank." },
              packId: { ...REF_SCHEMA, description: "Required when kind=compendium." },
              entryId: { ...REF_SCHEMA, description: "Required when kind=compendium." },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          name: { ...NAME_SCHEMA, description: "Explicit unique name; spaces and CJK allowed." },
          folderId: { ...REF_SCHEMA, description: "Existing Actor folder." },
          initialItems: { type: "array", maxItems: 50, items: GRANT_ITEM_SCHEMA },
          prototypeToken: {
            type: "object",
            properties: { name: NAME_SCHEMA },
            required: ["name"],
            additionalProperties: false,
          },
          dnd5e: {
            type: "object",
            properties: { abilities: ABILITY_SCORES_SCHEMA },
            required: ["abilities"],
            additionalProperties: false,
          },
        },
        required: ["requestId", "source", "name"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => prepTools.actorCreate(input),
    },
    {
      name: "arcane_actor_update",
      description:
        "Update bounded Actor name, existing folder, prototype Token fields, HP, flat AC or base ability scores (integers 1..20). Ability writes are SET semantics: after advancement they must already include racial/ASI additions, so new characters should receive base scores via arcane_actor_create instead. Requires a current readRef (from arcane_actor_get in this page session) covering the touched fields; unrelated changes do not block. Use arcane_image for portraits and Token image synchronization. Each call needs a unique requestId; retrying the same requestId with identical arguments is idempotent; rejected receipts have no side effects and may be corrected and retried with a NEW requestId. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: REQUEST_ID_SCHEMA,
          actorUuid: UUID_REF_SCHEMA,
          readRef: READ_REF_SCHEMA,
          changes: ACTOR_CHANGES_SCHEMA,
        },
        required: ["requestId", "actorUuid", "readRef", "changes"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => prepTools.actorUpdate(input),
    },
    {
      name: "arcane_actor_grant_items",
      description:
        "Grant exact compendium Items to an Actor after reading its items projection (readRef from arcane_actor_get with include=items). Existing sources are skipped, never stacked or replaced; the receipt reports created and skipped identities. expectedName/expectedType are exact-match drift guards: copy the name verbatim from arcane_compendium_browse output or omit them entirely — a synthesized or translated name rejects the whole batch before any write. Each call needs a unique requestId; retrying the same requestId with identical arguments is idempotent. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: REQUEST_ID_SCHEMA,
          actorUuid: UUID_REF_SCHEMA,
          readRef: READ_REF_SCHEMA,
          items: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: GRANT_ITEM_SCHEMA,
            description: "Compendium Items to grant; each needs uuid or packId+entryId.",
          },
        },
        required: ["requestId", "actorUuid", "readRef", "items"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => prepTools.actorGrantItems(input),
    },
    {
      name: "arcane_actor_advance",
      description:
        "Advance an existing dnd5e Character or NPC through the native AdvancementManager. First compute arcane_advancement_plan, then supply source UUIDs and fill choices.bySlot slot by slot: copy each key verbatim from the plan's choiceRequirements[].key (choicesTemplate carries one fill-in skeleton per key). Trait/pool slots take an array of native trait keys (skills:arc, languages:standard:elvish) or candidate-pool UUIDs exactly count entries long; ASI slots take { abilityScore: { str: 2 } } floating picks and race fixed bonuses merge in automatically; asi-or-feat slots take either { abilityScore } or { feat: \"<uuid>\" }, never both; subclass-uuid requirements stay the top-level subclassUuid argument. Keys the plan never listed reject before any write with CHOICE_SLOT_UNKNOWN naming the valid slots. HP, class features, resources and derived values are calculated by dnd5e. Expertise slots (mode 'expertise' in the plan): every pick must already be proficient — on the sheet or chosen in an earlier slot of this same call. Mirror rule for default-mode trait slots: never re-pick a skills:/tool: trait already on the sheet or chosen in an earlier slot of this call; redundant picks reject the whole advance before any write naming the offenders. Requires a current Actor readRef. Missing or invalid choices are rejected before any world write; additionalItems are validated the same way — expectedName must be copied verbatim from browse output or omitted. When the plan's spellBudget carries fullList (prepared-list casters such as cleric, druid, paladin or artificer), pass fullSpellList true once to grant the whole annotated class spell list up to the highest slot level after advancement; other classes reject with INPUT_INVALID before any write. Fresh actors (level 0 before advancement) automatically end at full spell slots and, for characters, full HP; advances of experienced actors never touch current HP or slots. For NPC extensions HP uses the monster size die per native dnd5e rules, never the class die. Partial/indeterminate receipts must never be replayed. Each call needs a unique requestId. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: REQUEST_ID_SCHEMA,
          actorUuid: UUID_REF_SCHEMA,
          readRef: READ_REF_SCHEMA,
          classUuid: UUID_REF_SCHEMA,
          subclassUuid: UUID_REF_SCHEMA,
          raceUuid: UUID_REF_SCHEMA,
          targetLevel: { type: "integer", minimum: 1, maximum: 20 },
          choices: {
            type: "object",
            properties: {
              bySlot: {
                type: "object",
                description: "Keys copied verbatim from the advancement plan; values are trait lists or abilityScore/feat picks.",
                additionalProperties: {
                  anyOf: [
                    { type: "array", maxItems: 20, uniqueItems: true, items: REF_SCHEMA },
                    {
                      type: "object",
                      properties: {
                        abilityScore: {
                          type: "object",
                          description: "Floating ASI picks, e.g. { str: 2 }.",
                          additionalProperties: { type: "integer", minimum: 1, maximum: 2 },
                        },
                        feat: REF_SCHEMA,
                      },
                      additionalProperties: false,
                    },
                  ],
                },
              },
              hp: { enum: ["max", "avg"] },
            },
            additionalProperties: false,
          },
          additionalItems: { type: "array", maxItems: 50, items: GRANT_ITEM_SCHEMA },
          fullSpellList: { type: "boolean", description: "Grant the full class spell list for prepared-list casters; only when the plan's spellBudget carries fullList." },
        },
        required: ["requestId", "actorUuid", "readRef", "classUuid", "targetLevel"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => prepTools.actorAdvance(input),
    },
    {
      name: "arcane_scene_apply",
      description:
        "Create or update an explicit Scene's metadata, grid, background and Token layout. At most 100 total Token operations per kind; grouped creates/updates/deletes run in order and activation runs last. Token actorLink defaults to its Actor prototype. Background accepts a Data-relative path only — WebMCP cannot upload local files, never Base64. Updates require a readRef from arcane_scene_get (include tokens before changing or deleting existing Tokens). Partial/indeterminate receipts must never be replayed. Each call needs a unique requestId; retrying the same requestId with identical arguments is idempotent. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: REQUEST_ID_SCHEMA,
          operation: { enum: ["create", "update"] },
          scene: {
            type: "object",
            properties: SCENE_FIELDS_PROPERTIES,
            description: "Scene changes; name is required when operation=create.",
            additionalProperties: false,
          },
          sceneUuid: UUID_REF_SCHEMA,
          readRef: READ_REF_SCHEMA,
          tokens: TOKEN_LAYOUT_SCHEMA,
        },
        required: ["requestId", "operation"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => prepTools.sceneApply(input),
    },
    {
      name: "arcane_image",
      description:
        "Apply an existing Data-relative PNG/JPEG/WebP image to an exact world Actor, Item (including embedded Items), or image-type JournalEntryPage UUID; omit targetUuid to only validate the path. Actor targets update portrait and prototype Token; syncPlacedTokens additionally updates placed Token images across scenes, preserving layout and names. Item targets update img; Journal image pages update src; text Journal pages can embed the returned path using native APIs. WebMCP has no local byte channel: sourcePath uploads and Base64 are rejected with CAPABILITY_UNAVAILABLE — upload through the Desktop app or Foundry UI first, then reference the resulting dataPath. Partial/indeterminate receipts must never be replayed. Each call needs a unique requestId; retrying the same requestId with identical arguments is idempotent. Requires the current Foundry user to be a GM.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: REQUEST_ID_SCHEMA,
          dataPath: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
            description: "Existing Data-relative PNG/JPEG/WebP path, e.g. modules/mymodule/art/portrait.png.",
          },
          targetUuid: { ...UUID_REF_SCHEMA, description: "World Actor/Item/JournalEntryPage UUID; omit for path validation only." },
          syncPlacedTokens: { type: "boolean", description: "Actor targets only: also update placed Token images." },
        },
        required: ["requestId", "dataPath"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => prepTools.image(input),
    },
    {
      name: "arcane_execute_turn",
      description:
        "Execute exactly one currently available Arcane Turn Protocol v2 action for the active combatant, without advancing the turn. CONSEQUENCES: this can create chat messages, roll dice, consume actor resources, change HP, and apply effects; the underlying Foundry action may also open a human-in-the-loop dialog. Inputs must echo the current bridge/runtime/world/battle/turn identity from arcane_probe and arcane_turn_context. A durable requestId receipt is written before execution. Never retry with a new requestId after an interruption; read arcane_execute_turn_receipts and live turn state first.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Unique idempotency key for this intended action.",
          },
          expectedBridgeSessionId: {
            type: "string",
            enum: [bridgeIdentity.sessionId],
            description: "Exact page session ID returned by arcane_probe.",
          },
          expectedModuleVersion: {
            type: "string",
            enum: [bridgeIdentity.moduleVersion],
          },
          expectedRuntimeVersion: {
            type: "string",
            enum: [bridgeIdentity.runtimeVersion],
          },
          expectedProtocolVersion: {
            type: "integer",
            enum: [bridgeIdentity.protocolVersion],
          },
          expectedRuntimeHash: {
            type: "string",
            enum: [bridgeIdentity.runtimeHash],
          },
          expectedWorldId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          expectedBattleId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          expectedRound: { type: "integer", minimum: 0 },
          expectedTurnIndex: { type: "integer", minimum: 0 },
          expectedSourceTokenId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          actionId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          targetTokenIds: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              pattern: "^[A-Za-z0-9._:-]+$",
            },
          },
        },
        required: [
          "requestId",
          "expectedBridgeSessionId",
          "expectedModuleVersion",
          "expectedRuntimeVersion",
          "expectedProtocolVersion",
          "expectedRuntimeHash",
          "expectedWorldId",
          "expectedBattleId",
          "expectedRound",
          "expectedTurnIndex",
          "expectedSourceTokenId",
          "actionId",
          "targetTokenIds",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => turnExecutor.execute(input),
    },
  ];
}

export async function registerArcaneWebMcp({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  gameRef = globalThis.game,
  locationRef = globalThis.location,
  runtime,
  sdkMetadata,
  moduleVersion,
  writeProbeStore,
  turnExecutor,
  playTools,
  prepTools,
  bridgeIdentity,
} = {}) {
  if (!documentRef || !windowRef) {
    return { status: "unsupported", reason: "missing-page-globals", tools: [] };
  }

  if (windowRef.top !== windowRef) {
    return { status: "unsupported", reason: "not-top-level", tools: [] };
  }

  const registerTool = documentRef.modelContext?.registerTool;
  if (typeof registerTool !== "function") {
    return { status: "unsupported", reason: "webmcp-api-missing", tools: [] };
  }

  const tools = createToolDefinitions({
    gameRef,
    locationRef,
    runtime,
    sdkMetadata,
    moduleVersion,
    writeProbeStore,
    turnExecutor,
    playTools,
    prepTools,
    bridgeIdentity,
  });

  const registered = [];
  for (const tool of tools) {
    await registerTool.call(documentRef.modelContext, tool);
    registered.push(tool.name);
  }

  return { status: "registered", reason: null, tools: registered };
}
