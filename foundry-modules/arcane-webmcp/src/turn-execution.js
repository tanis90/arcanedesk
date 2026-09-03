import { MODULE_ID } from "./write-probe.js";

export const TURN_EXECUTION_SETTING = "turnExecutionLedger";
export const TURN_EXECUTION_SCHEMA_VERSION = 1;

const MAX_RECORDS = 20;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const WORLD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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

function cloneJson(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function initialState() {
  return {
    schemaVersion: TURN_EXECUTION_SCHEMA_VERSION,
    records: [],
  };
}
function validateRecord(record) {
  return (
    record &&
    ID_PATTERN.test(record.requestId) &&
    typeof record.fingerprint === "string" &&
    WORLD_ID_PATTERN.test(record.worldId) &&
    ID_PATTERN.test(record.battleId) &&
    ID_PATTERN.test(record.actionId) &&
    ["started", "completed", "rejected", "partial", "indeterminate"].includes(
      record.status,
    ) &&
    typeof record.startedAt === "string" &&
    (record.settledAt === null || typeof record.settledAt === "string")
  );
}

function validateState(state) {
  if (
    !state ||
    state.schemaVersion !== TURN_EXECUTION_SCHEMA_VERSION ||
    !Array.isArray(state.records) ||
    state.records.length > MAX_RECORDS ||
    !state.records.every(validateRecord)
  ) {
    fail(
      "INVALID_EXECUTION_LEDGER",
      `Stored ${MODULE_ID}.${TURN_EXECUTION_SETTING} data is invalid`,
    );
  }
  return cloneJson(state);
}

function validateExpectedIdentity(input, identity, gameRef) {
  const comparisons = [
    ["expectedBridgeSessionId", identity.sessionId, "BRIDGE_SESSION_MISMATCH"],
    ["expectedModuleVersion", identity.moduleVersion, "MODULE_VERSION_MISMATCH"],
    ["expectedRuntimeVersion", identity.runtimeVersion, "RUNTIME_VERSION_MISMATCH"],
    ["expectedProtocolVersion", identity.protocolVersion, "PROTOCOL_VERSION_MISMATCH"],
    ["expectedRuntimeHash", identity.runtimeHash, "RUNTIME_HASH_MISMATCH"],
    ["expectedWorldId", gameRef?.world?.id, "WORLD_MISMATCH"],
  ];
  for (const [field, actual, code] of comparisons) {
    if (input[field] !== actual) {
      fail(
        code,
        `${field}=${String(input[field])} does not match current value ${String(actual)}`,
      );
    }
  }
}

function validateInput(rawInput, identity, gameRef) {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    fail("INVALID_INPUT", "Input must be an object");
  }
  const allowed = new Set([
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
  ]);
  const unknown = Object.keys(rawInput).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("INVALID_INPUT", `Unknown input field: ${unknown.join(", ")}`);
  }

  for (const field of [
    "requestId",
    "expectedBridgeSessionId",
    "expectedBattleId",
    "expectedSourceTokenId",
    "actionId",
  ]) {
    if (!ID_PATTERN.test(rawInput[field] ?? "")) {
      fail("INVALID_INPUT", `${field} is missing or invalid`);
    }
  }
  if (!WORLD_ID_PATTERN.test(rawInput.expectedWorldId ?? "")) {
    fail("INVALID_INPUT", "expectedWorldId is missing or invalid");
  }
  if (!Number.isInteger(rawInput.expectedRound) || rawInput.expectedRound < 0) {
    fail("INVALID_INPUT", "expectedRound must be a non-negative integer");
  }
  if (!Number.isInteger(rawInput.expectedTurnIndex) || rawInput.expectedTurnIndex < 0) {
    fail("INVALID_INPUT", "expectedTurnIndex must be a non-negative integer");
  }
  if (
    !Array.isArray(rawInput.targetTokenIds) ||
    rawInput.targetTokenIds.length < 1 ||
    rawInput.targetTokenIds.length > 8 ||
    rawInput.targetTokenIds.some((id) => !ID_PATTERN.test(id)) ||
    new Set(rawInput.targetTokenIds).size !== rawInput.targetTokenIds.length
  ) {
    fail(
      "INVALID_INPUT",
      "targetTokenIds must contain 1-8 unique valid token IDs",
    );
  }

  validateExpectedIdentity(rawInput, identity, gameRef);

  return {
    requestId: rawInput.requestId,
    expectedBattleId: rawInput.expectedBattleId,
    expectedRound: rawInput.expectedRound,
    expectedTurnIndex: rawInput.expectedTurnIndex,
    expectedSourceTokenId: rawInput.expectedSourceTokenId,
    actionId: rawInput.actionId,
    targetTokenIds: [...rawInput.targetTokenIds],
    worldId: rawInput.expectedWorldId,
  };
}
function fingerprint(input) {
  return JSON.stringify({
    worldId: input.worldId,
    battleId: input.expectedBattleId,
    round: input.expectedRound,
    turnIndex: input.expectedTurnIndex,
    sourceTokenId: input.expectedSourceTokenId,
    actionId: input.actionId,
    targetTokenIds: input.targetTokenIds,
  });
}

function interruptedResult(message) {
  return {
    status: "indeterminate",
    retry: false,
    code: "WEBMCP_EXECUTION_INTERRUPTED",
    message,
  };
}

