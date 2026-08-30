import {
  FOUNDRY_SDK_ERROR_CODES,
  FoundrySdkError,
  SAFE_DIRECT_ACTIONS,
  isWriteDirectAction,
  type DirectAction,
  type DirectActionInterruption,
  type ExecuteTurnReceipt,
  type FoundryActionInput,
  type FoundryActionOutput,
  type RuntimeArguments,
  type RuntimeStatus,
  type SafeDirectAction,
  type WriteDirectAction,
  type WorldInfo,
} from "./contracts.js";
import { runtimeFunction as defaultRuntimeFunction } from "./runtime-source.js";

export const DEFAULT_READY_TIMEOUT_MS = 90_000;
export const DEFAULT_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 120_000;
export const DEFAULT_READY_POLL_MS = 250;

export interface FoundryPageState {
  url?: string | null;
  path?: string | null;
  detected?: boolean;
  ready?: boolean;
  gm?: boolean;
  user?: unknown;
  world?: unknown;
  [key: string]: unknown;
}

export type FoundryInspectionOutcome =
  | { ok: true; state: FoundryPageState; status?: string }
  | { ok: false; status?: string; error?: string; state?: FoundryPageState };

export type FoundryEvaluationOutcome<Value = unknown> =
  | { status: "completed"; value: Value }
  | { status: "navigated"; url?: string | null }
  | { status: "aborted" }
  | { status: "timeout"; timeoutMs?: number | null }
  | { status: "error"; error?: string };

export interface FoundryTransportOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Transport boundary implemented by a consumer. Context can be an Electron
 * WebContents, a CDP session, a browser automation page, or any equivalent
 * execution handle. The SDK itself has no Electron/CDP/WebSocket dependency.
 */
export interface FoundryTransport<Context = unknown> {
  acquire(): Context | null | Promise<Context | null>;
  isAvailable?(context: Context): boolean;
  inspect(
    context: Context,
    options: FoundryTransportOptions,
  ): Promise<FoundryInspectionOutcome>;
  evaluate(
    context: Context,
    expression: string,
    options: FoundryTransportOptions,
  ): Promise<FoundryEvaluationOutcome>;
}

export interface FoundryRuntimeCallOptions {
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  executionTimeoutMs?: number;
}

export interface FoundryRuntimeCallResultRecord {
  action: string;
  phase: "preflight" | "dispatched";
  status: "completed" | RuntimeStatus;
  receipt: "none" | "completed" | "rejected" | "partial" | "indeterminate";
  durationMs: number;
  errorCode: string | null;
}

export interface FoundryRuntimeClientOptions<Context> {
  transport: FoundryTransport<Context>;
  runtimeSource?: string;
  allowedActions?: readonly DirectAction[];
  requireGM?: boolean;
  readyPollMs?: number;
  log?: (level: "warn", message: string, details?: unknown) => void;
  onCallResult?: (record: FoundryRuntimeCallResultRecord) => void;
}

interface DispatchMarker {
  dispatched: boolean;
}

function toNonNegativeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new FoundrySdkError(
      FOUNDRY_SDK_ERROR_CODES.INVALID_TIMEOUT,
      "Runtime timeout must be a non-negative finite number",
      { value },
    );
  }
  return Math.floor(number);
}

function abortError(phase: "preflight" | "dispatched" = "preflight"): FoundrySdkError {
  return new FoundrySdkError(
    FOUNDRY_SDK_ERROR_CODES.ABORTED,
    phase === "dispatched"
      ? "Foundry runtime read was aborted after dispatch"
      : "Foundry runtime call was aborted before dispatch",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function waitForPoll(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, timeoutMs);
    const onAbort = (): void => finish(abortError());

    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    function finish(error?: FoundrySdkError): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function serializeRuntimeValue(value: unknown, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new FoundrySdkError(
      FOUNDRY_SDK_ERROR_CODES.INVALID_ARGUMENTS,
      `Could not serialize ${label} for the Foundry runtime`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  if (serialized === undefined) {
    throw new FoundrySdkError(
      FOUNDRY_SDK_ERROR_CODES.INVALID_ARGUMENTS,
      `Could not serialize ${label} for the Foundry runtime`,
    );
  }

  return serialized.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

export function buildRuntimeExpression(
  source: string,
  action: DirectAction,
  args: RuntimeArguments,
  options: { requireGM: boolean; timeoutMs: number },
): string {
  return `(${source})(`
    + `${serializeRuntimeValue(action, "action")},`
    + `${serializeRuntimeValue(args, "arguments")},`
    + `${serializeRuntimeValue(options, "options")}`
    + ")";
}

function isFoundryGamePath(state: FoundryPageState): boolean {
  const path = String(state.path ?? "").replace(/\/+$/, "");
  return path === "/game";
}

function inspectFailureMessage(inspected: FoundryInspectionOutcome | null): string {
  if (inspected && "error" in inspected && inspected.error) return String(inspected.error);
  if (inspected?.status) return `page inspection ended with status ${inspected.status}`;
  return "page inspection did not return Foundry state";
}

function readOutcomeError(outcome: FoundryEvaluationOutcome): FoundrySdkError {
  switch (outcome.status) {
    case "navigated":
      return new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.NAVIGATED,
        "Foundry navigated while the runtime read was in progress",
        { url: outcome.url ?? null },
      );
    case "aborted":
      return abortError("dispatched");
    case "timeout":
      return new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.TIMEOUT,
        "Foundry runtime read timed out",
        { timeoutMs: outcome.timeoutMs ?? null },
      );
    case "error":
      return new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.EVALUATION_FAILED,
        outcome.error
          ? `Foundry runtime read failed: ${outcome.error}`
          : "Foundry runtime read failed",
      );
    default:
      return new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.EVALUATION_FAILED,
        "Foundry runtime read returned an unknown outcome",
      );
  }
}

