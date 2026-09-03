const EMPTY_OBJECT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});

export function compileRuntime(runtimeSource, FunctionConstructor = Function) {
  if (typeof runtimeSource !== "string" || !runtimeSource.includes("async function")) {
    throw new TypeError("Arcane SDK runtimeFunction is invalid");
  }

  const factory = new FunctionConstructor(
    `"use strict"; return (${runtimeSource});`,
  );
  const runtime = factory();
  if (typeof runtime !== "function") {
    throw new TypeError("Arcane SDK runtimeFunction did not compile to a function");
  }
  return runtime;
}

function foundrySummary(gameRef) {
  return {
    ready: gameRef?.ready === true,
    foundryVersion: gameRef?.version ?? null,
    world: gameRef?.world
      ? { id: gameRef.world.id, title: gameRef.world.title }
      : null,
    system: gameRef?.system
      ? {
          id: gameRef.system.id,
          title: gameRef.system.title,
          version: gameRef.system.version,
        }
      : null,
    user: gameRef?.user
      ? {
          id: gameRef.user.id,
          name: gameRef.user.name,
          isGM: gameRef.user.isGM === true,
        }
      : null,
  };
}

export function createToolDefinitions({
  gameRef,
  locationRef,
  runtime,
  sdkMetadata,
  moduleVersion,
  writeProbeStore,
  turnExecutor,
  bridgeIdentity,
}) {
  return [
    {
      name: "arcane_probe",
      description:
        "Read a small diagnostic snapshot proving that Arcane WebMCP is attached to this top-level Foundry page and current session.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => ({
        ok: true,
        bridge: "arcane-webmcp-fvtt",
        bridgeSession: bridgeIdentity,
        moduleVersion,
        sdk: sdkMetadata,
        page: {
          href: locationRef?.href ?? null,
        },
        foundry: foundrySummary(gameRef),
      }),
    },
    {
      name: "arcane_world_info",
      description:
        "Read Foundry world, system, user, and key module status through the Arcane Foundry SDK runtime. Requires the current Foundry user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => runtime("worldInfo", {}, { requireGM: true }),
    },
    {
      name: "arcane_battle_context",
      description:
        "Read the active Foundry combat roster and agent-callable action catalog through Arcane Turn Protocol v2. Requires the current Foundry user to be a GM and fails when no combat is active.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => runtime("battleContext", {}, { requireGM: true }),
    },
    {
      name: "arcane_turn_context",
      description:
        "Read the current Foundry turn, active actor resources, available action IDs, and combatant state through Arcane Turn Protocol v2. Requires the current Foundry user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => runtime("turnContext", {}, { requireGM: true }),
    },
    {
      name: "arcane_write_probe_state",
      description:
        "Read the Arcane WebMCP module's private write-probe marker, revision, and bounded idempotency receipts. Requires the current Foundry user to be a GM and does not read actors, scenes, or combat state.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => writeProbeStore.read(),
    },
    {
      name: "arcane_execute_turn_receipts",
      description:
        "Read Arcane WebMCP's module-owned execute-turn receipt ledger for the current Foundry world. Use this after an interrupted call to determine whether a request completed or became indeterminate. Requires the current user to be a GM.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true },
      execute: async () => turnExecutor.read(),
    },
    {
      name: "arcane_write_probe",
      description:
        "TEST ONLY: update the Arcane WebMCP module's private world-scoped marker. This persists only idle/armed probe state plus a bounded receipt ledger; it does not modify actors, scenes, items, chat, or combat. The write requires a GM, the exact world ID and current revision returned by arcane_write_probe_state, and a unique requestId. Retrying the same requestId with identical arguments is idempotent. simulateResponseDelayMs delays only the response after the write has committed so interrupted-call recovery can be tested.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Unique idempotency key for this intended write.",
          },
          expectedWorldId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]+$",
            description:
              "Exact current world ID returned by arcane_write_probe_state; mismatches fail closed.",
          },
          value: {
            type: "string",
            enum: ["idle", "armed"],
            description: "The test marker value to persist.",
          },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description: "Current revision returned by arcane_write_probe_state.",
          },
          simulateResponseDelayMs: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            default: 0,
            description:
              "Test-only delay after commit and before returning the receipt.",
          },
        },
        required: [
          "requestId",
          "expectedWorldId",
          "value",
          "expectedRevision",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => writeProbeStore.write(input),
    },
    {
      name: "arcane_execute_turn",
      description:
        "Execute exactly one currently available Arcane Turn Protocol v2 action for the active combatant, without advancing the turn. CONSEQUENCES: this can create chat messages, roll dice, consume actor resources, change HP, and apply effects; the underlying Foundry action may also open a human-in-the-loop dialog. Inputs must echo the current bridge/runtime/world/battle/turn identity from arcane_probe and arcane_turn_context. A durable requestId receipt is written before execution. Never retry with a new requestId after an interruption; read arcane_execute_turn_receipts and live turn state first.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
            description: "Unique idempotency key for this intended action.",
          },
          expectedBridgeSessionId: {
            type: "string",
            enum: [bridgeIdentity.sessionId],
            description: "Exact page session ID returned by arcane_probe.",
          },
          expectedModuleVersion: {
            type: "string",
            enum: [bridgeIdentity.moduleVersion],
          },
          expectedRuntimeVersion: {
            type: "string",
            enum: [bridgeIdentity.runtimeVersion],
          },
          expectedProtocolVersion: {
            type: "integer",
            enum: [bridgeIdentity.protocolVersion],
          },
          expectedRuntimeHash: {
            type: "string",
            enum: [bridgeIdentity.runtimeHash],
          },
          expectedWorldId: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          expectedBattleId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          expectedRound: { type: "integer", minimum: 0 },
          expectedTurnIndex: { type: "integer", minimum: 0 },
          expectedSourceTokenId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          actionId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          targetTokenIds: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              pattern: "^[A-Za-z0-9._:-]+$",
            },
          },
        },
        required: [
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
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (input) => turnExecutor.execute(input),
    },
  ];
}

export async function registerArcaneWebMcp({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  gameRef = globalThis.game,
  locationRef = globalThis.location,
  runtime,
  sdkMetadata,
  moduleVersion,
  writeProbeStore,
  turnExecutor,
  bridgeIdentity,
} = {}) {
  if (!documentRef || !windowRef) {
    return { status: "unsupported", reason: "missing-page-globals", tools: [] };
  }

  if (windowRef.top !== windowRef) {
    return { status: "unsupported", reason: "not-top-level", tools: [] };
  }

  const registerTool = documentRef.modelContext?.registerTool;
  if (typeof registerTool !== "function") {
    return { status: "unsupported", reason: "webmcp-api-missing", tools: [] };
  }

  const tools = createToolDefinitions({
    gameRef,
    locationRef,
    runtime,
    sdkMetadata,
    moduleVersion,
    writeProbeStore,
    turnExecutor,
    bridgeIdentity,
  });

  const registered = [];
  for (const tool of tools) {
    await registerTool.call(documentRef.modelContext, tool);
    registered.push(tool.name);
  }

  return { status: "registered", reason: null, tools: registered };
}
