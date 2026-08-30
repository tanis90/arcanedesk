// 授权与安装标识(客户端方案 §3.1):userData/config/telemetry.json。
// 默认关闭;拒绝或关闭不影响任何免费功能。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULTS = {
  enabled: false,
  consentRevision: 1,
  decidedAt: null,
  installationId: null,
};

/** installation_id 即上传凭据,必须 ≥128bit 熵(后端设计 §4),不能像示例那样只用 8 hex。 */
function newInstallationId() {
  return `ins_${randomBytes(16).toString("hex")}`;
}

export class TelemetryStore {
  /**
   * @param {string} file config 目录下的 telemetry.json 路径
   * @param {(...data: any[]) => void} [log]
   */
  constructor(file, log = () => {}) {
    this.file = file;
    this.log = log;
    this.data = this.#load();
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch (error) {
      // 配置目录不可写只会让本 boot 的遥测无法持久化，不能阻断主进程初始化。
      this.#warn("[telemetry] config directory unavailable, using in-memory defaults:", error);
    }
  }

  #warn(message, error) {
    try {
      this.log(message, error?.message ?? error);
    } catch {
      /* 诊断 logger 也不得把遥测故障带回业务流程 */
    }
  }

  #load() {
    try {
      if (!existsSync(this.file)) return { ...DEFAULTS };
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return {
        ...DEFAULTS,
        enabled: Boolean(parsed?.enabled),
        consentRevision: Number(parsed?.consentRevision) || DEFAULTS.consentRevision,
        decidedAt: typeof parsed?.decidedAt === "string" ? parsed.decidedAt : null,
        installationId: typeof parsed?.installationId === "string" ? parsed.installationId : null,
      };
    } catch (error) {
      this.#warn("[telemetry] config unreadable, using defaults:", error);
      return { ...DEFAULTS };
    }
  }

  #save() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /** 幂等确保安装标识存在;重置即换新身份(删除数据后的语义,§14.4)。 */
  ensureInstallationId() {
    if (typeof this.data.installationId === "string" && /^ins_[0-9a-f]{32}$/.test(this.data.installationId)) {
      return this.data.installationId;
    }
    this.data.installationId = newInstallationId();
    this.#save();
    return this.data.installationId;
  }

  resetInstallationId() {
    this.data.installationId = newInstallationId();
    this.#save();
  }

  setEnabled(enabled) {
    this.data.enabled = Boolean(enabled);
    this.data.decidedAt = new Date().toISOString();
    this.#save();
  }

  get enabled() {
    return this.data.enabled;
  }

  get decided() {
    return typeof this.data.decidedAt === "string";
  }
}
