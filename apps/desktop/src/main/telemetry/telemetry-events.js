// 事件目录与 bucket/枚举(客户端方案 §7/§8)。唯一允许构造遥测 data 的地方;
// TelemetryClient 只接受这里产出的字段,业务代码不得自由拼对象(§4.1)。
import { assertEventSerializable } from "./telemetry-privacy.js";

export const SCHEMA_VERSION = 1;
export const PRIVACY_REVISION = 1;

export const EVENT_NAMES = new Set([
  "app.started",
  "agent.session_attached",
  "input.submitted",
  "turn.started",
  "turn.steered",
  "turn.aborted",
  "turn.summary",
  "model.completed",
  "model.retry",
  "compaction.completed",
  "tool.started",
  "tool.completed",
  "approval.resolved",
  "foundry.runtime_completed",
]);

// ---- buckets ----

/** prompt 文本长度只允许 bucket(§7.1),原始长度不落盘。 */
export function textLengthBucket(length) {
  const n = Number(length) || 0;
  if (n === 0) return "0";
  if (n <= 20) return "1-20";
  if (n <= 80) return "21-80";
  if (n <= 200) return "81-200";
  if (n <= 500) return "201-500";
  return "501+";
}

export function imageCountBucket(count) {
  const n = Number(count) || 0;
  if (n === 0) return "0";
  if (n === 1) return "1";
  return "2+";
}

/** 回合时长 bucket(§10 duration_ms_bucket)。 */
export function durationBucket(ms) {
  const n = Number(ms) || 0;
  if (n < 5_000) return "<5s";
  if (n < 10_000) return "5-10s";
  if (n < 30_000) return "10-30s";
  if (n < 60_000) return "30-60s";
  if (n < 300_000) return "1-5m";
  return "5m+";
}

/** steer/abort 时的已耗时 bucket。 */
export function elapsedBucket(ms) {
  const n = Number(ms) || 0;
  if (n < 5_000) return "<5s";
  if (n < 30_000) return "5-30s";
  if (n < 120_000) return "30-120s";
  return "120s+";
}

/** 审批等人工介入延迟 bucket。 */
export function latencyBucket(ms) {
  const n = Number(ms) || 0;
  if (n < 2_000) return "<2s";
  if (n < 10_000) return "2-10s";
  if (n < 60_000) return "10-60s";
  return "60s+";
}

/** 压缩前 token 数 bucket。 */
export function tokensBucket(n) {
  const v = Number(n) || 0;
  if (v < 10_000) return "<10k";
  if (v < 50_000) return "10-50k";
  if (v < 100_000) return "50-100k";
  return "100k+";
}

// ---- 枚举(§7/§8) ----

export const ERROR_CLASSES = new Set([
  "none",
  "model_auth",
  "model_rate_limit",
  "model_timeout",
  "model_transport",
  "model_invalid_response",
  "foundry_unavailable",
  "foundry_not_game",
  "foundry_not_ready",
  "foundry_not_gm",
  "foundry_navigation",
  "foundry_timeout",
  "tool_validation",
  "user_abort",
  "unknown",
]);

export const TOOL_STATUSES = new Set(["completed", "error", "aborted"]);
export const APPROVAL_OUTCOMES = new Set(["allowed", "denied", "timeout"]);
export const RUNTIME_PHASES = new Set(["preflight", "dispatched"]);
export const RUNTIME_STATUSES = new Set(["completed", "error", "aborted", "timeout", "navigated"]);
export const RUNTIME_RECEIPTS = new Set(["none", "completed", "rejected", "partial", "indeterminate"]);
export const INPUT_SOURCES = new Set(["unknown", "voice", "keyboard", "mixed", "image_only"]);
export const SUBMIT_METHODS = new Set(["unknown", "enter", "click"]);

const RELEASE_CHANNELS = new Set(["dev", "alpha", "beta", "stable", "canary"]);
const FINISH_CLASSES = new Set(["stop", "length", "tool_use", "error", "aborted", "unknown"]);
const COMPACTION_REASONS = new Set(["threshold", "overflow", "manual", "unknown"]);

/**
 * 原始错误只允许映射为稳定 error_class(§8):优先读受控 code,
 * 没有稳定 code 时用本地正则分类,message 立即丢弃。
 */
