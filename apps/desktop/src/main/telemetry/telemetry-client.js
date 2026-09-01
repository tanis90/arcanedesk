// TelemetryClient — 遥测总入口(客户端方案 §4.1):唯一对外 API 是语义化方法,
// 事件只经 telemetry-events.js 工厂产生。遥测任何故障绝不影响聊天/语音/Foundry/Agent。
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  classifyError,
  durationBucket,
  elapsedBucket,
  imageCountBucket,
  latencyBucket,
  makeEvent,
  makeSummaryEvent,
  modelFamily,
  providerFamily,
  skillsUpdateErrorClass,
  textLengthBucket,
} from "./telemetry-events.js";
import { matchSkillFile } from "./skill-usage.js";
import { actionFamily, sideEffectClass, toolFamily } from "./task-taxonomy.js";
import { TelemetryStore } from "./telemetry-store.js";
import { TelemetryUploader } from "./telemetry-uploader.js";
import { TurnSummarizer } from "./turn-summarizer.js";
import { TelemetryWriter } from "./telemetry-writer.js";

// 官方发行版的可选默认端点。自托管构建可用
// ARCANE_TELEMETRY_ENDPOINT 覆盖，或用 ARCANE_TELEMETRY_DISABLED=1 完全关闭。
const DEFAULT_TELEMETRY_ENDPOINT = "https://api.arcanedesk.bitterbebop.cn";

