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
  assert.equal(valid("foundry_image", { sourcePath: "images/npc.webp", targetUuid: "Item.a" }), true);
  assert.equal(valid("foundry_image", { dataPath: "assets/npc.png", targetUuid: "JournalEntry.j.JournalEntryPage.p" }), true);
  const actor = image => ({ actorUuid: "Actor.a", readRef: "read", changes: { image } });
  assert.equal(valid("foundry_actor_update", actor({ sourcePath: "images/npc.webp", syncPlacedTokens: true })), false);
  assert.equal(valid("foundry_actor_update", actor({ dataPath: "assets/npc.png" })), false);
  assert.equal(valid("foundry_actor_update", actor({ sourcePath: "npc.png", dataPath: "assets/npc.png" })), false);
  assert.equal(valid("foundry_actor_update", actor({ dataPath: "assets/npc.png", upload: { base64: "secret" } })), false);
  assert.equal(valid("foundry_scene_apply", { operation: "create", scene: { name: "Encounter" }, tokens: { create: [{ actorUuid: "Actor.a", x: 0, y: 0 }] } }), true);
  assert.equal(valid("foundry_scene_apply", { operation: "update", sceneUuid: "Scene.s", readRef: "ref", tokens: { walls: [] } }), false);
  assert.equal(valid("foundry_scene_apply", { operation: "create", scene: { name: "Encounter", background: { sourcePath: "map.webp", syncPlacedTokens: true } } }), false);
  assert.equal(valid("foundry_scene_import", { operation: "create", sourcePath: "maps/church.json" }), true);
  assert.equal(valid("foundry_scene_import", { operation: "create", sourcePath: "maps/church.json", backgroundSourcePath: "maps/church.png" }), true);
  assert.equal(valid("foundry_scene_import", { operation: "update", sceneUuid: "Scene.s", readRef: "ref", sourcePath: "maps/church.json" }), true);
  // Flattened publish schema keeps cross-branch fields optional; the exact union check
  // rejects mismatched branches (update without readRef, create with sceneUuid) before dispatch.
  assert.equal(valid("foundry_scene_import", { operation: "update", sceneUuid: "Scene.s", sourcePath: "maps/church.json" }), true);
  assert.equal(valid("foundry_scene_import", { operation: "create", sourcePath: "maps/church.json", sceneUuid: "Scene.s" }), true);
  assert.equal(valid("foundry_scene_import", { operation: "create", sourcePath: "maps/church.json", background: { dataPath: "a.png" } }), false);
  assert.equal(valid("foundry_scene_import", { operation: "update", sceneUuid: "Scene.s", readRef: "ref", sourcePath: "maps/church.json", readState: { sceneUuid: "Scene.s" } }), false);
});

test("scene portal schemas preserve pair operations and readRef requirements", async () => {
  const tools = new Map(createFoundryTools({}).map(tool => [tool.name, tool]));
  const valid = (name, params) => Value.Check(tools.get(name).parameters, params);
  assert.equal(valid("foundry_scene_get", { sceneUuid: "Scene.a", include: ["portals", "tokens"] }), true);
  assert.equal(valid("foundry_scene_portal", { operation: "create", sourceSceneUuid: "Scene.a", targetSceneUuid: "Scene.b",
    sourcePoint: { x: 10, y: 20 }, targetPoint: { x: 30, y: 40 }, playerVisible: true }), true);
  assert.equal(valid("foundry_scene_portal", { operation: "create", sourceSceneUuid: "Scene.a", targetSceneUuid: "Scene.a",
    sourcePoint: { x: 10, y: 20 }, targetPoint: { x: 30, y: 40 }, sourceScale: 1.5, targetScale: 0.5 }), true);
  assert.equal(valid("foundry_scene_portal", { operation: "create", sourceSceneUuid: "Scene.a", targetSceneUuid: "Scene.b",
    sourcePoint: { x: 10, y: 20 }, targetPoint: { x: 30, y: 40 }, sourceScale: 2.5 }), false);
  assert.equal(valid("foundry_scene_portal", { operation: "create", sourceSceneUuid: "Scene.a", targetSceneUuid: "Scene.b",
    sourcePoint: { x: 10 }, targetPoint: { x: 30, y: 40 } }), false);
  assert.equal(valid("foundry_scene_portal", { operation: "delete", sceneUuid: "Scene.a", portalId: "p1", readRef: "read" }), true);
  assert.equal(valid("foundry_scene_portal", { operation: "delete", sceneUuid: "Scene.a", portalId: "p1" }), true);
  assert.equal(valid("foundry_scene_portal", { operation: "teleport", tokenUuid: "Scene.a.Token.t",
    targetSceneUuid: "Scene.b", targetPortalId: "p2", readRef: "read" }), true);
  assert.equal(valid("foundry_scene_portal", { operation: "move", sceneUuid: "Scene.a" }), false);
  let calls = 0;
  const host = {
    taskCoordinator: () => ({ currentInputBinding: () => ({}) }),
    maybeRequestApproval: async () => true,
    foundryServices: () => ({ scenePortal: async () => { calls++; return { status: "completed" }; } }),
  };
  const tool = createFoundryTools(host).find(value => value.name === "foundry_scene_portal");
  for (const [id, params] of [
    ["missing-point", { operation: "create", sourceSceneUuid: "Scene.a", targetSceneUuid: "Scene.b",
      sourcePoint: { x: 10 }, targetPoint: { x: 30, y: 40 } }],
    ["missing-read-ref", { operation: "delete", sceneUuid: "Scene.a", portalId: "p1" }],
    ["unsupported-operation", { operation: "move", sceneUuid: "Scene.a" }],
  ]) {
    const result = await tool.execute(id, params);
    assert.equal(result.details.code, "INPUT_INVALID", id);
  }
  assert.equal(calls, 0);
});

test("provider object schemas retain exact branch validation before host access or writes", async () => {
  const tools = new Map(createFoundryTools({}).map(tool => [tool.name, tool]));
  for (const [name, params] of [
    ["foundry_play_context", { view: "operation" }],
    ["foundry_play_context", { view: "current", operationRef: "unexpected" }],
    ["foundry_scene_apply", { operation: "update", sceneUuid: "Scene.s", scene: { name: "Renamed" } }],
    ["foundry_scene_apply", { operation: "create", scene: { name: "New" }, sceneUuid: "Scene.s" }],
    ["foundry_scene_import", { operation: "create", sourcePath: "scene.json", sceneUuid: "Scene.s" }],
    ["foundry_scene_import", { operation: "update", sceneUuid: "Scene.s", sourcePath: "scene.json" }],
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

test("tool results survive circular service payloads (dnd5e back-references)", async () => {
  const actor = { name: "Cleric", system: { attributes: {} } };
  // structured-clone from the page preserves cycles; dnd5e 5.3 actors carry them
  actor.system.attributes.hd = actor;
  const host = { foundryServices: () => ({ actorRead: async () => ({ actor }) }) };
  const tool = createFoundryTools(host).find(value => value.name === "foundry_actor_get");
  const result = await tool.execute("call", { actorUuid: "Actor.a" });
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(result.details.actor.system.attributes.hd, "[Circular]");
  assert.equal(JSON.parse(result.content[0].text).actor.name, "Cleric");
});
