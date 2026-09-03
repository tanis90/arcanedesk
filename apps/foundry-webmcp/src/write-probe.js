export const MODULE_ID = "arcane-webmcp";
export const WRITE_PROBE_SETTING = "writeProbeState";
export const WRITE_PROBE_SCHEMA_VERSION = 2;
export const WRITE_PROBE_VALUES = Object.freeze(["idle", "armed"]);

const MAX_RECEIPTS = 20;
const MAX_RESPONSE_DELAY_MS = 10_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
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

function initialState() {
  return {
    schemaVersion: WRITE_PROBE_SCHEMA_VERSION,
    revision: 0,
    value: "idle",
    receipts: [],
  };
}

function cloneReceipt(receipt, fallbackWorldId) {
  return {
    requestId: receipt.requestId,
    worldId: receipt.worldId ?? fallbackWorldId,
    requestedValue: receipt.requestedValue,
    expectedRevision: receipt.expectedRevision,
    before: { ...receipt.before },
    after: { ...receipt.after },
    committedAt: receipt.committedAt,
  };
}

function validateReceipt(receipt, { legacy = false } = {}) {
  return (
    receipt &&
    REQUEST_ID_PATTERN.test(receipt.requestId) &&
    (legacy || WORLD_ID_PATTERN.test(receipt.worldId)) &&
    WRITE_PROBE_VALUES.includes(receipt.requestedValue) &&
    Number.isInteger(receipt.expectedRevision) &&
    Number.isInteger(receipt.before?.revision) &&
    WRITE_PROBE_VALUES.includes(receipt.before?.value) &&
    Number.isInteger(receipt.after?.revision) &&
    WRITE_PROBE_VALUES.includes(receipt.after?.value) &&
    typeof receipt.committedAt === "string"
  );
}

function validateState(value, worldId) {
  const legacy = value?.schemaVersion === 1;
  if (
    !value ||
    (!legacy && value.schemaVersion !== WRITE_PROBE_SCHEMA_VERSION) ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    !WRITE_PROBE_VALUES.includes(value.value) ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > MAX_RECEIPTS ||
    !value.receipts.every((receipt) => validateReceipt(receipt, { legacy }))
  ) {
    fail(
      "INVALID_PROBE_STATE",
      `Stored ${MODULE_ID}.${WRITE_PROBE_SETTING} data is invalid`,
    );
  }

  return {
    schemaVersion: WRITE_PROBE_SCHEMA_VERSION,
    revision: value.revision,
    value: value.value,
    receipts: value.receipts.map((receipt) => cloneReceipt(receipt, worldId)),
  };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_INPUT", "Input must be an object");
  }

  const allowed = new Set([
    "requestId",
    "expectedWorldId",
    "value",
    "expectedRevision",
    "simulateResponseDelayMs",
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail("INVALID_INPUT", `Unknown input field: ${unknown.join(", ")}`);
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId ?? "")) {
    fail(
      "INVALID_INPUT",
      "requestId must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  if (!WORLD_ID_PATTERN.test(input.expectedWorldId ?? "")) {
    fail(
      "INVALID_INPUT",
      "expectedWorldId must be 1-128 characters using letters, digits, underscore, or hyphen",
    );
  }
  if (!WRITE_PROBE_VALUES.includes(input.value)) {
    fail("INVALID_INPUT", "value must be either idle or armed");
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    fail("INVALID_INPUT", "expectedRevision must be a non-negative integer");
  }

  const simulateResponseDelayMs = input.simulateResponseDelayMs ?? 0;
  if (
    !Number.isInteger(simulateResponseDelayMs) ||
    simulateResponseDelayMs < 0 ||
    simulateResponseDelayMs > MAX_RESPONSE_DELAY_MS
  ) {
    fail(
      "INVALID_INPUT",
      `simulateResponseDelayMs must be an integer from 0 to ${MAX_RESPONSE_DELAY_MS}`,
    );
  }

  return {
    requestId: input.requestId,
    expectedWorldId: input.expectedWorldId,
    value: input.value,
    expectedRevision: input.expectedRevision,
    simulateResponseDelayMs,
  };
}