function runtimeStatusForOutcome(outcome: FoundryEvaluationOutcome): RuntimeStatus {
  return outcome.status === "completed" ? "error" : outcome.status;
}

function indeterminateMessage(
  action: WriteDirectAction,
  outcome: FoundryEvaluationOutcome,
): string {
  switch (outcome.status) {
    case "navigated":
      return `Foundry navigated after ${action} was dispatched; the result cannot be determined safely.`;
    case "aborted":
      return `The request was stopped after ${action} was dispatched; the result cannot be determined safely.`;
    case "timeout":
      return `${action} timed out after dispatch; the result cannot be determined safely.`;
    case "error":
      return outcome.error
        ? `Foundry ${action} execution was interrupted after dispatch: ${outcome.error}`
        : `Foundry ${action} execution was interrupted after dispatch; the result cannot be determined safely.`;
    default:
      return `Foundry execution ended unexpectedly after ${action} was dispatched; the result cannot be determined safely.`;
  }
}

function interruptedReceipt(outcome: FoundryEvaluationOutcome): ExecuteTurnReceipt {
  return {
    status: "indeterminate",
    retry: false,
    code: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
    runtimeStatus: runtimeStatusForOutcome(outcome),
    message: indeterminateMessage("executeTurn", outcome),
  };
}

function interruptedWriteError(
  action: WriteDirectAction,
  outcome: FoundryEvaluationOutcome,
): FoundrySdkError {
  const details: DirectActionInterruption = {
    status: "indeterminate",
    retry: false,
    code: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
    action,
    runtimeStatus: runtimeStatusForOutcome(outcome),
    message: indeterminateMessage(action, outcome),
  };
  return new FoundrySdkError(
    FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
    details.message,
    details,
  );
}

function isExecuteTurnReceipt(value: unknown): value is ExecuteTurnReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  if (!["completed", "rejected", "partial", "indeterminate"].includes(String(receipt.status))) {
    return false;
  }
  if (receipt.status === "partial" || receipt.status === "indeterminate") {
    return receipt.retry === false;
  }
  return true;
}

function protocolViolationReceipt(value: unknown): ExecuteTurnReceipt {
  return {
    status: "indeterminate",
    retry: false,
    code: FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED,
    runtimeStatus: "error",
    message: "executeTurn returned an invalid receipt after dispatch; the result cannot be determined safely.",
  };
}

/**
 * Transport-neutral direct-runtime client. Calls are globally serialized per
 * instance. Interruptions after the dispatch boundary are always marked
 * non-retryable for write actions. executeTurn retains its typed receipt;
 * other write actions reject with a stable error carrying interruption data.
 */
export class FoundryRuntimeClient<Context = unknown> {
  readonly #transport: FoundryTransport<Context>;
  readonly #runtimeSource: string;
  readonly #allowedActions: ReadonlySet<DirectAction>;
  readonly #requireGM: boolean;
  readonly #readyPollMs: number;
  readonly #log: (level: "warn", message: string, details?: unknown) => void;
  readonly #onCallResult: ((record: FoundryRuntimeCallResultRecord) => void) | null;
  #queue: Promise<unknown> = Promise.resolve();
  #lastWorldInfo: WorldInfo | null = null;

  constructor(options: FoundryRuntimeClientOptions<Context>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("FoundryRuntimeClient options are required");
    }
    if (!options.transport || typeof options.transport.acquire !== "function") {
      throw new TypeError("transport.acquire must be a function");
    }
    if (typeof options.transport.inspect !== "function") {
      throw new TypeError("transport.inspect must be a function");
    }
    if (typeof options.transport.evaluate !== "function") {
      throw new TypeError("transport.evaluate must be a function");
    }

