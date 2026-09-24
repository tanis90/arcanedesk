import { MODULE_ID } from "./write-probe.js";

/**
 * Play-mode (跑团) tool surface: the in-page port of the Desktop host layer
 * (apps/desktop/src/main/foundry-services.js). The module owns the static/turn
 * snapshot state machine, resolves model actionRefs against the cached manual,
 * and journals every write through the world-scoped play ledger. The SDK
 * runtime remains the second validation layer (STATIC_CONTEXT_STALE,
 * TURN_CHANGED, WORLD_CHANGED, SOURCE_*).
 */

/** Byte-parity with Desktop foundry-services.js aliases; frozen by tests. */
export const CONDITION_ALIASES = Object.freeze({
  倒地: "prone",
  中毒: "poisoned",
  失明: "blinded",
  魅惑: "charmed",
  耳聋: "deafened",
  恐慌: "frightened",
  恐惧: "frightened",
  擒抱: "grappled",
  失能: "incapacitated",
  隐形: "invisible",
  麻痹: "paralyzed",
  石化: "petrified",
  束缚: "restrained",
  震慑: "stunned",
  昏迷: "unconscious",
  专注: "concentrating",
  concentration: "concentrating",
});

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REF_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const WORLD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ATTACK_ROLL_MODES = Object.freeze(["normal", "advantage", "disadvantage"]);

function fail(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  throw error;
}

function requireGm(gameRef) {
  if (gameRef?.user?.isGM !== true) {
    fail("GM_REQUIRED", "The current Foundry user must be a GM");
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function checkUnknownFields(rawInput, allowed, label) {
  if (!isPlainObject(rawInput)) {
    fail("INVALID_INPUT", `${label} must be an object`);
  }
  const unknown = Object.keys(rawInput).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("INVALID_INPUT", `Unknown input field: ${unknown.join(", ")}`);
  }
}

function checkRef(value, field) {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) {
    fail("INVALID_INPUT", `${field} is missing or invalid`);
  }
  return value;
}

function checkTargetTokenUuids(value, field) {
  if (!Array.isArray(value) || value.length > 100) {
    fail("INVALID_INPUT", `${field} must be an array of at most 100 token UUIDs`);
  }
  for (const item of value) checkRef(item, `${field} entry`);
  return [...value];
}

function checkActivityInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "spellLevel",
    "attackRollMode",
    "selections",
    "allocation",
    "declaredRiders",
    "targetSpec",
  ]), "input");
  const normalized = {};
  if (rawInput.spellLevel !== undefined) {
    if (!Number.isInteger(rawInput.spellLevel) || rawInput.spellLevel < 1 || rawInput.spellLevel > 9) {
      fail("INVALID_INPUT", "input.spellLevel must be an integer from 1 to 9");
    }
    normalized.spellLevel = rawInput.spellLevel;
  }
  if (rawInput.attackRollMode !== undefined) {
    if (!ATTACK_ROLL_MODES.includes(rawInput.attackRollMode)) {
      fail("INVALID_INPUT", "input.attackRollMode must be normal, advantage, or disadvantage");
    }
    normalized.attackRollMode = rawInput.attackRollMode;
  }
  if (rawInput.selections !== undefined) {
    if (!isPlainObject(rawInput.selections)) {
      fail("INVALID_INPUT", "input.selections must be an object");
    }
    for (const [key, entry] of Object.entries(rawInput.selections)) {
      if (key.length < 1 || key.length > 256) {
        fail("INVALID_INPUT", "input.selections keys must be 1-256 characters");
      }
      const valid = typeof entry === "boolean"
        || (typeof entry === "number" && Number.isFinite(entry))
        || (typeof entry === "string" && entry.length >= 1 && entry.length <= 256);
      if (!valid) {
        fail("INVALID_INPUT", "input.selections values must be a string, number, or boolean");
      }
    }
    normalized.selections = rawInput.selections;
  }
  if (rawInput.allocation !== undefined) {
    if (!Array.isArray(rawInput.allocation) || rawInput.allocation.length > 100
      || !rawInput.allocation.every(isPlainObject)) {
      fail("INVALID_INPUT", "input.allocation must be an array of at most 100 objects");
    }
    normalized.allocation = rawInput.allocation;
  }
  if (rawInput.declaredRiders !== undefined) {
    if (!Array.isArray(rawInput.declaredRiders) || rawInput.declaredRiders.length > 20
      || !rawInput.declaredRiders.every(isPlainObject)) {
      fail("INVALID_INPUT", "input.declaredRiders must be an array of at most 20 objects");
    }
    normalized.declaredRiders = rawInput.declaredRiders;
  }
  if (rawInput.targetSpec !== undefined) {
    if (!isPlainObject(rawInput.targetSpec)) {
      fail("INVALID_INPUT", "input.targetSpec must be an object");
    }
    normalized.targetSpec = rawInput.targetSpec;
  }
  return normalized;
}