export function classifyError(error) {
  const code = String(error?.code ?? "");
  switch (code) {
    case "FOUNDRY_SDK_TRANSPORT_UNAVAILABLE":
    case "FOUNDRY_SDK_INSPECTION_FAILED":
    case "FOUNDRY_SDK_EVALUATION_FAILED":
      return "foundry_unavailable";
    case "FOUNDRY_SDK_FOUNDRY_NOT_GAME":
      return "foundry_not_game";
    case "FOUNDRY_SDK_FOUNDRY_NOT_GM":
      return "foundry_not_gm";
    case "FOUNDRY_SDK_FOUNDRY_NOT_READY":
    case "FOUNDRY_SDK_FOUNDRY_NOT_DETECTED":
      return "foundry_not_ready";
    case "FOUNDRY_SDK_NAVIGATED":
      return "foundry_navigation";
    case "FOUNDRY_SDK_TIMEOUT":
      return "foundry_timeout";
    case "FOUNDRY_SDK_ABORTED":
      return "user_abort";
    default:
      break;
  }
  const message = String(error?.message ?? error ?? "");
  if (/abort/i.test(message)) return "user_abort";
  if (/No API key|unauthorized|\b401\b/i.test(message)) return "model_auth";
  if (/rate limit|too many requests|\b429\b/i.test(message)) return "model_rate_limit";
  if (/timeout|timed out/i.test(message)) return "model_timeout";
  if (/fetch|network|ECONN|ENOTFOUND|socket/i.test(message)) return "model_transport";
  if (/invalid.*response|parse|unexpected token/i.test(message)) return "model_invalid_response";
  return "unknown";
}

// 内置 provider 预设白名单(provider-catalog.json 的 id 集合快照);
// BYOK 自定义项一律上报 "custom",不上传 base URL/命名/原始模型 id(§7.2)。
const KNOWN_PROVIDER_IDS = new Set([
  "alibaba-token-plan",
  "kimi-coding",
  "zhipu-coding",
  "alibaba-dashscope",
  "volcano-ark",
  "deepseek",
  "minimax",
  "xiaomi-mimo",
  "siliconflow",
  "moonshot",
  "zhipu",
  "stepfun",
  "baidu-qianfan",
  "tencent-hunyuan",
  "qiniu",
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "agentrouter",
]);

export function providerFamily(providerId) {
  const id = String(providerId ?? "").toLowerCase();
  return KNOWN_PROVIDER_IDS.has(id) ? id : "custom";
}

/** 模型 family:已知 provider 归一化模型 id 前缀,未知者 custom。 */
export function modelFamily(providerId, modelId) {
  if (providerFamily(providerId) === "custom") return "custom";
  const id = String(modelId ?? "").toLowerCase();
  if (!id) return "custom";
  const prefix = id.split(/[-._/]/)[0];
  return /^[a-z0-9]{1,24}$/.test(prefix) ? prefix : "custom";
}

// ---- 事件工厂:每个事件一个构建器,输出通过隐私断言的 data ----

function oneOf(value, set, field) {
  if (!set.has(value)) throw new Error(`telemetry: invalid ${field}: ${String(value)}`);
  return value;
}

function normalizedEnum(value, set, fallback = "unknown") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
  return set.has(normalized) ? normalized : fallback;
}

function int(value, field) {
  const n = Number(value) || 0;
  if (!Number.isFinite(n) || n < 0) throw new Error(`telemetry: invalid ${field}`);
  return Math.floor(n);
}