function shortId(prefix) {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export class TelemetryClient {
  /**
   * @param {{
   *   userDataDir: string,
   *   appVersion: string,
   *   packaged: boolean,
   *   log?: (...data: any[]) => void,
   *   fetchImpl?: typeof fetch,
   *   monotonicNow?: () => number,
   * }} options
   */
  constructor({ userDataDir, appVersion, packaged, log = () => {}, fetchImpl, monotonicNow }) {
    this.log = log;
    this.packaged = Boolean(packaged);
    this.appVersion = String(appVersion ?? "0");
    this.releaseChannel = process.env.ARCANE_RELEASE_CHANNEL ?? (this.packaged ? "beta" : "dev");
    this.monotonicNow = monotonicNow ?? (() => performance.now());
    this.disabledByEnv = process.env.ARCANE_TELEMETRY_DISABLED === "1";
    this.telemetryEndpoint = String(process.env.ARCANE_TELEMETRY_ENDPOINT ?? "").trim();
    this.bootId = shortId("boot");
    this.appSessionId = shortId("appss");
    this.seq = 0;
    /** @type {Map<string, string>} mode -> 本 boot 内稳定的 agent session 映射 id */
    this.agentSessions = new Map();
    /** @type {Map<string, { providerFamily: string, modelFamily: string, builtinTools: boolean }>} */
    this.agentSessionInfo = new Map();
    /** @type {Map<string, {turnId: string, startedMonotonicMs: number}>} */
    this.activeTurns = new Map();
    /** @type {Map<string, number>} toolCallId -> started monotonic ms(仅内存,duration 用) */
    this.toolStarts = new Map();
    /** @type {Map<string, { attempt: number, maxAttempts: number, errorClass: string }>} mode -> 当前 retry */
    this.pendingRetries = new Map();
    /** skills 生效目录上下文 getter(main 注入,skill.loaded 归因用);null = 未接线。 */
    this.getSkillsContext = null;
    /** @type {Map<string, { skillName: string, fileKind: string, revision: number }>} toolCallId -> 待确认的 skill 读取 */
    this.pendingSkillReads = new Map();

    this.store = new TelemetryStore(path.join(userDataDir, "config", "telemetry.json"), log);
    const telemetryDir = path.join(userDataDir, "telemetry");
    this.writer = new TelemetryWriter(telemetryDir, { log });
    this.summarizer = new TurnSummarizer({ onSummary: (mode, data) => this.#emitSummary(mode, data) });
    // 上传端点:正式版跟随授权走生产端点;开发版只有显式测试 endpoint 才上传(§3.1)
    this.uploader = new TelemetryUploader({
      telemetryDir,
      getEndpoint: () => {
        if (!this.recording) return null;
        if (!this.packaged) return this.telemetryEndpoint || null;
        return this.store.enabled ? (this.telemetryEndpoint || DEFAULT_TELEMETRY_ENDPOINT) : null;
      },
      getInstallationId: () => this.installationId,
      log,
      fetchImpl,
    });
    this.recording = false;
    this.installationId = null;
    this.started = false;
    this.appStartedRecorded = false;
  }

  /**
   * 采集开关(§3.1):开发版本地总是记录(dogfood),正式版必须用户已同意。
   * 上传另由 uploader 的 getEndpoint 控制。
   */
  #evaluateRecording() {
    if (this.disabledByEnv) {
      this.recording = false;
      return;
    }
    this.recording = this.packaged ? this.store.enabled : true;
  }

  start() {
    if (this.started || this.disabledByEnv) return;
    this.started = true;
    try {
      this.#evaluateRecording();
      // 正式版在用户同意前不生成持久安装标识；开发版 dogfood 与已授权正式版
      // 才需要该上传/事件信封凭据。
      if (this.recording) this.installationId = this.store.ensureInstallationId();
      // whenReady:初始化(含 app.started)完成信号,测试与诊断用
      this.whenReady = this.writer.start().then(() => {
        if (!this.recording) return;
        this.#recordAppStartedOnce();
        this.uploader.start();
      });
      void this.whenReady.catch((error) => {
        this.log("[telemetry] writer init failed:", error?.message ?? error);
      });
    } catch (error) {
      this.log("[telemetry] start failed (telemetry stays off):", error?.message ?? error);
      this.recording = false;
    }
  }

  /** Renderer 只得到产品状态，不暴露 installation_id 或本地路径。 */
  consentStatus() {
    const mode = this.disabledByEnv
      ? "disabled"
      : this.packaged ? "production" : "development";
    return {
      available: !this.disabledByEnv,
      userControllable: this.packaged && !this.disabledByEnv,
      enabled: this.store.enabled,
      decided: this.store.decided,
      recording: this.recording,
      mode,
    };
  }

  async close() {
    try {
      this.uploader.stop();
      await this.writer.prepareQuit();
    } catch {
      /* best-effort */
    }
  }

  /** 用户关闭授权:停写、停传、删本地队列(§5.4)。 */
  async consentDisabled() {
    this.recording = false;
    this.uploader.stop();
    try {
      this.store.setEnabled(false);
    } catch (error) {
      this.log("[telemetry] failed to persist disabled consent:", error?.message ?? error);
    }
    await this.writer.deleteAll();
    this.activeTurns.clear();
    this.pendingRetries.clear();
    this.toolStarts.clear();
    this.pendingSkillReads.clear();
    this.summarizer.reset();
    this.appStartedRecorded = false;
  }

  async consentEnabled() {
    const wasRecording = this.recording;
    this.store.setEnabled(true);
    this.#evaluateRecording();
    if (!this.recording) return;
    if (!this.started) return; // start() 会按已持久化的授权完成初始化与 app.started
    if (!this.installationId) this.installationId = this.store.ensureInstallationId();
    if (this.whenReady) await this.whenReady;
    else await this.writer.start();
    if (this.writer.disabled) await this.writer.start();
    this.#recordAppStartedOnce();
    if (!wasRecording) {
      for (const [mode, info] of this.agentSessionInfo) this.#recordSessionAttachment(mode, info);
    }
    this.uploader.start();
  }

  #recordAppStartedOnce() {
    if (this.appStartedRecorded || !this.recording) return;
    this.appStartedRecorded = true;
    this.#record("app.started", null, null, {
      platform: process.platform,
      arch: process.arch,
      releaseChannel: this.releaseChannel,
    });
  }

  // ---- envelope ----

  #nextEnvelope(mode, turnId) {
    this.seq += 1;
    return {
      bootId: this.bootId,
      seq: this.seq,
      monotonicMs: this.monotonicNow(),
      installationId: this.installationId,
      appSessionId: this.appSessionId,
      agentSessionId: mode ? this.agentSessions.get(mode) ?? null : null,
      turnId: turnId ?? (mode ? this.activeTurns.get(mode)?.turnId ?? null : null),
      mode: mode ?? null,
      appVersion: this.appVersion,
      releaseChannel: this.releaseChannel,
    };
  }

  /** 语义化 record:唯一写入口,任何异常吞掉并只记一条日志(不影响业务)。 */
  #record(name, mode, turnId, fields) {
    if (!this.recording) return;
    try {
      const event = makeEvent(name, fields, this.#nextEnvelope(mode, turnId));
      this.writer.append(event);
      this.#feedSummarizer(name, mode, fields);
    } catch (error) {
      this.log("[telemetry] event dropped:", name, error?.message ?? error);
    }
  }

  #emitSummary(mode, data, turnId = null) {
    if (!this.recording) return;
    try {
      const activeTurnId = this.activeTurns.get(mode)?.turnId ?? null;
      const event = makeSummaryEvent(data, this.#nextEnvelope(mode, turnId ?? activeTurnId));
      this.writer.append(event);
    } catch (error) {
      this.log("[telemetry] summary dropped:", error?.message ?? error);
    }
  }

  #reportBoundaryFailure(method, error) {
    try {
      this.log(`[telemetry] ${method} failed; event dropped:`, error?.message ?? error);
    } catch {
      /* logger 也属于遥测边界，不能把异常带回调用方 */
    }
  }

  /**
   * 所有业务层可调用的同步语义入口都经过这里：未来 summarizer / taxonomy
   * 即使引入会抛错的实现，也只能丢遥测，不能破坏 IPC 或 Foundry 流程。
   */
  #safe(method, operation, fallback = undefined) {
    try {
      return operation();
    } catch (error) {
      this.#reportBoundaryFailure(method, error);
      return fallback;
    }
  }

  #feedSummarizer(name, mode, fields) {
    switch (name) {
      case "model.completed":
        this.summarizer.noteModelCall(mode);
        if (fields.errorClass && fields.errorClass !== "none") this.summarizer.noteError(mode, fields.errorClass);
        break;
      case "model.retry":
        this.summarizer.noteRetry(mode);
        if (!fields.recovered) this.summarizer.noteError(mode, fields.errorClass);
        break;
      case "compaction.completed":
        this.summarizer.noteCompaction(mode);
        break;
      case "tool.completed":
        this.summarizer.noteTool(mode, fields.toolFamily, fields.status === "error");
        break;
      case "foundry.runtime_completed":
        if (fields.receipt && fields.receipt !== "none") this.summarizer.noteReceipt(mode, fields.receipt);
        break;
      default:
        break;
    }
  }

  // ---- AgentHost 适配器(§16.2):在 forwardEvent 的 UI 转换之前消费原始 SDK 事件,
  // 只读元数据,不碰 extractText/args/result。唯一例外:read 工具的 args.path 会被
  // 瞬时用于 skill 目录归属判定(#noteSkillReadStart),只产出白名单 skill 名,
  // 路径本身绝不留存——隐私禁列断言仍在每个事件落盘前兜底。 ----

  /** host attach 完成:记录会话与模型 family。providerId/modelId 原始值不落盘。 */
  sessionAttached(mode, providerId, modelId, builtinTools) {
    return this.#safe("sessionAttached", () => {
      const info = {
        providerFamily: providerFamily(providerId),
        modelFamily: modelFamily(providerId, modelId),
        builtinTools: Boolean(builtinTools),
      };
      this.agentSessionInfo.set(mode, info);
      this.#recordSessionAttachment(mode, info);
    });
  }

  #recordSessionAttachment(mode, info) {
    // 每次 attach/重新授权都建立新的 boot-local 关联，不保留 Pi session 标识。
    this.agentSessions.set(mode, shortId("agss"));
    this.#record("agent.session_attached", mode, null, {
      providerFamily: info.providerFamily,
      modelFamily: info.modelFamily,
      builtinTools: info.builtinTools,
    });
  }

  /** SDK lifecycle 事件适配;绝不抛错。 */
  observeAgentEvent(mode, event) {
    if (!this.recording || !event || typeof event !== "object") return;
    return this.#safe("observeAgentEvent", () => this.#adaptAgentEvent(mode, event));
  }

  #adaptAgentEvent(mode, event) {
    switch (event.type) {
      case "message_end": {
        // 只消费 message_end;turn_end 与其折叠去重,这里不再处理 turn_end
        const message = event.message ?? {};
        if (message.role !== "assistant") return;
        const usage = message.usage ?? {};
        const failed = Boolean(message.errorMessage);
        this.#record("model.completed", mode, null, {
          providerFamily: providerFamily(message.provider),
          modelFamily: modelFamily(message.provider, message.model),
          finish: failed ? "error" : String(message.stopReason ?? "stop"),
          errorClass: failed ? classifyError(message.errorMessage) : "none",
          inputTokens: usage.input ?? 0,
          outputTokens: usage.output ?? 0,
        });
        return;
      }
      case "auto_retry_start":
        this.pendingRetries.set(mode, {
          attempt: event.attempt ?? 1,
          maxAttempts: event.maxAttempts ?? 0,
          errorClass: classifyError(event.errorMessage),
        });
        return;
      case "auto_retry_end": {
        const pending = this.pendingRetries.get(mode);
        this.pendingRetries.delete(mode);
        this.#record("model.retry", mode, null, {
          attempt: pending?.attempt ?? event.attempt ?? 0,
          maxAttempts: pending?.maxAttempts ?? event.maxAttempts ?? 0,
          errorClass: event.success
            ? pending?.errorClass ?? "unknown"
            : event.finalError
              ? classifyError(event.finalError)
              : pending?.errorClass ?? "unknown",
          recovered: Boolean(event.success),
        });
        return;
      }
      case "compaction_end":
        this.#record("compaction.completed", mode, null, {
          reason: event.reason ?? "unknown",
          errorClass: event.errorMessage ? classifyError(event.errorMessage) : "none",
          tokensBefore: event.result?.tokensBefore ?? 0,
        });
        return;
      case "tool_execution_start": {
        this.toolStarts.set(event.toolCallId, this.monotonicNow());
        const name = event.toolName;
        this.#record("tool.started", mode, null, {
          toolFamily: toolFamily(name),
          sideEffectClass: sideEffectClass(name),
        });
        this.#noteSkillReadStart(event);
        return;
      }
      case "tool_execution_end": {
        const started = this.toolStarts.get(event.toolCallId);
        this.toolStarts.delete(event.toolCallId);
        const family = toolFamily(event.toolName);
        const status = event.isError ? "error" : "completed";
        this.#record("tool.completed", mode, null, {
          toolFamily: family,
          status,
          durationMs: started != null ? Math.max(0, this.monotonicNow() - started) : 0,
        });
        this.#noteSkillReadEnd(mode, event);
        return;
      }
      case "agent_settled": {
        this.#closeTurn(mode, "settled");
        return;
      }
      default:
        return;
    }
  }

  /**
   * skill.loaded 的起点(§16.2 注释的唯一例外):tool_execution_start 才带 args,
   * 瞬时判定 read 目标是否落在 skills 生效目录内,是则连同当时 revision 挂起,
   * 等 end 确认读取成功;判定产物只有白名单 skill 名与类别,路径不入任何状态。
   */
  #noteSkillReadStart(event) {
    if (!this.getSkillsContext || event.toolName !== "read") return;
    const context = this.getSkillsContext();
    if (!context?.rootDir) return;
    const match = matchSkillFile(context.rootDir, event.args?.path);
    if (match) this.pendingSkillReads.set(event.toolCallId, { ...match, revision: context.revision });
  }

  /** read 成功收尾才发 skill.loaded;失败/中止的读取不算"加载"。 */
  #noteSkillReadEnd(mode, event) {
    const pending = this.pendingSkillReads.get(event.toolCallId);
    if (pending == null) return;
    this.pendingSkillReads.delete(event.toolCallId);
    if (event.isError) return;
    this.#record("skill.loaded", mode, null, {
      skillName: pending.skillName,
      bundleRevision: pending.revision,
      fileKind: pending.fileKind,
    });
  }

  // ---- 回合生命周期(chat:prompt 是权威入口,§16.1) ----

  /** 空闲提交:创建新回合。返回 turn_id(main 可用于日志,不强制)。 */
  turnStarted(mode) {
    return this.#safe("turnStarted", () => {
      // TODO(telemetry-correctness):若 agent_settled 永久丢失，用有界 watchdog
      // 关闭旧 turn；当前先拒绝覆盖，避免业务路径承担恢复逻辑。
      if (!this.recording || this.summarizer.hasActive(mode)) return null;
      const turnId = shortId("turn");
      const startedAt = this.monotonicNow();
      this.activeTurns.set(mode, { turnId, startedMonotonicMs: startedAt });
      this.summarizer.startTurn(mode, turnId, startedAt);
      this.#record("turn.started", mode, turnId, { source: "chat" });
      return turnId;
    }, null);
  }

  /** 忙碌时追加输入 = steer,不建新回合(§4.3)。 */
  turnSteered(mode) {
    return this.#safe("turnSteered", () => {
      const turn = this.activeTurns.get(mode);
      if (!turn) return;
      this.summarizer.noteSteer(mode);
      this.#record("turn.steered", mode, turn.turnId, {
        elapsedBucket: elapsedBucket(this.monotonicNow() - turn.startedMonotonicMs),
      });
    });
  }

  /** chat:abort。 */
  turnAborted(mode) {
    return this.#safe("turnAborted", () => {
      const turn = this.activeTurns.get(mode);
      if (!turn) return;
      this.summarizer.noteAbort(mode);
      this.#record("turn.aborted", mode, turn.turnId, {
        elapsedBucket: elapsedBucket(this.monotonicNow() - turn.startedMonotonicMs),
        trigger: "user",
      });
      this.#closeTurn(mode, "aborted");
    });
  }

  /** prompt 抛错兜底:回合以 error 关闭(agent_settled 不会再来)。 */
  turnFailed(mode, error) {
    return this.#safe("turnFailed", () => {
      const turn = this.activeTurns.get(mode);
      if (!turn) return;
      this.summarizer.noteError(mode, classifyError(error));
      this.#closeTurn(mode, "error");
    });
  }

  #closeTurn(mode, reason) {
    const turn = this.activeTurns.get(mode);
    if (!turn) return;
    const data = this.summarizer.closeTurn(mode, reason, this.monotonicNow());
    const turnId = turn.turnId;
    this.activeTurns.delete(mode);
    this.pendingRetries.delete(mode);
    if (data) this.#emitSummary(mode, data, turnId);
  }

  /** input.submitted:长度/图片只记 bucket(§7.1)。 */
  inputSubmitted(mode, text, imageCount, submitMethod) {
    return this.#safe("inputSubmitted", () => {
      this.#record("input.submitted", mode, null, {
        lengthBucket: textLengthBucket(String(text ?? "").length),
        imageCountBucket: imageCountBucket(imageCount),
        inputSource: "unknown", // renderer 交互摘要属后续迭代(§16.4)
        submitMethod: submitMethod ?? "unknown",
      });
    });
  }

  /** 审批门结果(§7.3);latency 只进 bucket。 */
  approvalResolved(mode, toolName, outcome, latencyMs) {
    return this.#safe("approvalResolved", () => {
      this.#record("approval.resolved", mode, null, {
        toolFamily: toolFamily(toolName),
        outcome,
        latencyBucket: latencyBucket(latencyMs),
      });
      if (outcome === "denied" || outcome === "timeout") this.summarizer.noteApprovalDenied(mode);
    });
  }

  /** DirectFoundryRuntime 调用结果(§16.3):归入战斗模式活动回合。 */
  foundryRuntimeResult(record = {}) {
    return this.#safe("foundryRuntimeResult", () => {
      const { action, phase, status, receipt, durationMs, errorCode } = record ?? {};
      const errorClass =
        status === "completed"
          ? "none"
          : status === "timeout"
            ? "foundry_timeout"
            : status === "navigated"
              ? "foundry_navigation"
              : status === "aborted"
                ? "user_abort"
                : errorCode
                  ? classifyError({ code: errorCode })
                  : "unknown";
      this.#record("foundry.runtime_completed", "combat", null, {
        actionFamily: actionFamily(action),
        phase,
        status,
        receipt,
        durationMs,
        errorClass,
      });
    });
  }

  /**
   * 注入 skills 生效目录上下文(skill.loaded 的归因来源)。getter 在事件发生时
   * 现取,SkillsUpdater 刷新激活新 bundle 后自动跟随;getter 抛错只丢当次
   * skill 归因(#safe 兜底),不影响工具事件本身。
   */
  setSkillsContext(getContext) {
    this.getSkillsContext = typeof getContext === "function" ? getContext : null;
  }

  /** skills 自更新通道每次 refresh 一条结果事件;app 级运维信号,不归任何回合。 */
  skillsUpdateCompleted(report = {}) {
    return this.#safe("skillsUpdateCompleted", () => {
      const { outcome, fromRevision, toRevision, error, durationMs } = report ?? {};
      this.#record("skills.update_completed", null, null, {
        outcome,
        fromRevision,
        toRevision,
        errorClass: error ? skillsUpdateErrorClass(error) : "none",
        durationMs,
      });
    });
  }
}
