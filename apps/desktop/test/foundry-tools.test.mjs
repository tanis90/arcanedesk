import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { createFoundryTools } from "../src/main/foundry-tools.js";

test("new schemas reject unknown keys and unbounded selectors", () => {
  const tools = new Map(createFoundryTools({}).map(tool => [tool.name, tool]));
  const valid = (name, params) => Value.Check(tools.get(name).parameters, params);
  assert.equal(valid("foundry_static_context", {}), true);
  assert.equal(valid("foundry_static_context", { source: "actor" }), false);
  assert.equal(valid("foundry_play_context", { view: "operation", operationRef: "known" }), true);
  assert.equal(valid("foundry_play_context", { view: "current" }), true);
  assert.equal(valid("foundry_play_context", { view: "scene" }), false);
  assert.equal(valid("foundry_conditions_set", { targets: [{ kind: "selected" }], conditions: [{ key: "prone", active: false }] }), true);
  assert.equal(valid("foundry_conditions_set", { targets: Array(21).fill({ kind: "selected" }), conditions: [{ key: "prone", active: false }] }), false);
  assert.equal(valid("foundry_conditions_set", { targets: [{ kind: "selected", code: "x" }], conditions: [{ key: "prone", toggle: true }] }), false);
  const actor = image => ({ actorUuid: "Actor.a", readRef: "read", changes: { image } });
  assert.equal(valid("foundry_actor_update", actor({ sourcePath: "images/npc.webp", syncPlacedTokens: true })), true);
  assert.equal(valid("foundry_actor_update", actor({ dataPath: "assets/npc.png" })), true);
  assert.equal(valid("foundry_actor_update", actor({ sourcePath: "npc.png", dataPath: "assets/npc.png" })), false);
  assert.equal(valid("foundry_actor_update", actor({ dataPath: "assets/npc.png", upload: { base64: "secret" } })), false);
  assert.equal(valid("foundry_scene_apply", { operation: "create", scene: { name: "Encounter" }, tokens: { create: [{ actorUuid: "Actor.a", x: 0, y: 0 }] } }), true);
  assert.equal(valid("foundry_scene_apply", { operation: "update", sceneUuid: "Scene.s", readRef: "ref", tokens: { walls: [] } }), false);
  assert.equal(valid("foundry_scene_apply", { operation: "create", scene: { name: "Encounter", background: { sourcePath: "map.webp", syncPlacedTokens: true } } }), false);
});

test("provider object schemas retain exact branch validation before host access or writes", async () => {
  const tools = new Map(createFoundryTools({}).map(tool => [tool.name, tool]));
  for (const [name, params] of [
    ["foundry_play_context", { view: "operation" }],
    ["foundry_play_context", { view: "current", operationRef: "unexpected" }],
    ["foundry_scene_apply", { operation: "update", sceneUuid: "Scene.s", scene: { name: "Renamed" } }],
    ["foundry_scene_apply", { operation: "create", scene: { name: "New" }, sceneUuid: "Scene.s" }],
    ["foundry_execute_action", {}],
    ["foundry_execute_action", { actionRef: "one", actions: [{ actionRef: "two" }] }],
    ["foundry_execute_action", { actions: [{ actionRef: "one" }], resolution: "narrative" }],
  ]) {
    const tool = tools.get(name);
    assert.equal(tool.parameters.type, "object"); assert.equal(tool.parameters.anyOf, undefined);
    assert.equal((await tool.execute("invalid", params)).details.code, "INPUT_INVALID");
  }
});

test("condition approval pins the consumed input and denial does not create an operation", async () => {
  let approved, called = 0, current = { taskId: "original" }, received;
  const host = {
    taskCoordinator: () => ({ currentInputBinding: () => current }),
    maybeRequestApproval: () => new Promise(resolve => { approved = resolve; }),
    foundryServices: () => ({ setConditions: async (_params, binding) => { called++; received = binding; return { status: "completed" }; } }),
  };
  const tool = createFoundryTools(host).find(value => value.name === "foundry_conditions_set");
  const params = { targets: [{ kind: "selected" }], conditions: [{ key: "prone", active: true }] };
  const pending = tool.execute("call", params);
  current = { taskId: "later" }; approved(true); await pending;
  assert.equal(received.taskId, "original"); assert.equal(called, 1);
  const declined = tool.execute("next", params); approved(false);
  assert.equal((await declined).details.code, "DECLINED"); assert.equal(called, 1);
});