function checkActionSpec(rawSpec) {
  checkUnknownFields(rawSpec, new Set(["actionRef", "targetTokenUuids", "input"]), "actions entry");
  const normalized = { actionRef: checkRef(rawSpec.actionRef, "actionRef") };
  if (rawSpec.targetTokenUuids !== undefined) {
    normalized.targetTokenUuids = checkTargetTokenUuids(rawSpec.targetTokenUuids, "targetTokenUuids");
  }
  if (rawSpec.input !== undefined) {
    normalized.input = checkActivityInput(rawSpec.input);
  }
  return normalized;
}

function validateExecuteActionInput(rawInput) {
  checkUnknownFields(rawInput, new Set([
    "requestId",
    "actionRef",
    "targetTokenUuids",
    "input",
    "actions",
    "resolution",
    "advance",
  ]), "arcane_execute_action input");
  if (!ID_PATTERN.test(rawInput.requestId ?? "")) {
    fail("INVALID_INPUT", "requestId is missing or invalid");
  }
  const normalized = { requestId: rawInput.requestId };
  if (rawInput.actionRef !== undefined) {
    normalized.actionRef = checkRef(rawInput.actionRef, "actionRef");
  }
  if (rawInput.targetTokenUuids !== undefined) {
    normalized.targetTokenUuids = checkTargetTokenUuids(rawInput.targetTokenUuids, "targetTokenUuids");
  }
  if (rawInput.input !== undefined) {
    normalized.input = checkActivityInput(rawInput.input);
  }
  if (rawInput.actions !== undefined) {
    if (!Array.isArray(rawInput.actions) || rawInput.actions.length < 1 || rawInput.actions.length > 20) {
      fail("INVALID_INPUT", "actions must contain 1-20 entries");
    }
    normalized.actions = rawInput.actions.map(checkActionSpec);
  }
  if (rawInput.resolution !== undefined) {
    if (!["auto", "narrative"].includes(rawInput.resolution)) {
      fail("INVALID_INPUT", "resolution must be auto or narrative");
    }
    normalized.resolution = rawInput.resolution;
  }
  if (rawInput.advance !== undefined) {
    if (typeof rawInput.advance !== "boolean") {
      fail("INVALID_INPUT", "advance must be a boolean");
    }
    normalized.advance = rawInput.advance;
  }
  if (normalized.actions && normalized.actionRef) {
    fail("INVALID_INPUT", "Specify a single action or a sequence, never both");
  }
  if (!normalized.actions && !normalized.actionRef) {
    fail("INVALID_INPUT", "Specify actionRef or actions");
  }
  return normalized;
}

