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
