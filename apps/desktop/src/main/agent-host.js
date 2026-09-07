// AgentHost — Pi coding agent session: agent loop is the core of the app.
// Tools come in two layers:
//   界面层:foundry_open + browser_evaluate(战斗做有界诊断;备团可按 DM 指令读写世界)
//   运维视觉层:foundry_screenshot(仅备团/运维模式,返回当前 Foundry viewport)
//   数据层:world_status + combat_*(固定页面 runtime,Turn Protocol v2,四态)
// 审批门默认关闭(ARCANE_APPROVALS=1 恢复 R2 审批卡)。
import { randomUUID } from "node:crypto";
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createBashTool, createPowerShellTool, createReadTool, createWriteTool, createEditTool, defineTool, DefaultResourceLoader, getAgentDir, isToolCallEventType, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { filesystemResource, toolFilesystemPath } from "./scheduling/resource-coordinator.js";
import { Type } from "typebox";
import { capturePageNavigationSafe, encodeFoundryScreenshot } from "./foundry-screenshot.js";
import { evaluateNavigationSafe, readFoundryPageState } from "./foundry-web.js";
import { err, errorToIpc, I18nError } from "./i18n-error.mjs";
import { claimSessionMode, isPathInside, readSessionMode, sessionDirForMode, SessionModeError } from "./session-mode.js";
import { applyArcaneFvttOpsEnvironment } from "./subprocess-env.mjs";
import { SessionProjection } from "./sync/session-projection.js";
import { MessageIdentity, messageKey } from "./sync/message-identity.js";
import { HistoryIndex } from "./sync/history-index.js";
import { TaskCoordinator } from "./tasks/task-coordinator.js";
import { InputJournal } from "./tasks/input-journal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 战斗模式的系统提示 = system-prompts/combat.md。
 * 单一真相就是这个文件;缺失时降级为 SDK 默认 prompt,不让 app 起不来。
 */
function loadCombatSystemPrompt(log) {
  try {
    const promptPath = path.join(__dirname, "..", "..", "system-prompts", "combat.md");
    const body = readFileSync(promptPath, "utf8").trim();
    if (!body) throw new Error("combat prompt is empty");
    log(`[agent] system prompt: system-prompts/combat.md (${body.length} chars)`);
    return body;
  } catch (error) {
    log(`[agent] combat prompt unavailable, fallback to SDK default prompt: ${error.message}`);
    return null;
  }
}

const APPROVALS_ENABLED = process.env.ARCANE_APPROVALS === "1";
const APPROVAL_TIMEOUT_MS = 120_000;

// ---- 模式 profile(M2):行为差异全部收敛到这里,战斗模式走默认值 ----

/**
 * 备团模式的系统提示 = pi 默认 coding prompt + system-prompts/prep.md(append,不覆盖)。
 * 单一真相就是这个文件;缺失时退化为纯 pi 默认 prompt,不让 app 起不来。
 */
function loadPrepPreamble(log) {
  try {
    const promptPath = path.join(__dirname, "..", "..", "system-prompts", "prep.md");
    const body = readFileSync(promptPath, "utf8").trim();
    if (!body) throw new Error("prep preamble is empty");
    log(`[agent] prep preamble: system-prompts/prep.md (${body.length} chars)`);
    return body;
  } catch (error) {
    log(`[agent] prep preamble unavailable, fallback to bare SDK default prompt: ${error.message}`);
    return null;
  }
}

/**
 * 模型按会话生效:会话自身有可恢复模型(JSONL 里的 model_change/assistant
 * provider)时返回 null,让 SDK 在建 session 时恢复会话自己的模型;只有
 * 尚无可恢复模型的会话(全新或只有用户消息)才用设置页全局默认兜底。
 * 这里一旦把全局默认传进 options.model,SDK 就不再恢复会话模型 ——
 * 这是"在 A 切模型导致 B 也跟着变"的第二层机制。
 */
export function initialModelRefForAttach(sessionContextModel, providerStore) {
  if (sessionContextModel?.provider && sessionContextModel?.modelId) return null;
  return providerStore?.effectiveModel?.() ?? null;
}

/**
 * 系统提示正文是中文(战斗回执模板也是中文),界面语言为英文时模型容易被
 * prompt 语言带跑。补一条回复语言指令;zh-CN 不需要(默认行为已是中文)。
 * 指令在建 session 时快照:运行中切语言只影响之后新建的 session。
 */
export function languageDirectiveForLocale(locale) {
  if (locale !== "en-US") return null;
  return (
    "Language: the app interface is set to English. Always respond in English — " +
    "including combat receipts and status lines — unless the user's latest message " +
    "is clearly written in another language; in that case follow the user's language."
  );
}

/**
 * cwd 围栏(M3):备团模式下 edit/write 的目标路径必须 resolve 到 cwd 内。
 * block 时 agent 收到 reason,自行向用户解释;这就是全部"审批 UX"。
 */
function makeCwdFence(getCwd) {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
      const cwd = path.resolve(getCwd());
      const target = path.resolve(cwd, String(event.input.path ?? ""));
      const rel = path.relative(cwd, target);
      if (rel === "") return; // 目标就是 cwd 自身(目录),防御性放行
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return { block: true, reason: `路径在工作目录外:${event.input.path}(允许范围:${cwd})` };
      }
    });
  };
}

/** 战斗模式的行为默认值；cwd 必须由应用层显式注入稳定目录。 */
const COMBAT_PROFILE = {
  mode: "combat",
  getCwd: null, // main 必须注入稳定 cwd；禁止用随启动方式变化的 process.cwd()
  builtinTools: false, // false = tools allowlist 只放 custom tools,禁全部内置
  systemPrompt: "combat", // "combat" = combat.md 全文替换;"append" = pi 默认 prompt + prep.md
  skillPaths: [], // prep: 用 getSkillPaths() 现取(SkillsUpdater 激活副本优先于包内基线)
  getSkillPaths: null,
  customToolNames: null, // null = 全部 desktop custom tools;prep 只启用界面/eval
  fence: false, // prep: true 挂 cwd 围栏
};

/** Pi 默认仍启用 Bash；Windows 必须显式选择一等公民的 PowerShell 工具。 */
export function builtinToolNamesForPlatform(platform = process.platform) {
  return ["read", platform === "win32" ? "powershell" : "bash", "edit", "write"];
}

/**
 * Pi prepends its own fd/rg directory when a shell call begins. Re-apply the
 * Arcane runtime inside the shell spawn hook so the Node directory is truly
 * first in the child environment, independent of Pi's PATH implementation.
 */
export function pinArcaneNodeForShellSpawn(context, nodeBinary, platform = process.platform) {
  applyArcaneFvttOpsEnvironment(context.env, nodeBinary, platform);
  return context;
}

export function arcaneShellTool(cwd, nodeBinary, platform = process.platform, operations) {
  const options = {
    spawnHook: (context) => pinArcaneNodeForShellSpawn(context, nodeBinary, platform),
    ...(operations ? { operations } : {}),
  };
  return platform === "win32"
    ? createPowerShellTool(cwd, options)
    : createBashTool(cwd, options);
}

