/** Public protocol carried by the Arcane Foundry in-page runtime. */
export const protocolVersion = 2 as const;

/** Package/runtime release that owns the exact in-page source. */
export const runtimeVersion = "0.1.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RuntimeArguments = Record<string, unknown>;

export const SAFE_DIRECT_ACTIONS = [
  "worldInfo",
  "battleContext",
  "turnContext",
  "executeTurn",
] as const;

export type SafeDirectAction = (typeof SAFE_DIRECT_ACTIONS)[number];

/**
 * All actions implemented by the 0.1 runtime. Applications must still apply
 * their own allowlist. The SDK client defaults to SAFE_DIRECT_ACTIONS.
 */
export const ALL_DIRECT_ACTIONS = [
  "sceneRead", "sceneApply",
  "actorRead", "actorCreate", "actorEdit", "actorGrantItems", "actorAdvance", "imageApply",
  "contentSearch", "advancementPlan", "compendiumBrowse",
  "staticContext",
  "playContext",
  "conditionsSet",
  "executeAction",
  "doctor",
  "worldInfo",
  "sceneSnapshot",
  "combatSnapshot",
  "actorSearch",
  "actorGet",
  "actorExport",
  "actorImport",
  "actorCreateFromCompendium",
  "actorUpdate",
  "actorDamageMigrate",
  "actorBilingualSync",
  "actorAddItems",
  "actorAddItemsFromCompendium",
  "actorSetImage",
  "assetUpload",
  "createToken",
  "deleteToken",
  "tokenDetails",
  "tokenActions",
  "battleContext",
  "turnContext",
  "useAction",
  "executeTurn",
  "profileExecuteTurn",
  "applyTokenState",
  "startCombat",
  "nextTurn",
] as const;

export type DirectAction = (typeof ALL_DIRECT_ACTIONS)[number];

export type DirectActionEffect = "read" | "write";

/**
 * Conservative side-effect classification for every public runtime action.
 * Actions that can write under any supported argument shape are classified as
 * writes, including maintenance actions that also expose a dry-run mode.
 */
export const DIRECT_ACTION_EFFECTS = {
  sceneRead: "read", sceneApply: "write",
  actorRead: "read", actorCreate: "write", actorEdit: "write", actorGrantItems: "write", actorAdvance: "write", imageApply: "write",
  contentSearch: "read", advancementPlan: "read", compendiumBrowse: "read",
  staticContext: "read",
  playContext: "read",
  conditionsSet: "write",
  executeAction: "write",
  doctor: "read",
  worldInfo: "read",
  sceneSnapshot: "read",
  combatSnapshot: "read",
  actorSearch: "read",
  actorGet: "read",
  actorExport: "read",
  actorImport: "write",
  actorCreateFromCompendium: "write",
  actorUpdate: "write",
  actorDamageMigrate: "write",
  actorBilingualSync: "write",
  actorAddItems: "write",
  actorAddItemsFromCompendium: "write",
  actorSetImage: "write",
  assetUpload: "write",
  createToken: "write",
  deleteToken: "write",
  tokenDetails: "read",
  tokenActions: "read",
  battleContext: "read",
  turnContext: "read",
  useAction: "write",
  executeTurn: "write",
  profileExecuteTurn: "write",
  applyTokenState: "write",
  startCombat: "write",
  nextTurn: "write",
} as const satisfies Record<DirectAction, DirectActionEffect>;

export type WriteDirectAction = {
  [Action in DirectAction]:
    (typeof DIRECT_ACTION_EFFECTS)[Action] extends "write" ? Action : never;
}[DirectAction];

export type ReadDirectAction = Exclude<DirectAction, WriteDirectAction>;

export function isWriteDirectAction(action: DirectAction): action is WriteDirectAction {
  return DIRECT_ACTION_EFFECTS[action] === "write";
}

export const WRITE_DIRECT_ACTIONS: readonly WriteDirectAction[] =
  ALL_DIRECT_ACTIONS.filter(isWriteDirectAction);

export const READ_DIRECT_ACTIONS: readonly ReadDirectAction[] =
  ALL_DIRECT_ACTIONS.filter((action): action is ReadDirectAction => !isWriteDirectAction(action));

