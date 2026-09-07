import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { createFoundryTools } from "../src/main/foundry-tools.js";

test("new schemas reject unknown keys, unbounded selectors and operation view without a reference", () => {
  const tools = new Map(createFoundryTools({}).map(tool => [tool.name, tool]));
  const valid = (name, params) => Value.Check(tools.get(name).parameters, params);
  assert.equal(valid("foundry_static_context", {}), true);
  assert.equal(valid("foundry_static_context", { source: "actor" }), false);
  assert.equal(valid("foundry_play_context", { view: "operation" }), false);
  assert.equal(valid("foundry_play_context", { view: "operation", operationRef: "known" }), true);
  assert.equal(valid("foundry_conditions_set", { targets: [{ kind: "selected" }], conditions: [{ key: "prone", active: false }] }), true);
  assert.equal(valid("foundry_conditions_set", { targets: Array(21).fill({ kind: "selected" }), conditions: [{ key: "prone", active: false }] }), false);
  assert.equal(valid("foundry_conditions_set", { targets: [{ kind: "selected", code: "x" }], conditions: [{ key: "prone", toggle: true }] }), false);
  const actor = image => ({ actorUuid: "Actor.a", readRef: "read", changes: { image } });
  assert.equal(valid("foundry_actor_update", actor({ sourcePath: "images/npc.webp", syncPlacedTokens: true })), true);
  assert.equal(valid("foundry_actor_update", actor({ dataPath: "assets/npc.png" })), true);
  assert.equal(valid("foundry_actor_update", actor({ sourcePath: "npc.png", dataPath: "assets/npc.png" })), false);
  assert.equal(valid("foundry_actor_update", actor({ dataPath: "assets/npc.png", upload: { base64: "secret" } })), false);
  assert.equal(valid("foundry_scene_apply", { operation: "create", scene: { name: "Encounter" }, tokens: { create: [{ actorUuid: "Actor.a", x: 0, y: 0 }] } }), true);
  assert.equal(valid("foundry_scene_apply", { operation: "update", sceneUuid: "Scene.s", scene: { name: "Renamed" } }), false);
  assert.equal(valid("foundry_scene_apply", { operation: "update", sceneUuid: "Scene.s", readRef: "ref", tokens: { walls: [] } }), false);
  assert.equal(valid("foundry_scene_apply", { operation: "create", scene: { name: "Encounter", background: { sourcePath: "map.webp", syncPlacedTokens: true } } }), false);
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