/**
 * @param {string} text
 * @param {any} [details]
 * @returns {import("@earendil-works/pi-coding-agent").AgentToolResult<any>}
 */
function textResult(text, details) {
  return { content: [{ type: "text", text }], details: details ?? { text } };
}

/** Tool images belong in the model transcript, not the renderer IPC payload. */
function resultForRenderer(result) {
  if (!Array.isArray(result?.content) || !result.content.some((part) => part?.type === "image")) return result;
  return {
    ...result,
    content: result.content.filter((part) => part?.type === "text"),
  };
}

function safeJson(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function extractThinking(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking)
    .join("");
}

/** Short human summary of an execute-turn call, shown on the approval card. */
function summarizeExecuteTurn(params) {
  if (!params) return "(no params)";
  const parts = [];
  if (Array.isArray(params.actions) && params.actions.length > 0) {
    parts.push(
      params.actions
        .map((a) => {
          const targets = Array.isArray(a?.targetTokenIds) && a.targetTokenIds.length > 0 ? ` -> ${a.targetTokenIds.join(", ")}` : "";
          return `${a?.actionId ?? "?"}${targets}`;
        })
        .join("; ")
    );
  } else if (params.actionId) {
    const targets = Array.isArray(params.targetTokenIds) && params.targetTokenIds.length > 0 ? ` -> ${params.targetTokenIds.join(", ")}` : "";
    parts.push(`${params.actionId}${targets}`);
  } else {
    parts.push("(no actionId)");
  }
  if (params.advance) parts.push("[advance]");
  return parts.join(" ");
}

export class AgentHost {
  /**
   * @param {{
   *   foundryRuntime?: any,
   *   getFoundryView?: () => any,
   *   openFoundry?: (url?: string) => Promise<any> | any,
   *   sendToRenderer?: (payload: any) => void,
   *   providerStore?: any,
   *   telemetry?: import("./telemetry/telemetry-client.js").TelemetryClient | null,
   *   runtimeReady?: Promise<unknown>,
   *   log?: (...data: any[]) => void,
   *   profile?: Record<string, any>,
   *   getLocale?: () => string,
   *   taskStorageDir?: string,
   *   scheduler?: any,
   *   resources?: any,
   * }} [deps]
   */
  constructor({ foundryRuntime, getFoundryView, openFoundry, sendToRenderer, providerStore, telemetry, runtimeReady, log = console.log, profile, getLocale, taskStorageDir, scheduler, resources } = {}) {
    this.scheduler = scheduler;
    this.closing = false;
    this.lastUsedAt = Date.now(); this.retired = false; this.operations = 0;
    this.resources = resources;
    this.foundryRuntime = foundryRuntime;
    this.getFoundryView = getFoundryView;
    this.openFoundry = openFoundry;
    this.sendToRenderer = sendToRenderer;
    this.providerStore = providerStore ?? null;
    this.telemetry = telemetry ?? null;
    this.runtimeReady = runtimeReady ?? Promise.resolve(null);
    this.getLocale = getLocale ?? null;
    this.fvttOpsNode = null;
    this.modelRuntime = null;
    // 用户当前选择的模型。缺 key 时它可以先于 AgentSession.model 生效，
    // 让 UI/发送守卫准确指向待配置 provider，而不是继续误认旧会话模型。
    this._currentModelRef = null;
    this.log = log;
    this.session = null;
    this.sessionManager = null;
    this.unsubscribe = null;
    this.projection = new SessionProjection();
    this.messageIdentity = new MessageIdentity();
    this.tasks = null;
    this.taskStorageDir = taskStorageDir;
    this.approvals = new Map();
    this.approvalSnapshots = new Map();
    this.profile = { ...COMBAT_PROFILE, ...(profile ?? {}) };
    // 本轮最近一次模型/重试错误(agent_start 时重置);AgentSession 无 errorMessage 属性,
    // 错误只能从 assistant 消息与 auto_retry 事件里跟踪。
    this._lastError = null;
  }

  /** 本 host 的工作目录:session 分桶、内置工具、skills 扫描全部以它为锚。 */
  cwd() {
    const cwd = this.profile.getCwd?.();
    if (!cwd) throw new I18nError("err.agent.cwdMissing", { mode: this.profile.mode });
    return path.resolve(cwd);
  }

  /** Pi 原生模式存储目录；不依赖 cwd 编码，也不需要外部 path -> mode 索引。 */
  sessionDir() {
    return sessionDirForMode(getAgentDir(), this.profile.mode);
  }

  createSessionManager() {
    const manager = SessionManager.create(this.cwd(), this.sessionDir());
    claimSessionMode(manager, this.profile.mode);
    // The SDK defers the first file until an assistant message finishes. Persist
    // the identity before accepting work, so a crash during turn one is recoverable.
    // Reopen through the public API to put the SDK in append mode (no private flags).
    const file = manager.getSessionFile();
    const fd = openSync(file, "wx");
    try { writeFileSync(fd, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    return SessionManager.open(file, this.sessionDir());
  }

  openSessionManager(sessionPath) {
    if (!isPathInside(this.sessionDir(), sessionPath)) {
      throw new SessionModeError("SESSION_PATH_OUTSIDE_MODE_DIR", "会话文件不在当前模式目录内");
    }
    const manager = SessionManager.open(sessionPath, this.sessionDir());
    claimSessionMode(manager, this.profile.mode);
    return manager;
  }

  /** 目录与 JSONL marker 双重验证；损坏/误放文件不进入 UI，也不会被自动认领。 */
  async listOwnedSessionInfos() {
    const list = await SessionManager.list(this.cwd(), this.sessionDir());
    return list.filter((sessionInfo) => {
      try {
        if (!isPathInside(this.sessionDir(), sessionInfo.path)) return false;
        const manager = SessionManager.open(sessionInfo.path, this.sessionDir());
        return readSessionMode(manager) === this.profile.mode;
      } catch (error) {
        this.log(`[agent:${this.profile.mode}] ignored invalid session ${sessionInfo.path}: ${error.message}`);
        return false;
      }
    });
  }

  /** 统一出站口:所有事件带 mode 标签,renderer 按活动模式过滤。 */
  emit(payload) {
    if (this.retired) return;
    this.lastUsedAt = Date.now();
    if (payload.type === "task_state") this.telemetry?.taskState?.(this.profile.mode, payload.task);
    if (payload.type === "session_switched") {
      this.sendToRenderer({ ...payload, mode: this.profile.mode, sessionId: this.describeCurrent()?.id });
      return;
    }
    // World state belongs to the shared Foundry runtime, not a conversation stream.
    if (payload.type === "world_info") {
      this.sendToRenderer({ ...payload, mode: this.profile.mode });
      return;
    }
    this.sendToRenderer(this.projection.publish({ ...payload, mode: this.profile.mode, taskId: this.task?.id ?? null }));
  }

  /**
   * 启动:有历史会话则继续最近一场,否则新建。
   * 会话本体分别存在 Pi 原生 arcane-desktop-combat / prep sessionDir；
   * cwd 仍写进 header，让备团目录继续按项目过滤。
   */
  async start({ sessionPath = null, fresh = false } = {}) {
    // A clean machine may have another Node on PATH, or none at all. Do not
    // create Pi's shell tools until the packaged FVTT Ops Node has been
    // installed, verified, and injected into the inherited environment.
    const runtime = await this.runtimeReady;
    this.fvttOpsNode = runtime?.nodeBinary ?? process.env.ARCANE_FVTT_NODE ?? null;
    // ModelRuntime 读 ~/.pi/agent 的 auth.json/models.json;用户自管的
    // provider(设置页)再运行时注册进去,两者共存。
    const agentDir = getAgentDir();
    this.modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
    });
    this.providerStore?.applyToRuntime(this.modelRuntime);

    let manager;
    if (sessionPath) {
      manager = this.openSessionManager(sessionPath);
      const restoredCwd = manager.getCwd();
      this.profile = { ...this.profile, getCwd: () => restoredCwd };
    }
    else if (fresh) manager = this.createSessionManager();
    else {
    try {
      const existing = await this.listOwnedSessionInfos();
      const recent = existing
        .slice()
        .sort((a, b) => (Number(b.modified) || 0) - (Number(a.modified) || 0))[0];
      manager = recent ? this.openSessionManager(recent.path) : this.createSessionManager();
    } catch (error) {
      this.log(`[agent:${this.profile.mode}] session discovery failed, starting clean: ${error.message}`);
      manager = this.createSessionManager();
    }
    }
    await this.attach(manager);
    return this.session;
  }

