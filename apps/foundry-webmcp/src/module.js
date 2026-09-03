import {
  protocolVersion,
  runtimeFunction,
  runtimeHash,
  runtimeVersion,
} from "@arcanedesk/foundry-sdk/runtime";
import packageJson from "../package.json" with { type: "json" };
import { compileRuntime, registerArcaneWebMcp } from "./webmcp.js";
import {
  createWriteProbeStore,
  MODULE_ID,
  registerWriteProbeSetting,
} from "./write-probe.js";
import {
  createTurnExecutor,
  registerTurnExecutionSetting,
} from "./turn-execution.js";

const MODULE_VERSION = packageJson.version;
const MAX_ATTEMPTS = 40;
const RETRY_DELAY_MS = 250;
let writeProbeStore;
let turnExecutor;
const BRIDGE_SESSION_ID =
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const PAGE_LOADED_AT = new Date().toISOString();

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function publishDiagnostic(result, extra = {}) {
  const diagnostic = {
    moduleId: MODULE_ID,
    moduleVersion: MODULE_VERSION,
    runtimeVersion,
    protocolVersion,
    runtimeHash,
    bridgeSessionId: BRIDGE_SESSION_ID,
    pageLoadedAt: PAGE_LOADED_AT,
    ...result,
    ...extra,
  };
  globalThis.arcaneWebMcp = diagnostic;
  return diagnostic;
}

async function start() {
  let runtime;
  try {
    runtime = compileRuntime(runtimeFunction);
  } catch (error) {
    const diagnostic = publishDiagnostic(
      { status: "failed", reason: "runtime-compilation-failed", tools: [] },
      { error: String(error?.message ?? error) },
    );
    console.error(`[${MODULE_ID}] Arcane SDK runtime compilation failed`, error);
    return diagnostic;
  }

  const sdkMetadata = { runtimeVersion, protocolVersion, runtimeHash };
  const bridgeIdentity = {
    sessionId: BRIDGE_SESSION_ID,
    pageLoadedAt: PAGE_LOADED_AT,
    moduleVersion: MODULE_VERSION,
    ...sdkMetadata,
  };
  turnExecutor = createTurnExecutor({ runtime, identity: bridgeIdentity });
  let result;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      result = await registerArcaneWebMcp({
        runtime,
        sdkMetadata,
        moduleVersion: MODULE_VERSION,
        writeProbeStore,
        turnExecutor,
        bridgeIdentity,
      });
    } catch (error) {
      const diagnostic = publishDiagnostic(
        { status: "failed", reason: "tool-registration-failed", tools: [] },
        { attempt, error: String(error?.message ?? error) },
      );
      console.error(`[${MODULE_ID}] WebMCP tool registration failed`, error);
      return diagnostic;
    }

    if (result.status === "registered") {
      const diagnostic = publishDiagnostic(result, { attempt });
      console.info(
        `[${MODULE_ID}] registered Site tools: ${result.tools.join(", ")}`,
      );
      globalThis.ui?.notifications?.info?.(
        `Arcane WebMCP ready: ${result.tools.length} tools (1 guarded test write)`,
      );
      return diagnostic;
    }

    if (result.reason !== "webmcp-api-missing") break;
    await delay(RETRY_DELAY_MS);
  }

  const diagnostic = publishDiagnostic(result ?? {
    status: "unsupported",
    reason: "unknown",
    tools: [],
  });
  console.info(
    `[${MODULE_ID}] Site tools unavailable: ${diagnostic.reason}`,
  );
  return diagnostic;
}

Hooks.once("init", () => {
  try {
    registerWriteProbeSetting();
    registerTurnExecutionSetting();
    writeProbeStore = createWriteProbeStore();
  } catch (error) {
    publishDiagnostic(
      { status: "failed", reason: "write-probe-initialization-failed", tools: [] },
      { error: String(error?.message ?? error) },
    );
    console.error(`[${MODULE_ID}] write probe initialization failed`, error);
  }
});

Hooks.once("ready", () => {
  if (writeProbeStore) void start();
});

export { start };
