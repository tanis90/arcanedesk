import { CdpEndpoint, CdpSession, CdpTarget, listTargets } from "./cdp-client.js";
import { CliError } from "./errors.js";
import {
  FOUNDRY_SDK_ERROR_CODES,
  isWriteDirectAction,
  type DirectAction,
  type DirectActionInterruption,
  type ExecuteTurnReceipt,
  type RuntimeStatus,
  type WriteDirectAction,
} from "@arcanedesk/foundry-sdk/contracts";
import { runtimeFunction } from "@arcanedesk/foundry-sdk/runtime";

export { runtimeFunction };
export type { DirectAction } from "@arcanedesk/foundry-sdk/contracts";
export {
  actionBlockV2,
  actionConfigProblemV2,
  actionIdMaterialV2,
  actionIdV2,
  buildActivityUseCreateOptions,
  checkActivityTargetRangeWithFoundry,
  collectActionCandidatesV2,
  deriveActivityInputContract,
  effectiveActivityActivationTypeV2,
  featureDeclaredRiderOptionsV2,
  fnv1a64Hex,
  isActionAvailableV2,
  isAgentCallableActionV2,
  isAgentCallableActivityV2,
  isTokenWithinDistanceWithFoundry,
  locateActionByIdV2,
  measureTokenDistanceWithFoundry,
  parseActivitySelectionConstraintsV2,
  parseIndependentProjectilesContractV2,
  resolveActivityTargetCountLimit,
  resolveDeclaredRiderRequestsV2,
  resolveIndependentProjectileAllocationV2,
  resolveIndependentProjectileCountV2,
  resolveNativeSpellSlotConsumption,
  resolveNativeSummonActivityV2,
  resolveNativeSummonLifecycleV2,
  resolveRequiredSelectionsForContract,
  resolveTargetSpecForContract,
  serializeTurnResponseV2,
  validateDeclaredRiderPlanV2,
} from "@arcanedesk/foundry-sdk/runtime-helpers";
export type {
  ActionCandidateV2,
  ActionFactV2,
  DeclaredRiderOptionV2,
  ExecuteTurnResponseV2,
  FoundryActivityRangeCheck,
  NativeSummonLifecycleV2,
  NativeSummonReceiptV2,
  RejectCodeV2,
  ResolvedDeclaredRiderV2,
  TurnExecutionFactsV2,
} from "@arcanedesk/foundry-sdk/runtime-helpers";

export interface FoundryTargetOptions extends CdpEndpoint {
  targetId?: string;
  targetUrl?: string;
}

export interface RuntimeCallOptions {
  timeoutMs?: number;
  requireGM?: boolean;
}

export interface FoundryPageReloadOptions {
  targetUrl: string;
  expectedOrigin: string;
  expectedWorldId: string;
  timeoutMs?: number;
}

export interface FoundryPageReloadResult {
  status: "acknowledged";
  retry: false;
  target: {
    id: string;
    url: string;
  };
  frame: {
    id: string;
    loaderId: string;
    url: string;
  };
  gate: {
    ready: true;
    worldId: string;
    userId: string;
    isGM: true;
  };
  reload: {
    ignoreCache: false;
    loaderId: string;
  };
}

interface FoundryMainFrameSnapshot {
  id: string;
  loaderId: string;
  url: string;
}

export interface CanvasClickOptions {
  x: number;
  y: number;
  waitForTemplatePreviewMs?: number;
  settleMs?: number;
}

interface DomElementSummary {
  tag: string | null;
  id: string | null;
  classes: string[];
  aria: {
    role: string | null;
    modal: string | null;
    hidden: string | null;
    disabled: string | null;
  };
}

interface CanvasPointerContext {
  sceneId: string | null;
  client: { x: number; y: number };
  roundTrip: { x: number; y: number };
  viewport: { width: number; height: number };
  previewCount: number;
  templateIds: string[];
  dom: {
    accepted: boolean;
    hit: DomElementSummary | null;
    canvas: DomElementSummary | null;
    dialog: DomElementSummary | null;
  };
}

export interface ActivityUiClickOptions {
  actorIdentifier: string;
  itemIdentifier: string;
  activityIdentifier: string;
  targetTokenIds?: string[];
  tab?: string;
  settleMs?: number;
  requireGM?: boolean;
}

export interface ActivityUiActorIdentity {
  id: string;
  uuid: string;
  isToken: boolean;
  tokenUuid: string | null;
  actorLink: boolean | null;
}

export function isExactSyntheticActorUuid(value: string): boolean {
  return /^Scene\.[^.]+\.Token\.[^.]+\.Actor\.[^.]+$/.test(String(value ?? "").trim());
}

export function activityUiDefaultTab(
  actorType: string,
  itemType: string,
  requestedTab = "",
): string {
  const requested = String(requestedTab ?? "").trim();
  if (requested) return requested;
  if (String(itemType ?? "").trim() === "spell") return "spells";
  if (String(actorType ?? "").trim() === "npc") return "features";
  return "inventory";
}

export function activityUiActorIdentity(actor: any): ActivityUiActorIdentity {
  const isToken = actor?.isToken === true;
  return {
    id: String(actor?.id ?? ""),
    uuid: String(actor?.uuid ?? ""),
    isToken,
    tokenUuid: isToken ? String(actor?.token?.uuid ?? "") || null : null,
    actorLink: isToken ? actor?.token?.actorLink === true : null,
  };
}

export interface EffectUiBreakConcentrationOptions {
  actorIdentifier: string;
  effectIdentifier: string;
  settleMs?: number;
}

export interface FoundryLoginOptions {
  userName: string;
  password: string;
  expectedOrigin: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requireGM?: boolean;
  refreshJoinPage?: boolean;
}

export interface FoundryLoginPageState {
  href: string;
  title: string;
  originMatches: boolean;
  joinFormReady: boolean;
  ready: boolean;
  user: {
    id: string;
    name: string;
    isGM: boolean;
  } | null;
  world: {
    id: string | null;
    title: string | null;
  } | null;
  notifications: Array<{
    level: string;
    text: string;
  }>;
}

function assertUiPointInViewport(
  client: { x: number; y: number },
  viewport: { width: number; height: number },
  code: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (
    client.x < 0
    || client.y < 0
    || client.x >= viewport.width
    || client.y >= viewport.height
  ) {
    throw new CliError(code, message, details);
  }
}

export interface FoundryLoginResult {
  status: "logged-in" | "already-logged-in";
  href: string;
  user: {
    id: string;
    name: string;
    isGM: boolean;
  };
  world: {
    id: string | null;
    title: string | null;
  } | null;
}


export interface FoundryLoginUserOption {
  value: string;
  text: string;
  disabled?: boolean;
}

export type FoundryLoginUserSelection =
  | {
      ok: true;
      user: {
        id: string;
        name: string;
      };
    }
  | {
      ok: false;
      code:
        | "ERR_LOGIN_USER_REQUIRED"
        | "ERR_LOGIN_USER_NOT_FOUND"
        | "ERR_LOGIN_USER_AMBIGUOUS"
        | "ERR_LOGIN_USER_UNAVAILABLE"
        | "ERR_LOGIN_FORM_NOT_FOUND"
        | "ERR_LOGIN_PASSWORD_FIELD_NOT_FOUND"
        | "ERR_LOGIN_ORIGIN_MISMATCH";
      message: string;
      availableUsers: Array<{
        id: string;
        name: string;
        disabled: boolean;
      }>;
    };

export async function findFoundryTarget(options: FoundryTargetOptions): Promise<CdpTarget> {
  return selectFoundryTarget(await listTargets(options), options);
}

export function selectFoundryTarget(
  targets: CdpTarget[],
  options: Pick<FoundryTargetOptions, "targetId" | "targetUrl"> = {},
): CdpTarget {
  const pages = targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl);
  const targetId = normalizeOptionalTargetId(options.targetId);
  const candidates = pages.filter(target =>
    (!targetId || target.id === targetId)
    && isFoundryGameTarget(target, options.targetUrl)
  );

  if (candidates.length === 0) {
    throw new CliError("ERR_NO_FOUNDRY_TAB", "No debuggable Foundry /game tab found", {
      targetId,
      targetUrl: options.targetUrl,
      pages: pages.map(({ id, title, url }) => ({ id, title, url })),
    });
  }

  if (candidates.length > 1) {
    throw new CliError(
      "ERR_AMBIGUOUS_FOUNDRY_TAB",
      "Multiple debuggable Foundry /game tabs match; select one with --target-id or a complete --target-url",
      {
        targetId,
        targetUrl: options.targetUrl,
        candidates: candidates.map(({ id, title, url }) => ({ id, title, url })),
      },
    );
  }

  return candidates[0]!;
}

export async function findFoundryPageReloadTarget(
  options: FoundryTargetOptions,
  expectedOrigin: string,
  timeoutMs?: number,
): Promise<CdpTarget> {
  return selectFoundryPageReloadTarget(
    await listTargets(options, timeoutMs),
    options.targetUrl,
    expectedOrigin,
    options.targetId,
  );
}

export function selectFoundryPageReloadTarget(
  targets: CdpTarget[],
  targetUrl: string | undefined,
  expectedOrigin: string,
  targetId?: string,
): CdpTarget {
  const policy = normalizeFoundryPageReloadTargetPolicy(targetUrl, expectedOrigin);
  const normalizedTargetId = normalizeOptionalTargetId(targetId);
  const pages = targets.filter(target =>
    target.type === "page"
    && target.webSocketDebuggerUrl
    && (!normalizedTargetId || target.id === normalizedTargetId)
  );
  const candidates = pages.filter(target =>
    isExactFoundryPageReloadTarget(target, policy.expectedGameUrl)
  );

  if (candidates.length === 0) {
    throw new CliError(
      "ERR_NO_FOUNDRY_RELOAD_TAB",
      `No unique debuggable Foundry /game tab found at ${policy.expectedGameUrl}`,
      {
        targetId: normalizedTargetId,
        targetUrl: policy.targetUrl,
        expectedOrigin: policy.expectedOrigin,
        expectedGameUrl: policy.expectedGameUrl,
        pages: pages.map(({ id, title, url }) => ({ id, title, url })),
      },
    );
  }

  if (candidates.length > 1) {
    throw new CliError(
      "ERR_AMBIGUOUS_FOUNDRY_RELOAD_TAB",
      "Multiple debuggable Foundry /game tabs match the exact reload target",
      {
        targetId: normalizedTargetId,
        targetUrl: policy.targetUrl,
        expectedOrigin: policy.expectedOrigin,
        expectedGameUrl: policy.expectedGameUrl,
        candidates: candidates.map(({ id, title, url }) => ({ id, title, url })),
      },
    );
  }

  return candidates[0]!;
}

