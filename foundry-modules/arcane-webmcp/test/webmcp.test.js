import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runtimeFunction, runtimeHash } from "@arcanedesk/foundry-sdk/runtime";
import {
  compileRuntime,
  createToolDefinitions,
  registerArcaneWebMcp,
} from "../src/webmcp.js";

const originalGame = globalThis.game;

afterEach(() => {
  if (originalGame === undefined) delete globalThis.game;
  else globalThis.game = originalGame;
});

function testMetadata() {
  return { runtimeVersion: "0.1.0", protocolVersion: 2, runtimeHash };
}

function testGame({ isGM = true } = {}) {
  return {
    ready: true,
    version: "13.351",
    world: { id: "testclean", title: "Test Clean" },
    system: { id: "dnd5e", title: "D&D 5e", version: "5.1.9" },
    user: { id: "gm", name: "Gamemaster", isGM },
    modules: new Map([["socketlib", { active: true }]]),
  };
}

function testWriteProbeStore() {
  return {
    read: () => ({ state: { revision: 0, value: "idle" } }),
    write: async (input) => ({ ok: true, input }),
  };
}

function testBridgeIdentity() {
  return {
    sessionId: "session-test",
    pageLoadedAt: "2026-09-03T00:00:00.000Z",
    moduleVersion: "0.4.0",
    runtimeVersion: "0.1.0",
    protocolVersion: 2,
    runtimeHash,
  };
}

function testTurnExecutor() {
  return {
    read: () => ({ state: { records: [] } }),
    execute: async (input) => ({ requestId: input.requestId }),
  };
}

test("canonical SDK runtime compiles and executes worldInfo in page context", async () => {
  const game = testGame();
  globalThis.game = game;
  const runtime = compileRuntime(runtimeFunction);

  const result = await runtime("worldInfo", {}, { requireGM: true });

  assert.deepEqual(result.world, { id: "testclean", title: "Test Clean" });
  assert.equal(result.user.isGM, true);
  assert.equal(result.modules.socketlib, true);
});