export interface WorldInfo {
  world: { id: string; title: string };
  system: { id: string; title: string; version: string };
  foundryVersion: string | null;
  user: { id: string; name: string; isGM: boolean };
  modules: Record<string, boolean>;
  ready?: boolean;
  moduleVersions?: Record<string, string | null>;
  capabilities?: {
    nativeActionEntryAvailable: boolean; narrativeSpellConsumption: boolean; conditionSetEntryAvailable: boolean;
    prepActorDocuments: boolean; prepSceneDocuments: boolean; imageUploadEntryAvailable: boolean;
    summonPlacement: false; summonDependency: "AUTO-001";
  };
}

export type CombatantSide = "party" | "hostile" | "neutral";

export interface BattleActionTarget {
  kind: string | null;
  count: number | null;
  range: number | null;
}

export interface BattleActionDefinition {
  id: string;
  itemId: string | null;
  itemName: string | null;
  name: string;
  kind: string | null;
  summary: string;
  target: BattleActionTarget;
  input: RuntimeArguments;
  declaredRiders?: RuntimeArguments[];
  warnings?: string[];
}

export interface BattleCombatant {
  actorId: string;
  tokenId: string;
  name: string | null;
  side: CombatantSide;
  static: {
    maxHp: number | null;
    ac: number | null;
    speed: number | null;
    senses: string[];
    traits: unknown[];
  };
  actions: BattleActionDefinition[];
}

export interface BattleContext {
  schema: "arcane.turn.v2";
  battleId: string;
  combatants: BattleCombatant[];
}

export interface TurnCombatant {
  actorId: string | null;
  tokenId: string;
  name: string | null;
  hp: { value: number | null; temp: number };
  conditions: string[];
  concentration: string | null;
  defeated: boolean;
  visible: boolean;
}

export interface ActiveTurn {
  round: number;
  index: number | null;
  actorId: string | null;
  tokenId: string | null;
  name: string | null;
}

export type TurnContext =
  | {
      schema: "arcane.turn.v2";
      battleId: null;
      ended: true;
    }
  | {
      schema: "arcane.turn.v2";
      battleId: string;
      ended: false;
      turn: ActiveTurn;
      actor: {
        hp: { value: number | null; temp: number };
        resources: Record<string, number>;
        conditions: string[];
        concentration: string | null;
        availableActionIds: string[];
      } | null;
      combatants: TurnCombatant[];
    };

export type AttackRollMode = "normal" | "advantage" | "disadvantage";

export interface DeclaredRiderRequest {
  id?: string;
  identifier?: string;
  spellLevel?: number;
  [key: string]: unknown;
}

export interface ExecuteTurnActionInput {
  attackRollMode?: AttackRollMode;
  declaredRiders?: DeclaredRiderRequest[];
  selections?: RuntimeArguments;
  allocation?: unknown[];
  targetSpec?: RuntimeArguments;
  spellLevel?: number;
  [key: string]: unknown;
}

export interface ExecuteTurnAction {
  actionId: string;
  targetTokenIds?: string[];
  input?: ExecuteTurnActionInput;
}

export type ExecuteTurnInput =
  | {
      actionId: string;
      targetTokenIds?: string[];
      input?: ExecuteTurnActionInput;
      advance?: boolean | "true";
    }
  | {
      actions: ExecuteTurnAction[];
      advance?: boolean | "true";
    };

export type RejectCode =
  | "ACTION_NOT_FOUND"
  | "ACTOR_NOT_ACTIVE"
  | "ACTION_BLOCKED"
  | "ACTION_MISCONFIGURED"
  | "INPUT_INVALID"
  | "BATTLE_NOT_ACTIVE";

export type NativeSummonLifecycle =
  | { mode: "concentration" | "root-concentration"; effectUuid: string }
  | { mode: "dm-duration" | "native"; effectUuid: null };

export interface NativeSummonReceipt {
  kind: "native-summon";
  humanStep: "native-summon-placement";
  outcome: "placed" | "partial-manual" | "skipped-manual";
  requestId: string;
  activityUuid: string;
  artifactId: string;
  choice: string;
  profileId: string;
  expectedCount: 1 | 2;
  placedCount: number;
  skippedCount: number;
  workflowUuid: string | null;
  messageUuid: string | null;
  members: Array<{
    memberIndex: number;
    tokenUuid: string;
    combatantUuid: string;
  }>;
  sourceCombatantUuid: string;
  inheritedInitiative: number;
  lifecycle: NativeSummonLifecycle;
  retry: false;
}