function normalizeFoundryPageReloadTargetPolicy(
  targetUrl: string | undefined,
  expectedOrigin: string,
): { targetUrl: string; expectedOrigin: string; expectedGameUrl: string } {
  const origin = normalizeFoundryLoginOrigin(expectedOrigin);
  const input = String(targetUrl ?? "").trim();
  if (!input) {
    throw new CliError(
      "ERR_PAGE_RELOAD_TARGET_URL_REQUIRED",
      "The page-reload command requires an exact --target-url",
    );
  }

  let configured: URL;
  try {
    configured = new URL(input);
  } catch {
    throw new CliError(
      "ERR_PAGE_RELOAD_TARGET_URL_INVALID",
      "The page-reload target URL must be an absolute http(s) URL",
    );
  }

  if (
    !["http:", "https:"].includes(configured.protocol)
    || configured.username
    || configured.password
    || !["/", "/game"].includes(configured.pathname)
    || configured.search
    || configured.hash
    || configured.origin !== origin
  ) {
    throw new CliError(
      "ERR_PAGE_RELOAD_TARGET_URL_MISMATCH",
      "The page-reload target URL must be the expected origin or its exact /game path",
      {
        expectedOrigin: origin,
        configuredOrigin: configured.origin,
        configuredPath: configured.pathname,
        hasCredentials: !!configured.username || !!configured.password,
        hasQuery: !!configured.search,
        hasFragment: !!configured.hash,
      },
    );
  }

  return {
    targetUrl: configured.href,
    expectedOrigin: origin,
    expectedGameUrl: `${origin}/game`,
  };
}

function isExactFoundryPageReloadTarget(target: CdpTarget, expectedGameUrl: string): boolean {
  return !!target.webSocketDebuggerUrl && isExactFoundryPageReloadUrl(target.url, expectedGameUrl);
}

function isExactFoundryPageReloadUrl(value: string, expectedGameUrl: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === new URL(expectedGameUrl).origin
      && !url.username
      && !url.password
      && url.pathname === "/game"
      && !url.search
      && !url.hash
    );
  } catch {
    return false;
  }
}

export async function findFoundryLoginTarget(
  options: FoundryTargetOptions,
  expectedOrigin: string,
  timeoutMs?: number
): Promise<CdpTarget> {
  const origin = normalizeFoundryLoginOrigin(expectedOrigin);
  return selectFoundryLoginTarget(
    await listTargets(options, timeoutMs),
    origin,
    options.targetId,
    options.targetUrl,
  );
}