export const buildEventData = {
  "app.started": ({ platform, arch, releaseChannel }) => ({
    platform: String(platform),
    arch: String(arch),
    release_channel: normalizedEnum(releaseChannel, RELEASE_CHANNELS),
  }),
  "agent.session_attached": ({ providerFamily, modelFamily, builtinTools }) => ({
    provider_family: String(providerFamily),
    model_family: String(modelFamily),
    builtin_tools: Boolean(builtinTools),
  }),
  "input.submitted": ({ lengthBucket, imageCountBucket: images, inputSource, submitMethod }) => ({
    length_bucket: String(lengthBucket),
    image_count_bucket: String(images),
    input_source: normalizedEnum(inputSource, INPUT_SOURCES),
    submit_method: normalizedEnum(submitMethod, SUBMIT_METHODS),
  }),
  "turn.started": ({ source }) => ({ source: String(source) }),
  "turn.steered": ({ elapsedBucket: elapsed }) => ({ elapsed_bucket: String(elapsed) }),
  "turn.aborted": ({ elapsedBucket: elapsed, trigger }) => ({
    elapsed_bucket: String(elapsed),
    trigger: String(trigger),
  }),
  "model.completed": ({ providerFamily: provider, modelFamily: model, finish, errorClass, inputTokens, outputTokens }) => ({
    provider_family: String(provider),
    model_family: String(model),
    finish: normalizedEnum(finish, FINISH_CLASSES),
    error_class: oneOf(errorClass, ERROR_CLASSES, "error_class"),
    input_tokens: int(inputTokens, "input_tokens"),
    output_tokens: int(outputTokens, "output_tokens"),
  }),
  "model.retry": ({ attempt, maxAttempts, errorClass, recovered }) => ({
    attempt: int(attempt, "attempt"),
    max_attempts: int(maxAttempts, "max_attempts"),
    error_class: oneOf(errorClass, ERROR_CLASSES, "error_class"),
    recovered: Boolean(recovered),
  }),
  "compaction.completed": ({ reason, errorClass, tokensBefore }) => ({
    reason: normalizedEnum(reason, COMPACTION_REASONS),
    error_class: oneOf(errorClass, ERROR_CLASSES, "error_class"),
    tokens_before_bucket: tokensBucket(tokensBefore),
  }),
  "tool.started": ({ toolFamily, sideEffectClass }) => ({
    tool_family: String(toolFamily),
    side_effect_class: String(sideEffectClass),
  }),
  "tool.completed": ({ toolFamily, status, durationMs }) => ({
    tool_family: String(toolFamily),
    status: oneOf(status, TOOL_STATUSES, "status"),
    duration_ms: int(durationMs, "duration_ms"),
  }),
  "approval.resolved": ({ toolFamily, outcome, latencyBucket: latency }) => ({
    tool_family: String(toolFamily),
    outcome: oneOf(outcome, APPROVAL_OUTCOMES, "outcome"),
    latency_bucket: String(latency),
  }),
  "foundry.runtime_completed": ({ actionFamily, phase, status, receipt, durationMs, errorClass }) => ({
    action_family: String(actionFamily),
    phase: oneOf(phase, RUNTIME_PHASES, "phase"),
    status: oneOf(status, RUNTIME_STATUSES, "status"),
    receipt: oneOf(receipt, RUNTIME_RECEIPTS, "receipt"),
    duration_ms: int(durationMs, "duration_ms"),
    error_class: oneOf(errorClass, ERROR_CLASSES, "error_class"),
  }),
};

/**
 * 构造一个完整事件(envelope + data),是唯一出口。
 * data 构建器抛错或隐私断言失败都会阻止事件产生。
 */
export function makeEvent(name, fields, envelope) {
  const builder = buildEventData[name];
  if (!builder || !EVENT_NAMES.has(name)) throw new Error(`telemetry: unknown event ${name}`);
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
    event: name,
    occurred_at: new Date().toISOString(),
    boot_id: envelope.bootId,
    seq: envelope.seq,
    monotonic_ms: Math.round(envelope.monotonicMs),
    installation_id: envelope.installationId,
    app_session_id: envelope.appSessionId,
    agent_session_id: envelope.agentSessionId ?? null,
    turn_id: envelope.turnId ?? null,
    mode: envelope.mode ?? null,
    app_version: envelope.appVersion,
    release_channel: normalizedEnum(envelope.releaseChannel, RELEASE_CHANNELS),
    privacy_revision: PRIVACY_REVISION,
    data: builder(fields),
  };
  assertEventSerializable(event);
  return event;
}

// turn.summary 的 data 由 TurnSummarizer 产出,单独入口(字段集不同,§10)。
export function makeSummaryEvent(summaryData, envelope) {
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
    event: "turn.summary",
    occurred_at: new Date().toISOString(),
    boot_id: envelope.bootId,
    seq: envelope.seq,
    monotonic_ms: Math.round(envelope.monotonicMs),
    installation_id: envelope.installationId,
    app_session_id: envelope.appSessionId,
    agent_session_id: envelope.agentSessionId ?? null,
    turn_id: envelope.turnId,
    mode: envelope.mode,
    app_version: envelope.appVersion,
    release_channel: normalizedEnum(envelope.releaseChannel, RELEASE_CHANNELS),
    privacy_revision: PRIVACY_REVISION,
    data: summaryData,
  };
  assertEventSerializable(event);
  return event;
}
