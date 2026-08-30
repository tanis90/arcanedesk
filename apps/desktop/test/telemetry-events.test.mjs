import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEventData,
  classifyError,
  durationBucket,
  elapsedBucket,
  imageCountBucket,
  makeEvent,
  makeSummaryEvent,
  modelFamily,
  providerFamily,
  textLengthBucket,
} from "../src/main/telemetry/telemetry-events.js";
import { findForbiddenKey } from "../src/main/telemetry/telemetry-privacy.js";
import { classifyTask, sideEffectClass, toolFamily } from "../src/main/telemetry/task-taxonomy.js";

const ENVELOPE = {
  bootId: "boot_00112233",
  seq: 7,
  monotonicMs: 1234.5,
  installationId: "ins_00112233445566778899aabbccddeeff",
  appSessionId: "appss_00112233",
  agentSessionId: "agss_00112233",
  turnId: "turn_00112233",
  mode: "combat",
  appVersion: "0.1.0",
  releaseChannel: "beta",
};

test("text length buckets match the §7.1 contract", () => {
  assert.equal(textLengthBucket(0), "0");
  assert.equal(textLengthBucket(1), "1-20");
  assert.equal(textLengthBucket(80), "21-80");
  assert.equal(textLengthBucket(500), "201-500");
  assert.equal(textLengthBucket(501), "501+");
});

test("image count buckets", () => {
  assert.deepEqual([0, 1, 3].map(imageCountBucket), ["0", "1", "2+"]);
});

test("Foundry screenshots are read-only visual diagnosis in the task taxonomy", () => {
  const family = toolFamily("foundry_screenshot");
  assert.equal(family, "foundry.visual_inspect");
  assert.equal(sideEffectClass("foundry_screenshot"), "read");
  assert.equal(classifyTask({ shape: [{ family, count: 1 }] }), "world.diagnose");
});

test("duration and elapsed buckets are ordered ranges", () => {
  assert.equal(durationBucket(4_999), "<5s");
  assert.equal(durationBucket(15_000), "10-30s");
  assert.equal(durationBucket(400_000), "5m+");
  assert.equal(elapsedBucket(45_000), "30-120s");
});

test("makeEvent produces the full envelope and passes privacy scan", () => {
  const event = makeEvent(
    "tool.completed",
    { toolFamily: "combat.execute", status: "completed", durationMs: 1_840 },
    ENVELOPE
  );
  assert.equal(event.event, "tool.completed");
  assert.equal(event.schema_version, 1);
  assert.equal(event.seq, 7);
  assert.equal(event.installation_id, ENVELOPE.installationId);
  assert.equal(event.data.tool_family, "combat.execute");
  assert.ok(event.event_id.startsWith("evt_"));
  assert.equal(findForbiddenKey(event), null);
});

test("invalid enums and unknown events are rejected by the factory", () => {
  assert.throws(() =>
    makeEvent("tool.completed", { toolFamily: "x", status: "not-a-status", durationMs: 1 }, ENVELOPE)
  );
  assert.throws(() => makeEvent("not.an.event", {}, ENVELOPE));
});

test("renderer-controlled enum fields are normalized instead of persisted verbatim", () => {
  const data = buildEventData["input.submitted"]({
    lengthBucket: "1-20",
    imageCountBucket: "0",
    inputSource: "private user prose",
    submitMethod: "C:\\secret\\path",
  });
  assert.equal(data.input_source, "unknown");
  assert.equal(data.submit_method, "unknown");
});

test("the privacy contract rejects overlong strings and excessive nesting", () => {
  assert.throws(() => makeEvent("turn.started", { source: "chat" }, { ...ENVELOPE, appVersion: "x".repeat(300) }));
  let nested = { value: "ok" };
  for (let i = 0; i < 10; i++) nested = { child: nested };
  assert.throws(() => makeSummaryEvent(nested, ENVELOPE));
});

test("provider/model families: known ids pass through, custom stays custom", () => {
  assert.equal(providerFamily("deepseek"), "deepseek");
  assert.equal(providerFamily("my-own-relay"), "custom");
  assert.equal(modelFamily("deepseek", "deepseek-v4-flash"), "deepseek");
  assert.equal(modelFamily("my-own-relay", "gpt-9"), "custom");
});

test("classifyError maps stable codes and message patterns, never keeps the message", () => {
  assert.equal(classifyError({ code: "FOUNDRY_SDK_FOUNDRY_NOT_GAME" }), "foundry_not_game");
  assert.equal(classifyError({ code: "FOUNDRY_SDK_TIMEOUT" }), "foundry_timeout");
  assert.equal(classifyError({ code: "FOUNDRY_SDK_ABORTED" }), "user_abort");
  assert.equal(classifyError(new Error("HTTP 429 too many requests")), "model_rate_limit");
  assert.equal(classifyError(new Error("whatever")), "unknown");
});

test("summary events with forbidden or non-finite values are refused", () => {
  assert.throws(() => makeSummaryEvent({ task_category: "x", payload: { prompt: "hi" } }, ENVELOPE));
  assert.throws(() => makeSummaryEvent({ task_category: "x", ratio: Infinity }, ENVELOPE));
});

test("every P0 event builder output passes the privacy scan", () => {
  for (const [name, fields] of Object.entries(SAMPLE_FIELDS)) {
    const data = buildEventData[name](fields);
    assert.equal(findForbiddenKey(data), null, name);
  }
});

const SAMPLE_FIELDS = {
  "app.started": { platform: "win32", arch: "x64", releaseChannel: "beta" },
  "agent.session_attached": { providerFamily: "deepseek", modelFamily: "deepseek", builtinTools: false },
  "input.submitted": { lengthBucket: "21-80", imageCountBucket: "0", inputSource: "unknown", submitMethod: "unknown" },
  "turn.started": { source: "chat" },
  "turn.steered": { elapsedBucket: "5-30s" },
  "turn.aborted": { elapsedBucket: "30-120s", trigger: "user" },
  "model.completed": { providerFamily: "deepseek", modelFamily: "deepseek", finish: "stop", errorClass: "none", inputTokens: 100, outputTokens: 50 },
  "model.retry": { attempt: 1, maxAttempts: 3, errorClass: "model_timeout", recovered: false },
  "compaction.completed": { reason: "threshold", errorClass: "none", tokensBefore: 40_000 },
  "tool.started": { toolFamily: "world.inspect", sideEffectClass: "read" },
  "tool.completed": { toolFamily: "world.inspect", status: "completed", durationMs: 900 },
  "approval.resolved": { toolFamily: "combat.execute", outcome: "allowed", latencyBucket: "2-10s" },
  "foundry.runtime_completed": { actionFamily: "execute_turn", phase: "dispatched", status: "completed", receipt: "partial", durationMs: 2_000, errorClass: "none" },
};
