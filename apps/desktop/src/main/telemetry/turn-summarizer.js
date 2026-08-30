// 产品回合状态机与 turn.summary(客户端方案 §4.3/§10)。
// 只消费已通过隐私合同的结构化事实;summary 是同一 JSONL 流中的派生事件。
// agent_settled 只代表回合可以结算,不代表任务成功(§10.1 分层表达)。
import { classifyTask, SUMMARY_VERSION, TASK_TAXONOMY_VERSION } from "./task-taxonomy.js";
import { durationBucket } from "./telemetry-events.js";

const MAX_SHAPE_SEGMENTS = 16;

/** world_outcome 严重度:不确定 > 部分 > 拒绝 > 完成(§12.1 severity)。 */
const RECEIPT_RANK = { none: 0, completed: 1, rejected: 2, partial: 3, indeterminate: 4 };

class TurnState {
  constructor(turnId, startedMonotonicMs) {
    this.turnId = turnId;
    this.startedMonotonicMs = startedMonotonicMs;
    this.modelCalls = 0;
    this.providerRetries = 0;
    this.compactions = 0;
    this.toolErrors = 0;
    this.steerCount = 0;
    this.aborted = false;
    this.approvalDenied = false;
    this.lastErrorClass = "none";
    this.transportStatus = "completed";
    /** @type {{family: string, count: number}[]} */
    this.toolShape = [];
    /** @type {string[]} execute_turn 四态回执(仅 dispatched) */
    this.receipts = [];
  }

  noteTool(family) {
    const last = this.toolShape[this.toolShape.length - 1];
    if (last && last.family === family) last.count += 1;
    else this.toolShape.push({ family, count: 1 });
  }

  worstReceipt() {
    let worst = "none";
    for (const receipt of this.receipts) {
      if (RECEIPT_RANK[receipt] > RECEIPT_RANK[worst]) worst = receipt;
    }
    return worst;
  }

  intervention() {
    if (this.aborted) return "abort";
    if (this.approvalDenied) return "approval_denied";
    if (this.steerCount > 0) return "steer";
    return "none";
  }

  /** 压缩后的 task_shape:run-length,最多 16 段,超出以 truncated 收尾(§10)。 */
  shapeSegments() {
    if (this.toolShape.length <= MAX_SHAPE_SEGMENTS) return this.toolShape;
    const kept = this.toolShape.slice(0, MAX_SHAPE_SEGMENTS);
    const rest = this.toolShape.slice(MAX_SHAPE_SEGMENTS).reduce((sum, s) => sum + s.count, 0);
    kept.push({ family: "truncated", count: rest });
    return kept;
  }
}

export class TurnSummarizer {
  /**
   * @param {{ onSummary: (mode: string, data: any) => void }} options
   */
  constructor({ onSummary }) {
    this.onSummary = onSummary;
    /** @type {Map<string, TurnState>} mode -> active turn(每模式最多一个,§4.3) */
    this.turns = new Map();
  }

  hasActive(mode) {
    return this.turns.has(mode);
  }

  reset() {
    this.turns.clear();
  }

  startTurn(mode, turnId, monotonicMs) {
    this.turns.set(mode, new TurnState(turnId, monotonicMs));
  }

  noteModelCall(mode) {
    const turn = this.turns.get(mode);
    if (turn) turn.modelCalls += 1;
  }

  noteRetry(mode) {
    const turn = this.turns.get(mode);
    if (turn) turn.providerRetries += 1;
  }

  noteCompaction(mode) {
    const turn = this.turns.get(mode);
    if (turn) turn.compactions += 1;
  }

  noteTool(mode, family, isError) {
    const turn = this.turns.get(mode);
    if (!turn) return;
    turn.noteTool(family);
    if (isError) turn.toolErrors += 1;
  }

  noteReceipt(mode, receipt) {
    this.turns.get(mode)?.receipts.push(receipt);
  }

  noteSteer(mode) {
    const turn = this.turns.get(mode);
    if (turn) turn.steerCount += 1;
  }

  noteAbort(mode) {
    const turn = this.turns.get(mode);
    if (turn) turn.aborted = true;
  }

  noteApprovalDenied(mode) {
    const turn = this.turns.get(mode);
    if (turn) turn.approvalDenied = true;
  }

  noteError(mode, errorClass) {
    const turn = this.turns.get(mode);
    if (turn) turn.lastErrorClass = errorClass;
  }

  /**
   * 关闭回合并产出 summary data;reason 决定 transport_status。
   * @param {"settled" | "aborted" | "error"} reason
   * @param {number} endedMonotonicMs
   */
  closeTurn(mode, reason, endedMonotonicMs) {
    const turn = this.turns.get(mode);
    if (!turn) return null;
    this.turns.delete(mode);
    const transportStatus = reason === "aborted" ? "aborted" : reason === "error" ? "failed" : "completed";
    return {
      summary_version: SUMMARY_VERSION,
      task_taxonomy_version: TASK_TAXONOMY_VERSION,
      task_category: classifyTask({ shape: turn.toolShape, receipts: turn.receipts }),
      task_shape: turn.shapeSegments(),
      duration_ms_bucket: durationBucket(endedMonotonicMs - turn.startedMonotonicMs),
      model_calls: turn.modelCalls,
      tool_calls: turn.toolShape.reduce((sum, s) => sum + s.count, 0),
      provider_retries: turn.providerRetries,
      tool_retries: 0,
      compactions: turn.compactions,
      transport_status: transportStatus,
      world_outcome: turn.worstReceipt(),
      user_intervention: turn.intervention(),
      approval_outcome: turn.approvalDenied ? "denied" : "allowed",
      input_source: "unknown",
      completion_mode: "unknown", // 只能来自静态产品合同,没有合同就 unknown(§10.1)
      error_class: reason === "settled" && turn.lastErrorClass === "none" ? "none" : turn.lastErrorClass,
    };
  }
}