    const source = options.runtimeSource ?? defaultRuntimeFunction;
    if (typeof source !== "string" || !source.trim()) {
      throw new TypeError("runtimeSource must be a non-empty string");
    }
    const pollMs = Number(options.readyPollMs ?? DEFAULT_READY_POLL_MS);
    if (!Number.isFinite(pollMs) || pollMs < 0) {
      throw new TypeError("readyPollMs must be a non-negative finite number");
    }

    this.#transport = options.transport;
    this.#runtimeSource = source;
    this.#allowedActions = new Set(options.allowedActions ?? SAFE_DIRECT_ACTIONS);
    this.#requireGM = options.requireGM !== false;
    this.#readyPollMs = Math.floor(pollMs);
    this.#log = options.log ?? (() => undefined);
    this.#onCallResult = options.onCallResult ?? null;
  }

  get lastWorldInfo(): WorldInfo | null {
    return this.#lastWorldInfo;
  }

  invalidate(): void {
    this.#lastWorldInfo = null;
  }

  call<Action extends SafeDirectAction>(
    action: Action,
    args: FoundryActionInput<Action>,
    options?: FoundryRuntimeCallOptions,
  ): Promise<FoundryActionOutput<Action>>;
  call<Output = unknown>(
    action: DirectAction,
    args?: RuntimeArguments,
    options?: FoundryRuntimeCallOptions,
  ): Promise<Output>;
  call<Output = unknown>(
    action: DirectAction,
    args: RuntimeArguments = {},
    options: FoundryRuntimeCallOptions = {},
  ): Promise<Output> {
    const marker: DispatchMarker = { dispatched: false };
    const startedMs = Date.now();
    const run = this.#queue.then(() => this.#callSerial(action, args, options, marker)) as Promise<Output>;
    this.#queue = run.catch(() => undefined);

    if (!this.#onCallResult) return run;
    return run.then(
      (value) => {
        this.#notifyResult(action, marker, startedMs, { value });
        return value;
      },
      (error: unknown) => {
        this.#notifyResult(action, marker, startedMs, { error });
        throw error;
      },
    );
  }

  #notifyResult(
    action: DirectAction,
    marker: DispatchMarker,
    startedMs: number,
    outcome: { value?: unknown; error?: unknown },
  ): void {
    const record: FoundryRuntimeCallResultRecord = {
      action,
      phase: marker.dispatched ? "dispatched" : "preflight",
      status: "completed",
      receipt: "none",
      durationMs: Date.now() - startedMs,
      errorCode: outcome.error instanceof FoundrySdkError ? outcome.error.code : null,
    };

    if (outcome.error) {
      const code = outcome.error instanceof FoundrySdkError ? outcome.error.code : "";
      const details = outcome.error instanceof FoundrySdkError
        && outcome.error.details
        && typeof outcome.error.details === "object"
        ? outcome.error.details as Partial<DirectActionInterruption>
        : null;
      if (
        code === FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED
        && details?.status === "indeterminate"
        && details.retry === false
      ) {
        record.receipt = "indeterminate";
        record.status = ["error", "aborted", "timeout", "navigated"]
          .includes(String(details.runtimeStatus))
          ? details.runtimeStatus as RuntimeStatus
          : "error";
      } else {
        record.status = code === FOUNDRY_SDK_ERROR_CODES.ABORTED
          ? "aborted"
          : code === FOUNDRY_SDK_ERROR_CODES.TIMEOUT
            ? "timeout"
            : code === FOUNDRY_SDK_ERROR_CODES.NAVIGATED
              ? "navigated"
              : "error";
      }
    } else if (action === "executeTurn") {
      const receipt = (outcome.value as { status?: unknown } | undefined)?.status;
      if (["completed", "rejected", "partial", "indeterminate"].includes(String(receipt))) {
        record.receipt = receipt as FoundryRuntimeCallResultRecord["receipt"];
        if (receipt === "indeterminate") {
          const value = outcome.value as { runtimeStatus?: unknown; code?: unknown };
          record.status = ["error", "aborted", "timeout", "navigated"].includes(String(value.runtimeStatus))
            ? value.runtimeStatus as RuntimeStatus
            : "error";
          record.errorCode = value.code ? String(value.code) : FOUNDRY_SDK_ERROR_CODES.RUNTIME_INTERRUPTED;
        }
      } else {
        record.status = "error";
        record.errorCode = FOUNDRY_SDK_ERROR_CODES.PROTOCOL_VIOLATION;
      }
    }

    try {
      this.#onCallResult?.(record);
    } catch {
      // Observability must never alter a runtime result.
    }
  }

  async #callSerial(
    action: DirectAction,
    args: RuntimeArguments,
    options: FoundryRuntimeCallOptions,
    marker: DispatchMarker,
  ): Promise<unknown> {
    if (!this.#allowedActions.has(action)) {
      throw new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.ACTION_UNSUPPORTED,
        `Unsupported Foundry runtime action: ${String(action)}`,
        { action },
      );
    }

    throwIfAborted(options.signal);
    const readyTimeout = toNonNegativeTimeout(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    const executionTimeout = toNonNegativeTimeout(
      options.executionTimeoutMs,
      isWriteDirectAction(action) ? DEFAULT_WRITE_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS,
    );
    const context = await this.#preflight(options.signal, readyTimeout);
    throwIfAborted(options.signal);

    const expression = buildRuntimeExpression(this.#runtimeSource, action, args, {
      requireGM: this.#requireGM,
      timeoutMs: executionTimeout,
    });
    throwIfAborted(options.signal);

    let outcome: FoundryEvaluationOutcome;
    try {
      marker.dispatched = true;
      outcome = await this.#transport.evaluate(context, expression, {
        timeoutMs: executionTimeout,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      outcome = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.status === "completed") {
      if (action === "executeTurn") {
        if (!isExecuteTurnReceipt(outcome.value)) {
          this.#warn("executeTurn returned an invalid receipt", { value: outcome.value });
          return protocolViolationReceipt(outcome.value);
        }
        return outcome.value;
      }
      if (action === "worldInfo") this.#lastWorldInfo = outcome.value as WorldInfo;
      return outcome.value;
    }

    if (action === "executeTurn") {
      this.#warn("executeTurn became indeterminate after dispatch", outcome);
      return interruptedReceipt(outcome);
    }

    if (isWriteDirectAction(action)) {
      this.#warn(`${action} became indeterminate after dispatch`, outcome);
      throw interruptedWriteError(action, outcome);
    }

    throw readOutcomeError(outcome);
  }

  #warn(message: string, details: unknown): void {
    try {
      this.#log("warn", message, details);
    } catch {
      // Logging must never alter the safety receipt.
    }
  }

  async #preflight(signal: AbortSignal | undefined, readyTimeoutMs: number): Promise<Context> {
    const deadline = Date.now() + readyTimeoutMs;
    let lastInspection: FoundryInspectionOutcome | null = null;
    let lastState: FoundryPageState | null = null;

    while (true) {
      throwIfAborted(signal);
      const context = await this.#transport.acquire();
      let available = context !== null;
      if (available && this.#transport.isAvailable) {
        try {
          available = this.#transport.isAvailable(context as Context);
        } catch {
          available = false;
        }
      }
      if (context === null || !available) {
        throw new FoundrySdkError(
          FOUNDRY_SDK_ERROR_CODES.TRANSPORT_UNAVAILABLE,
          "Foundry transport is not available",
        );
      }

      const remainingMs = Math.max(0, deadline - Date.now());
      let inspected: FoundryInspectionOutcome;
      try {
        inspected = await this.#transport.inspect(context, {
          timeoutMs: Math.max(1, Math.min(3_000, remainingMs || 1)),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        inspected = {
          ok: false,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      lastInspection = inspected;

      if (inspected.status === "aborted" || signal?.aborted) throw abortError();

      if (inspected.ok) {
        const state = inspected.state;
        lastState = state;

        if (!isFoundryGamePath(state)) {
          throw new FoundrySdkError(
            FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_GAME,
            "Foundry is not currently on a /game page",
            { url: state.url ?? null, path: state.path ?? null },
          );
        }

        if (state.detected && state.ready && (state.gm || !this.#requireGM)) return context;

        if (state.ready && !state.gm && this.#requireGM) {
          throw new FoundrySdkError(
            FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_GM,
            "The active Foundry user is not a GM",
            { user: state.user ?? null, world: state.world ?? null },
          );
        }
      }

      const now = Date.now();
      if (now >= deadline) break;
      await waitForPoll(Math.min(this.#readyPollMs, deadline - now), signal);
    }

    if (lastState && !lastState.detected) {
      throw new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_DETECTED,
        "The /game page did not initialize as Foundry before the ready timeout",
        { url: lastState.url ?? null },
      );
    }
    if (lastState) {
      throw new FoundrySdkError(
        FOUNDRY_SDK_ERROR_CODES.FOUNDRY_NOT_READY,
        "Foundry did not become ready before the ready timeout",
        { world: lastState.world ?? null, readyTimeoutMs },
      );
    }
    throw new FoundrySdkError(
      FOUNDRY_SDK_ERROR_CODES.INSPECTION_FAILED,
      `Could not inspect the Foundry page: ${inspectFailureMessage(lastInspection)}`,
      { readyTimeoutMs },
    );
  }
}

/** Historical product name retained as a source-compatible class alias. */
export { FoundryRuntimeClient as DirectFoundryRuntime };
