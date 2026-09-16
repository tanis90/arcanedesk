import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFoundryWriteReceipt } from "../src/main/foundry-write-receipt.js";

test("Desktop maps legacy native completion without inventing damage or changing the SDK receipt", () => {
  const original = { status: "completed" }, context = { action: "executeAction", args: { resolvedActions: [{ sourceTokenUuid: "Scene.s.Token.t" }] } };
  const result = normalizeFoundryWriteReceipt(original,context);
  assert.equal(result.steps[0].state,"completed");
  assert.deepEqual(result.steps[0].targets,["Scene.s.Token.t"]);
  assert.deepEqual(result.verification,[{ kind: "native-execution", confirmed: true }]);
  assert.deepEqual(original,{ status: "completed" });
  const uncertain = normalizeFoundryWriteReceipt({ status: "partial", completed: 1, requested: 2 },context);
  assert.equal(uncertain.steps[0].state,"unknown"); assert.equal(uncertain.steps[0].completed,1);
  assert.equal(uncertain.retry,false);
});

test("step spelling and summaries follow the Desktop contract; uploaded files are not UUID targets", () => {
  const result = normalizeFoundryWriteReceipt({ status: "partial", steps: [
    { step: "upload-image", state: "completed", targets: ["arcanedesk/assets/hash.png"] },
    { step: "token-image", state: "not-started", targets: ["Scene.s.Token.t"] },
  ] },{ action: "actorEdit", args: {} });
  assert.equal(result.steps[1].state,"not_started");
  assert.equal(typeof result.steps[1].summary,"string");
  assert.deepEqual(result.steps[0].targets,[]);
  assert.deepEqual(result.steps[0].dataPaths,["arcanedesk/assets/hash.png"]);
});

test("advancement steps keep their slot shape and never produce undefined summaries", () => {
  const result = normalizeFoundryWriteReceipt({ status: "completed", steps: [
    { label: "class", level: 1, kind: "HitPointsAdvancement", slot: "class:1:HitPointsAdvancement:0" },
    { label: "subclass", level: 2, kind: "ItemGrantAdvancement", slot: "subclass:2:ItemGrantAdvancement" },
  ] },{ action: "actorAdvance", args: {} });
  assert.equal(result.steps[0].summary,"class:1:HitPointsAdvancement:0 class");
  assert.equal(result.steps[1].summary,"subclass:2:ItemGrantAdvancement subclass");
  assert.ok(!JSON.stringify(result.steps).includes("undefined"));
});