export function normalizeFoundryLoginOrigin(expectedOrigin: string): string {
  const input = String(expectedOrigin ?? "").trim();
  if (!input) {
    throw new CliError(
      "ERR_LOGIN_ORIGIN_REQUIRED",
      "An exact Foundry origin is required for login"
    );
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(
      "ERR_LOGIN_ORIGIN_INVALID",
      "Foundry login origin must be an absolute http(s) URL"
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new CliError(
      "ERR_LOGIN_ORIGIN_INVALID",
      "Foundry login origin must contain only scheme, host, and optional port"
    );
  }

  return url.origin;
}

export function assertFoundryLoginOrigin(
  state: FoundryLoginPageState,
  expectedOrigin: string
): void {
  if (state.originMatches) return;

  let actualOrigin: string | null = null;
  try {
    actualOrigin = new URL(state.href).origin;
  } catch {
    // Keep malformed page locations out of the error formatter.
  }
  throw new CliError(
    "ERR_LOGIN_ORIGIN_MISMATCH",
    "Foundry login target navigated away from the expected origin",
    {
      expectedOrigin,
      actualOrigin,
      href: state.href,
    }
  );
}

export function selectFoundryLoginTarget(
  targets: CdpTarget[],
  expectedOrigin: string,
  targetId?: string,
  targetUrl?: string,
): CdpTarget {
  const origin = normalizeFoundryLoginOrigin(expectedOrigin);
  const normalizedTargetId = normalizeOptionalTargetId(targetId);
  const pages = targets.filter(target =>
    target.type === "page"
    && target.webSocketDebuggerUrl
    && (!normalizedTargetId || target.id === normalizedTargetId)
  );
  const candidates = pages.filter(target =>
    isFoundryLoginTargetForOrigin(target, origin)
    && isFoundryLoginTarget(target, targetUrl)
  );
  const joinCandidates = candidates.filter(target =>
    isFoundryPathTargetForOrigin(target, "join", origin)
  );
  const preferred = joinCandidates.length > 0 ? joinCandidates : candidates;

  if (preferred.length === 0) {
    throw new CliError(
      "ERR_NO_FOUNDRY_LOGIN_TAB",
      `No debuggable Foundry /join or /game tab found at ${origin}`,
      {
        targetId: normalizedTargetId,
        targetUrl,
        expectedOrigin: origin,
        pages: pages.map(({ id, title, url }) => ({ id, title, url })),
      }
    );
  }

  if (preferred.length > 1) {
    throw new CliError(
      "ERR_AMBIGUOUS_FOUNDRY_LOGIN_TAB",
      "Multiple debuggable Foundry login tabs match the expected origin",
      {
        targetId: normalizedTargetId,
        targetUrl,
        expectedOrigin: origin,
        candidates: preferred.map(({ id, title, url }) => ({ id, title, url })),
      }
    );
  }

  return preferred[0]!;
}

export function isFoundryGameTarget(target: CdpTarget, targetUrl?: string): boolean {
  return isFoundryPathTarget(target, "game", targetUrl);
}

export function isFoundryJoinTarget(target: CdpTarget, targetUrl?: string): boolean {
  return isFoundryPathTarget(target, "join", targetUrl);
}

export function isFoundryLoginTarget(target: CdpTarget, targetUrl?: string): boolean {
  return isFoundryJoinTarget(target, targetUrl) || isFoundryGameTarget(target, targetUrl);
}

export function isFoundryLoginTargetForOrigin(
  target: CdpTarget,
  expectedOrigin: string
): boolean {
  const origin = normalizeFoundryLoginOrigin(expectedOrigin);
  return (
    isFoundryPathTargetForOrigin(target, "join", origin) ||
    isFoundryPathTargetForOrigin(target, "game", origin)
  );
}

function normalizeOptionalTargetId(targetId: string | undefined): string | undefined {
  if (targetId === undefined) return undefined;
  const normalized = String(targetId).trim();
  if (!normalized) {
    throw new CliError(
      "ERR_TARGET_ID_INVALID",
      "The Foundry --target-id must be a non-empty exact CDP target id",
    );
  }
  return normalized;
}

function normalizeFoundryTargetUrlSelector(
  targetUrl: string,
): { kind: "origin" | "url"; value: string } {
  const input = String(targetUrl ?? "").trim();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(
      "ERR_TARGET_URL_INVALID",
      "The Foundry --target-url must be an absolute http(s) URL or origin",
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
  ) {
    throw new CliError(
      "ERR_TARGET_URL_INVALID",
      "The Foundry --target-url must be an absolute http(s) URL or origin without credentials",
    );
  }

  const originOnly = ["", "/"].includes(url.pathname) && !url.search && !url.hash;
  return originOnly
    ? { kind: "origin", value: url.origin }
    : { kind: "url", value: url.href };
}

function isFoundryPathTarget(
  target: CdpTarget,
  path: "game" | "join",
  targetUrl?: string
): boolean {
  if (!target.webSocketDebuggerUrl) return false;
  const selector = targetUrl === undefined
    ? undefined
    : normalizeFoundryTargetUrlSelector(targetUrl);

  try {
    const url = new URL(target.url);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
    ) return false;
    if (
      selector
      && (selector.kind === "origin" ? url.origin : url.href) !== selector.value
    ) return false;
    return path === "game"
      ? /\/game(?:\/|$)/.test(url.pathname)
      : /\/join(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function isFoundryPathTargetForOrigin(
  target: CdpTarget,
  path: "game" | "join",
  expectedOrigin: string
): boolean {
  if (!target.webSocketDebuggerUrl) return false;

  try {
    const url = new URL(target.url);
    if (url.origin !== expectedOrigin) return false;
    return path === "game"
      ? /^\/game(?:\/|$)/.test(url.pathname)
      : /^\/join(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export function resolveFoundryLoginUser(
  options: FoundryLoginUserOption[],
  requestedUser: string
): FoundryLoginUserSelection {
  const requested = String(requestedUser ?? "").trim();
  const availableUsers = options
    .filter(option => option.value || option.text.trim())
    .map(option => ({
      id: option.value,
      name: option.text.trim(),
      disabled: option.disabled === true,
    }));

  if (!requested) {
    return {
      ok: false,
      code: "ERR_LOGIN_USER_REQUIRED",
      message: "Foundry user name or ID is required",
      availableUsers,
    };
  }

  const candidates = options.filter(option => option.value || option.text.trim());
  const idMatches = candidates.filter(option => option.value === requested);
  const matches =
    idMatches.length > 0
      ? idMatches
      : candidates.filter(option => option.text.trim() === requested);

  if (matches.length === 0) {
    return {
      ok: false,
      code: "ERR_LOGIN_USER_NOT_FOUND",
      message: `Foundry user was not found: ${requested}`,
      availableUsers,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      code: "ERR_LOGIN_USER_AMBIGUOUS",
      message: `Multiple Foundry users have the exact name: ${requested}`,
      availableUsers,
    };
  }

  const match = matches[0]!;
  if (match.disabled === true) {
    return {
      ok: false,
      code: "ERR_LOGIN_USER_UNAVAILABLE",
      message: `Foundry user is unavailable: ${requested}`,
      availableUsers,
    };
  }

  return {
    ok: true,
    user: {
      id: match.value,
      name: match.text.trim(),
    },
  };
}

export function validateFoundryLoginState(
  requestedUser: string,
  selectedUserId: string | undefined,
  state: FoundryLoginPageState,
  requireGM: boolean,
  status: FoundryLoginResult["status"]
): FoundryLoginResult {
  const user = state.user;
  let isGamePath = false;
  try {
    isGamePath = /^\/game(?:\/|$)/.test(new URL(state.href).pathname);
  } catch {
    // The origin guard reports malformed or cross-origin locations separately.
  }
  if (!state.ready || !user || !isGamePath) {
    throw new CliError("ERR_LOGIN_NOT_READY", "Foundry game is not ready after login", {
      requestedUser,
      href: state.href,
    });
  }

  const matches =
    selectedUserId !== undefined
      ? user.id === selectedUserId
      : user.id === requestedUser || user.name === requestedUser;
  if (!matches) {
    throw new CliError(
      status === "already-logged-in" ? "ERR_ALREADY_LOGGED_IN" : "ERR_LOGIN_USER_MISMATCH",
      status === "already-logged-in"
        ? `The Foundry tab is already logged in as ${user.name}`
        : `Foundry logged in as ${user.name}, not the requested user`,
      {
        requestedUser,
        ...(selectedUserId !== undefined ? { selectedUserId } : {}),
        actualUser: user,
      }
    );
  }

  if (requireGM && !user.isGM) {
    throw new CliError("ERR_LOGIN_NOT_GM", `Foundry user is not a Gamemaster: ${user.name}`, {
      requestedUser,
      actualUser: user,
    });
  }

  return {
    status,
    href: state.href,
    user,
    world: state.world,
  };
}

export class FoundryRuntimeClient {
  private readonly session: CdpSession;
  private mainFrameId: string | undefined;
  private mainExecutionContextId: number | undefined;

  constructor(private readonly target: CdpTarget) {
    if (!target.webSocketDebuggerUrl) {
      throw new CliError("ERR_TARGET_NOT_DEBUGGABLE", "Target has no websocket debugger URL", {
        target,
      });
    }
    this.session = new CdpSession(target.webSocketDebuggerUrl);
    this.session.on("Page.frameNavigated", params => {
      const frame = (params as { frame?: { id?: unknown; parentId?: unknown } } | undefined)?.frame;
      if (typeof frame?.id !== "string" || frame.parentId) return;
      this.mainFrameId = frame.id;
      this.mainExecutionContextId = undefined;
    });
    this.session.on("Runtime.executionContextsCleared", () => {
      this.mainExecutionContextId = undefined;
    });
    this.session.on("Runtime.executionContextDestroyed", params => {
      const executionContextId = (
        params as { executionContextId?: unknown } | undefined
      )?.executionContextId;
      if (executionContextId === this.mainExecutionContextId) {
        this.mainExecutionContextId = undefined;
      }
    });
    this.session.on("Runtime.executionContextCreated", params => {
      const context = (
        params as {
          context?: {
            id?: unknown;
            auxData?: { frameId?: unknown; isDefault?: unknown; type?: unknown };
          };
        } | undefined
      )?.context;
      const auxData = context?.auxData;
      if (
        typeof context?.id === "number"
        && auxData?.isDefault === true
        && auxData.type === "default"
        && typeof auxData.frameId === "string"
        && auxData.frameId === this.mainFrameId
      ) {
        this.mainExecutionContextId = context.id;
      }
    });
  }

  async connect(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const remainingTimeout = (): number => Math.max(1, deadline - Date.now());
    await this.session.connect(remainingTimeout());
    await this.session.call("Page.enable", {}, remainingTimeout());
    const frameTree = await this.session.call<{
      frameTree?: { frame?: { id?: string } };
    }>("Page.getFrameTree", {}, remainingTimeout());
    const mainFrameId = frameTree.frameTree?.frame?.id;
    if (!mainFrameId) {
      throw new CliError("ERR_CDP_MAIN_FRAME", "Could not resolve the page main frame");
    }
    this.mainFrameId = mainFrameId;
    await this.session.call("Runtime.enable", {}, remainingTimeout());
    await this.waitForMainExecutionContext(deadline);
  }

  async pageReload(options: FoundryPageReloadOptions): Promise<FoundryPageReloadResult> {
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs!
      : 10000;
    const deadline = Date.now() + timeoutMs;
    const remainingTimeout = (): number => Math.max(1, deadline - Date.now());
    const expectedWorldId = String(options.expectedWorldId ?? "").trim();
    if (!expectedWorldId) {
      throw new CliError(
        "ERR_PAGE_RELOAD_WORLD_REQUIRED",
        "The page-reload command requires an exact expected world id",
      );
    }

    const target = selectFoundryPageReloadTarget(
      [this.target],
      options.targetUrl,
      options.expectedOrigin,
    );
    const policy = normalizeFoundryPageReloadTargetPolicy(
      options.targetUrl,
      options.expectedOrigin,
    );
    const before = await this.readMainFrameSnapshot(remainingTimeout());
    if (!isExactFoundryPageReloadUrl(before.url, policy.expectedGameUrl)) {
      throw new CliError(
        "ERR_PAGE_RELOAD_FRAME_URL_MISMATCH",
        "The current main frame is not the exact expected Foundry /game page",
        { frame: before, expectedGameUrl: policy.expectedGameUrl },
      );
    }

    const diagnostics = await this.direct<{
      href?: unknown;
      ready?: unknown;
      user?: { id?: unknown; isGM?: unknown } | null;
      world?: { id?: unknown } | null;
    }>("doctor", {}, {
      timeoutMs: remainingTimeout(),
      requireGM: true,
    });
    if (
      diagnostics.ready !== true
      || diagnostics.user?.isGM !== true
      || typeof diagnostics.user.id !== "string"
    ) {
      throw new CliError(
        "ERR_PAGE_RELOAD_GATE",
        "Foundry must be ready under an active GM user before page reload",
        { diagnostics },
      );
    }
    if (diagnostics.world?.id !== expectedWorldId) {
      throw new CliError(
        "ERR_PAGE_RELOAD_WORLD_MISMATCH",
        "The current Foundry world does not match the exact expected world",
        {
          expectedWorldId,
          actualWorldId: diagnostics.world?.id ?? null,
        },
      );
    }
    if (
      typeof diagnostics.href !== "string"
      || !isExactFoundryPageReloadUrl(diagnostics.href, policy.expectedGameUrl)
    ) {
      throw new CliError(
        "ERR_PAGE_RELOAD_RUNTIME_URL_MISMATCH",
        "The authorized Foundry runtime is not on the exact expected /game page",
        {
          href: diagnostics.href ?? null,
          expectedGameUrl: policy.expectedGameUrl,
        },
      );
    }

    const authorized = await this.readMainFrameSnapshot(remainingTimeout());
    if (!isExactFoundryPageReloadUrl(authorized.url, policy.expectedGameUrl)) {
      throw new CliError(
        "ERR_PAGE_RELOAD_FRAME_URL_MISMATCH",
        "The authorized main frame is not the exact expected Foundry /game page",
        { frame: authorized, expectedGameUrl: policy.expectedGameUrl },
      );
    }
    if (
      before.id !== authorized.id
      || before.loaderId !== authorized.loaderId
      || before.url !== authorized.url
      || diagnostics.href !== authorized.url
    ) {
      throw new CliError(
        "ERR_PAGE_RELOAD_RACE",
        "The Foundry main frame changed while authorizing page reload",
        { before, authorized, runtimeHref: diagnostics.href },
      );
    }

    const reload = {
      ignoreCache: false as const,
      loaderId: authorized.loaderId,
    };
    try {
      await this.session.call("Page.reload", reload, remainingTimeout());
    } catch (error) {
      if (error instanceof CliError && error.code === "ERR_CDP_COMMAND_TIMEOUT") {
        throw new CliError(
          "ERR_PAGE_RELOAD_INDETERMINATE",
          "Page.reload acknowledgement timed out; reload state is indeterminate and must not be retried",
          {
            status: "indeterminate",
            retry: false,
            target: { id: target.id, url: target.url },
            frame: authorized,
            cause: { code: error.code, message: error.message },
          },
        );
      }
      throw error;
    }

    return {
      status: "acknowledged",
      retry: false,
      target: { id: target.id, url: target.url },
      frame: authorized,
      gate: {
        ready: true,
        worldId: expectedWorldId,
        userId: diagnostics.user.id,
        isGM: true,
      },
      reload,
    };
  }

  async screenshot(options: { fullPage?: boolean; format?: "png" | "jpeg" } = {}): Promise<{
    data: string;
    format: "png" | "jpeg";
  }> {
    await this.session.call("Page.enable", {}, 5000);
    const result = await this.session.call<{ data?: string }>(
      "Page.captureScreenshot",
      {
        format: options.format ?? "png",
        captureBeyondViewport: !!options.fullPage,
      },
      30000
    );
    if (!result.data) throw new CliError("ERR_SCREENSHOT_EMPTY", "CDP returned no screenshot data");
    return { data: result.data, format: options.format ?? "png" };
  }

  async bringToFront(
    timeoutMs = 20000
  ): Promise<Array<{ method: string; ok: boolean; error?: string }>> {
    const attempts: Array<{ method: string; ok: boolean; error?: string }> = [];
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["Page.enable", {}],
      ["Page.bringToFront", {}],
      ["Emulation.setFocusEmulationEnabled", { enabled: true }],
      ["Page.setWebLifecycleState", { state: "active" }],
    ];
    for (const [method, params] of calls) {
      if (Date.now() >= deadline) break;
      try {
        await this.session.call(
          method,
          params,
          Math.max(1, Math.min(5000, deadline - Date.now()))
        );
        attempts.push({ method, ok: true });
      } catch (error) {
        attempts.push({
          method,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return attempts;
  }

  async canvasClick(options: CanvasClickOptions): Promise<unknown> {
    const { x, y } = options;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new CliError("ERR_CANVAS_COORDINATES", "Canvas coordinates must be finite numbers", { x, y });
    }

    const waitForTemplatePreviewMs = Math.max(0, options.waitForTemplatePreviewMs ?? 0);
    const deadline = Date.now() + waitForTemplatePreviewMs;
    let before = await this.canvasPointerContext(x, y);

    while (waitForTemplatePreviewMs > 0 && before.previewCount === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      before = await this.canvasPointerContext(x, y);
    }

    if (waitForTemplatePreviewMs > 0 && before.previewCount === 0) {
      throw new CliError(
        "ERR_TEMPLATE_PREVIEW_TIMEOUT",
        "Timed out waiting for a measured-template preview before clicking the canvas",
        { x, y, waitForTemplatePreviewMs, before },
      );
    }

    // Opening a measured-template preview can trigger a final Foundry camera
    // pan after the preview object already exists. A client coordinate captured
    // during that pan no longer points at the requested canvas coordinate when
    // the trusted mouse event is dispatched. Require two consecutive stable
    // coordinate observations before clicking so batch QA and normal CLI use
    // cannot place a template at a stale screen position.
    let stableCoordinateObservations = 0;
    if (waitForTemplatePreviewMs > 0) {
      const stabilityDeadline = Date.now() + 1500;
      while (stableCoordinateObservations < 2 && Date.now() < stabilityDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const current = await this.canvasPointerContext(x, y);
        const stable =
          current.sceneId === before.sceneId
          && current.previewCount > 0
          && Math.abs(current.client.x - before.client.x) < 0.5
          && Math.abs(current.client.y - before.client.y) < 0.5;
        stableCoordinateObservations = stable
          ? stableCoordinateObservations + 1
          : 0;
        before = current;
      }
      if (stableCoordinateObservations < 2) {
        throw new CliError(
          "ERR_CANVAS_VIEW_UNSTABLE",
          "Foundry kept moving the canvas after the measured-template preview opened",
          { x, y, before, stableCoordinateObservations },
        );
      }
    }

    if (
      before.client.x < 0 ||
      before.client.y < 0 ||
      before.client.x >= before.viewport.width ||
      before.client.y >= before.viewport.height
    ) {
      throw new CliError(
        "ERR_CANVAS_POINT_OFFSCREEN",
        "The requested canvas point is outside the current browser viewport",
        { x, y, before },
      );
    }

    if (!before.dom.accepted) {
      throw new CliError(
        "ERR_CANVAS_POINT_OBSTRUCTED",
        "The requested canvas point is covered by another DOM element; dismiss or move the obstructing UI before retrying",
        {
          canvas: { x, y },
          client: before.client,
          dom: before.dom,
        },
      );
    }

    await this.session.call(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: before.client.x,
        y: before.client.y,
        button: "none",
        buttons: 0,
      },
      5000,
    );
    await this.session.call(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: before.client.x,
        y: before.client.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      5000,
    );
    await this.session.call(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: before.client.x,
        y: before.client.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
      5000,
    );

    const settleMs = Math.max(0, options.settleMs ?? 250);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    const after = await this.canvasPointerContext(x, y);
    const beforeIds = new Set(before.templateIds);

    return {
      canvas: { x, y },
      client: before.client,
      roundTrip: before.roundTrip,
      roundTripError: {
        x: before.roundTrip.x - x,
        y: before.roundTrip.y - y,
      },
      stableCoordinateObservations,
      preview: {
        before: before.previewCount,
        after: after.previewCount,
      },
      templates: {
        before: before.templateIds,
        after: after.templateIds,
        created: after.templateIds.filter(id => !beforeIds.has(id)),
      },
      sceneId: after.sceneId,
    };
  }

  async activityUiClick(options: ActivityUiClickOptions): Promise<unknown> {
    const actorIdentifier = String(options.actorIdentifier ?? "").trim();
    const itemIdentifier = String(options.itemIdentifier ?? "").trim();
    const activityIdentifier = String(options.activityIdentifier ?? "").trim();
    if (!actorIdentifier || !itemIdentifier || !activityIdentifier) {
      throw new CliError(
        "ERR_ACTIVITY_UI_CLICK_INPUT",
        "actorIdentifier, itemIdentifier, and activityIdentifier are required",
        { actorIdentifier, itemIdentifier, activityIdentifier },
      );
    }

    const before = await this.activityUiPointerContext({
      actorIdentifier,
      itemIdentifier,
      activityIdentifier,
      targetTokenIds: Array.isArray(options.targetTokenIds)
        ? options.targetTokenIds.map(value => String(value))
        : [],
      tab: String(options.tab ?? "").trim(),
      requireGM: options.requireGM !== false,
    });

    let clickFailed = false;
    let clickError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    let cleanup: Awaited<ReturnType<FoundryRuntimeClient["activityUiClickReceipt"]>> | null = null;
    try {
      assertUiPointInViewport(
        before.client,
        before.viewport,
        "ERR_ACTIVITY_UI_CONTROL_OFFSCREEN",
        "The requested activity-use control is outside the current browser viewport",
        { before },
      );

      await this.session.call(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: before.client.x,
          y: before.client.y,
          button: "none",
          buttons: 0,
        },
        5000,
      );
      await this.session.call(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: before.client.x,
          y: before.client.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        },
        5000,
      );
      await this.session.call(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: before.client.x,
          y: before.client.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        },
        5000,
      );

      const settleMs = Math.max(0, options.settleMs ?? 500);
      if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    } catch (error) {
      clickFailed = true;
      clickError = error;
    } finally {
      try {
        cleanup = await this.activityUiClickReceipt(before.receiptKey);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
    }

    if (clickFailed) throw clickError;
    if (cleanupFailed) throw cleanupError;
    const receipt = cleanup?.receipt ?? null;
    if (!receipt?.clicked || receipt.isTrusted !== true) {
      throw new CliError(
        "ERR_ACTIVITY_UI_CLICK_NOT_RECEIVED",
        "The exact activity-use control did not receive a trusted browser click",
        { before, cleanup },
      );
    }
    if (
      receipt.actorId !== before.actor.id
      || receipt.actorUuid !== before.actor.uuid
      || receipt.isToken !== before.actor.isToken
      || receipt.tokenUuid !== before.actor.tokenUuid
      || receipt.actorLink !== before.actor.actorLink
      || receipt.itemId !== before.item.id
      || receipt.activityId !== before.activity.id
    ) {
      throw new CliError(
        "ERR_ACTIVITY_UI_CLICK_IDENTITY_DRIFT",
        "The trusted activity click receipt no longer matches the exact Actor, Token, Item, and Activity",
        { before, cleanup },
      );
    }

    return {
      actor: before.actor,
      item: before.item,
      activity: before.activity,
      targets: before.targets,
      tab: before.tab,
      client: before.client,
      viewport: before.viewport,
      receipt,
      uiState: cleanup?.uiState,
    };
  }

  async effectUiBreakConcentration(
    options: EffectUiBreakConcentrationOptions,
  ): Promise<unknown> {
    const actorIdentifier = String(options.actorIdentifier ?? "").trim();
    const effectIdentifier = String(options.effectIdentifier ?? "").trim();
    if (!actorIdentifier || !effectIdentifier) {
      throw new CliError(
        "ERR_EFFECT_UI_BREAK_INPUT",
        "actorIdentifier and effectIdentifier are required",
        { actorIdentifier, effectIdentifier },
      );
    }

    const before = await this.effectUiBreakPointerContext({
      actorIdentifier,
      effectIdentifier,
    });
    assertUiPointInViewport(
      before.client,
      before.viewport,
      "ERR_EFFECT_UI_CONTROL_OFFSCREEN",
      "The requested effect context-menu control is outside the current browser viewport",
      { before },
    );
    await this.dispatchTrustedLeftClick(before.client);

    const settleMs = Math.max(0, options.settleMs ?? 500);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    const controlReceipt = await this.effectUiClickReceipt(before.receiptKey);
    if (
      !controlReceipt?.clicked
      || controlReceipt.isTrusted !== true
      || controlReceipt.button !== 0
      || controlReceipt.detail < 1
    ) {
      throw new CliError(
        "ERR_EFFECT_UI_CONTROL_CLICK_NOT_RECEIVED",
        "The exact effect context-menu control did not receive a trusted browser click",
        { before, receipt: controlReceipt },
      );
    }

    const menu = await this.effectUiBreakMenuPointerContext({
      actorId: before.actor.id,
      effectId: before.effect.id,
    });
    assertUiPointInViewport(
      menu.client,
      menu.viewport,
      "ERR_EFFECT_UI_BREAK_MENU_OFFSCREEN",
      "The break-concentration menu item is outside the current browser viewport",
      { before, menu },
    );
    await this.dispatchTrustedLeftClick(menu.client);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    const menuReceipt = await this.effectUiClickReceipt(menu.receiptKey);
    if (
      !menuReceipt?.clicked
      || menuReceipt.isTrusted !== true
      || menuReceipt.button !== 0
      || menuReceipt.detail < 1
    ) {
      throw new CliError(
        "ERR_EFFECT_UI_BREAK_CLICK_NOT_RECEIVED",
        "The break-concentration menu item did not receive a trusted browser click",
        { before, menu, receipt: menuReceipt },
      );
    }

    const result = await this.effectUiBreakResult({
      actorId: before.actor.id,
      effectId: before.effect.id,
    });
    if (!result.removed) {
      throw new CliError(
        "ERR_EFFECT_UI_BREAK_NOT_APPLIED",
        "The trusted break-concentration UI action did not remove the requested effect",
        { before, menu, controlReceipt, menuReceipt, result },
      );
    }

    return {
      actor: before.actor,
      effect: before.effect,
      control: {
        client: before.client,
        receipt: controlReceipt,
      },
      menu: {
        label: menu.label,
        client: menu.client,
        receipt: menuReceipt,
      },
      result,
    };
  }

  async login(options: FoundryLoginOptions): Promise<FoundryLoginResult> {
    const userName = String(options.userName ?? "").trim();
    if (!userName) {
      throw new CliError("ERR_LOGIN_USER_REQUIRED", "Foundry user name or ID is required");
    }

    const timeoutMs =
      Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
        ? options.timeoutMs!
        : 60000;
    const pollIntervalMs =
      Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) > 0
        ? Math.max(50, options.pollIntervalMs!)
        : 250;
    const requireGM = options.requireGM !== false;
    const expectedOrigin = normalizeFoundryLoginOrigin(options.expectedOrigin);
    const deadline = Date.now() + timeoutMs;
    let lastState: FoundryLoginPageState | undefined;
    let lastError: string | undefined;
    let joinPageRefreshed = options.refreshJoinPage !== true;

    while (Date.now() < deadline) {
      try {
        lastState = await this.readLoginState(
          expectedOrigin,
          Math.max(1, Math.min(5000, deadline - Date.now()))
        );
        assertFoundryLoginOrigin(lastState, expectedOrigin);
        if (lastState.ready && lastState.user) {
          return validateFoundryLoginState(
            userName,
            undefined,
            lastState,
            requireGM,
            "already-logged-in"
          );
        }
        if (lastState.joinFormReady) {
          if (!joinPageRefreshed) {
            joinPageRefreshed = true;
            this.mainExecutionContextId = undefined;
            await this.session.call(
              "Page.reload",
              { ignoreCache: true },
              Math.max(1, Math.min(10000, deadline - Date.now())),
            );
            lastState = undefined;
            continue;
          }
          break;
        }
      } catch (error) {
        if (
          error instanceof CliError &&
          (error.code.startsWith("ERR_LOGIN_") || error.code === "ERR_ALREADY_LOGGED_IN")
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }

      await new Promise(resolve =>
        setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
      );
    }

    if (!lastState?.joinFormReady) {
      throw new CliError(
        "ERR_LOGIN_TIMEOUT",
        "Timed out waiting for a Foundry /join form or ready /game page",
        {
          userName,
          timeoutMs,
          ...(lastState ? { lastState } : {}),
          ...(lastError ? { lastError } : {}),
        }
      );
    }

    const submission = (await this.callFunction(
      foundryLoginSubmitFunction,
      [
        { value: userName },
        { value: String(options.password ?? "") },
        { value: expectedOrigin },
      ],
      Math.max(1, Math.min(10000, deadline - Date.now()))
    )) as FoundryLoginUserSelection | undefined;

    if (!submission) {
      throw new CliError("ERR_LOGIN_SUBMIT", "Foundry login form returned no result", {
        userName,
      });
    }
    if (!submission.ok) {
      throw new CliError(submission.code, submission.message, {
        userName,
        availableUsers: submission.availableUsers,
      });
    }

    while (Date.now() < deadline) {
      try {
        lastState = await this.readLoginState(
          expectedOrigin,
          Math.max(1, Math.min(5000, deadline - Date.now()))
        );
        assertFoundryLoginOrigin(lastState, expectedOrigin);
        if (lastState.ready && lastState.user) {
          return validateFoundryLoginState(
            userName,
            submission.user.id,
            lastState,
            requireGM,
            "logged-in"
          );
        }

        const errors = lastState.notifications.filter(
          notification => notification.level === "error"
        );
        if (errors.length > 0) {
          throw new CliError("ERR_LOGIN_FAILED", "Foundry rejected the login request", {
            userName,
            notifications: errors,
          });
        }
      } catch (error) {
        if (
          error instanceof CliError &&
          (error.code.startsWith("ERR_LOGIN_") || error.code === "ERR_ALREADY_LOGGED_IN")
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }

      await new Promise(resolve =>
        setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
      );
    }

    throw new CliError("ERR_LOGIN_TIMEOUT", "Timed out waiting for Foundry game login", {
      userName,
      timeoutMs,
      ...(lastState ? { lastState } : {}),
      ...(lastError ? { lastError } : {}),
    });
  }

  async direct<T = unknown>(
    action: DirectAction,
    args: Record<string, unknown> = {},
    options: RuntimeCallOptions = {}
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 30000;
    let dispatched = false;
    try {
      return (await this.callFunction(
        runtimeFunction,
        [
          { value: action },
          { value: args },
          {
            value: {
              requireGM: options.requireGM !== false,
              timeoutMs,
            },
          },
        ],
        timeoutMs,
        () => { dispatched = true; },
      )) as T;
    } catch (error) {
      if (!dispatched || !isWriteDirectAction(action)) throw error;
      if (action === "executeTurn") {
        return executeTurnTransportInterruption(error) as T;
      }
      throw writeTransportInterruptionError(action, error);
    }
  }

  async debugEval<T = unknown>(
    scriptBody: string,
    arg: unknown = {},
    options: RuntimeCallOptions = {}
  ): Promise<T> {
    return (await this.callFunction(
      debugEvalFunction(scriptBody),
      [{ value: arg }],
      options.timeoutMs ?? 30000
    )) as T;
  }

  close(): void {
    this.session.close();
  }

  private async canvasPointerContext(
    x: number,
    y: number,
  ): Promise<CanvasPointerContext> {
    return (await this.callFunction(
      canvasPointerContextFunction,
      [{ value: x }, { value: y }],
      5000,
    )) as CanvasPointerContext;
  }

  private async activityUiPointerContext(options: {
    actorIdentifier: string;
    itemIdentifier: string;
    activityIdentifier: string;
    targetTokenIds: string[];
    tab: string;
    requireGM: boolean;
  }): Promise<{
    actor: ActivityUiActorIdentity & { name: string; type: string };
    item: { id: string; name: string; identifier: string };
    activity: { id: string; name: string; semanticActionId: string };
    targets: Array<{ id: string; name: string }>;
    tab: string;
    client: { x: number; y: number };
    viewport: { width: number; height: number };
    receiptKey: string;
    expandedByCli: boolean;
  }> {
    return (await this.callFunction(
      activityUiPointerContextFunction,
      [{ value: options }],
      10000,
    )) as {
      actor: ActivityUiActorIdentity & { name: string; type: string };
      item: { id: string; name: string; identifier: string };
      activity: { id: string; name: string; semanticActionId: string };
      targets: Array<{ id: string; name: string }>;
      tab: string;
      client: { x: number; y: number };
      viewport: { width: number; height: number };
      receiptKey: string;
      expandedByCli: boolean;
    };
  }

  private async activityUiClickReceipt(receiptKey: string): Promise<{
    receipt: {
      clicked: boolean;
      isTrusted: boolean;
      button: number;
      detail: number;
      actorId: string;
      actorUuid: string;
      isToken: boolean;
      tokenUuid: string | null;
      actorLink: boolean | null;
      itemId: string;
      activityId: string;
      timestamp: number;
    } | null;
    uiState: {
      expandedByCli: boolean;
      restored: boolean;
      status: string;
    };
  }> {
    return (await this.callFunction(
      activityUiClickReceiptFunction,
      [{ value: receiptKey }],
      5000,
    )) as {
      receipt: {
        clicked: boolean;
        isTrusted: boolean;
        button: number;
        detail: number;
        actorId: string;
        actorUuid: string;
        isToken: boolean;
        tokenUuid: string | null;
        actorLink: boolean | null;
        itemId: string;
        activityId: string;
        timestamp: number;
      } | null;
      uiState: {
        expandedByCli: boolean;
        restored: boolean;
        status: string;
      };
    };
  }

  private async effectUiBreakPointerContext(options: {
    actorIdentifier: string;
    effectIdentifier: string;
  }): Promise<{
    actor: { id: string; name: string };
    effect: { id: string; name: string; origin: string };
    client: { x: number; y: number };
    viewport: { width: number; height: number };
    receiptKey: string;
  }> {
    return (await this.callFunction(
      effectUiBreakPointerContextFunction,
      [{ value: options }],
      10000,
    )) as {
      actor: { id: string; name: string };
      effect: { id: string; name: string; origin: string };
      client: { x: number; y: number };
      viewport: { width: number; height: number };
      receiptKey: string;
    };
  }

  private async effectUiBreakMenuPointerContext(options: {
    actorId: string;
    effectId: string;
  }): Promise<{
    label: string;
    client: { x: number; y: number };
    viewport: { width: number; height: number };
    receiptKey: string;
  }> {
    return (await this.callFunction(
      effectUiBreakMenuPointerContextFunction,
      [{ value: options }],
      5000,
    )) as {
      label: string;
      client: { x: number; y: number };
      viewport: { width: number; height: number };
      receiptKey: string;
    };
  }

  private async effectUiClickReceipt(receiptKey: string): Promise<{
    clicked: boolean;
    isTrusted: boolean;
    button: number;
    detail: number;
    actorId: string;
    effectId: string;
    stage: string;
    timestamp: number;
  } | null> {
    return (await this.callFunction(
      effectUiClickReceiptFunction,
      [{ value: receiptKey }],
      5000,
    )) as {
      clicked: boolean;
      isTrusted: boolean;
      button: number;
      detail: number;
      actorId: string;
      effectId: string;
      stage: string;
      timestamp: number;
    } | null;
  }

  private async effectUiBreakResult(options: {
    actorId: string;
    effectId: string;
  }): Promise<{ removed: boolean; remainingEffectIds: string[] }> {
    return (await this.callFunction(
      effectUiBreakResultFunction,
      [{ value: options }],
      5000,
    )) as { removed: boolean; remainingEffectIds: string[] };
  }

  private async dispatchTrustedLeftClick(client: {
    x: number;
    y: number;
  }): Promise<void> {
    await this.session.call(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x: client.x,
        y: client.y,
        button: "none",
        buttons: 0,
      },
      5000,
    );
    await this.session.call(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: client.x,
        y: client.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      5000,
    );
    await this.session.call(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: client.x,
        y: client.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
      5000,
    );
  }

  private async readLoginState(
    expectedOrigin: string,
    timeoutMs: number
  ): Promise<FoundryLoginPageState> {
    return (await this.callFunction(
      foundryLoginStateFunction,
      [{ value: expectedOrigin }],
      timeoutMs
    )) as FoundryLoginPageState;
  }

  private async readMainFrameSnapshot(timeoutMs: number): Promise<FoundryMainFrameSnapshot> {
    const frameTree = await this.session.call<{
      frameTree?: {
        frame?: {
          id?: unknown;
          loaderId?: unknown;
          url?: unknown;
        };
      };
    }>("Page.getFrameTree", {}, timeoutMs);
    const frame = frameTree.frameTree?.frame;
    if (
      typeof frame?.id !== "string"
      || typeof frame.loaderId !== "string"
      || !frame.loaderId
      || typeof frame.url !== "string"
      || !frame.url
    ) {
      throw new CliError(
        "ERR_PAGE_RELOAD_MAIN_FRAME",
        "Could not resolve the current main frame loader id and URL",
        { frame: frame ?? null },
      );
    }
    if (this.mainFrameId !== frame.id) {
      throw new CliError(
        "ERR_PAGE_RELOAD_RACE",
        "The tracked Foundry main frame changed before page reload",
        {
          trackedMainFrameId: this.mainFrameId ?? null,
          currentMainFrameId: frame.id,
          loaderId: frame.loaderId,
          url: frame.url,
        },
      );
    }
    return {
      id: frame.id,
      loaderId: frame.loaderId,
      url: frame.url,
    };
  }

  private async callFunction(
    functionDeclaration: string,
    args: Array<{ value: unknown }>,
    timeoutMs: number,
    onDispatch?: () => void,
  ): Promise<unknown> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const remainingTimeout = (): number => Math.max(1, deadline - Date.now());
    const executionContextId = await this.waitForMainExecutionContext(deadline);
    onDispatch?.();
    const response = await this.session.call<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>(
      "Runtime.callFunctionOn",
      {
        executionContextId,
        functionDeclaration,
        arguments: args,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      remainingTimeout()
    );

    if (response.exceptionDetails) {
      throw new CliError("ERR_FOUNDRY_RUNTIME_EXCEPTION", "Foundry runtime threw an exception", {
        exceptionDetails: response.exceptionDetails,
      });
    }

    return response.result?.value;
  }

  private async waitForMainExecutionContext(deadline: number): Promise<number> {
    while (Date.now() < deadline) {
      if (typeof this.mainExecutionContextId === "number") {
        return this.mainExecutionContextId;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new CliError(
      "ERR_CDP_EXECUTION_CONTEXT",
      "Timed out waiting for the page main-world execution context",
      { mainFrameId: this.mainFrameId ?? null },
    );
  }
}

function executeTurnTransportInterruption(error: unknown): ExecuteTurnReceipt {
  const { action: _action, ...receipt } = transportInterruption("executeTurn", error);
  return receipt;
}

function transportInterruption(
  action: WriteDirectAction,
  error: unknown,
): DirectActionInterruption {
  const code = error instanceof CliError ? error.code : "";
  const message = error instanceof Error ? error.message : String(error);
  const runtimeStatus: RuntimeStatus = code.includes("TIMEOUT")
    ? "timeout"
    : /navigat|execution context.*destroyed|frame.*detached/i.test(message)
      ? "navigated"
      : "error";
  return {
    status: "indeterminate",
    retry: false,
    code: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
    action,
    runtimeStatus,
    message: `${action} was interrupted after CDP dispatch; inspect fresh state before any further action.`,
  };
}

function writeTransportInterruptionError(
  action: WriteDirectAction,
  error: unknown,
): CliError {
  const details = transportInterruption(action, error);
  return new CliError(details.code, details.message, details);
}

export async function withRuntimeConnection<T>(
  runtime: Pick<FoundryRuntimeClient, "connect" | "close">,
  fn: () => Promise<T>,
  connectTimeoutMs?: number
): Promise<T> {
  try {
    if (connectTimeoutMs === undefined) await runtime.connect();
    else await runtime.connect(connectTimeoutMs);
    return await fn();
  } finally {
    runtime.close();
  }
}

const canvasPointerContextFunction = String.raw`
function (x, y) {
  if (!globalThis.game?.ready || !globalThis.canvas?.ready) {
    throw new Error("Foundry canvas is not ready");
  }
  if (
    typeof canvas.clientCoordinatesFromCanvas !== "function" ||
    typeof canvas.canvasCoordinatesFromClient !== "function"
  ) {
    throw new Error("Foundry canvas coordinate conversion APIs are unavailable");
  }

  const clientPoint = canvas.clientCoordinatesFromCanvas({ x, y });
  const roundTripPoint = canvas.canvasCoordinatesFromClient(clientPoint);
  const previewChildren = Array.from(canvas.templates?.preview?.children ?? []);
  const templateIds = Array.from(canvas.scene?.templates ?? [])
    .map(template => template?.id)
    .filter(id => typeof id === "string");
  const summarizeElement = element => {
    if (!element || element.nodeType !== 1) return null;
    const classes = Array.from(element.classList ?? [])
      .filter(className => typeof className === "string" && className.length > 0)
      .slice(0, 16);
    const attribute = name => {
      const value = element.getAttribute?.(name);
      return typeof value === "string" && value.length > 0 ? value : null;
    };
    return {
      tag: typeof element.tagName === "string" ? element.tagName.toLowerCase() : null,
      id: typeof element.id === "string" && element.id.length > 0 ? element.id : null,
      classes,
      aria: {
        role: attribute("role"),
        modal: attribute("aria-modal"),
        hidden: attribute("aria-hidden"),
        disabled: attribute("aria-disabled"),
      },
    };
  };
  const configuredView = canvas.app?.view;
  const configuredCanvas = canvas.app?.canvas;
  const board = globalThis.document?.querySelector?.("#board");
  const acceptableTargets = [configuredView, configuredCanvas, board]
    .filter((element, index, values) =>
      element?.nodeType === 1 && values.indexOf(element) === index
    );
  const canvasTarget = acceptableTargets[0] ?? null;
  const hit = globalThis.document?.elementFromPoint?.(clientPoint.x, clientPoint.y) ?? null;
  const accepted = acceptableTargets.some(target =>
    hit === target || (typeof target.contains === "function" && target.contains(hit))
  );
  const dialog = hit?.closest?.(
    'dialog, [role="dialog"], [aria-modal="true"], .dialog, .window-app'
  ) ?? null;

  return {
    sceneId: canvas.scene?.id ?? null,
    client: { x: clientPoint.x, y: clientPoint.y },
    roundTrip: { x: roundTripPoint.x, y: roundTripPoint.y },
    viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
    previewCount: previewChildren.length,
    templateIds,
    dom: {
      accepted,
      hit: summarizeElement(hit),
      canvas: summarizeElement(canvasTarget),
      dialog: summarizeElement(dialog),
    },
  };
}
`;

const activityUiPointerContextFunction = String.raw`
async function (options) {
  if (!globalThis.game?.ready || !globalThis.canvas?.ready) {
    throw new Error("Foundry is not ready");
  }
  if (options.requireGM !== false && !globalThis.game.user?.isGM) {
    throw new Error("GM user is required");
  }

  const values = collection => {
    if (!collection) return [];
    if (typeof collection.values === "function") return Array.from(collection.values());
    if (Array.isArray(collection)) return collection;
    return Object.values(collection);
  };
  const exactOrUnique = (documents, identifier, describe, identifiers) => {
    const wanted = String(identifier ?? "").trim();
    const exact = documents.filter(document =>
      identifiers(document).some(value => String(value ?? "").trim() === wanted)
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error("Ambiguous " + describe + ": " + wanted);
    }
    throw new Error(describe + " not found: " + wanted);
  };

  const isExactSyntheticActorUuid = ${isExactSyntheticActorUuid.toString()};
  const activityUiDefaultTab = ${activityUiDefaultTab.toString()};
  const activityUiActorIdentity = ${activityUiActorIdentity.toString()};

  const wantedActor = String(options.actorIdentifier ?? "").trim();
  let actor;
  if (isExactSyntheticActorUuid(wantedActor)) {
    actor = await fromUuid(wantedActor);
    const identity = activityUiActorIdentity(actor);
    const tokenUuid = wantedActor.slice(0, wantedActor.lastIndexOf(".Actor."));
    if (
      actor?.documentName !== "Actor"
      || identity.uuid !== wantedActor
      || identity.isToken !== true
      || identity.tokenUuid !== tokenUuid
      || identity.actorLink !== false
      || actor?.token?.documentName !== "Token"
      || actor?.token?.actor !== actor
      || actor?.token?.parent?.id !== canvas.scene?.id
    ) {
      throw new Error(
        "Synthetic Actor UUID did not resolve to its exact unlinked Token identity: "
          + wantedActor,
      );
    }
  } else {
    // Preserve the existing world-Actor lookup contract: id, UUID, or name
    // must still identify exactly one document in game.actors.
    actor = exactOrUnique(
      values(game.actors),
      wantedActor,
      "Actor",
      current => [current.id, current.uuid, current.name],
    );
  }
  const actorIdentity = activityUiActorIdentity(actor);
  const item = exactOrUnique(
    values(actor.items),
    options.itemIdentifier,
    "Item",
    current => [current.id, current.uuid, current.name, current.system?.identifier],
  );
  const activity = exactOrUnique(
    values(item.system?.activities),
    options.activityIdentifier,
    "Activity",
    current => [
      current.id,
      current.name,
      current.flags?.["arcane-dnd5e-2014-automation"]?.semanticActionId,
    ],
  );

  const targets = [];
  const requestedTargetIds = Array.isArray(options.targetTokenIds)
    ? options.targetTokenIds.map(value => String(value))
    : [];
  for (const current of Array.from(game.user?.targets ?? [])) {
    current.setTarget(false, { releaseOthers: false, groupSelection: true });
  }
  for (const requestedId of requestedTargetIds) {
    const matches = (canvas.tokens?.placeables ?? []).filter(token =>
      [token.id, token.document?.id, token.name, token.actor?.id, token.actor?.name]
        .some(value => String(value ?? "") === requestedId)
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length > 1
          ? "Ambiguous target token: " + requestedId
          : "Target token not found: " + requestedId,
      );
    }
    matches[0].setTarget(true, { releaseOthers: false, groupSelection: true });
    targets.push({ id: matches[0].id, name: matches[0].name });
  }

  const sheet = actor.sheet;
  if (!sheet) throw new Error("Actor sheet is unavailable: " + actor.name);
  await sheet.render(true);
  await new Promise(resolve => setTimeout(resolve, 200));
  const requestedTab = activityUiDefaultTab(actor.type, item.type, options.tab);
  if (typeof sheet.changeTab === "function") {
    await sheet.changeTab(requestedTab, "primary");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (typeof sheet.bringToFront === "function") sheet.bringToFront();

  let root = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
  if (!(root instanceof HTMLElement)) {
    throw new Error("Actor sheet DOM is unavailable: " + actor.name);
  }
  const findControl = () => Array.from(
    root.querySelectorAll('[data-action="activity-use"]'),
  ).find(element => {
    const itemRow = element.closest("[data-item-id]");
    const activityRow = element.closest("[data-activity-id]");
    return itemRow?.dataset?.itemId === item.id
      && activityRow?.dataset?.activityId === activity.id;
  });
  let control = findControl();
  if (!(control instanceof HTMLElement)) {
    throw new Error(
      "Exact activity-use control not found for " + item.id + "/" + activity.id,
    );
  }

  let itemRow = control.closest("[data-item-id]");
  let expandedByCli = false;
  const restoreItemExpansion = async () => {
    if (!expandedByCli) {
      return { expandedByCli: false, restored: true, status: "not-needed" };
    }

    const currentRoot = sheet.element instanceof HTMLElement
      ? sheet.element
      : sheet.element?.[0];
    if (!(currentRoot instanceof HTMLElement)) {
      return { expandedByCli: true, restored: false, status: "sheet-unavailable" };
    }

    if (!(itemRow instanceof HTMLElement) || !itemRow.isConnected) {
      itemRow = Array.from(currentRoot.querySelectorAll("[data-item-id]"))
        .find(element => {
          if (!(element instanceof HTMLElement) || element.dataset.itemId !== item.id) {
            return false;
          }
          return Array.from(element.querySelectorAll("[data-activity-id]"))
            .some(activityElement => activityElement.dataset.activityId === activity.id);
        }) ?? null;
    }
    if (!(itemRow instanceof HTMLElement)) {
      return { expandedByCli: true, restored: false, status: "item-row-unavailable" };
    }
    if (itemRow.classList.contains("collapsed")) {
      return { expandedByCli: true, restored: true, status: "already-collapsed" };
    }

    const toggle = itemRow.querySelector('[data-action="toggleExpand"]');
    if (!(toggle instanceof HTMLElement)) {
      return { expandedByCli: true, restored: false, status: "toggle-unavailable" };
    }
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const restored = itemRow.classList.contains("collapsed");
    return {
      expandedByCli: true,
      restored,
      status: restored ? "restored" : "restore-not-observed",
    };
  };

  try {
    if (itemRow instanceof HTMLElement && itemRow.classList.contains("collapsed")) {
      const toggle = itemRow.querySelector('[data-action="toggleExpand"]');
      if (!(toggle instanceof HTMLElement)) {
        throw new Error(
          "Cannot expand the item row for " + item.id + "/" + activity.id,
        );
      }
      // Expanding is preparation only; the activity-use itself is still invoked
      // exclusively by the trusted CDP mouse event below.
      expandedByCli = true;
      toggle.click();
      await new Promise(resolve => setTimeout(resolve, 250));
      root = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
      if (!(root instanceof HTMLElement)) {
        throw new Error("Actor sheet DOM disappeared while expanding: " + actor.name);
      }
      control = findControl();
      if (!(control instanceof HTMLElement)) {
        throw new Error(
          "Exact activity-use control disappeared after expanding "
            + item.id + "/" + activity.id,
        );
      }
      itemRow = control.closest("[data-item-id]");
    }

    // The dnd5e item row opens with a CSS grid transition. A fixed delay is
    // racy: longer descriptions can temporarily report a zero-sized control
    // or leave a sibling overlay at the planned click point. Wait until the
    // exact control is both laid out and wins the browser hit test.
    const readinessDeadline = Date.now() + 2000;
    let rect = null;
    let hit = null;
    let readiness = "not-visible";
    while (Date.now() <= readinessDeadline) {
      root = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
      if (!(root instanceof HTMLElement)) {
        throw new Error("Actor sheet DOM disappeared while locating: " + actor.name);
      }
      const currentControl = findControl();
      if (currentControl instanceof HTMLElement) control = currentControl;
      control.scrollIntoView({ block: "center", inline: "center" });
      await new Promise(resolve => setTimeout(resolve, 50));
      rect = control.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        readiness = "not-visible";
        continue;
      }
      if (
        getComputedStyle(control).pointerEvents === "none"
        || control.getAttribute("aria-disabled") === "true"
      ) {
        readiness = "disabled";
        break;
      }
      const pointX = rect.left + rect.width / 2;
      const pointY = rect.top + rect.height / 2;
      hit = document.elementFromPoint(pointX, pointY);
      if (hit instanceof Element && (hit === control || control.contains(hit))) {
        readiness = "ready";
        break;
      }
      readiness = "covered";
    }
    if (readiness === "not-visible") {
      throw new Error(
        "Exact activity-use control is not visible for " + item.id + "/" + activity.id,
      );
    }
    if (readiness === "disabled") {
      throw new Error(
        "Exact activity-use control is disabled for " + item.id + "/" + activity.id,
      );
    }
    if (readiness !== "ready") {
      throw new Error(
        "Exact activity-use control is covered at the planned click point",
      );
    }
    const client = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };

    const receiptKey = [
      actor.id,
      item.id,
      activity.id,
      Date.now(),
      Math.random().toString(36).slice(2),
    ].join(":");
    globalThis.__arcaneActivityUiClickReceipts ??= {};
    const store = globalThis.__arcaneActivityUiClickReceipts;
    const handler = event => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (!path.includes(control)) return;
      const entry = store[receiptKey];
      if (entry) {
        entry.receipt = {
          clicked: true,
          isTrusted: event.isTrusted === true,
          button: Number(event.button ?? 0),
          detail: Number(event.detail ?? 0),
          actorId: actor.id,
          actorUuid: actorIdentity.uuid,
          isToken: actorIdentity.isToken,
          tokenUuid: actorIdentity.tokenUuid,
          actorLink: actorIdentity.actorLink,
          itemId: item.id,
          activityId: activity.id,
          timestamp: Date.now(),
        };
      }
    };
    const entry = {
      receipt: null,
      handler,
      watchdogId: null,
      cleanupPromise: null,
      cleanup() {
        this.cleanupPromise ??= (async () => {
          if (this.handler) {
            document.removeEventListener("click", this.handler, true);
            this.handler = null;
          }
          if (this.watchdogId !== null) {
            clearTimeout(this.watchdogId);
            this.watchdogId = null;
          }
          const uiState = await restoreItemExpansion();
          delete store[receiptKey];
          return { receipt: this.receipt, uiState };
        })();
        return this.cleanupPromise;
      },
    };
    store[receiptKey] = entry;
    document.addEventListener("click", handler, true);
    entry.watchdogId = setTimeout(() => {
      void entry.cleanup().catch(() => undefined);
    }, 15000);

    return {
      actor: {
        ...actorIdentity,
        name: actor.name,
        type: actor.type,
      },
      item: {
        id: item.id,
        name: item.name,
        identifier: String(item.system?.identifier ?? ""),
      },
      activity: {
        id: activity.id,
        name: activity.name,
        semanticActionId: String(
          activity.flags?.["arcane-dnd5e-2014-automation"]?.semanticActionId ?? "",
        ),
      },
      targets,
      tab: requestedTab,
      client,
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      receiptKey,
      expandedByCli,
    };
  } catch (error) {
    await restoreItemExpansion();
    throw error;
  }
}
`;

const activityUiClickReceiptFunction = String.raw`
async function (receiptKey) {
  const store = globalThis.__arcaneActivityUiClickReceipts ?? {};
  const entry = store[receiptKey];
  if (!entry) {
    return {
      receipt: null,
      uiState: {
        expandedByCli: false,
        restored: false,
        status: "receipt-missing",
      },
    };
  }
  return await entry.cleanup();
}
`;

const effectUiBreakPointerContextFunction = String.raw`
async function (options) {
  if (!globalThis.game?.ready || !globalThis.canvas?.ready) {
    throw new Error("Foundry is not ready");
  }

  const values = collection => {
    if (!collection) return [];
    if (typeof collection.values === "function") return Array.from(collection.values());
    if (Array.isArray(collection)) return collection;
    return Object.values(collection);
  };
  const exactOrUnique = (documents, identifier, describe, identifiers) => {
    const wanted = String(identifier ?? "").trim();
    const exact = documents.filter(document =>
      identifiers(document).some(value => String(value ?? "").trim() === wanted)
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error("Ambiguous " + describe + ": " + wanted);
    throw new Error(describe + " not found: " + wanted);
  };

  const actor = exactOrUnique(
    values(game.actors),
    options.actorIdentifier,
    "Actor",
    current => [current.id, current.uuid, current.name],
  );
  const effect = exactOrUnique(
    values(actor.effects),
    options.effectIdentifier,
    "ActiveEffect",
    current => [current.id, current.uuid, current.name],
  );
  const concentrationEffects = actor.concentration?.effects;
  if (
    !concentrationEffects
    || typeof concentrationEffects.has !== "function"
    || !concentrationEffects.has(effect)
  ) {
    throw new Error("Requested ActiveEffect is not an active concentration effect: " + effect.id);
  }

  const sheet = actor.sheet;
  if (!sheet) throw new Error("Actor sheet is unavailable: " + actor.name);
  await sheet.render(true);
  await new Promise(resolve => setTimeout(resolve, 200));
  if (typeof sheet.changeTab === "function") {
    await sheet.changeTab("effects", "primary");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (typeof sheet.bringToFront === "function") sheet.bringToFront();

  const root = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
  if (!(root instanceof HTMLElement)) {
    throw new Error("Actor sheet DOM is unavailable: " + actor.name);
  }
  const effectRow = Array.from(root.querySelectorAll("[data-effect-id]"))
    .find(element => element?.dataset?.effectId === effect.id);
  if (!(effectRow instanceof HTMLElement)) {
    throw new Error("Exact ActiveEffect row not found: " + effect.id);
  }
  const control = effectRow.querySelector("[data-context-menu]");
  if (!(control instanceof HTMLElement)) {
    throw new Error("Effect context-menu control not found: " + effect.id);
  }

  control.scrollIntoView({ block: "center", inline: "center" });
  await new Promise(resolve => setTimeout(resolve, 100));
  const rect = control.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error("Effect context-menu control is not visible: " + effect.id);
  }
  if (
    getComputedStyle(control).pointerEvents === "none"
    || control.getAttribute("aria-disabled") === "true"
  ) {
    throw new Error("Effect context-menu control is disabled: " + effect.id);
  }
  const client = {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
  const hit = document.elementFromPoint(client.x, client.y);
  if (!(hit instanceof Element) || !(hit === control || control.contains(hit))) {
    throw new Error("Effect context-menu control is covered at the planned click point");
  }

  const receiptKey = [
    actor.id,
    effect.id,
    "control",
    Date.now(),
    Math.random().toString(36).slice(2),
  ].join(":");
  globalThis.__arcaneEffectUiClickReceipts ??= {};
  const handler = event => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(control)) return;
    const entry = globalThis.__arcaneEffectUiClickReceipts?.[receiptKey];
    if (entry) {
      entry.receipt = {
        clicked: true,
        isTrusted: event.isTrusted === true,
        button: Number(event.button ?? 0),
        detail: Number(event.detail ?? 0),
        actorId: actor.id,
        effectId: effect.id,
        stage: "context-menu-control",
        timestamp: Date.now(),
      };
    }
  };
  globalThis.__arcaneEffectUiClickReceipts[receiptKey] = {
    receipt: null,
    handler,
  };
  document.addEventListener("click", handler, true);

  return {
    actor: { id: actor.id, name: actor.name },
    effect: {
      id: effect.id,
      name: effect.name,
      origin: String(effect.origin ?? ""),
    },
    client,
    viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
    receiptKey,
  };
}
`;

const effectUiBreakMenuPointerContextFunction = String.raw`
async function (options) {
  const actor = game.actors?.get(options.actorId);
  const effect = actor?.effects?.get(options.effectId);
  if (!actor || !effect) {
    throw new Error("ActiveEffect disappeared before its concentration menu opened");
  }

  const sheetRoot = actor.sheet?.element instanceof HTMLElement
    ? actor.sheet.element
    : actor.sheet?.element?.[0];
  if (!(sheetRoot instanceof HTMLElement)) {
    throw new Error("Actor sheet DOM disappeared before the concentration menu opened");
  }

  let menuItem = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const context = ui.context;
    const target = context?.target;
    const contextElement = context?.element;
    const ownsRequestedEffect = target instanceof HTMLElement
      && target.dataset?.effectId === effect.id
      && target.isConnected
      && sheetRoot.contains(target);
    const exactContextMenu = contextElement instanceof HTMLElement
      && contextElement.matches('nav#context-menu[popover="manual"]')
      && contextElement.isConnected;
    const candidates = ownsRequestedEffect && exactContextMenu
      ? Array.from(context?.menuItems ?? []).map(item => item?.element).filter(element => {
          if (!(element instanceof HTMLElement) || !element.isConnected) return false;
          const item = Array.from(context?.menuItems ?? [])
            .find(current => current?.element === element);
          if (item?.name !== "DND5E.ConcentrationBreak") return false;
          return Boolean(
            element.querySelector('dnd5e-icon[src$="/break-concentration.svg"]'),
          );
        })
      : [];
    if (candidates.length === 1) {
      menuItem = candidates[0];
      break;
    }
    if (candidates.length > 1) {
      throw new Error("Ambiguous break-concentration context-menu item");
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!(menuItem instanceof HTMLElement)) {
    throw new Error("Break-concentration context-menu item did not appear");
  }

  // Foundry's singleton context menu animates open and can remain covered for
  // several frames after insertion. Poll the exact hit target while retaining
  // the ownership checks; never click through a persistent obstruction.
  let client = null;
  let hit = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const context = ui.context;
    if (
      context?.target?.dataset?.effectId !== effect.id
      || !sheetRoot.contains(context.target)
      || context?.element?.id !== "context-menu"
      || !menuItem.isConnected
    ) {
      throw new Error("Another context menu replaced the requested effect menu");
    }
    const rect = menuItem.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      client = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      hit = document.elementFromPoint(client.x, client.y);
      if (
        hit instanceof Element
        && (hit === menuItem || menuItem.contains(hit))
      ) break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!client) {
    throw new Error("Break-concentration menu item is not visible");
  }
  if (!(hit instanceof Element) || !(hit === menuItem || menuItem.contains(hit))) {
    throw new Error("Break-concentration menu item is covered at the planned click point");
  }

  const receiptKey = [
    actor.id,
    effect.id,
    "break",
    Date.now(),
    Math.random().toString(36).slice(2),
  ].join(":");
  globalThis.__arcaneEffectUiClickReceipts ??= {};
  const handler = event => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(menuItem)) return;
    const entry = globalThis.__arcaneEffectUiClickReceipts?.[receiptKey];
    if (entry) {
      entry.receipt = {
        clicked: true,
        isTrusted: event.isTrusted === true,
        button: Number(event.button ?? 0),
        detail: Number(event.detail ?? 0),
        actorId: actor.id,
        effectId: effect.id,
        stage: "break-concentration",
        timestamp: Date.now(),
      };
    }
  };
  globalThis.__arcaneEffectUiClickReceipts[receiptKey] = {
    receipt: null,
    handler,
  };
  document.addEventListener("click", handler, true);

  return {
    label: String(menuItem.textContent ?? "").trim(),
    client,
    viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
    receiptKey,
  };
}
`;

const effectUiClickReceiptFunction = String.raw`
function (receiptKey) {
  const store = globalThis.__arcaneEffectUiClickReceipts ?? {};
  const entry = store[receiptKey];
  if (!entry) return null;
  if (entry.handler) document.removeEventListener("click", entry.handler, true);
  delete store[receiptKey];
  return entry.receipt ?? null;
}
`;

const effectUiBreakResultFunction = String.raw`
async function (options) {
  const actor = game.actors?.get(options.actorId);
  if (!actor) throw new Error("Actor disappeared after breaking concentration");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const remainingEffectIds = Array.from(actor.effects ?? [])
      .map(effect => effect?.id)
      .filter(id => typeof id === "string");
    if (!remainingEffectIds.includes(options.effectId)) {
      return { removed: true, remainingEffectIds };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const remainingEffectIds = Array.from(actor.effects ?? [])
    .map(effect => effect?.id)
    .filter(id => typeof id === "string");
  return {
    removed: !remainingEffectIds.includes(options.effectId),
    remainingEffectIds,
  };
}
`;

export const foundryLoginSubmitFunction = String.raw`
function (requestedUser, password, expectedOrigin) {
  const resolveFoundryLoginUser = ${resolveFoundryLoginUser.toString()};
  if (
    globalThis.location.origin !== expectedOrigin ||
    !/^\/join(?:\/|$)/.test(globalThis.location.pathname)
  ) {
    return {
      ok: false,
      code: "ERR_LOGIN_ORIGIN_MISMATCH",
      message: "Foundry login page origin or path changed before password entry",
      availableUsers: [],
    };
  }

  const userSelect = document.querySelector('select[name="userid"]');
  const form = userSelect?.closest("form");

  if (!(userSelect instanceof HTMLSelectElement) || !(form instanceof HTMLFormElement)) {
    return {
      ok: false,
      code: "ERR_LOGIN_FORM_NOT_FOUND",
      message: "Foundry join form was not found",
      availableUsers: [],
    };
  }

  const formAction = new URL(form.action, globalThis.location.href);
  if (formAction.origin !== expectedOrigin) {
    return {
      ok: false,
      code: "ERR_LOGIN_ORIGIN_MISMATCH",
      message: "Foundry login form action does not match the expected origin",
      availableUsers: [],
    };
  }

  const options = Array.from(userSelect.options).map(option => ({
    value: option.value,
    text: option.text.trim(),
    disabled: option.disabled,
  }));
  const selection = resolveFoundryLoginUser(options, requestedUser);
  if (!selection.ok) return selection;

  const passwordInput = form.querySelector('input[name="password"]');
  if (!(passwordInput instanceof HTMLInputElement)) {
    return {
      ok: false,
      code: "ERR_LOGIN_PASSWORD_FIELD_NOT_FOUND",
      message: "Foundry password field was not found",
      availableUsers: options
        .filter(option => option.value || option.text)
        .map(option => ({
          id: option.value,
          name: option.text,
          disabled: option.disabled === true,
        })),
    };
  }

  for (const notification of document.querySelectorAll(".notification.error")) {
    notification.remove();
  }

  userSelect.value = selection.user.id;
  userSelect.dispatchEvent(new Event("input", { bubbles: true }));
  userSelect.dispatchEvent(new Event("change", { bubbles: true }));
  passwordInput.value = String(password ?? "");
  passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
  passwordInput.dispatchEvent(new Event("change", { bubbles: true }));

  const joinButton = form.querySelector('button[name="join"], button[type="submit"]');
  if (joinButton instanceof HTMLButtonElement) form.requestSubmit(joinButton);
  else form.requestSubmit();
  return selection;
}
`;

export const foundryLoginStateFunction = String.raw`
function (expectedOrigin) {
  const foundryGame = globalThis.game;
  const user = foundryGame?.user;
  const world = foundryGame?.world;
  const userSelect = document.querySelector('select[name="userid"]');
  const joinForm = userSelect?.closest("form");
  const notifications = Array.from(document.querySelectorAll(".notification"))
    .map(notification => {
      const levels = ["error", "warning", "success", "info"];
      return {
        level: levels.find(level => notification.classList.contains(level)) ?? "unknown",
        text: (notification.textContent ?? "").trim(),
      };
    })
    .filter(notification => notification.text);

  return {
    href: globalThis.location.href,
    title: document.title,
    originMatches: globalThis.location.origin === expectedOrigin,
    joinFormReady:
      userSelect instanceof HTMLSelectElement &&
      joinForm instanceof HTMLFormElement &&
      joinForm.querySelector('input[name="password"]') instanceof HTMLInputElement,
    ready: foundryGame?.ready === true,
    user: user
      ? {
          id: String(user.id ?? ""),
          name: String(user.name ?? ""),
          isGM: user.isGM === true,
        }
      : null,
    world: world
      ? {
          id: world.id == null ? null : String(world.id),
          title: world.title == null ? null : String(world.title),
        }
      : null,
    notifications,
  };
}
`;

function debugEvalFunction(scriptBody: string): string {
  return `
async function (__arcaneArg) {
  const __arcaneAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const __arcaneFn = new __arcaneAsyncFunction("arg", ${JSON.stringify(scriptBody)});
  const __arcaneResult = await __arcaneFn(__arcaneArg);
  return __arcaneResult === undefined ? null : __arcaneResult;
}
`;
}
