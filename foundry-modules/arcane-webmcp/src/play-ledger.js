import { MODULE_ID } from "./write-probe.js";

export const PLAY_LEDGER_SETTING = "playOperationLedger";
export const PLAY_LEDGER_SCHEMA_VERSION = 1;

const MAX_RECORDS = 20;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const WORLD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LEDGER_ACTIONS = Object.freeze(["executeAction", "conditionsSet"]);
const LEDGER_STATUSES = Object.freeze([
  "started",
  "completed",
  "rejected",
  "partial",
  "indeterminate",
]);

function fail(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  throw error;
}

function cloneJson(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function initialState() {
  return {
    schemaVersion: PLAY_LEDGER_SCHEMA_VERSION,
    records: [],
  };
}

function validateRecord(record) {
  return (
    record &&
    ID_PATTERN.test(record.requestId) &&
    typeof record.fingerprint === "string" &&
    WORLD_ID_PATTERN.test(record.worldId) &&
    LEDGER_ACTIONS.includes(record.action) &&
    LEDGER_STATUSES.includes(record.status) &&
    typeof record.startedAt === "string" &&
    (record.settledAt === null || typeof record.settledAt === "string") &&
    (record.status === "started" ? record.result === null : true)
  );
}

function validateState(state) {
  if (
    !state ||
    state.schemaVersion !== PLAY_LEDGER_SCHEMA_VERSION ||
    !Array.isArray(state.records) ||
    state.records.length > MAX_RECORDS ||
    !state.records.every(validateRecord)
  ) {
    fail(
      "INVALID_PLAY_LEDGER",
      `Stored ${MODULE_ID}.${PLAY_LEDGER_SETTING} data is invalid`,
    );
  }
  return cloneJson(state);
}

function uncertain(requestId, message) {
  return {
    status: "indeterminate",
    operationRef: requestId,
    retry: false,
    steps: [],
    message:
      message ??
      "The operation was dispatched but its final result is unknown. Do not retry.",
  };
}

function publicResult(record, replayed) {
  if (record.status === "started") {
    return {
      requestId: record.requestId,
      replayed,
      result: uncertain(
        record.requestId,
        "The request started but has no terminal receipt. Inspect live state; do not execute it again.",
      ),
    };
  }
  return {
    requestId: record.requestId,
    replayed,
    result: cloneJson(record.result),
  };
}

export function registerPlayLedgerSetting({ gameRef = globalThis.game } = {}) {
  if (typeof gameRef?.settings?.register !== "function") {
    fail("SETTINGS_UNAVAILABLE", "Foundry settings registration is unavailable");
  }
  gameRef.settings.register(MODULE_ID, PLAY_LEDGER_SETTING, {
    name: "Arcane WebMCP play operation ledger",
    hint: "Private receipts used to prevent duplicate WebMCP play operations.",
    scope: "world",
    config: false,
    type: Object,
    default: initialState(),
  });
}

/**
 * World-scoped durable receipt ledger shared by the play write tools. Mirrors
 * the Desktop FoundryOperationStore contract (replay by identity fingerprint,
 * dispatch journal persisted before execution, never replay after restart)
 * using the module's private Foundry setting like the turn ledger.
 */
export function createPlayLedger({
  gameRef = globalThis.game,
  now = () => new Date().toISOString(),
} = {}) {
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
    return validateState(settings().get(MODULE_ID, PLAY_LEDGER_SETTING));
  }

  async function persist(state) {
    await settings().set(MODULE_ID, PLAY_LEDGER_SETTING, state);
  }

  /**
   * Replay lookup before any guard or dispatch: same requestId with the same
   * fingerprint returns the stored receipt; a different fingerprint fails
   * closed. Returns null when this requestId was never used.
   */
  function replay({ requestId, action, fingerprint }) {
    const state = readState();
    const existing = state.records.find(
      (record) => record.requestId === requestId,
    );
    if (!existing) return null;
    if (existing.action !== action || existing.fingerprint !== fingerprint) {
      fail(
        "IDEMPOTENCY_KEY_REUSE",
        "requestId was already used for a different play operation",
      );
    }
    return publicResult(existing, true);
  }

  /** Resolve an operationRef (the requestId) to its durable receipt. */
  function lookup(requestId) {
    const state = readState();
    const record = state.records.find(
      (candidate) => candidate.requestId === requestId,
    );
    if (!record) return null;
    return record.status === "started"
      ? uncertain(requestId)
      : cloneJson(record.result);
  }

  /** Caller validates everything else; this owns journaling and settling. */
  async function execute({ requestId, worldId, action, fingerprint, run }) {
    const state = readState();
    const existing = state.records.find(
      (record) => record.requestId === requestId,
    );
    if (existing) {
      // The executor checked replay first with the raw-input fingerprint; a
      // record here means the fingerprint matched, so answer from storage.
      return publicResult(existing, true);
    }

    if (state.records.length >= MAX_RECORDS) {
      const removable = state.records.findIndex(
        (record) => record.status !== "started",
      );
      if (removable < 0) {
        fail("PLAY_LEDGER_FULL", "No settled receipt can be evicted safely");
      }
      state.records.splice(removable, 1);
    }

    const record = {
      requestId,
      fingerprint,
      worldId,
      action,
      status: "started",
      startedAt: now(),
      settledAt: null,
      result: null,
    };
    state.records.push(record);
    await persist(state);

    let result;
    try {
      result = await run();
    } catch (error) {
      result = uncertain(requestId, String(error?.message ?? error));
    }

    if (
      !result ||
      typeof result !== "object" ||
      !LEDGER_STATUSES.slice(1).includes(result.status)
    ) {
      result = uncertain(
        requestId,
        "Runtime returned no valid completion receipt. Do not retry.",
      );
    }

    try {
      const settled = readState();
      const target = settled.records.find(
        (candidate) => candidate.requestId === requestId,
      );
      if (!target) {
        fail(
          "PLAY_RECEIPT_LOST",
          "The dispatch receipt disappeared before the operation settled",
        );
      }
      target.status = result.status;
      target.settledAt = now();
      target.result = cloneJson(result);
      await persist(settled);
      return publicResult(target, false);
    } catch (error) {
      return {
        requestId,
        replayed: false,
        result: uncertain(
          requestId,
          `The operation returned but its terminal receipt could not be persisted: ${String(error?.message ?? error)}`,
        ),
      };
    }
  }

  return {
    replay,
    lookup,
    execute,
    readStateForTesting: readState,
  };
}
