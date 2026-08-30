// ready 文件批量上传(客户端方案 §14 / 后端设计 §6):单文件串行、gzip NDJSON、
// 幂等 ack 后删文件。不可恢复 4xx 直接删除;429/5xx/网络错误指数退避,上限 6 小时。
import { promises as fs } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

const FIRST_DELAY_MS = 30_000;
const IDLE_POLL_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 6 * 3600 * 1000;
const BASE_BACKOFF_MS = 60_000;

export class TelemetryUploader {
  #timer = null;
  #backoffMs = BASE_BACKOFF_MS;
  #stopped = false;
  #inFlight = null;
  /**
   * @param {{
   *   telemetryDir: string,
   *   getEndpoint: () => string | null,
   *   getInstallationId: () => string | null,
   *   log?: (...data: any[]) => void,
   *   fetchImpl?: typeof fetch,
   * }} options
   */
  constructor({ telemetryDir, getEndpoint, getInstallationId, log = () => {}, fetchImpl }) {
    this.queueDir = path.join(telemetryDir, "queue");
    this.getEndpoint = getEndpoint;
    this.getInstallationId = getInstallationId;
    this.log = log;
    this.fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  }

  start() {
    this.#stopped = false;
    this.#schedule(FIRST_DELAY_MS);
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs) {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#inFlight = this.attempt().catch(() => {});
    }, delayMs);
    this.#timer.unref?.(); // 定时器不阻止进程退出(Electron 主进程由 app 生命周期管理)
  }

  /** 一次尝试:取最旧 ready,上传一个文件(§14.2 单次只上传一个)。测试可直接调用。 */
  async attempt() {
    if (this.#stopped) return;
    const endpoint = this.getEndpoint();
    const installationId = this.getInstallationId();
    if (!endpoint || !installationId || typeof this.fetch !== "function") {
      this.#schedule(IDLE_POLL_MS);
      return;
    }
    let file = null;
    try {
      const ready = (await fs.readdir(this.queueDir)).filter((n) => n.endsWith(".ready.jsonl")).sort();
      if (ready.length === 0) {
        this.#backoffMs = BASE_BACKOFF_MS;
        this.#schedule(IDLE_POLL_MS);
        return;
      }
      file = path.join(this.queueDir, ready[0]);
      // TODO(telemetry-performance):改用异步 zlib.gzip；当前 5 MiB 上限仍可能
      // 在 Electron 主线程造成一次可感知的同步压缩停顿。
      const body = gzipSync(await fs.readFile(file));
      const batchId = path.basename(file, ".ready.jsonl");
      const response = await this.fetch(`${endpoint.replace(/\/+$/, "")}/v1/telemetry/batches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Encoding": "gzip",
          Authorization: `Bearer ${installationId}`,
          "X-Arcane-Batch-Id": batchId,
          "X-Arcane-Schema-Version": "1",
        },
        body,
      });
      if (response.ok) {
        const ack = await response.json().catch(() => null);
        if (ack?.accepted === true && ack?.batchId === batchId) {
          await fs.rm(file, { force: true }); // 只有匹配 ack 后才删(§14.1)
          this.#backoffMs = BASE_BACKOFF_MS;
          this.#schedule(1_000); // 还有文件就尽快继续
          return;
        }
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // schema 类 4xx 不可恢复；只记 batch id/状态后删除，避免客户端留证无界增长。
        await fs.rm(file, { force: true });
        this.log("[telemetry] batch rejected (4xx), deleted:", path.basename(file), response.status);
        this.#schedule(1_000);
        return;
      }
      this.#fail(null); // 429/5xx:保留文件,退避
    } catch (error) {
      this.#fail(error); // 网络错误:保留文件,退避
    }
  }

  #fail(error) {
    const jitter = 0.5 + Math.random() / 2;
    const delay = Math.min(this.#backoffMs * jitter, MAX_BACKOFF_MS);
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    if (error) this.log("[telemetry] upload failed, will retry:", error?.message ?? error);
    this.#schedule(Math.round(delay));
  }

  /** 等待进行中的尝试结束(测试与退出用)。 */
  async idle() {
    await this.#inFlight;
  }
}