export type RuntimeStatus = "navigated" | "aborted" | "timeout" | "error";

export interface DirectActionInterruption {
  status: "indeterminate";
  retry: false;
  code: "FOUNDRY_SDK_RUNTIME_INTERRUPTED";
  action: WriteDirectAction;
  runtimeStatus: RuntimeStatus;
  message: string;
}

export type ExecuteTurnReceipt =
  | { status: "completed"; receipt?: NativeSummonReceipt }
  | { status: "rejected"; code: RejectCode; message?: string }
  | {
      status: "partial";
      completed: number;
      requested: number;
      advance: "not-requested" | "completed" | "not-completed";
      retry: false;
      message?: string;
    }
  | { status: "indeterminate"; retry: false }
  | {
      status: "indeterminate";
      retry: false;
      code: "FOUNDRY_SDK_RUNTIME_INTERRUPTED";
      runtimeStatus: RuntimeStatus;
      message: string;
    };

export interface FoundryActionContract<Input, Output> {
  input: Input;
  output: Output;
}

export interface FoundryActionMap {
  sceneRead: FoundryActionContract<SceneReadInput, SceneReadResult>;
  imageApply: FoundryActionContract<{ image: FoundryDataImage; targetUuid?: string; syncPlacedTokens?: boolean; world: { origin: string; id: string }; requestId?: string }, PlayWriteReceipt & { dataPath?: string }>;
  sceneApply: FoundryActionContract<SceneApplyInput, PlayWriteReceipt>;
  actorRead: FoundryActionContract<ActorReadInput, ActorReadResult>;
  actorCreate: FoundryActionContract<ActorCreateInput, PlayWriteReceipt>;
  actorEdit: FoundryActionContract<ActorEditInput, PlayWriteReceipt>;
  actorGrantItems: FoundryActionContract<ActorGrantInput, PlayWriteReceipt>;
  actorAdvance: FoundryActionContract<ActorAdvanceInput, PlayWriteReceipt>;
  contentSearch: FoundryActionContract<ContentSearchInput, ContentSearchResult>;
  advancementPlan: FoundryActionContract<AdvancementPlanInput, AdvancementPlanResult>;
  compendiumBrowse: FoundryActionContract<CompendiumBrowseInput, CompendiumBrowseResult>;
  executeAction: FoundryActionContract<PlayExecuteInput, PlayWriteReceipt | ExecuteTurnReceipt>;
  conditionsSet: FoundryActionContract<ConditionsSetInput, PlayWriteReceipt>;
  staticContext: FoundryActionContract<Record<string, never>, PlayStaticContext>;
  playContext: FoundryActionContract<Record<string, never>, PlayDynamicContext>;
  worldInfo: FoundryActionContract<Record<string, never>, WorldInfo>;
  battleContext: FoundryActionContract<Record<string, never>, BattleContext>;
  turnContext: FoundryActionContract<Record<string, never>, TurnContext>;
  executeTurn: FoundryActionContract<ExecuteTurnInput, ExecuteTurnReceipt>;
}

export type TypedDirectAction = keyof FoundryActionMap;

export interface SceneReadInput {
  sceneUuid: string; include?: Array<"tokens" | "walls" | "lights" | "tiles" | "notes" | "sounds">;
  limit?: number; cursor?: string;
}
export interface SceneReadState {
  sceneUuid: string; world: { origin: string; id: string }; fields: RuntimeArguments;
  include: NonNullable<SceneReadInput["include"]>;
  tokens?: Array<{ id: string; uuid: string; fields: RuntimeArguments; fingerprint: string }>;
}
export interface SceneReadResult {
  sceneUuid: string; name: string; active: boolean; width: number; height: number;
  placeables: Record<string, RuntimeArguments[]>; nextCursors: Record<string, string | null>; readState: SceneReadState;
}
export interface TokenPlacementFields {
  x?: number; y?: number; name?: string; hidden?: boolean; disposition?: -1 | 0 | 1;
  width?: number; height?: number; elevation?: number;
}
export interface TokenPlacement extends TokenPlacementFields { actorUuid: string; x: number; y: number; actorLink?: boolean }
export interface TokenLayout {
  create?: TokenPlacement[]; update?: Array<{ tokenId: string; changes: TokenPlacementFields }>; deleteIds?: string[];
}
export interface SceneChanges {
  name?: string; active?: boolean; background?: Omit<ActorDataImage, "syncPlacedTokens">;
  width?: number; height?: number; grid?: { type?: number; size?: number; distance?: number; units?: string };
}
export type SceneApplyInput = PrepWriteIdentity & { tokens?: TokenLayout } & (
  { operation: "create"; scene: SceneChanges & { name: string } }
  | { operation: "update"; sceneUuid: string; readState: SceneReadState; scene?: SceneChanges }
);

