// search/cache.js — run 级搜索去重缓存与用量计数。
// 窗口 = 同一条用户消息引发的整条 agent 链；runKey 由调用方（AgentHost）在
// 用户输入事件时 reset。缓存值存 toolPayload（JSON 字符串），命中直接复用，
// 不计次、不发包。没有任何次数上限，计数只用于渲染层用量展示。

/** 归一化：trim + 折叠空白 + ASCII 小写（中文 query 不受影响）。 */
export function normalizeQuery(query) {
  return String(query ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

export class SearchRunCache {
  constructor() {
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

  /** 命中缓存返回缓存的 toolPayload，否则 null。 */
  lookup(runKey, query) {
    return this.#run(runKey).cache.get(normalizeQuery(query)) ?? null;
  }

  /** 一次真实执行后记账并写入缓存。 */
  record(runKey, query, toolPayload) {
    const run = this.#run(runKey);
    run.count += 1;
    run.cache.set(normalizeQuery(query), toolPayload);
  }

  used(runKey) {
    return this.#run(runKey).count;
  }

  /** 会话结束时整体丢弃。 */
  clear() {
    this.runs.clear();
  }
}
