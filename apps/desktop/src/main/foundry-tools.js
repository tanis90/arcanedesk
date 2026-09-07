import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

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
const activityInput = exact({
  spellLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })),
  attackRollMode: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("advantage"), Type.Literal("disadvantage")])),
  selections: Type.Optional(Type.Record(Type.String({ maxLength: 256 }), Type.Union([ref(), Type.Number(), Type.Boolean()]))),
  allocation: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100 })),
  declaredRiders: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 20 })),
  targetSpec: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const actionFields = { actionRef: ref(), targetTokenUuids: Type.Optional(Type.Array(ref(), { maxItems: 100 })), input: Type.Optional(activityInput) };
const grant = exact({ packId: ref(), entryId: ref(), expectedName: Type.Optional(ref()), expectedType: Type.Optional(ref()),
  quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 999 })), equipped: Type.Optional(Type.Boolean()) });
const actorImage = Type.Union([
  exact({ dataPath: Type.String({ minLength: 1, maxLength: 4096 }), syncPlacedTokens: Type.Optional(Type.Boolean()) }),
  exact({ sourcePath: Type.String({ minLength: 1, maxLength: 4096 }), syncPlacedTokens: Type.Optional(Type.Boolean()) }),
]);
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
const actorChanges = exact({ name: Type.Optional(ref()), folderId: Type.Optional(Type.Union([ref(), Type.Null()])),
  image: Type.Optional(actorImage),
  prototypeToken: Type.Optional(exact({ name: Type.Optional(ref()), width: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
    height: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })), disposition: Type.Optional(Type.Union([Type.Literal(-1), Type.Literal(0), Type.Literal(1)])) })),
  dnd5e: Type.Optional(exact({ hp: Type.Optional(exact({ value: Type.Optional(Type.Number({ minimum: 0 })),
    max: Type.Optional(Type.Number({ minimum: 0 })), temp: Type.Optional(Type.Number({ minimum: 0 })) })),
    ac: Type.Optional(exact({ flat: Type.Number() })) })) });

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
      name: ref(), folderId: Type.Optional(ref()), image: Type.Optional(actorImage), initialItems: Type.Optional(Type.Array(grant, { maxItems: 50 })),
    }), "Create an empty or compendium Actor with an explicit name and optional initial compendium Items. Existing names are returned as collisions; partial creation is never retried automatically. Prep-only."),
    actorWrite("foundry_actor_update", "actorEdit", exact({ actorUuid: ref(), readRef: ref(), changes: actorChanges }),
      "Update bounded Actor name, existing folder, image, prototype Token fields, HP or flat AC. Images use a Data-relative path or a local sourcePath inside the prep directory (PNG/JPEG/WebP, at most 10 MiB); never supply Base64. Include prototypeToken in the prior read, and sceneTokens when syncPlacedTokens is true. Synchronization preserves Token names, positions and sizes. Requires a current readRef for touched fields; unrelated changes do not block. Prep-only."),
    actorWrite("foundry_actor_grant_items", "actorGrantItems", exact({ actorUuid: ref(), readRef: ref(), items: Type.Array(grant, { minItems: 1, maxItems: 50 }) }),
      "Grant exact compendium Items to an Actor after reading its items projection. Existing sources are skipped, never stacked or replaced. Reports created and skipped identities. Prep-only."),
    defineTool({
      name: "foundry_content_search", label: "Search Foundry Content",
      description: "Search world Actors/Scenes or compendium Actors/Items. Returns exact UUIDs and source pack references in bounded pages. Use these references to avoid guessing identities or duplicate content. Prep-only.",
      parameters: exact({ scope: Type.Union([Type.Literal("world"), Type.Literal("compendium")]),
        documentType: Type.Union([Type.Literal("Actor"), Type.Literal("Item"), Type.Literal("Scene")]),
        query: Type.String({ maxLength: 256 }), packIds: Type.Optional(Type.Array(ref(), { maxItems: 20 })),
        actorType: Type.Optional(ref()), itemType: Type.Optional(ref()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(ref()) }),
      execute: async (_id, params, signal) => textResult(await host.foundryServices().contentSearch(params, signal)),
    }),
    defineTool({
      name: "foundry_execute_action", label: "Execute Action",
      description: "Use a discovered action reference. Outside combat execute one spell or attack; during combat execute only the current actor and read current turn first. Narrative records spell consumption while the DM resolves fiction. Summoning awaits auto pack support. Partial or indeterminate receipts must never be retried automatically.",
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
      description: "Read the full static manual once per combat or Scene: all focused Tokens and their complete supported abilities. During combat focus is its participants; otherwise every current Scene Token. Refresh only when the scope or capability structure changes.",
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
      description: "Set or remove named system conditions, including explicitly ending concentration. Supply active true/false, never toggle. Selected means the Tokens selected when the user submitted their message. Play targets must have a Token in the current focus; actor/actors selectors are prep-only. Source-managed effects are protected.",
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
