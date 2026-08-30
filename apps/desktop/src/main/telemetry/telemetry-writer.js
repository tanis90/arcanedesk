// 单 writer JSONL 落盘(客户端方案 §5):queue/*.open.jsonl -> 轮转 *.ready.jsonl,
// quarantine 隔离可疑文件。写盘失败只 disable 本 boot,绝不影响业务(§4.2)。
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_EVENTS = 2_000;
const CAP_BYTES = 50 * 1024 * 1024;

function utcStamp(date = new Date()) {
  return date.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export class TelemetryWriter {
  #queue = Promise.resolve();
  #current = null; // { file, bytes, events, hour }
  #batchCounter = 0;
  /**
   * @param {string} telemetryDir userData/telemetry
   * @param {{ log?: (...data: any[]) => void, now?: () => Date, maxFileBytes?: number, maxFileEvents?: number, capBytes?: number }} [options]
   */
  constructor(telemetryDir, {
    log = () => {},
    now = () => new Date(),
    maxFileBytes = MAX_FILE_BYTES,
    maxFileEvents = MAX_FILE_EVENTS,
    capBytes = CAP_BYTES,
  } = {}) {
    this.queueDir = path.join(telemetryDir, "queue");
    this.quarantineDir = path.join(telemetryDir, "quarantine");
    this.log = log;
    this.now = now;
    this.maxFileBytes = maxFileBytes;
    this.maxFileEvents = maxFileEvents;
    this.capBytes = capBytes;
    this.disabled = false;
  }

  async start() {
    // consentDisabled() 会把本实例停写并清空；用户在同一 boot 重新开启时允许复用。
    this.disabled = false;
    try {
      await fs.mkdir(this.queueDir, { recursive: true });
      await fs.mkdir(this.quarantineDir, { recursive: true });
      await this.#recoverOpenFiles();
      await this.#enforceTotalCap();
    } catch (error) {
      this.#disable(error);
    }
  }

  /** 事件追加:同步入队,异步落盘;调用方不等待物理写。 */
  append(event) {
    if (this.disabled) return;
    let line;
    try {
      line = JSON.stringify(event);
    } catch {
      return; // 不可序列化的事件直接丢弃,不落盘
    }
    this.#queue = this.#queue.then(() => this.#appendLine(line)).catch((error) => this.#disable(error));
  }

  async #appendLine(line) {
    if (this.disabled) return;
    if (!this.#current) this.#current = await this.#openFile();
    await fs.appendFile(this.#current.file, line + "\n", "utf8");
    this.#current.bytes += Buffer.byteLength(line) + 1;
    this.#current.events += 1;
    const currentHour = utcStamp(this.now()).slice(0, 11);
    if (
      this.#current.bytes >= this.maxFileBytes ||
      this.#current.events >= this.maxFileEvents ||
      this.#current.hour !== currentHour
    ) {
      await this.#rotate();
    }
  }

  async #openFile() {
    const date = this.now();
    const stamp = utcStamp(date);
    this.#batchCounter += 1;
    const file = path.join(this.queueDir, `${stamp}_${String(this.#batchCounter).padStart(4, "0")}.open.jsonl`);
    await fs.writeFile(file, "", { flag: "a" });
    return { file, bytes: 0, events: 0, hour: stamp.slice(0, 11) };
  }

  async #rotate() {
    if (!this.#current || this.#current.events === 0) return;
    const ready = this.#current.file.replace(/\.open\.jsonl$/, ".ready.jsonl");
    await fs.rename(this.#current.file, ready);
    this.#current = null;
    await this.#enforceTotalCap();
  }

  /** 等待队列中的写操作完成,不触发轮转;测试与确定性检查用。 */
  async flush() {
    await this.#queue;
  }

  /** 正常退出前的 best-effort:把 open 轮转成 ready,最多等 500ms(§4.2)。 */
  async prepareQuit() {
    if (this.disabled) return;
    await Promise.race([
      this.#queue.then(() => this.#rotate()),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]).catch(() => {});
  }

  /** 授权关闭:立即停写并删除全部 open/ready(§5.4)。 */
  async deleteAll() {
    this.disabled = true;
    await this.#queue.catch(() => {});
    for (const dir of [this.queueDir, this.quarantineDir]) {
      try {
        for (const entry of await fs.readdir(dir)) {
          if (entry.endsWith(".jsonl")) {
            await fs.rm(path.join(dir, entry), { force: true });
          }
        }
      } catch {
        /* 目录不存在即无事可做 */
      }
    }
    this.#current = null;
  }

  // ---- 崩溃恢复(§5.3) ----

  async #recoverOpenFiles() {
    const entries = (await fs.readdir(this.queueDir)).filter((name) => name.endsWith(".open.jsonl")).sort();
    for (const name of entries) {
      const file = path.join(this.queueDir, name);
      try {
        const raw = await fs.readFile(file, "utf8");
        const lines = raw.split("\n");
        // 有换行时末项是 split 产生的空串；无换行时末项可能是崩溃残行。
        // 两种情况都移除最后一项，但原因不同，不用伪分支掩盖这个约定。
        const complete = lines.slice(0, -1);
        let kept = [];
        for (const line of complete) {
          JSON.parse(line); // 中间非法行:整文件进 quarantine,不上传部分可疑内容
          kept.push(line);
        }
        if (kept.length === 0) {
          await fs.rm(file, { force: true });
          continue;
        }
        await fs.writeFile(file, kept.join("\n") + "\n", "utf8");
        await fs.rename(file, file.replace(/\.open\.jsonl$/, ".ready.jsonl"));
      } catch (error) {
        try {
          await fs.rename(file, path.join(this.quarantineDir, name));
          this.log("[telemetry] quarantined unparseable file:", name, error?.message ?? error);
        } catch {
          /* quarantine 也失败就只能留着 */
        }
      }
    }
  }

  /**
   * 本地硬上限:queue + quarantine 合计 50 MiB(§5.4)。只删除已封盘
   * ready 与 quarantine；当前 open 最多另占 maxFileBytes，绝不删正在写的文件。
   */
  async #enforceTotalCap() {
    try {
      let total = 0;
      const removable = [];
      for (const dir of [this.queueDir, this.quarantineDir]) {
        for (const name of await fs.readdir(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const file = path.join(dir, name);
          let stat;
          try {
            stat = await fs.stat(file);
          } catch (error) {
            if (error?.code === "ENOENT") continue; // uploader 可能刚刚 ack 后删除
            throw error;
          }
          total += stat.size;
          if (dir === this.quarantineDir || name.endsWith(".ready.jsonl")) {
            removable.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
          }
        }
      }
      removable.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
      for (const entry of removable) {
        if (total <= this.capBytes) break;
        await fs.rm(entry.file, { force: true }); // 与 uploader 竞态时 force 保持幂等
        total -= entry.size;
      }
    } catch (error) {
      this.log("[telemetry] cap enforcement failed:", error?.message ?? error);
    }
  }

  #disable(error) {
    if (this.disabled) return;
    this.disabled = true;
    // 诊断日志不含事件数据(§4.2)
    this.log("[telemetry] writer disabled for this boot:", error?.message ?? error);
  }
}
