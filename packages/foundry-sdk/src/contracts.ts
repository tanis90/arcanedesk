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
  worldInfo: FoundryActionContract<Record<string, never>, WorldInfo>;
  battleContext: FoundryActionContract<Record<string, never>, BattleContext>;
  turnContext: FoundryActionContract<Record<string, never>, TurnContext>;
  executeTurn: FoundryActionContract<ExecuteTurnInput, ExecuteTurnReceipt>;
}

export type FoundryActionInput<Action extends SafeDirectAction> =
  FoundryActionMap[Action]["input"];

export type FoundryActionOutput<Action extends SafeDirectAction> =
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