export interface ActorReadInput {
  actorUuid: string;
  include?: Array<"items" | "resources" | "prototypeToken" | "sceneTokens">;
  limit?: number;
  cursor?: string;
}
export interface PrepItemIdentity { id: string; uuid: string; name: string; type: string; sourceUuid: string | null }
export interface PrepItemProjection extends PrepItemIdentity { quantity: number | null; equipped: boolean | null }
export interface ActorReadState {
  actorUuid: string;
  world: { origin: string; id: string };
  include: NonNullable<ActorReadInput["include"]>;
  fields: RuntimeArguments;
  items?: PrepItemIdentity[];
  sceneTokens?: RuntimeArguments[];
}
export interface ActorReadResult {
  actorUuid: string; name: string; type: string; folderId: string | null; img: string | null;
  hp: { value: number | null; max: number | null; temp: number | null }; ac: number | null;
  items?: PrepItemProjection[]; resources?: Record<string, number>; prototypeToken?: RuntimeArguments;
  sceneTokens?: RuntimeArguments[]; nextCursor: string | null; readState: ActorReadState;
}
export interface CompendiumGrant {
  uuid?: string; packId?: string; entryId?: string; expectedName?: string; expectedType?: string; quantity?: number; equipped?: boolean;
}
export interface PrepWriteIdentity { world: { origin: string; id: string }; requestId: string }
/** Internal upload bytes are prepared by the host, never supplied by the model. */
export interface FoundryDataImage {
  dataPath: string;
  upload?: { base64: string; hash: string; mimeType: string; extension: "png" | "jpg" | "webp" };
}
/** Compatibility name for existing Actor callers. */
export interface ActorDataImage extends FoundryDataImage { syncPlacedTokens?: boolean }
export type Dnd5eAbilityScores = Partial<Record<"str" | "dex" | "con" | "int" | "wis" | "cha", number>>;
export interface ActorCreateInput extends PrepWriteIdentity {
  source: { kind: "blank"; actorType: "character" | "npc" } | { kind: "compendium"; packId: string; entryId: string };
  name: string; folderId?: string; initialItems?: CompendiumGrant[]; image?: ActorDataImage;
  prototypeToken?: { name: string };
  dnd5e?: { abilities?: Dnd5eAbilityScores };
}
export interface ActorChanges {
  name?: string; folderId?: string | null;
  image?: ActorDataImage;
  prototypeToken?: { name?: string; width?: number; height?: number; disposition?: -1 | 0 | 1 };
  dnd5e?: { hp?: { value?: number; max?: number; temp?: number }; ac?: { flat: number }; abilities?: Dnd5eAbilityScores };
}
export interface ActorEditInput extends PrepWriteIdentity { actorUuid: string; readState: ActorReadState; changes: ActorChanges }
export interface ActorGrantInput extends PrepWriteIdentity { actorUuid: string; readState: ActorReadState; items: CompendiumGrant[] }
/** Slot-addressed choices: every key is a slot string copied verbatim from advancement_plan
 *  choiceRequirements[].key. Trait/pool slots take an array of trait keys or pool UUIDs whose
 *  length must equal the requirement's count; ASI slots take { abilityScore } with per-ability
 *  floating picks (race fixed bonuses merge in automatically); asi-or-feat slots take either
 *  { abilityScore } or { feat: uuid }, never both. hp stays a hidden override for HP steps. */