function checkTargetSource(rawTarget) {
  checkUnknownFields(rawTarget, new Set(["kind", "tokenUuid", "name", "scope"]), "targets entry");
  const kind = rawTarget.kind;
  if (kind === "token") {
    if (rawTarget.name !== undefined || rawTarget.scope !== undefined) {
      fail("INVALID_INPUT", "token targets take tokenUuid only");
    }
    return { kind, tokenUuid: checkRef(rawTarget.tokenUuid, "tokenUuid") };
  }
  if (kind === "name") {
    if (rawTarget.tokenUuid !== undefined || rawTarget.scope !== "focus") {
      fail("INVALID_INPUT", "name targets take name and scope=focus");
    }
    return { kind, name: checkRef(rawTarget.name, "name"), scope: "focus" };
  }
  if (kind === "selected") {
    if (rawTarget.tokenUuid !== undefined || rawTarget.name !== undefined || rawTarget.scope !== undefined) {
      fail("INVALID_INPUT", "selected targets take no other field");
    }
    return { kind };
  }
  fail("INVALID_INPUT", "targets entry kind must be token, name, or selected");
}

function checkConditionKey(value) {
  // Condition keys are user-facing vocabulary: the Chinese alias table maps
  // them before dispatch, so they carry no ASCII pattern (Desktop parity).
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    fail("INVALID_INPUT", "conditions entry key is missing or invalid");
  }
  return value;
}

function validateConditionsInput(rawInput) {
  checkUnknownFields(rawInput, new Set(["requestId", "targets", "conditions"]), "arcane_conditions_set input");
  if (!ID_PATTERN.test(rawInput.requestId ?? "")) {
    fail("INVALID_INPUT", "requestId is missing or invalid");
  }
  if (!Array.isArray(rawInput.targets) || rawInput.targets.length < 1 || rawInput.targets.length > 20) {
    fail("INVALID_INPUT", "targets must contain 1-20 entries");
  }
  if (!Array.isArray(rawInput.conditions) || rawInput.conditions.length < 1 || rawInput.conditions.length > 8) {
    fail("INVALID_INPUT", "conditions must contain 1-8 entries");
  }
  return {
    requestId: rawInput.requestId,
    targets: rawInput.targets.map(checkTargetSource),
    conditions: rawInput.conditions.map((condition) => {
      checkUnknownFields(condition, new Set(["key", "active"]), "conditions entry");
      if (typeof condition.active !== "boolean") {
        fail("INVALID_INPUT", "conditions entry active must be a boolean");
      }
      return { key: checkConditionKey(condition.key), active: condition.active };
    }),
  };
}

function validatePlayContextInput(rawInput) {
  checkUnknownFields(rawInput, new Set(["view", "operationRef"]), "arcane_play_context input");
  const view = rawInput.view ?? "current";
  if (!["current", "turn", "operation"].includes(view)) {
    fail("INVALID_INPUT", "view must be current, turn, or operation");
  }
  if (view === "operation") {
    if (!ID_PATTERN.test(rawInput.operationRef ?? "")) {
      fail("INVALID_INPUT", "operationRef is required when view is operation");
    }
    return { view, operationRef: rawInput.operationRef };
  }
  if (rawInput.operationRef !== undefined) {
    fail("INVALID_INPUT", "operationRef is only valid with view=operation");
  }
  return { view };
}

/**
 * Desktop readPlay join, byte-parity: map stable action IDs to actionRefs via
 * the cached manual, filter narrative actions by remaining resource, and flag
 * whether the manual still matches the live contextRef.
 */
export function joinPlayContext(data, staticSnapshot) {
  const valid = !!staticSnapshot && data.contextRef === staticSnapshot.contextRef;
  const combatants = (data.combatants ?? []).map((token) => {
    const definitions = valid
      ? staticSnapshot.combatants.find((value) => value.tokenUuid === token.tokenUuid)?.actions ?? []
      : [];
    const available = new Set(token.availableActionIds ?? []);
    return {
      ...token,
      availableActionIds: definitions
        .filter((action) => action.resolution === "narrative"
          ? action.resource?.kind === "none"
            || Number(token.resources?.[action.resource?.key] ?? 0) > 0
          : available.has(action.id))
        .map((action) => action.actionRef),
    };
  });
  return { ...data, combatants, staticContextValid: valid };
}

