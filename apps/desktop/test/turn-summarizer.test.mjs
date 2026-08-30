import assert from "node:assert/strict";
import test from "node:test";

import { TurnSummarizer } from "../src/main/telemetry/turn-summarizer.js";

function summarizerWithSpy() {
  const summaries = [];
  const summarizer = new TurnSummarizer({
    onSummary: (mode, data) => summaries.push({ mode, data }),
  });
  return { summarizer, summaries };
}

test("combat turn: tools feed shape, receipts feed world_outcome, settled is not success", async () => {
  const { summarizer, summaries } = summarizerWithSpy();
  summarizer.startTurn("combat", "turn_1", 0);
  summarizer.noteModelCall("combat");
  summarizer.noteTool("combat", "world.inspect", false);
  summarizer.noteTool("combat", "combat.battle_context", false);
  summarizer.noteTool("combat", "combat.turn_context", false);
  summarizer.noteModelCall("combat");
  summarizer.noteTool("combat", "combat.turn_context", false);
  summarizer.noteTool("combat", "combat.execute", false);
  summarizer.noteReceipt("combat", "partial");
  const data = summarizer.closeTurn("combat", "settled", 20_000);
  // agent_settled 只结束回合并结算,summary 里没有 success 布尔(§10.1)
  assert.equal(data.transport_status, "completed");
  assert.equal(data.world_outcome, "partial");
  assert.equal(data.user_intervention, "none");
  assert.equal(data.task_category, "combat.execute_action");
  assert.equal(data.model_calls, 2);
  assert.deepEqual(
    data.task_shape.map((s) => `${s.family}x${s.count}`),
    ["world.inspectx1", "combat.battle_contextx1", "combat.turn_contextx2", "combat.executex1"]
  );
  assert.equal(summaries.length, 0); // summary 经回调由 client 包 envelope,这里只验证 data
  assert.equal(summarizer.hasActive("combat"), false);
});

test("uncertain receipt followed by a turn-context reread classifies as recover_uncertain", () => {
  const { summarizer } = summarizerWithSpy();
  summarizer.startTurn("combat", "turn_2", 0);
  summarizer.noteTool("combat", "combat.turn_context", false);
  summarizer.noteTool("combat", "combat.execute", false);
  summarizer.noteReceipt("combat", "indeterminate");
  summarizer.noteTool("combat", "combat.turn_context", false);
  const data = summarizer.closeTurn("combat", "settled", 5_000);
  assert.equal(data.task_category, "combat.recover_uncertain");
});

test("steer and abort surface as user_intervention, transport aborted", () => {
  const { summarizer } = summarizerWithSpy();
  summarizer.startTurn("combat", "turn_3", 0);
  summarizer.noteTool("combat", "combat.execute", false);
  summarizer.noteReceipt("combat", "completed");
  summarizer.noteSteer("combat");
  summarizer.noteAbort("combat");
  const data = summarizer.closeTurn("combat", "aborted", 50_000);
  assert.equal(data.user_intervention, "abort");
  assert.equal(data.transport_status, "aborted");
  assert.equal(data.world_outcome, "completed");
  assert.equal(data.approval_outcome, "allowed");
});

test("approval denial outranks steer in the intervention layering", () => {
  const { summarizer } = summarizerWithSpy();
  summarizer.startTurn("combat", "turn_4", 0);
  summarizer.noteSteer("combat");
  summarizer.noteApprovalDenied("combat");
  const data = summarizer.closeTurn("combat", "settled", 2_000);
  assert.equal(data.user_intervention, "approval_denied");
});

test("shape longer than 16 segments is run-length capped with a truncated tail", () => {
  const { summarizer } = summarizerWithSpy();
  summarizer.startTurn("prep", "turn_5", 0);
  for (let i = 0; i < 20; i++) summarizer.noteTool("prep", `other-${i % 2 === 0 ? "a" : "b"}${i}`, false);
  const data = summarizer.closeTurn("prep", "settled", 1_000);
  assert.equal(data.task_shape.length, 17); // 16 段 + truncated
  assert.equal(data.task_shape[16].family, "truncated");
  assert.equal(data.task_shape[16].count, 4);
});

test("prep file work classifies into prep taxonomy", () => {
  const { summarizer } = summarizerWithSpy();
  summarizer.startTurn("prep", "turn_6", 0);
  summarizer.noteTool("prep", "filesystem.read", false);
  summarizer.noteTool("prep", "filesystem.write", false);
  summarizer.noteTool("prep", "terminal.execute", false);
  const data = summarizer.closeTurn("prep", "settled", 90_000);
  assert.equal(data.task_category, "prep.execute_and_verify");
});
