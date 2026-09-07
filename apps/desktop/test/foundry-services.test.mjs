import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FoundryServices } from "../src/main/foundry-services.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "arcane-services-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let locked = false, contextRef = "first";
  const calls = [];
  const service = new FoundryServices({ sessionId: "A", directory, mode: "combat",
    withPage: async (_signal, fn) => { assert.equal(locked, false); locked = true; try { return await fn(); } finally { locked = false; } },
    call: async (action, args) => {
      assert.equal(locked, true);
      calls.push({ action, args });
      return action === "conditionsSet" ? { status: "completed", steps: [], verification: [], warnings: [] }
        : { contextRef, combatants: [{ tokenId: "A" }] };
    } });
  const binding = { taskId: "task", metadata: Promise.resolve({ world: { origin: "https://f.test", id: "w" }, selectedTokenUuids: ["Scene.s.Token.original"] }) };
  return { service, binding, calls, change: () => { contextRef = "next"; } };
}

test("one lease, bound selection, alias resolution and operation lookup without extra page reads", async t => {
  const f = fixture(t);
  const result = await f.service.setConditions({ targets: [{ kind: "selected" }], conditions: [{ key: "倒地", active: true }] }, f.binding, "call");
  assert.equal(result.status, "completed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args.selectedTokenUuids, ["Scene.s.Token.original"]);
  assert.deepEqual(f.calls[0].args.conditions, [{ key: "prone", active: true }]);
  assert.deepEqual(await f.service.readPlay({ view: "operation", operationRef: result.operationRef }), result);
  assert.equal(f.calls.length, 1);
});

test("missing admission world and cancellation never dispatch", async t => {
  const f = fixture(t), params = { targets: [], conditions: [] };
  assert.equal((await f.service.setConditions(params, { taskId: "t", metadata: Promise.resolve(null) }, "call")).status, "rejected");
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.service.setConditions(params, f.binding, "call", controller.signal)).code, "ABORTED");
  assert.equal(f.calls.length, 0);
});

test("dynamic reads signal invalidation without returning cached definitions", async t => {
  const f = fixture(t);
  assert.equal((await f.service.readPlay()).staticContextValid, false);
  await f.service.readStatic();
  assert.equal((await f.service.readPlay()).staticContextValid, true);
  f.change();
  assert.equal((await f.service.readPlay()).staticContextValid, false);
  assert.equal((await f.service.readPlay({ view: "operation", operationRef: "other" })).code, "OPERATION_NOT_FOUND");
});

test("execution resolves references from the session snapshot and requires fresh combat turn evidence", async t => {
  const f = fixture(t);
  const params = { actionRef: "ref" };
  assert.equal((await f.service.executeAction(params, f.binding, "one")).code, "STATIC_CONTEXT_REQUIRED");
  f.service.staticSnapshot = { contextRef: "first", scope: { combatId: "combat" }, combatants: [{
    tokenUuid: "Scene.s.Token.t", actorUuid: "Actor.a", actions: [{ actionRef: "ref", id: "action", itemId: "item", activityId: "activity" }] }] };
  assert.equal((await f.service.executeAction({ actionRef: "other" }, f.binding, "one")).code, "ACTION_REFERENCE_UNKNOWN");
  assert.equal((await f.service.executeAction(params, f.binding, "one")).code, "TURN_CONTEXT_REQUIRED");
  f.service.turnSnapshot = { contextRef: "first", turn: { tokenId: "t", round: 1, index: 0 } };
  await f.service.executeAction(params, f.binding, "one");
  const sent = f.calls[0];
  assert.equal(sent.action, "executeAction");
  assert.equal(sent.args.resolvedActions[0].sourceTokenUuid, "Scene.s.Token.t");
  assert.equal(sent.args.resolvedActions[0].actionId, "action");
  assert.equal(f.service.turnSnapshot, null);
});

test("light context maps current IDs to stable references and narrative availability without leaking schemas", async t => {
  const f = fixture(t);
  f.service.staticSnapshot = { contextRef: "first", combatants: [{ tokenUuid: "Token.t", actions: [
    { id: "native", actionRef: "ref-native", resolution: "auto", input: { heavy: "definition" } },
    { id: "spell", actionRef: "ref-spell", resolution: "narrative", resource: { kind: "spellSlot", key: "spell1" } },
  ] }] };
  let slots = 1;
  f.service.call = async () => ({ contextRef: "first", combatants: [{ tokenUuid: "Token.t", availableActionIds: ["native"], resources: { spell1: slots } }] });
  const live = await f.service.readPlay();
  assert.deepEqual(live.combatants[0].availableActionIds, ["ref-native", "ref-spell"]);
  assert.equal(JSON.stringify(live).includes("definition"), false);
  slots = 0;
  assert.deepEqual((await f.service.readPlay()).combatants[0].availableActionIds, ["ref-native"]);
});

test("content search is prep-only and uses one fixed read call", async t => {
  const f = fixture(t), query = { scope: "world", documentType: "Actor", query: "Guard" };
  await assert.rejects(f.service.contentSearch(query), /MODE_FORBIDDEN/);
  assert.equal(f.calls.length, 0);
  f.service.mode = "prep";
  await f.service.contentSearch(query);
  assert.deepEqual(f.calls, [{ action: "contentSearch", args: query }]);
});

test("Actor readRef hides internal state, binds to this session and injects request identity into writes", async t => {
  const f = fixture(t); f.service.mode = "prep";
  const readState = { actorUuid: "Actor.a", world: { origin: "https://f.test", id: "w" }, fields: { name: "Guard" }, include: [] };
  const calls = [];
  f.service.call = async (action, args) => { calls.push({ action, args }); return action === "actorRead"
    ? { actorUuid: "Actor.a", name: "Guard", readState } : { status: "completed", steps: [], verification: [], warnings: [] }; };
  const read = await f.service.actorRead({ actorUuid: "Actor.a" });
  assert.ok(read.readRef); assert.equal("readState" in read, false);
  const input = { actorUuid: "Actor.a", readRef: read.readRef, changes: { name: "New" } };
  assert.equal((await f.service.writeActor("actorEdit", { ...input, actorUuid: "Actor.other" }, f.binding, "bad")).code, "READ_REF_INVALID");
  const result = await f.service.writeActor("actorEdit", input, f.binding, "edit");
  assert.equal(result.status, "completed"); assert.equal(calls[1].args.requestId, result.operationRef);
  assert.deepEqual(calls[1].args.readState, readState); assert.equal("readRef" in calls[1].args, false);
  const other = fixture(t); other.service.mode = "prep";
  assert.equal((await other.service.writeActor("actorEdit", input, f.binding, "edit")).code, "READ_REF_INVALID");
});
