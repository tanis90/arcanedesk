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
  "actorRead", "actorCreate", "actorEdit", "actorGrantItems",
  "contentSearch",
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
  actorRead: "read", actorCreate: "write", actorEdit: "write", actorGrantItems: "write",
  contentSearch: "read",
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
  sceneApply: FoundryActionContract<SceneApplyInput, PlayWriteReceipt>;
  actorRead: FoundryActionContract<ActorReadInput, ActorReadResult>;
  actorCreate: FoundryActionContract<ActorCreateInput, PlayWriteReceipt>;
  actorEdit: FoundryActionContract<ActorEditInput, PlayWriteReceipt>;
  actorGrantItems: FoundryActionContract<ActorGrantInput, PlayWriteReceipt>;
  contentSearch: FoundryActionContract<ContentSearchInput, ContentSearchResult>;
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
  packId: string; entryId: string; expectedName?: string; expectedType?: string; quantity?: number; equipped?: boolean;
}
export interface PrepWriteIdentity { world: { origin: string; id: string }; requestId: string }
/** Internal upload bytes are prepared by the host, never supplied by the model. */
export interface ActorDataImage {
  dataPath: string; syncPlacedTokens?: boolean;
  upload?: { base64: string; hash: string; mimeType: string; extension: "png" | "jpg" | "webp" };
}
export interface ActorCreateInput extends PrepWriteIdentity {
  source: { kind: "blank"; actorType: "character" | "npc" } | { kind: "compendium"; packId: string; entryId: string };
  name: string; folderId?: string; initialItems?: CompendiumGrant[]; image?: ActorDataImage;
  prototypeToken?: { name: string };
}
export interface ActorChanges {
  name?: string; folderId?: string | null;
  image?: ActorDataImage;
  prototypeToken?: { name?: string; width?: number; height?: number; disposition?: -1 | 0 | 1 };
  dnd5e?: { hp?: { value?: number; max?: number; temp?: number }; ac?: { flat: number } };
}
export interface ActorEditInput extends PrepWriteIdentity { actorUuid: string; readState: ActorReadState; changes: ActorChanges }
export interface ActorGrantInput extends PrepWriteIdentity { actorUuid: string; readState: ActorReadState; items: CompendiumGrant[] }

export interface ContentSearchInput {
  scope: "world" | "compendium";
  documentType: "Actor" | "Item" | "Scene";
  query: string | string[];
  packIds?: string[];
  actorType?: string;
  itemType?: string;
  limit?: number;
  cursor?: string;
}

export interface ContentSearchResult {
  /** Batch queries with no match across all pages, not merely the current page. */
  missingQueries?: string[];
  entries: Array<{ uuid: string; id: string; name: string; type: string; documentType: string;
    entryId?: string; packId?: string; package?: string; matchedQueries?: string[] }>;
  total: number;
  nextCursor: string | null;
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
