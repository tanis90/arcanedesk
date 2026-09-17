// search/budget.js — run 级搜索防护（PRD §4 三级：去重缓存 + 软提示 + 硬上限）。
// 窗口 = 同一条用户消息引发的整条 agent 链；runKey 由调用方（AgentHost）在
// 用户输入事件时 reset。缓存值存 toolPayload（JSON 字符串），命中直接复用，
// 不计次、不发包。

export const SOFT_LIMIT = 5; // 第 6 次起 toolResult 附带收敛提示
export const HARD_LIMIT = 10; // 超过即拒绝

/** 归一化：trim + 折叠空白 + ASCII 小写（中文 query 不受影响）。 */
export function normalizeQuery(query) {
  return String(query ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

const SOFT_NOTICE =
  "\n\n[web_search] 本轮搜索预算偏低：请收敛检索，基于已有结果作答。";

export class SearchBudget {
  /**
   * @param {{ soft?: number, hard?: number, notice?: string }=} opts 可注入便于测试。
   */
  constructor({ soft = SOFT_LIMIT, hard = HARD_LIMIT, notice = SOFT_NOTICE } = {}) {
    this.soft = soft;
    this.hard = hard;
    this.notice = notice;
    /** @type {Map<string, { count: number, cache: Map<string, string> }>} */
    this.runs = new Map();
  }

  /** 用户输入事件时调用：同 runKey 重复调用幂等。 */
  reset(runKey) {
    if (!this.runs.has(runKey)) this.runs.set(runKey, { count: 0, cache: new Map() });
  }

  #run(runKey) {
    let run = this.runs.get(runKey);
    if (!run) {
      run = { count: 0, cache: new Map() };
      this.runs.set(runKey, run);
    }
    return run;
  }

  /** 是否允许再执行一次（硬上限判定）。 */
  allow(runKey) {
    return this.#run(runKey).count < this.hard;
  }

  /** 命中缓存返回缓存的 toolPayload，否则 null。 */
  lookup(runKey, query) {
    return this.#run(runKey).cache.get(normalizeQuery(query)) ?? null;
  }

  /** 一次真实执行后记账；返回值 = 本次是否已过软阈值（调用方据此附加提示）。 */
  record(runKey, query, toolPayload) {
    const run = this.#run(runKey);
    run.count += 1;
    run.cache.set(normalizeQuery(query), toolPayload);
    return run.count > this.soft;
  }

  /** 空结果等不进缓存的执行也消耗预算（上游已计费）。 */
  recordMiss(runKey) {
    this.#run(runKey).count += 1;
  }

  used(runKey) {
    return this.#run(runKey).count;
  }

  /** 会话结束时整体丢弃。 */
  clear() {
    this.runs.clear();
  }
}