/**
 * Port of Desktop normalizeFoundryWriteReceipt for the play actions (the
 * upload-image branch is unreachable here and intentionally omitted).
 */
export function normalizePlayWriteReceipt(value, { action, args } = {}) {
  if (!value || !["completed", "rejected", "partial", "indeterminate"].includes(value.status)) {
    return value;
  }
  if (value.status === "rejected") {
    return { ...value, message: value.message ?? value.code ?? "Request rejected before writing." };
  }
  let steps = value.steps;
  if (!Array.isArray(steps) && action === "executeAction") {
    const targets = [...new Set((args?.resolvedActions ?? [])
      .map((entry) => entry.sourceTokenUuid).filter(Boolean))];
    steps = [{
      step: "execute-action",
      targets,
      state: value.status === "completed" ? "completed" : "unknown",
      requested: args?.resolvedActions?.length ?? 0,
      ...(Number.isInteger(value.completed) ? { completed: value.completed } : {}),
      summary: value.status === "completed"
        ? "Native action execution confirmed; resulting combat state is read separately."
        : "Native execution is not fully confirmed; do not repeat the request.",
    }];
  }
  steps = (steps ?? []).map((step) => {
    const state = step.state === "not-started" ? "not_started" : step.state;
    return {
      ...step,
      targets: step.targets ?? [],
      state,
      summary: step.summary ?? (step.step !== undefined
        ? `${step.step}: ${state}`
        : [step.slot, step.label].filter(Boolean).join(" ")),
    };
  });
  return value.status === "completed"
    ? {
      ...value,
      steps,
      verification: value.verification ?? [{ kind: "native-execution", confirmed: true }],
      warnings: value.warnings ?? [],
    }
    : {
      ...value,
      steps,
      retry: false,
      message: value.message ?? "Execution is not fully confirmed; inspect this operation before any further action.",
    };
}

function interruptedResult(message) {
  return {
    status: "indeterminate",
    retry: false,
    code: "WEBMCP_PLAY_OPERATION_INTERRUPTED",
    message,
  };
}