  /** 用给定 SessionManager 建 agent session;new/open 会话都走这里。 */
  async attach(sessionManager) {
    const cwd = this.cwd();
    claimSessionMode(sessionManager, this.profile.mode);
    // 战斗只带 desktop custom tools;备团保留 pi 内置工具,再叠加
    // foundry_open/foundry_screenshot/browser_evaluate,直接操作右侧已登录的 GM 页面。
    // Pi tools intentionally carry heterogeneous TypeBox schemas. Widen the
    // inferred empty-schema union before adding the native shell tool.
    const customTools = /** @type {any[]} */ (this.buildTools());
    if (this.profile.builtinTools) {
      if (!this.fvttOpsNode) throw new Error("Arcane FVTT Node is unavailable for the Agent shell");
      // SDK custom tools override built-ins with the same name. This keeps Pi's
      // native shell behavior/rendering while enforcing our spawn environment.
      customTools.push(...[arcaneShellTool(cwd, this.fvttOpsNode), createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd)]
        .map(tool => this.coordinateWorkspaceTool(tool)));
    }
    const options = {
      cwd,
      customTools,
      sessionManager,
      modelRuntime: this.modelRuntime ?? undefined,
      agentDir: getAgentDir(),
    };
    if (!this.profile.builtinTools) {
      // allowlist 只放 custom tools:无 shell/文件等内置工具。
      // 注意不能用 noTools:"all"——那会连 customTools 一起禁掉,
      // 模型收不到任何工具定义,只能把工具调用幻觉成文本。
      options.tools = customTools.map((tool) => tool.name);
    } else {
      // Pi 默认仍是 read/bash/edit/write；Windows 要显式换成 powershell。
      // 传了 customTools 也不会自动激活它们,所以一并放进 allowlist。
      options.tools = [...builtinToolNamesForPlatform(), ...customTools.map((tool) => tool.name)];
    }
    // 模型按会话生效:已有会话恢复自己的模型,新会话才吃全局默认(见
    // initialModelRefForAttach)。传 model 对象是为了绕过 pi settings.json
    // 的默认,而不是覆盖会话选择。
    const sessionContextModel = sessionManager.buildSessionContext?.().model ?? null;
    const preferredModelRef = initialModelRefForAttach(sessionContextModel, this.providerStore);    if (preferredModelRef && this.modelRuntime) {
      const preferred = this.modelRuntime.getModel(preferredModelRef.providerId, preferredModelRef.modelId);
      if (preferred) options.model = preferred;
    }
    if (this.profile.systemPrompt === "combat") {
      // 战斗纪律系统提示:全量替换 SDK 默认的 coding-agent prompt
      // (默认 prompt 讲文件/代码工具,对无 shell 的战斗 agent 是误导)。
      // appendSystemPromptOverride 必须显式置空,挡掉 ~/.pi 的 APPEND_SYSTEM.md。
      const systemPrompt = loadCombatSystemPrompt(this.log);
      if (systemPrompt) {
        const languageDirective = languageDirectiveForLocale(this.getLocale?.());
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir: getAgentDir(),
          systemPromptOverride: () => [systemPrompt, languageDirective].filter(Boolean).join("\n\n"),
          appendSystemPromptOverride: () => [],
        });
        await loader.reload();
        options.resourceLoader = loader;
      }
    } else {
      // 备团:保留 pi 默认 coding prompt(它准确描述了内置工具),追加模式序言;
      // skills 走原生渐进披露(<available_skills> 清单,read 按需加载);
      // fence 挂 cwd 围栏 extension。
      const prepPreamble = loadPrepPreamble(this.log);
      const languageDirective = languageDirectiveForLocale(this.getLocale?.());
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        appendSystemPromptOverride: () => [prepPreamble, languageDirective].filter(Boolean),
        // skillPaths 每次建 session 现取:SkillsUpdater 刷新成功后,新 session
        // 立即落到 userData 激活副本,老 session 保持建会话时的快照。
        additionalSkillPaths: this.profile.getSkillPaths ? this.profile.getSkillPaths() : this.profile.skillPaths,
        extensionFactories: this.profile.fence
          ? [{ name: "arcane-cwd-fence", hidden: true, factory: makeCwdFence(this.profile.getCwd) }]
          : [],
      });
      await loader.reload();
      options.resourceLoader = loader;
    }
    const { session } = await createAgentSession(options);
    this.session = session;
    this.sessionManager = sessionManager;
    this.projection = new SessionProjection({ sessionId: sessionManager.getSessionId() });
    this.messageIdentity = new MessageIdentity();
    this.tasks = null;
    this.taskCoordinator();
    this._lastMessageKey = null;
    this.unsubscribe = session.subscribe((event) => this.forwardEvent(event));
    // ref/label 一律以会话实际持有的模型为准:恢复出的会话模型或 SDK 兜底
    // 结果都直接读 session.model,preferred 只在新会话上与它一致。
    const model = session.model;
    this._currentModelRef = model?.provider && (model.id ?? model.name)
      ? { providerId: model.provider, modelId: model.id ?? model.name }
      : (preferredModelRef ?? null);
    const selectedModel = model;
    this.modelLabel = this._currentModelRef
      ? `${this._currentModelRef.providerId}/${this._currentModelRef.modelId}`
      : null;
    this.supportsImages = selectedModel?.input?.includes("image") ?? true;
    this.log(`[agent:${this.profile.mode}] session ready (${customTools.length} custom tools, builtin ${this.profile.builtinTools ? "ON" : "off"}, approvals ${APPROVALS_ENABLED ? "ON" : "off"}, id=${sessionManager.getSessionId?.()?.slice(0, 8) ?? "?"})`);
    this.emit({ type: "model_info", label: this.modelLabel, supportsImages: this.supportsImages });
    // 遥测只拿 provider/model 的 family 映射,原始 id 不落盘(§7.2)
    this.telemetry?.sessionAttached(this.profile.mode, session.model?.provider, session.model?.id ?? session.model?.name, this.profile.builtinTools);
  }

  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
    this.sessionManager = null;
    this._currentModelRef = null;
  }

  // ---- 多会话管理 ----

  describeCurrent() {
    if (!this.sessionManager) return null;
    return {
      id: this.sessionManager.getSessionId?.() ?? null,
      path: this.sessionManager.getSessionFile?.() ?? null,
      name: this.sessionManager.getSessionName?.() ?? "",
    };
  }

  async listSessions() {
    try {
      const list = await this.listOwnedSessionInfos();
      const activePath = this.sessionManager?.getSessionFile?.();
      const mapped = list
        .map((s) => ({
          id: s.id,
          path: s.path,
          name: s.name ?? "",
          firstMessage: (s.firstMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
          // 结构化文案 key:仅"未保存新会话"占位用(见下方 unshift),真实首条消息是用户数据
          firstMessageI18n: null,
          modified: s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0,
          messageCount: s.messageCount ?? 0,
          active: s.path === activePath,
        }))
        .sort((a, b) => b.modified - a.modified);
      // 全新会话还没有落盘文件(首轮消息才写),list 看不到它——
      // 手动补一条"当前会话"在最上面,否则抽屉里会出现没有任何 active 项的瞬间。
      // firstMessageI18n 指向字典 key,渲染层按当前语言显示(首条消息是用户数据,不翻)。
      if (activePath && !mapped.some((s) => s.path === activePath)) {
        mapped.unshift({
          id: this.sessionManager.getSessionId?.() ?? null,
          path: activePath,
          name: "",
          firstMessage: "",
          firstMessageI18n: "sessions.unsaved",
          modified: Date.now(),
          messageCount: 0,
          active: true,
        });
      }
      return mapped;
    } catch (error) {
      this.log("[agent] list sessions failed:", error.message);
      return [];
    }
  }

  historyIndex() {
    if (!this.session) return new HistoryIndex([]);
    const manager = this.sessionManager;
    const leaf = manager?.getLeafId?.();
    if (manager?.getLeafId && this._historyCache?.manager === manager && this._historyCache.leaf === leaf) return this._historyCache.index;
    const branch = manager?.getBranch?.();
    const records = this.session ? (branch ? branch.filter(entry => entry.type === "message")
      : (this.session.messages ?? []).map(message => ({ message }))) : [];
    const index = new HistoryIndex(records);
    if (manager?.getLeafId) this._historyCache = { manager, leaf, index };
    return index;
  }

  buildHistory() { return this.historyIndex().all(); }

  currentPayload(historyQuery = {}) {
    const page = this.historyIndex().page(historyQuery);
    const messageKeys = new Set(page.history.flatMap(row => [row.key, row.legacyKey]));
    return {
      attentions: this.tasks?.snapshotAttentions() ?? [],
      approvals: structuredClone([...this.approvalSnapshots.values()]),
      pendingModel: this.tasks?.pendingModel ?? null,
      inputs: this.tasks?.snapshotInputs(messageKeys) ?? [],
      acceptedCommandIds: this.tasks?.snapshotInputCommandIds?.() ?? [],
      busy: this.busy,
      task: this.task ? { ...this.task } : null,
      inFlight: this.projection.snapshot(),
      session: this.describeCurrent(),
      ...page,
      modelLabel: this.modelLabel ?? null,
      supportsImages: this.supportsImages ?? true,
    };
  }
  async newSession() {
    await this.abort();
    this.detach();
    await this.attach(this.createSessionManager());
    this.emit({ type: "session_switched", ...this.currentPayload() });
    return { ok: true };
  }

  async openSession(path) {
    if (!path) return { ok: false, error: "empty path" };
    if (this.sessionManager?.getSessionFile?.() === path) return { ok: true, noop: true };
    await this.abort();
    this.detach();
    try {
      await this.attach(this.openSessionManager(path));
    } catch (error) {
      // 目标会话损坏:退回全新会话,不让 app 死在这里
      await this.attach(this.createSessionManager());
      this.emit({ type: "session_switched", ...this.currentPayload() });
      return { ok: false, error: errorToIpc(error) };
    }
    this.emit({ type: "session_switched", ...this.currentPayload() });
    return { ok: true };
  }

  async deleteSession(path) {
    if (!path) return { ok: false, error: "empty path" };
    if (!isPathInside(this.sessionDir(), path)) {
      return { ok: false, code: "SESSION_PATH_OUTSIDE_MODE_DIR", error: err("err.session.pathOutside") };
    }
    if (this.sessionManager?.getSessionFile?.() === path) {
      await this.newSession(); // 删除当前会话:先切到一场新的
    }
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  // ---- 模型 / provider ----

  /** 设置页模型下拉的候选列表:{ providerId, modelId, label }。 */
  async listModels() {
    if (!this.modelRuntime) return [];
    try {
      const models = await this.modelRuntime.getAvailable();
      return models.map((m) => ({
        providerId: m.provider,
        modelId: m.id,
        label: `${m.provider}/${m.id}`,
        name: m.name ?? m.id,
      }));
    } catch (error) {
      this.log("[agent] list models failed:", error.message);
      return [];
    }
  }

  /** 当前会话真正持有的模型；会话尚未启动时退回持久化选择的有效模型。 */
  currentModelRef() {
    if (this._currentModelRef?.providerId && this._currentModelRef?.modelId) {
      return { ...this._currentModelRef };
    }
    const model = this.session?.model;
    const providerId = String(model?.provider ?? "");
    const modelId = String(model?.id ?? model?.name ?? "");
    if (providerId && modelId) return { providerId, modelId };
    return this.providerStore?.effectiveModel?.() ?? null;
  }

  /** 发送前只检查本 host 当前模型，不再读取可能与会话脱节的默认偏好。 */
  missingApiKeyForCurrentModel() {
    return this.providerStore?.missingApiKeyForModel?.(this.currentModelRef()) ?? null;
  }

  /**
   * 立即切当前会话模型;model_change 由 Pi 写进本会话 JSONL,重开/重启后
   * 自然恢复。只作用于本 host 当前会话,不广播、不改全局默认。
   */
  async setCurrentModel(providerId, modelId, applyNow = false) {
    this.operations++;
    try {
      const ref = { providerId, modelId };
      const model = this.modelRuntime?.getModel(providerId, modelId) ?? null;
      if (this.modelRuntime && !model) {
        return { ok: false, error: `model not found: ${providerId}/${modelId}` };
      }
      if (this.busy && !applyNow) {
        this.taskCoordinator().setPendingModel(ref);
        return { ok: true, deferred: true, model: ref };
      }
      // 会话已在该模型上:不重复写 model_change,只同步 UI 状态
      const current = this.session?.model;
      const sameModel = current?.provider === providerId && (current.id ?? current.name) === modelId;
      const missingKey = this.providerStore?.missingApiKeyForModel?.(ref) ?? null;
      if (missingKey) {
        this._currentModelRef = ref;
        this.modelLabel = `${providerId}/${modelId}`;
        this.supportsImages = model?.input?.includes("image") ?? true;
        this.emit({ type: "model_info", label: this.modelLabel, supportsImages: this.supportsImages });
        if (!applyNow && this.tasks?.pendingModel) this.tasks.setPendingModel(null);
        return { ok: true, pendingKey: true };
      }
      if (!sameModel && model && this.session) {
        await this.session.setModel(model);
      }
      this._currentModelRef = ref;
      this.modelLabel = `${providerId}/${modelId}`;
      this.supportsImages = model?.input?.includes("image") ?? true;
      this.emit({ type: "model_info", label: this.modelLabel, supportsImages: this.supportsImages });
      if (!applyNow && this.tasks?.pendingModel) this.tasks.setPendingModel(null);
      return { ok: true, ...(sameModel ? { noop: true } : null) };
    } finally { this.operations--; }
  }

  /** 会话是否已开始对话(有消息条目);空会话才允许被全局默认接管。 */
  sessionHasMessages() {
    const entries = this.sessionManager?.getEntries?.() ?? [];
    return entries.some((entry) => entry?.type === "message");
  }

  /** slash 候选:当前会话加载出的 skills + prompt 模板,供输入框弹窗。 */
  listSlashCommands() {
    if (!this.session) return { skills: [], templates: [] };
    let skills = [];
    let templates = [];
    try {
      skills = (this.session.resourceLoader?.getSkills?.().skills ?? []).map((s) => ({
        name: s.name,
        description: s.description ?? "",
      }));
    } catch (error) {
      this.log("[agent] list skills failed:", error.message);
    }
    try {
      templates = (this.session.promptTemplates ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        argumentHint: t.argumentHint ?? "",
      }));
    } catch (error) {
      this.log("[agent] list prompt templates failed:", error.message);
    }
    return { skills, templates };
  }

  /** 手动压缩上下文(pi 原生 compact;自动压缩默认开启,这里只是手动入口)。 */
  async compact(instructions) {
    this.operations++;
    try {
      if (!this.session) throw new Error("agent session not started");
      if (this.session.isCompacting) return { ok: false, error: "compaction already in progress" };
      const result = await this.session.compact(instructions || undefined);
      return { ok: true, tokensBefore: result?.tokensBefore };
    } finally { this.operations--; }
  }

  get task() { return this.tasks?.task ?? null; }
  get busy() { return this.tasks?.busy ?? false; }

  taskCoordinator() {
    if (this.tasks) return this.tasks;
    const sessionId = this.describeCurrent()?.id ?? "unattached";
    const file = this.taskStorageDir ? path.join(this.taskStorageDir, `${sessionId}.jsonl`) : null;
    this.tasks = new TaskCoordinator({ sessionId, scheduler: this.scheduler, journal: new InputJournal(file), emit: event => this.emit(event),
      adapter: {
        beginTask: async (pending) => {
          if (!pending) return;
          const result = await this.setCurrentModel(pending.providerId, pending.modelId, true);
          if (!result.ok || result.pendingKey) throw new Error(result.error ?? "Selected model requires configuration");
          if (this.tasks.pendingModel === pending) this.tasks.setPendingModel(null);
        },
        prompt: (text, images) => this.session.prompt(text, images?.length ? { images } : undefined),
        steer: (text, images) => this.session.steer(text, images?.length ? images : undefined),
        isStreaming: () => Boolean(this.session?.isStreaming),
        clearQueue: () => this.session?.clearQueue?.(),
        settleTask: async taskId => {
          const waitId = `settle:${taskId}`;
          try {
            await this.resources?.waitForOwner(sessionId, taskId, details => {
              if (this.tasks.task?.id === taskId) this.tasks.resourceWaiting(waitId, details);
            });
          } finally {
            if (this.tasks.task?.id === taskId) this.tasks.resourceWaiting(waitId, null);
          }
        },
        abort: async () => {
          for (const id of this.approvals.keys()) this.respondApproval(id, false);
          await this.session?.abort();
        },
      } });
    return this.tasks;
  }

  submitInput(text, images, commandId, prepare = null) {
    if (this.closing) return { ok: false, code: "APP_STOPPING" };
    if (this.deleting) return { ok: false, code: "SESSION_DELETING" };
    if (!this.session) throw new Error("agent session not started");
    const result = this.taskCoordinator().submit({ commandId, text, images, prepare });
    if (result.ok && !result.duplicate && !this.sessionManager?.getSessionName()) {
      try { this.sessionManager?.appendSessionInfo(text.trim().replace(/\s+/g, " ").slice(0, 24)); } catch { /* naming is best effort */ }
    }
    return result;
  }

  async prompt(text, images) {
    if (!this.session) throw new Error("agent session not started");
    if (this.busy) throw new Error("Task already running");
    this.submitInput(text, images, randomUUID());
    await this.tasks.run;
    // 首轮结束后用首条用户消息做会话标题(best-effort;侧栏展示用)
    try {
      if (this.sessionManager && !this.sessionManager.getSessionName()) {
        const title = text.trim().replace(/\s+/g, " ").slice(0, 24);
        if (title) this.sessionManager.appendSessionInfo(title);
      }
    } catch {
      /* naming is best-effort */
    }
  }

  async steer(text, images) {
    if (!this.session) throw new Error("agent session not started");
    return this.submitInput(text, images, randomUUID());
  }

  async abort(taskId = null) {
    if (!this.session) return;
    return this.taskCoordinator().stop(taskId);
  }

  dispose() {
    this.retired = true;
    this.deleting = true;
    const unsubscribe = this.unsubscribe, session = this.session;
    this.unsubscribe = null;
    this.session = null;
    try { unsubscribe?.(); }
    finally { try { session?.dispose(); } finally { this.telemetry?.releaseSession?.(); } }
  }

  canEvict() {
    if (this.busy || this.tasks?.run || this.operations || this.deleting || this.closing || this.session?.isStreaming || this.session?.isCompacting || this.approvals.size) return false;
    const ref = this._currentModelRef, model = this.session?.model;
    // An unconfigured model choice can still be memory-only; keep its owner resident.
    if (ref && (model?.provider !== ref.providerId || (model?.id ?? model?.name) !== ref.modelId)) return false;
    return Boolean(this.sessionManager?.getSessionFile?.() && this.sessionManager?.getHeader?.());
  }
  persistForEviction() {
    if (!this.canEvict()) throw new Error("Session still owns active or unsaved state");
    const file = this.sessionManager.getSessionFile();
    new InputJournal(file).compact([this.sessionManager.getHeader(), ...this.sessionManager.getEntries()]);
    this.tasks?.compact(true);
  }

  async withResources(keys, signal, operation) {
    if (!this.resources) return operation();
    const tasks = this.tasks;
    const taskId = tasks?.task?.id;
    const owner = { sessionId: this.describeCurrent()?.id, taskId, name: this.describeCurrent()?.name || "" };
    const requestId = randomUUID();
    const waiting = details => { if (tasks?.task?.id === taskId) tasks.resourceWaiting(requestId, details); };
    try {
      return await this.resources.run(keys, owner, signal, waiting, async () => {
        waiting(null); return operation();
      });
    } finally { waiting(null); }
  }

  coordinateWorkspaceTool(tool) {
    if (!this.resources) return tool;
    return { ...tool, execute: (id, params, signal, onUpdate, context) => {
      const cwd = this.cwd();
      const keys = () => {
        const resolved = [filesystemResource(cwd)];
        if (typeof params?.path === "string") resolved.push(filesystemResource(toolFilesystemPath(params.path, cwd, tool.name === "read")));
        return resolved;
      };
      return this.withResources(keys, signal, () => tool.execute(id, params, signal, onUpdate, context));
    } };
  }

  // ---- approval gate(opt-in,默认关闭) ----

  maybeRequestApproval(payload) {
    if (!APPROVALS_ENABLED) return Promise.resolve(true);
    const requestedAt = Date.now();
    const pending = new Promise((resolve) => {
      const approvalId = `appr_${randomUUID()}`;
      const finish = (approved, outcome = approved ? "allowed" : "denied") => {
        clearTimeout(timer);
        this.approvals.delete(approvalId);
        this.approvalSnapshots.delete(approvalId);
        this.emit({ type: "approval_resolved", approvalId, approved });
        if (!this.tasks?.admission && this.tasks?.task?.state === "waiting_user" && !this.approvals.size && !this.tasks.snapshotAttentions().some(a => a.state === "pending")) this.tasks.setTaskState("running");
        this.telemetry?.approvalResolved(this.profile.mode, payload?.tool, outcome, Date.now() - requestedAt);
        resolve(approved);
      };
      const timer = setTimeout(() => {
        this.log(`[agent] approval ${approvalId} timed out -> denied`);
        finish(false, "timeout");
      }, APPROVAL_TIMEOUT_MS);
      this.approvals.set(approvalId, finish);
      this.approvalSnapshots.set(approvalId, { approvalId, requestedAt, ...payload });
      if (this.tasks?.busy && this.tasks.task.state !== "stopping") this.tasks.setTaskState("waiting_user");
      this.emit({ type: "approval_request", approvalId, ...payload });
    });
    return this.tasks?.admission ? this.tasks.admission.waitForUser(pending).catch(() => false) : pending;
  }

  respondApproval(approvalId, approved) {
    this.approvals.get(approvalId)?.(Boolean(approved));
  }

  // ---- events -> renderer ----

  forwardEvent(event) {
    this.messageIdentity.observe(event);
    this.tasks?.observe(event);
    // 遥测适配器在 UI 转换、去重与 early return 之前消费原始 SDK 生命周期事件,
    // 只读元数据,不碰 extractText/event.args/event.result(§16.2);内部自吞错误。
    // 例外:read 工具的 args.path 瞬时用于 skill.loaded 归属判定,路径不留存
    // (见 telemetry-client.js #noteSkillReadStart)。
    if (this.telemetry) this.telemetry.observeAgentEvent(this.profile.mode, event);
    let out = null;
    switch (event.type) {
      case "agent_start":
        this._lastError = null;
        this.log(`[agent:${this.profile.mode}] event agent_start`);
        this.emit({ type: "agent_start" });
        return;
      case "auto_retry_start":
        this._lastError = event.errorMessage ?? this._lastError;
        this.emit({ type: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts });
        this.log(`[agent:${this.profile.mode}] auto-retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
        return;
      case "auto_retry_end":
        this._lastError = event.success ? null : (event.finalError ?? this._lastError);
        this.emit({ type: "auto_retry_end", success: event.success });
        this.log(`[agent:${this.profile.mode}] auto-retry end (success=${event.success}${event.finalError ? `, error=${event.finalError}` : ""})`);
        return;
      case "turn_end":
      case "message_end": {
        const message = event.message ?? {};
        if (message.role !== "assistant") return; // 用户消息已在本地回显,避免重复
        const key = messageKey(message);
        if (this._lastMessageKey === key) return; // turn_end 与 message_end 去重
        this._lastMessageKey = key;
        if (message.errorMessage) this._lastError = message.errorMessage;
        const text = extractText(message);
        const thinking = extractThinking(message);
        if (text || thinking) {
          out = { type: "message", role: "assistant", text, thinking, key };
        } else if (message.errorMessage) {
          // 模型/接口错误必须可见,不能静默 settled。textI18n 让渲染层按当前语言显示。
          out = {
            type: "message",
            role: "assistant",
            textI18n: { key: "agent.modelCallFailed", params: { error: message.errorMessage } },
            key,
          };
        } else {
          return;
        }
        break;
      }
      case "message_update": {
        // 流式:转发 assistant 消息的当前累积文本与思考,renderer 就地更新。
        const message = event.message ?? {};
        if (message.role !== "assistant") return;
        const text = extractText(message);
        const thinking = extractThinking(message);
        if (!text && !thinking) return;
        out = { type: "message_delta", key: messageKey(message), text, thinking };
        break;
      }
      case "tool_execution_start":
        out = {
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        };
        break;
      case "tool_execution_end":
        out = {
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: Boolean(event.isError),
          result: resultForRenderer(event.result),
        };
        break;
      case "agent_settled":
        out = { type: "agent_settled" };
        this.log(`[agent] settled; lastError=${this._lastError ?? "none"}`);
        break;
      case "compaction_start":
        // pi 自动压缩(threshold/overflow)或 /compact(manual):透出给状态行
        out = { type: "compaction_start", reason: event.reason };
        this.log(`[agent:${this.profile.mode}] compaction start (${event.reason})`);
        break;
      case "compaction_end":
        out = {
          type: "compaction_end",
          reason: event.reason,
          errorMessage: event.errorMessage ?? null,
          tokensBefore: event.result?.tokensBefore ?? null,
        };
        this.log(`[agent:${this.profile.mode}] compaction end (${event.reason}, error=${event.errorMessage ?? "none"})`);
        break;
      case "agent_end":
        if (event.willRetry) return;
        out = { type: "agent_end" };
        this.log(`[agent] turn ended; messages=${event.messages?.length ?? 0}; lastError=${this._lastError ?? "none"}`);
        break;
      default:
        this.log(`[agent:${this.profile.mode}] event ${event?.type}`);
        return;
    }
    this.emit(out);
  }

  // ---- tools ----

  buildTools() {
    const host = this;
    const prepWorldEdit = host.profile.mode === "prep";
    const requestUserInput = defineTool({
      name: "request_user_input", label: "Ask the user",
      description: "Ask a concrete question when user input is necessary to continue. The task waits for the user's answer. Use options for concise choices; free-text answers are always allowed. Do not add unnecessary approval requests.",
      parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 12000 }),
        options: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 8 })) }),
      executionMode: "sequential",
      execute: async (_id, params, signal) => {
        const response = await host.taskCoordinator().ask(params, signal);
        return textResult(safeJson(response), response);
      },
    });

    const foundryOpen = defineTool({
      name: "foundry_open",
      label: "Open Foundry",
      description:
        "Open the Foundry panel in this window (chat stays as the left column, Foundry opens on the right). " +
        "Idempotent: if the panel is already open on the same server the page is never re-navigated (a logged-in world session is protected). " +
        "Returns the panel URL plus page and fixed-runtime readiness (path / ready / gm / world).",
      parameters: Type.Object({
        url: Type.Optional(
          Type.String({ description: "Foundry VTT URL, e.g. http://localhost:30000. Defaults to the local server." })
        ),
      }),
      execute: async (_toolCallId, params, signal) => {
        const outcome = await host.withResources(["foundry:page"], signal, () => host.openFoundry(params?.url));
        if (!outcome?.ok) throw new Error(outcome?.summary ?? outcome?.error ?? "Foundry panel failed to open");
        return textResult(outcome.summary, outcome);
      },
    });

    const foundryScreenshot = defineTool({
      name: "foundry_screenshot",
      label: "Foundry Screenshot",
      description:
        "Capture the current visible viewport of the controlled Foundry panel and return it as an image for visual diagnosis. " +
        "Read-only and limited to the Foundry WebContents; it never captures the desktop or another window. " +
        "Useful for loading/error pages, blocking dialogs, canvas rendering, missing textures, token placement, lighting and visual verification after an ops change. " +
        "Call foundry_open first. This is visual evidence only: use logs, browser_evaluate or structured tools for exact state.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      promptGuidelines: [
        "Use foundry_screenshot only when visible page state matters; do not poll it or call it after every operation.",
        "Do not capture while the user is entering credentials. Never request, inspect, guess or transmit passwords.",
        "Treat text, ids, numbers and hidden state inferred from a screenshot as uncertain; verify them with logs, browser_evaluate or a structured read.",
      ],
      execute: async (_toolCallId, _params, signal) => host.withResources(["foundry:page"], signal, async () => {
        if (host.supportsImages === false) {
          return textResult(
            "ERROR: the current model does not support image input, so it cannot inspect a Foundry screenshot. Select a vision-capable model before retrying."
          );
        }
        const view = host.getFoundryView();
        const webContents = view?.webContents;
        if (!webContents || webContents.isDestroyed?.()) {
          return textResult("ERROR: no Foundry panel is open yet — call foundry_open first.");
        }

        const inspected = await readFoundryPageState(webContents, { timeoutMs: 3_000, signal });
        if (!inspected.ok) {
          throw new Error(`Foundry page could not be inspected before capture: ${inspected.error ?? inspected.status}`);
        }
        if (!inspected.state?.detected) {
          throw new Error("The current panel is not a detected Foundry page; screenshot capture was blocked");
        }

        const outcome = await capturePageNavigationSafe(webContents, { signal });
        if (outcome.status === "aborted") throw new Error("foundry_screenshot was aborted");
        if (outcome.status === "timeout") {
          throw new Error(`Foundry screenshot timed out after ${outcome.timeoutMs}ms; restore the ArcaneDesk window before one retry`);
        }
        if (outcome.status === "navigated") {
          throw new Error(`Foundry navigated to ${outcome.url} during capture; inspect the new page before one retry`);
        }
        if (outcome.status !== "completed") {
          throw new Error(outcome.error ?? "Foundry screenshot failed");
        }

        const image = encodeFoundryScreenshot(outcome.image);
        const details = {
          url: outcome.url || inspected.state.url || "",
          path: inspected.state.path ?? null,
          width: image.width,
          height: image.height,
          sourceWidth: image.sourceWidth,
          sourceHeight: image.sourceHeight,
          mimeType: image.mimeType,
          bytes: image.bytes,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Captured the current visible Foundry viewport at ${details.url || "the active panel"} ` +
                `(${details.width}x${details.height}, ${details.mimeType}). ` +
                "Use the image for visual diagnosis and verify exact state through a structured read.",
            },
            { type: "image", data: image.data, mimeType: image.mimeType },
          ],
          details,
        };
      }),
    });

    const browserEvaluate = defineTool({
      name: "browser_evaluate",
      label: "Browser Evaluate",
      description: prepWorldEdit
        ? "Run JavaScript inside the controlled Foundry page and return the JSON-serialized result. " +
          "In prep mode this tool MAY read or change the current world when the DM explicitly asks for content synchronization. " +
          "Use public Foundry Document APIs (for example Actor.create/document.update/createEmbeddedDocuments), await writes, and return a compact verification value. " +
          "Call foundry_open first; require a ready GM /game page. Never submit /join or handle credentials. " +
          "Do not perform live combat actions. Provide ONE expression or an async IIFE that returns a value."
        : "Run JavaScript inside the Foundry page and return the JSON-serialized result. " +
          "Use it only for bounded diagnostics of page/game initialization. " +
          "Do not use it to submit the /join form or handle credentials; the user logs in directly in the Foundry panel. " +
          "Do not use it to bypass world_status or the structured combat tools for reads or writes. " +
          "Provide ONE expression or an async IIFE that returns a value. " +
          "For structured combat data always use world_status/combat_*.",
      parameters: Type.Object({
        code: Type.String({ description: "JS expression or async IIFE returning a value" }),
      }),
      executionMode: "sequential",
      promptGuidelines: prepWorldEdit
        ? [
            "Connecting to a world NEVER requires the admin/setup password. On /join, ask the user to log in directly in the right-hand Foundry panel. Do not navigate to /setup.",
            "Before a world write, verify game.ready && game.user.isGM, inspect collisions and source compendium entries, then use the smallest public Document API mutation and read it back.",
            "If a write times out, navigates, or has an uncertain result, do not retry blindly. Query the world to determine whether it already completed.",
            "Never request, inspect, guess or brute-force passwords through model tools.",
          ]
        : [
            "Connecting to a world NEVER requires the admin/setup password. On /join, ask the user to log in directly in the right-hand Foundry panel. Do not navigate to /setup.",
            "Use browser_evaluate only for bounded diagnostics. Never use arbitrary JavaScript to replace world_status or combat_* reads/writes.",
            "Never request, inspect, guess or brute-force passwords through model tools.",
          ],
      execute: async (_toolCallId, params, signal) => {
        const approved = await host.maybeRequestApproval({
          tool: "browser_evaluate",
          summary: params.code?.slice(0, 200),
          args: params,
        });
        if (!approved) return textResult("DM declined this code; do not retry it.");
        return host.withResources(["foundry:page"], signal, async () => {
          const view = host.getFoundryView();
          if (!view) return textResult("ERROR: no Foundry panel is open yet — call foundry_open first.");
          const outcome = await evaluateNavigationSafe(view.webContents, params.code, {
            signal,
            timeoutMs: prepWorldEdit ? 60_000 : undefined,
          });
          if (outcome.status === "completed") {
            return textResult(safeJson(outcome.value), { result: outcome.value });
          }
          if (outcome.status === "navigated") {
            return textResult(
              safeJson({ navigated: true, url: outcome.url, note: "Navigation was requested; inspect the new page in a new call after resource admission." }),
              outcome
            );
          }
          if (outcome.status === "aborted") throw new Error("browser_evaluate was aborted");
          if (outcome.status === "timeout") throw new Error(`browser_evaluate timed out after ${outcome.timeoutMs}ms`);
          throw new Error(outcome.error ?? "browser_evaluate failed");
        });
      },
    });

    const runtimeCall = async (action, args, options) => {
      if (!host.foundryRuntime?.call) {
        throw new Error("Foundry page runtime is unavailable. Open the Foundry panel and wait for the world to finish loading.");
      }
      return host.withResources(["foundry:page"], options?.signal, () => host.foundryRuntime.callForSession
        ? host.foundryRuntime.callForSession(host.telemetry, host.profile.mode, action, args, options)
        : host.foundryRuntime.call(action, args, options));
    };

    const worldStatus = defineTool({
      name: "world_status",
      label: "World Status",
      description:
        "Read current world info through the fixed runtime in the controlled Foundry page: world id/title, system, Foundry version and current user (GM). " +
        "When an authenticated /game page is still initializing or reloading, waits up to 90 seconds for readiness. Read-only.",
      parameters: Type.Object({}),
      promptGuidelines: [
        "Before claiming you can see the world, verify it with world_status and report what you actually read.",
      ],
      execute: async (_toolCallId, _params, signal) => {
        const data = await runtimeCall("worldInfo", {}, {
          signal,
          readyTimeoutMs: 90_000,
          executionTimeoutMs: 30_000,
        });
        host.emit({ type: "world_info", data });
        return textResult(safeJson(data), data);
      },
    });

    const combatBattleContext = defineTool({
      name: "combat_battle_context",
      label: "Battle Context",
      description:
        "Read the stable battle manual (Turn Protocol v2 battle-context): combatants, sides, static blocks and the action catalog with input contracts. Read ONCE per combat, not every turn.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, signal) => {
        const data = await runtimeCall("battleContext", {}, {
          signal,
          executionTimeoutMs: 30_000,
        });
        return textResult(safeJson(data), data);
      },
    });

    const combatTurnContext = defineTool({
      name: "combat_turn_context",
      label: "Turn Context",
      description:
        "Read the live mutable turn state (Turn Protocol v2 turn-context): current turn/round, actor HP, resources, conditions, concentration, available action ids. Read before EVERY decision.",
      parameters: Type.Object({}),
      promptGuidelines: [
        "Read combat_turn_context before every combat decision; never act on remembered state.",
      ],
      execute: async (_toolCallId, _params, signal) => {
        const data = await runtimeCall("turnContext", {}, {
          signal,
          executionTimeoutMs: 30_000,
        });
        return textResult(safeJson(data), data);
      },
    });

    const executeTurnInput = Type.Optional(
      Type.Object(
        {
          selections: Type.Optional(Type.Object({}, { additionalProperties: true })),
          // 注意:runtime 契约里 declaredRiders / allocation 都是对象数组,不是对象
          // (foundry-runtime.ts: "input.declaredRiders must be an array")。
          declaredRiders: Type.Optional(
            Type.Array(Type.Object({}, { additionalProperties: true }), {
              description: "Rider entries, e.g. [{ id: \"branding-smite\", spellLevel: 2 }]",
            })
          ),
          allocation: Type.Optional(
            Type.Array(Type.Object({}, { additionalProperties: true }), {
              description: "Non-empty array of allocation entries",
            })
          ),
          spellLevel: Type.Optional(Type.Number()),
          attackRollMode: Type.Optional(
            Type.String({
              enum: ["normal", "advantage", "disadvantage"],
              description:
                "Optional only when the selected battle-context action advertises input.attackRollMode. " +
                "Set it only from an explicit DM instruction: advantage/disadvantage set the corresponding Midi request flags; " +
                "normal leaves the roll unforced and does not cancel effects Foundry applies automatically. " +
                "Otherwise omit it; never infer it from conditions, positioning, or tactics.",
            })
          ),
          targetSpec: Type.Optional(Type.Object({}, { additionalProperties: true })),
        },
        { additionalProperties: true }
      )
    );

    const combatExecuteTurn = defineTool({
      name: "combat_execute_turn",
      label: "Execute Turn Action",
      description:
        "Submit combat action(s) for the current combatant (Turn Protocol v2 execute-turn). " +
        "Returns a four-state receipt: completed / rejected / partial / indeterminate.",
      parameters: Type.Object({
        actionId: Type.Optional(Type.String({ description: "Single action id from battle-context" })),
        actions: Type.Optional(
          Type.Array(
            Type.Object({
              actionId: Type.String(),
              targetTokenIds: Type.Optional(Type.Array(Type.String())),
              input: executeTurnInput,
            }),
            { description: "Multiple actions in one submission" }
          )
        ),
        targetTokenIds: Type.Optional(Type.Array(Type.String())),
        input: executeTurnInput,
        advance: Type.Optional(Type.Boolean({ description: "Advance the combat turn after execution" })),
      }),
      executionMode: "sequential",
      promptGuidelines: [
        "Pass input.attackRollMode only when battle-context advertises it and the DM explicitly declares the mode; otherwise omit it. For actions[], scope it per action instead of copying it to every attack unless the DM explicitly applies it to all attacks.",
        "When a receipt is partial or indeterminate, never retry automatically; read combat_turn_context for live state and report to the DM.",
      ],
      execute: async (_toolCallId, params, signal) => {
        const approved = await host.maybeRequestApproval({
          tool: "combat_execute_turn",
          summary: summarizeExecuteTurn(params),
          args: params,
        });
        if (!approved) return textResult("DM declined this action; do not retry it.");
        const data = await runtimeCall("executeTurn", params, {
          signal,
          executionTimeoutMs: 120_000,
        });
        return textResult(safeJson(data), data);
      },
    });

    const tools = [foundryOpen, browserEvaluate, worldStatus, combatBattleContext, combatTurnContext, combatExecuteTurn, requestUserInput];
    if (prepWorldEdit) tools.splice(1, 0, foundryScreenshot);
    if (!Array.isArray(host.profile.customToolNames)) return tools;
    const enabled = new Set(host.profile.customToolNames);
    return tools.filter((tool) => enabled.has(tool.name));
  }
}