export function registerTurnExecutionSetting({ gameRef = globalThis.game } = {}) {
  if (typeof gameRef?.settings?.register !== "function") {
    fail("SETTINGS_UNAVAILABLE", "Foundry settings registration is unavailable");
  }
  gameRef.settings.register(MODULE_ID, TURN_EXECUTION_SETTING, {
    name: "Arcane WebMCP turn execution ledger",
    hint: "Private receipts used to prevent duplicate WebMCP turn execution.",
    scope: "world",
    config: false,
    type: Object,
    default: initialState(),
  });
}

export function createTurnExecutor({
  gameRef = globalThis.game,
  runtime,
  identity,
  now = () => new Date().toISOString(),
} = {}) {
  let queue = Promise.resolve();

  function settings() {
    if (
      typeof gameRef?.settings?.get !== "function" ||
      typeof gameRef?.settings?.set !== "function"
    ) {
      fail("SETTINGS_UNAVAILABLE", "Foundry settings storage is unavailable");
    }
    return gameRef.settings;
  }

  function readState() {
    return validateState(settings().get(MODULE_ID, TURN_EXECUTION_SETTING));
  }

  async function persist(state) {
    await settings().set(MODULE_ID, TURN_EXECUTION_SETTING, state);
  }

  function publicResult(record, replayed) {
    if (record.status === "started") {
      return {
        requestId: record.requestId,
        replayed,
        result: interruptedResult(
          "The request started but has no terminal receipt. Inspect live turn state; do not execute it again.",
        ),
      };
    }
    return {
      requestId: record.requestId,
      replayed,
      result: cloneJson(record.result),
    };
  }

  async function begin(input) {
    const state = readState();
    const inputFingerprint = fingerprint(input);
    const existing = state.records.find(
      (record) => record.requestId === input.requestId,
    );
    if (existing) {
      if (existing.fingerprint !== inputFingerprint) {
        fail(
          "IDEMPOTENCY_KEY_REUSE",
          "requestId was already used for a different turn action",
        );
      }
      return { existing };
    }

    const turn = await runtime("turnContext", {}, { requireGM: true });
    if (turn?.ended === true || turn?.battleId !== input.expectedBattleId) {
      fail("TURN_MISMATCH", "The expected battle is not currently active");
    }
    if (
      turn.turn?.round !== input.expectedRound ||
      turn.turn?.index !== input.expectedTurnIndex ||
      turn.turn?.tokenId !== input.expectedSourceTokenId
    ) {
      fail(
        "TURN_MISMATCH",
        "The active round, turn index, or source token changed",
      );
    }
    if (!turn.actor?.availableActionIds?.includes(input.actionId)) {
      fail("ACTION_UNAVAILABLE", "actionId is not available to the active actor");
    }
    const combatantIds = new Set(
      (turn.combatants ?? []).map((combatant) => combatant.tokenId),
    );
    if (input.targetTokenIds.some((id) => !combatantIds.has(id))) {
      fail("TARGET_MISMATCH", "Every target must be a current combatant token");
    }

    if (state.records.length >= MAX_RECORDS) {
      const removable = state.records.findIndex(
        (record) => record.status !== "started",
      );
      if (removable < 0) {
        fail("EXECUTION_LEDGER_FULL", "No settled receipt can be evicted safely");
      }
      state.records.splice(removable, 1);
    }

    const record = {
      requestId: input.requestId,
      fingerprint: inputFingerprint,
      worldId: input.worldId,
      battleId: input.expectedBattleId,
      round: input.expectedRound,
      turnIndex: input.expectedTurnIndex,
      sourceTokenId: input.expectedSourceTokenId,
      actionId: input.actionId,
      targetTokenIds: [...input.targetTokenIds],
      status: "started",
      startedAt: now(),
      settledAt: null,
      result: null,
    };
    state.records.push(record);
    await persist(state);
    return { record };
  }

  async function settle(requestId, result) {
    const state = readState();
    const record = state.records.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!record) {
      fail(
        "EXECUTION_RECEIPT_LOST",
        "The start receipt disappeared before execution settled",
      );
    }
    record.status = ["completed", "rejected", "partial", "indeterminate"].includes(
      result?.status,
    )
      ? result.status
      : "indeterminate";
    record.settledAt = now();
    record.result = cloneJson(result);
    await persist(state);
    return record;
  }

  async function executeOnce(rawInput) {
    requireGm(gameRef);
    const input = validateInput(rawInput, identity, gameRef);
    const started = await begin(input);
    if (started.existing) return publicResult(started.existing, true);

    let result;
    try {
      result = await runtime(
        "executeTurn",
        {
          actionId: input.actionId,
          targetTokenIds: input.targetTokenIds,
          advance: false,
        },
        { requireGM: true },
      );
    } catch (error) {
      result = interruptedResult(String(error?.message ?? error));
    }

    try {
      const record = await settle(input.requestId, result);
      return publicResult(record, false);
    } catch (error) {
      return {
        requestId: input.requestId,
        replayed: false,
        result: interruptedResult(
          `Execution returned but its terminal receipt could not be persisted: ${String(error?.message ?? error)}`,
        ),
      };
    }
  }

  return {
    read() {
      requireGm(gameRef);
      return {
        moduleId: MODULE_ID,
        settingKey: TURN_EXECUTION_SETTING,
        world: {
          id: gameRef?.world?.id ?? null,
          title: gameRef?.world?.title ?? null,
        },
        state: readState(),
      };
    },

    execute(rawInput) {
      const operation = queue.then(
        () => executeOnce(rawInput),
        () => executeOnce(rawInput),
      );
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}