test("tool definitions are narrow and marked read-only", () => {
  const tools = createToolDefinitions({
    gameRef: testGame(),
    locationRef: { href: "http://127.0.0.1:30000/game" },
    runtime: async () => ({}),
    sdkMetadata: testMetadata(),
    moduleVersion: "0.1.0",
    writeProbeStore: testWriteProbeStore(),
    turnExecutor: testTurnExecutor(),
    bridgeIdentity: testBridgeIdentity(),
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "arcane_probe",
      "arcane_world_info",
      "arcane_battle_context",
      "arcane_turn_context",
      "arcane_write_probe_state",
      "arcane_execute_turn_receipts",
      "arcane_write_probe",
      "arcane_execute_turn",
    ],
  );
  assert.ok(tools.slice(0, 6).every((tool) => tool.annotations.readOnlyHint === true));
  assert.deepEqual(tools.at(-2).annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(tools.at(-1).annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.ok(tools.every((tool) => tool.inputSchema.additionalProperties === false));
});

test("registration uses the top-level document modelContext", async () => {
  const registered = [];
  const page = {};
  page.top = page;
  const result = await registerArcaneWebMcp({
    documentRef: {
      modelContext: {
        async registerTool(tool) {
          registered.push(tool);
        },
      },
    },
    windowRef: page,
    gameRef: testGame(),
    locationRef: { href: "http://127.0.0.1:30000/game" },
    runtime: async () => ({}),
    sdkMetadata: testMetadata(),
    moduleVersion: "0.1.0",
    writeProbeStore: testWriteProbeStore(),
    turnExecutor: testTurnExecutor(),
    bridgeIdentity: testBridgeIdentity(),
  });

  assert.equal(result.status, "registered");
  assert.deepEqual(result.tools, [
    "arcane_probe",
    "arcane_world_info",
    "arcane_battle_context",
    "arcane_turn_context",
    "arcane_write_probe_state",
    "arcane_execute_turn_receipts",
    "arcane_write_probe",
    "arcane_execute_turn",
  ]);
  assert.equal(registered.length, 8);
});

test("registration fails closed outside top-level or without WebMCP", async () => {
  const top = {};
  const frame = { top };
  assert.equal(
    (await registerArcaneWebMcp({ documentRef: {}, windowRef: frame })).reason,
    "not-top-level",
  );

  const page = {};
  page.top = page;
  assert.equal(
    (await registerArcaneWebMcp({ documentRef: {}, windowRef: page })).reason,
    "webmcp-api-missing",
  );
});

test("arcane_world_info preserves the SDK GM guard", async () => {
  const game = testGame({ isGM: false });
  globalThis.game = game;
  const runtime = compileRuntime(runtimeFunction);
  const tools = createToolDefinitions({
    gameRef: game,
    locationRef: { href: "http://127.0.0.1:30000/game" },
    runtime,
    sdkMetadata: testMetadata(),
    moduleVersion: "0.1.0",
    writeProbeStore: testWriteProbeStore(),
    turnExecutor: testTurnExecutor(),
    bridgeIdentity: testBridgeIdentity(),
  });

  await assert.rejects(
    () => tools.find((tool) => tool.name === "arcane_world_info").execute({}),
    /GM user is required/,
  );
});

test("write probe tools delegate to the isolated probe store", async () => {
  const calls = [];
  const tools = createToolDefinitions({
    gameRef: testGame(),
    locationRef: { href: "http://localhost:30001/game" },
    runtime: async () => ({}),
    sdkMetadata: testMetadata(),
    moduleVersion: "0.2.0",
    bridgeIdentity: testBridgeIdentity(),
    writeProbeStore: {
      read: () => ({ marker: "read" }),
      write: async (input) => {
        calls.push(input);
        return { marker: "write" };
      },
    },
    turnExecutor: testTurnExecutor(),
  });

  assert.deepEqual(
    await tools.find((tool) => tool.name === "arcane_write_probe_state").execute({}),
    { marker: "read" },
  );
  const input = {
    requestId: "test-1",
    expectedWorldId: "testclean",
    value: "armed",
    expectedRevision: 0,
  };
  assert.deepEqual(
    await tools.find((tool) => tool.name === "arcane_write_probe").execute(input),
    { marker: "write" },
  );
  assert.deepEqual(calls, [input]);
});
test("battle and turn tools preserve the canonical SDK action boundary", async () => {
  const calls = [];
  const tools = createToolDefinitions({
    gameRef: testGame(),
    locationRef: { href: "http://localhost:30001/game" },
    runtime: async (...args) => {
      calls.push(args);
      return { action: args[0] };
    },
    sdkMetadata: testMetadata(),
    moduleVersion: "0.3.0",
    writeProbeStore: testWriteProbeStore(),
    turnExecutor: testTurnExecutor(),
    bridgeIdentity: testBridgeIdentity(),
  });

  assert.deepEqual(
    await tools.find((tool) => tool.name === "arcane_battle_context").execute({}),
    { action: "battleContext" },
  );
  assert.deepEqual(
    await tools.find((tool) => tool.name === "arcane_turn_context").execute({}),
    { action: "turnContext" },
  );
  assert.deepEqual(calls, [
    ["battleContext", {}, { requireGM: true }],
    ["turnContext", {}, { requireGM: true }],
  ]);
});

test("execute-turn tools delegate through the guarded executor", async () => {
  const calls = [];
  const tools = createToolDefinitions({
    gameRef: testGame(),
    locationRef: { href: "http://localhost:30001/game" },
    runtime: async () => ({}),
    sdkMetadata: testMetadata(),
    moduleVersion: "0.4.0",
    writeProbeStore: testWriteProbeStore(),
    bridgeIdentity: testBridgeIdentity(),
    turnExecutor: {
      read: () => ({ ledger: true }),
      execute: async (input) => {
        calls.push(input);
        return { executed: true };
      },
    },
  });

  assert.deepEqual(
    await tools.find((tool) => tool.name === "arcane_execute_turn_receipts").execute({}),
    { ledger: true },
  );
  const input = { requestId: "execute-test" };
  assert.deepEqual(
    await tools.find((tool) => tool.name === "arcane_execute_turn").execute(input),
    { executed: true },
  );
  assert.deepEqual(calls, [input]);
});