export function createPlayTools({
  gameRef = globalThis.game,
  locationRef = globalThis.location,
  canvasRef = globalThis.canvas,
  runtime,
  ledger,
  clone = (value) => structuredClone(value),
} = {}) {
  let staticSnapshot = null;
  let turnSnapshot = null;
  let queue = Promise.resolve();

  function currentWorld() {
    const worldId = gameRef?.world?.id;
    const origin = locationRef?.origin;
    if (!WORLD_ID_PATTERN.test(worldId ?? "") || !origin) {
      fail("WORLD_UNAVAILABLE", "The current Foundry world is unavailable");
    }
    return { origin, id: worldId };
  }

  function liveSelectedTokenUuids() {
    return (canvasRef?.tokens?.controlled ?? [])
      .map((token) => token.document?.uuid)
      .filter(Boolean);
  }

  function resolveActions(specs) {
    const resolvedActions = [];
    for (const spec of specs) {
      let match;
      for (const token of staticSnapshot.combatants ?? []) {
        const action = (token.actions ?? []).find((value) => value.actionRef === spec.actionRef);
        if (action) {
          match = { token, action };
          break;
        }
      }
      if (!match) {
        fail(
          "ACTION_REFERENCE_UNKNOWN",
          `${spec.actionRef} is not in this page session's current static context`,
        );
      }
      resolvedActions.push({
        actionRef: match.action.actionRef,
        actionId: match.action.id,
        sourceTokenUuid: match.token.tokenUuid,
        actorUuid: match.token.actorUuid,
        itemId: match.action.itemId,
        activityId: match.action.activityId,
        ...(spec.targetTokenUuids ? { targetTokenUuids: spec.targetTokenUuids } : {}),
        ...(spec.input ? { input: spec.input } : {}),
      });
    }
    return resolvedActions;
  }

  function dispatchOperation({ requestId, world, action, fingerprint, args }) {
    const run = async () => normalizePlayWriteReceipt(
      await runtime(action, args, { requireGM: true }),
      { action, args },
    );
    return ledger.execute({ requestId, worldId: world.id, action, fingerprint, run });
  }

  return {
    async staticContext() {
      requireGm(gameRef);
      const data = await runtime("staticContext", {}, { requireGM: true });
      staticSnapshot = clone(data);
      turnSnapshot = null;
      return data;
    },

    async playContext(rawInput) {
      requireGm(gameRef);
      const input = validatePlayContextInput(rawInput);
      if (input.view === "operation") {
        const receipt = ledger.lookup(input.operationRef);
        return receipt ?? {
          status: "rejected",
          code: "OPERATION_NOT_FOUND",
          message: "Unknown play operation in this world",
        };
      }
      const data = await runtime("playContext", {}, { requireGM: true });
      if (input.view === "turn") turnSnapshot = clone(data);
      return joinPlayContext(data, staticSnapshot);
    },

    executeAction(rawInput) {
      requireGm(gameRef);
      const input = validateExecuteActionInput(rawInput);
      const world = currentWorld();
      const fingerprint = JSON.stringify({
        worldId: world.id,
        action: "executeAction",
        input,
      });
      const replayed = ledger.replay({ requestId: input.requestId, action: "executeAction", fingerprint });
      if (replayed) return replayed;

      if (!staticSnapshot) {
        fail(
          "STATIC_CONTEXT_REQUIRED",
          "Read arcane_static_context once in this page session before using abilities",
        );
      }
      const resolvedActions = resolveActions(input.actions ?? [input]);
      if (
        staticSnapshot.scope?.combatId
        && (!turnSnapshot || turnSnapshot.contextRef !== staticSnapshot.contextRef)
      ) {
        fail(
          "TURN_CONTEXT_REQUIRED",
          "Read arcane_play_context with view=turn before this combat action",
        );
      }
      const args = {
        world,
        contextRef: staticSnapshot.contextRef,
        turn: turnSnapshot?.turn ?? null,
        resolvedActions,
        resolution: input.resolution ?? "auto",
        advance: input.advance === true,
      };
      const dispatch = () => dispatchOperation({
        requestId: input.requestId,
        world,
        action: "executeAction",
        fingerprint,
        args,
      });
      const operation = queue.then(dispatch, dispatch);
      queue = operation.then(() => undefined, () => undefined);
      // Every combat execution invalidates the turn read, including failed or
      // interrupted ones; the next action must re-read the turn first.
      return operation.then((outcome) => {
        if (staticSnapshot?.scope?.combatId) turnSnapshot = null;
        return outcome;
      });
    },

    conditionsSet(rawInput) {
      requireGm(gameRef);
      const input = validateConditionsInput(rawInput);
      const world = currentWorld();
      const fingerprint = JSON.stringify({
        worldId: world.id,
        action: "conditionsSet",
        input,
      });
      const replayed = ledger.replay({ requestId: input.requestId, action: "conditionsSet", fingerprint });
      if (replayed) return replayed;

      const args = {
        targets: input.targets,
        conditions: input.conditions.map((condition) => ({
          ...condition,
          key: CONDITION_ALIASES[condition.key] ?? condition.key,
        })),
        mode: "combat",
        world,
        // No message-submission boundary exists in WebMCP: selected means the
        // canvas selection at call time, not at any earlier submit.
        selectedTokenUuids: liveSelectedTokenUuids(),
      };
      const dispatch = () => dispatchOperation({
        requestId: input.requestId,
        world,
        action: "conditionsSet",
        fingerprint,
        args,
      });
      const operation = queue.then(dispatch, dispatch);
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },

    stateForTesting() {
      return { staticSnapshot, turnSnapshot };
    },
  };
}

export { MODULE_ID };
