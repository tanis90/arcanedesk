// ModeHostController — 双 AgentHost 的模式真相与异步启动闸门。
// 每个调用方先拿 snapshot，跨 await 始终使用同一份 { mode, generation, host }；
// switchTo 采用 last-request-wins，较早但较慢的切换不能覆盖较新的用户选择。

export function normalizeMode(mode) {
  return mode === "prep" ? "prep" : "combat";
}

export class ModeHostController {
  #hosts;
  #activeMode;
  #generation = 0;
  #started = new Set();
  #startPromises = new Map();
  #latestSwitchRequest = 0;

  /**
   * @param {{
   *   hosts: { combat: any, prep: any },
   *   initialMode?: string,
   * }} options
   */
  constructor({ hosts, initialMode = "prep" }) {
    if (!hosts?.combat || !hosts?.prep) throw new TypeError("combat and prep hosts are required");
    this.#hosts = hosts;
    this.#activeMode = normalizeMode(initialMode);
  }

  /** 当前模式的不可变请求快照；跨 await 后用 matches() 判断是否仍然有效。 */
  snapshot() {
    const mode = this.#activeMode;
    return Object.freeze({ mode, generation: this.#generation, host: this.#hosts[mode] });
  }

  /** 只给 IPC 响应的模式字段，不把 host 对象泄露给 renderer。 */
  publicSnapshot(context = this.snapshot()) {
    return { mode: context.mode, generation: context.generation };
  }

  matches(context) {
    return Boolean(
      context &&
      context.mode === this.#activeMode &&
      context.generation === this.#generation &&
      context.host === this.#hosts[this.#activeMode]
    );
  }

  /**
   * 校验 renderer 发来的模式上下文。旧调用不带 mode/generation 时按当前模式处理，
   * 保留外部调试脚本兼容；正式 renderer 总是显式携带两者。
   */
  validateRequest(request) {
    const current = this.snapshot();
    const hasMode = request?.mode != null;
    const hasGeneration = Number.isInteger(request?.generation);
    if (hasMode && request.mode !== "combat" && request.mode !== "prep") {
      return {
        ok: false,
        code: "INVALID_MODE_CONTEXT",
        error: "无效的模式上下文",
        ...this.publicSnapshot(current),
      };
    }
    const requestedMode = hasMode ? normalizeMode(request.mode) : current.mode;
    const requestedGeneration = hasGeneration ? Number(request.generation) : current.generation;
    if (requestedMode !== current.mode || requestedGeneration !== current.generation) {
      return {
        ok: false,
        code: "STALE_MODE_CONTEXT",
        error: "模式已经切换，请在当前模式重试",
        ...this.publicSnapshot(current),
      };
    }
    return { ok: true, context: current };
  }

  /**
   * 同一 host 的并发启动共享一个 Promise；失败会清掉 Promise，下一次可以重试。
   * @param {string} requestedMode
   */
  ensureStarted(requestedMode) {
    const mode = normalizeMode(requestedMode);
    if (this.#started.has(mode)) return Promise.resolve(this.#hosts[mode]);
    const pending = this.#startPromises.get(mode);
    if (pending) return pending;

    const startPromise = Promise.resolve()
      .then(() => this.#hosts[mode].start())
      .then(() => {
        this.#started.add(mode);
        this.#startPromises.delete(mode);
        return this.#hosts[mode];
      })
      .catch((error) => {
        this.#startPromises.delete(mode);
        throw error;
      });
    this.#startPromises.set(mode, startPromise);
    return startPromise;
  }

  /**
   * 切换模式采用 last-request-wins：若等待 host 启动期间来了更新的切换请求，
   * 旧请求只返回 stale 快照，不再修改 activeMode。
   * @param {string} requestedMode
   */
  async switchTo(requestedMode) {
    const next = normalizeMode(requestedMode);
    const requestId = ++this.#latestSwitchRequest;
    await this.ensureStarted(next);

    if (requestId !== this.#latestSwitchRequest) {
      return { ...this.snapshot(), requestedMode: next, stale: true };
    }
    if (this.#activeMode !== next) {
      this.#activeMode = next;
      this.#generation += 1;
    }
    return { ...this.snapshot(), requestedMode: next, stale: false };
  }

  /** 当前模式在初始化期间改变时重试，保证返回的 host 已启动且快照一致。 */
  async readySnapshot() {
    while (true) {
      const context = this.snapshot();
      await this.ensureStarted(context.mode);
      if (this.matches(context)) return context;
    }
  }
}