export type ActorAdvanceSlotValue = string[] | { abilityScore?: Record<string, number>; feat?: string };
export interface ActorAdvanceChoices { bySlot?: Record<string, ActorAdvanceSlotValue>; hp?: "max" | "avg" }
/** fullSpellList: when true and the class is a prepared-list caster (its advancement_plan spellBudget
 *  carries fullList), the runtime grants the whole annotated class spell list up to the target
 *  level's highest slot level after advancement, chunked and deduplicated by source UUID.
 *  Rejected with INPUT_INVALID for other classes before any write. */
export interface ActorAdvanceInput extends PrepWriteIdentity { actorUuid: string; readState: ActorReadState; classUuid: string; subclassUuid?: string; raceUuid?: string; targetLevel: number; choices?: ActorAdvanceChoices; additionalItems?: CompendiumGrant[]; fullSpellList?: boolean }

export interface ContentSearchInput {
  scope: "world" | "compendium";
  documentType: "Actor" | "Item" | "Scene";
  query: string;
  packIds?: string[];
  actorType?: string;
  itemType?: string;
  limit?: number;
  cursor?: string;
}

export interface ContentSearchResult {
  entries: Array<{ uuid: string; id: string; name: string; type: string; documentType: string;
    entryId?: string; packId?: string; package?: string }>;
  total: number;
  nextCursor: string | null;
}
/** advancement_plan: the level-up plan for an existing character taking a class (with optional
 *  subclass/race) to characterLevel. rules is derived from the class document, never supplied. */
export interface AdvancementPlanInput {
  world?: { origin: string; id: string };
  actorUuid: string;
  classUuid: string;
  subclassUuid?: string;
  raceUuid?: string;
  characterLevel: number;
}
/** compendium_browse: conditional enumeration of compendium candidates, plus a uuids mode
 *  (absorbed content_detail) returning full documents for semantic selection or reconciliation.
 *  type is required unless uuids is given. rules defaults to returning both versions for the
 *  class/subclass/race catalogs (each entry labelled); spell/item filter only when supplied. */
export interface CompendiumBrowseInput {
  world?: { origin: string; id: string };
  scope: "compendium";
  type?: "spell" | "item" | "class" | "subclass" | "race";
  rules?: "2014" | "2024";
  classUuid?: string;
  maxLevel?: number;
  itemType?: "weapon" | "equipment" | "consumable" | "tool" | "loot" | "container" | "ammo";
  query?: string;
  /** Batch name resolution (spell/item only): each entry resolves independently with the same
   *  single-language substring/identifier matching as query — never combine languages in one
   *  string. Mutually exclusive with query; pagination does not apply. */
  names?: string[];
  page?: number;
  pageSize?: number;
  uuids?: string[];
}
export interface ContentListStepSummary { slot: string; level: number; kind: string; label: string; summary?: string }
export interface ContentListChoiceRequirement {
  slot: string; level: number; kind: string; label: string; count: number;
  /** Where the value goes on actor_advance: bySlot[key], except "subclassUuid" which stays the
   *  top-level subclassUuid argument. For every other valueFormat, key === slot. */
  valueFormat: string; key: string; candidates?: string[]; candidateNames?: Record<string, string>; cap?: number; mode?: string; note?: string; required: boolean;
}
export interface ContentListCandidate {
  uuid: string; name: string; identifier?: string | null; type: string | null; level: number | null;
  packId: string; entryId: string; eligibility?: "legal" | "auto-grant" | "name-match";
}
/** Discovery-catalog entry for type class/subclass/race: the bootstrap listing that hands the model
 * classUuid/raceUuid (and subclass candidates filterable by classUuid) without fuzzy search. Deduped
 * by rules+identifier, arcane module packs preferred; rules is explicit source rules, else inferred
 * from the pack name (trailing "24" = 2024), else 2014. */
export interface ContentListCatalogEntry {
  uuid: string; name: string; identifier: string | null;
  packId: string; rules: "2014" | "2024" | null; classIdentifier?: string;
}
export interface ContentListFullSpellList {
  maxLevel: number; count: number;
  candidates: Array<{ uuid: string; name: string; level: number }>;
}
/** Advisory spellcasting budget from hardcoded SRD rules tables. Preparation counts/state and
 *  slot counts are deliberately absent: preparation is a sheet marker we do not manage, and dnd5e
 *  computes slots. Prepared-list casters (2014 cleric/druid/paladin/artificer) instead receive
 *  fullList — every class spell up to their highest slot level, enumerated from module-annotated
 *  spell packs (flags.<moduleId>.spellClasses) — because they "know" their whole class list and
 *  preparation is left to the DM and players. Null for non-spellcasting classes.
 *  Subclass-introduced casting (source "subclass"; 2014 Eldritch Knight / Arcane Trickster via
 *  the shared third-caster table): known only — cantrips ride the subclass's own ItemChoice
 *  advancement slot and are deliberately absent here; leveled picks go additionalItems, drawn
 *  from the spellListClassUuid list (the wizard list) with browse maxLevel = maxSpellLevel. */