function publicState(state, gameRef) {
  return {
    moduleId: MODULE_ID,
    settingKey: WRITE_PROBE_SETTING,
    world: {
      id: gameRef.world.id,
      title: gameRef.world.title ?? null,
    },
    state,
  };
}

export function registerWriteProbeSetting({ gameRef = globalThis.game } = {}) {
  if (typeof gameRef?.settings?.register !== "function") {
    fail("SETTINGS_UNAVAILABLE", "Foundry settings registration is unavailable");
  }

  gameRef.settings.register(MODULE_ID, WRITE_PROBE_SETTING, {
    name: "Arcane WebMCP write probe state",
    hint: "Private test state used to validate WebMCP write safety and idempotency.",
    scope: "world",
    config: false,
    type: Object,
    default: initialState(),
  });
}

export function createWriteProbeStore({
  gameRef = globalThis.game,
  now = () => new Date().toISOString(),
  delay = (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
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
    const worldId = gameRef?.world?.id;
    if (!WORLD_ID_PATTERN.test(worldId ?? "")) {
      fail("WORLD_UNAVAILABLE", "The current Foundry world is unavailable");
    }
    return validateState(
      settings().get(MODULE_ID, WRITE_PROBE_SETTING),
      worldId,
    );
  }

  async function commit(input) {
    const worldId = gameRef?.world?.id;
    if (worldId !== input.expectedWorldId) {
      fail(
        "WORLD_MISMATCH",
        `Expected world ${input.expectedWorldId}, current world is ${worldId ?? "unavailable"}`,
      );
    }
    const state = readState();
    const existing = state.receipts.find(
      (receipt) => receipt.requestId === input.requestId,
    );

    if (existing) {
      if (
        existing.requestedValue !== input.value ||
        existing.expectedRevision !== input.expectedRevision ||
        existing.worldId !== input.expectedWorldId
      ) {
        fail(
          "IDEMPOTENCY_KEY_REUSE",
          "requestId was already committed with different arguments",
        );
      }
      return {
        ok: true,
        replayed: true,
        receipt: cloneReceipt(existing, worldId),
      };
    }

    if (state.revision !== input.expectedRevision) {
      fail(
        "REVISION_CONFLICT",
        `Expected revision ${input.expectedRevision}, current revision is ${state.revision}`,
      );
    }

    const receipt = {
      requestId: input.requestId,
      worldId,
      requestedValue: input.value,
      expectedRevision: input.expectedRevision,
      before: { revision: state.revision, value: state.value },
      after: { revision: state.revision + 1, value: input.value },
      committedAt: now(),
    };
    const nextState = {
      schemaVersion: WRITE_PROBE_SCHEMA_VERSION,
      revision: receipt.after.revision,
      value: receipt.after.value,
      receipts: [...state.receipts, receipt].slice(-MAX_RECEIPTS),
    };

    await settings().set(MODULE_ID, WRITE_PROBE_SETTING, nextState);

    const verified = readState();
    const verifiedReceipt = verified.receipts.find(
      (candidate) => candidate.requestId === input.requestId,
    );
    if (
      verified.revision !== receipt.after.revision ||
      verified.value !== receipt.after.value ||
      !verifiedReceipt
    ) {
      fail(
        "WRITE_NOT_VERIFIED",
        "Foundry returned without the expected persisted write receipt",
      );
    }

    return {
      ok: true,
      replayed: false,
      receipt: cloneReceipt(receipt, worldId),
    };
  }

  return {
    read() {
      requireGm(gameRef);
      return publicState(readState(), gameRef);
    },

    async write(rawInput) {
      requireGm(gameRef);
      const input = validateInput(rawInput);
      const operation = queue.then(
        () => commit(input),
        () => commit(input),
      );
      queue = operation.then(
        () => undefined,
        () => undefined,
      );

      const result = await operation;
      if (input.simulateResponseDelayMs > 0) {
        await delay(input.simulateResponseDelayMs);
      }
      return result;
    },
  };
}