export interface ContentListSpellBudget {
  ability: string | null;
  progression: string;
  source?: "subclass";
  cantrips?: number;
  known?: number;
  book?: number;
  fullList?: ContentListFullSpellList;
  /** Highest slot level at the target level (subclass casters only); browse maxLevel filter. */
  maxSpellLevel?: number;
  /** Class whose spell list the picks come from; feed back to compendium_browse classUuid. */
  spellListClassUuid?: string;
  /** Advisory natural-language rule note (school restrictions, fixed Mage Hand). Never validated. */
  note?: string;
}
export interface AdvancementPlanResult {
  status: "completed" | "rejected"; code?: string; message?: string;
  actorAdvanceArgs?: { classUuid: string; subclassUuid?: string; raceUuid?: string; targetLevel: number };
  /** Race-side facts the advancement steps cannot express (race items carry movement directly,
   *  not as advancement steps): surfaced so the model never reads race source for speed. */
  race?: { uuid: string; name: string | null; movement: Record<string, string | number> | null };
  automaticSteps?: ContentListStepSummary[];
  choiceRequirements?: ContentListChoiceRequirement[];
  /** One skeleton per bySlot key so the caller fills blanks instead of reconstructing shapes:
   *  [] for trait-key/pool-uuid slots, { abilityScore: {} } for ASI slots (asi-or-feat may
   *  substitute { feat: "<uuid>" }). subclass-uuid requirements have no entry. */
  choicesTemplate?: Record<string, string[] | { abilityScore: Record<string, number> }>;
  spellBudget?: ContentListSpellBudget | null;
  coverage?: { nativeStepCount: number; automaticStepCount: number; choiceStepCount: number; uncoveredRequiredSteps: string[] };
  warnings?: Array<RuntimeArguments>;
}
/** uuids-mode document: summary carries normalized fields for quick use, document the native
 *  full-fidelity data. Reading details never re-judges class eligibility; the plan owns that. */
export interface CompendiumBrowseDocument {
  uuid: string; name: string; type: string; packId: string | null;
  summary: { identifier: string | null; level: number | null; classIdentifier?: string };
  document: RuntimeArguments;
}
/** Per-name batch resolution result (names mode): exact name/identifier hits rank first in
 *  candidates (capped at 10); unique = exactly one deduped row, miss = none, ambiguous otherwise
 *  (cross-rules duplicates are the common ambiguous case — pass rules to narrow). */
export interface ContentListNameResolution {
  query: string; status: "unique" | "ambiguous" | "miss"; total: number; candidates: ContentListCandidate[];
}
export interface CompendiumBrowseResult {
  status: "completed" | "rejected"; code?: string; message?: string;
  candidates?: ContentListCandidate[] | ContentListCatalogEntry[];
  resolutions?: ContentListNameResolution[];
  documents?: CompendiumBrowseDocument[];
  total?: number; page?: number; nextPage?: number | null;
  warnings?: Array<RuntimeArguments>;
}

/** Resolved from the host's static snapshot, never supplied as a second model source selector. */
export interface PlayResolvedAction {
  actionRef: string;
  actionId: string;
  sourceTokenUuid: string;
  actorUuid: string;
  itemId: string;
  activityId: string | null;
  targetTokenUuids?: string[];
  input?: ExecuteTurnActionInput;
}

export interface PlayExecuteInput {
  world: { origin: string; id: string };
  contextRef: string;
  turn?: PlayContextBase["turn"];
  resolvedActions: PlayResolvedAction[];
  resolution?: "auto" | "narrative";
  advance?: boolean;
}

export type FoundrySource =
  | { kind: "actor"; actorUuid: string }
  | { kind: "token"; tokenUuid: string }
  | { kind: "selected" }
  | { kind: "name"; name: string; scope: "focus" | "actors" };

/** Host binds world, mode and the submitted selection; Runtime resolves actual Actors. */
export interface ConditionsSetInput {
  targets: FoundrySource[];
  selectedTokenUuids?: string[];
  conditions: Array<{ key: string; active: boolean }>;
  world: { origin: string; id: string };
  mode: "prep" | "combat";
}

export type PlayWriteReceipt =
  | { status: "rejected"; code: string; message: string }
  | { status: "completed"; steps: RuntimeArguments[]; verification: RuntimeArguments[]; warnings: string[] }
  | { status: "partial" | "indeterminate"; retry: false; steps: RuntimeArguments[]; message: string };

export interface PlayScope {
  world: { origin: string | null; id: string | null };
  sceneUuid: string | null;
  combatId: string | null;
}

export interface PlayTokenIdentity {
  tokenUuid: string;
  tokenId: string;
  actorUuid: string | null;
  actorId: string | null;
  name: string | null;
}

export interface PlayContextBase {
  schema: "arcane.play.v1";
  scope: PlayScope;
  contextRef: string;
  turn: { round: number; index: number | null; tokenId: string | null; actorId: string | null } | null;
}

export interface PlayStaticContext extends PlayContextBase {
  combatants: Array<PlayTokenIdentity & {
    side: CombatantSide;
    static: BattleCombatant["static"] | null;
    actions: Array<BattleActionDefinition & { actionRef: string; activityId: string | null; resolution: "auto" | "narrative" }>;
    warnings?: string[];
  }>;
}

export interface PlayDynamicContext extends PlayContextBase {
  combatants: Array<PlayTokenIdentity & {
    hp: { value: number | null; temp: number };
    resources: Record<string, number>;
    conditions: string[];
    concentration: string | null;
    visible: boolean;
    defeated: boolean;
    availableActionIds: string[];
    activeBuffRiderIds: string[];
  }>;
}

export type FoundryActionInput<Action extends TypedDirectAction> =
  FoundryActionMap[Action]["input"];

export type FoundryActionOutput<Action extends TypedDirectAction> =
  FoundryActionMap[Action]["output"];

export const FOUNDRY_SDK_ERROR_CODES = {
  INVALID_TIMEOUT: "FOUNDRY_SDK_INVALID_TIMEOUT",
  ABORTED: "FOUNDRY_SDK_ABORTED",
  INVALID_ARGUMENTS: "FOUNDRY_SDK_INVALID_ARGUMENTS",
  ACTION_UNSUPPORTED: "FOUNDRY_SDK_ACTION_UNSUPPORTED",
  TRANSPORT_UNAVAILABLE: "FOUNDRY_SDK_TRANSPORT_UNAVAILABLE",
  FOUNDRY_NOT_GAME: "FOUNDRY_SDK_FOUNDRY_NOT_GAME",
  FOUNDRY_NOT_GM: "FOUNDRY_SDK_FOUNDRY_NOT_GM",
  FOUNDRY_NOT_DETECTED: "FOUNDRY_SDK_FOUNDRY_NOT_DETECTED",
  FOUNDRY_NOT_READY: "FOUNDRY_SDK_FOUNDRY_NOT_READY",
  INSPECTION_FAILED: "FOUNDRY_SDK_INSPECTION_FAILED",
  NAVIGATED: "FOUNDRY_SDK_NAVIGATED",
  TIMEOUT: "FOUNDRY_SDK_TIMEOUT",
  EVALUATION_FAILED: "FOUNDRY_SDK_EVALUATION_FAILED",
  PROTOCOL_VIOLATION: "FOUNDRY_SDK_PROTOCOL_VIOLATION",
  RUNTIME_INTERRUPTED: "FOUNDRY_SDK_RUNTIME_INTERRUPTED",
} as const;

export type FoundrySdkErrorCode =
  (typeof FOUNDRY_SDK_ERROR_CODES)[keyof typeof FOUNDRY_SDK_ERROR_CODES];

export class FoundrySdkError extends Error {
  readonly code: FoundrySdkErrorCode;
  readonly details?: unknown;

  constructor(code: FoundrySdkErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "FoundrySdkError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
