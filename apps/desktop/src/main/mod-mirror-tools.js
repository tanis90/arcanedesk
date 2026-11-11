// mod-mirror-tools.js — Arcane 模块镜像的原生工具（M3 客户端接入）。
//
// 单一工具 foundry_module_prepare(query, version?)：毫秒级透传 POST {spark origin}/v1/mods/jobs，
// 服务端内部先 resolve 再入队；本进程不做后台任务、job Map 与轮询——轮询/下载/安装全部交给
// agent 走 mod-manager mirror-install 或 curl（见 skills/prep/arcane-fvtt-mods/SKILL.md）。
//
// 凭据与联网搜索同一边界：复用 AgentHost.searchDeps.spark()（内置 arcane-spark provider），
// key 只在主进程内拼 Authorization 头，任何返回结构都不包含 key。
// 响应契约（服务端 M1 定稿）：
//   ready         {status:"ready", download_url, sha256, size, module_id, version, …}
//   preparing     {status:"preparing", job_id, poll_url, retry_after, module_id, version, …}
//   candidates    {candidates:[{module_id,title,foundry_v13_ok,cached,license}]}
//   incompatible  {status:"incompatible", max_foundry}
//   blocked       {status:"blocked", reason:"license_proprietary"|"quota"|"takedown"|"unknown", user_message}
// HTTP 401/402/404/410/451 在响应体是应用层 JSON 时收敛进上述语义；非 JSON 体
// （网关/白名单拦截的裸 404 等，请求根本没到镜像服务）落回 MIRROR_UNAVAILABLE，
// 不转述成业务结论——否则会把"路由没放行"误诊成"目录里没有这个模块"。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { jsonSafe } from "./json-safe.js";

const REQUEST_TIMEOUT_MS = 10_000;
const BLOCKED_REASONS = new Set(["license_proprietary", "license_unknown", "quota", "takedown", "no_download", "incompatible", "unknown"]);
const CANDIDATE_FIELDS = ["module_id", "title", "foundry_v13_ok", "cached", "license"];
const IDENTITY_FIELDS = ["module_id", "title", "version", "sha256", "size", "download_url", "job_id", "poll_url", "retry_after"];

/** 可直接转述给用户的中文话术；服务端给了 user_message 时以服务端为准。 */
const BLOCKED_MESSAGES = Object.freeze({
  license_proprietary: "这个模块的许可证不允许镜像分发。请到 Foundry 官方商店或作者发布页自行购买/下载。",
  license_unknown: "这个模块没有附带许可证声明，镜像不能合法分发它（多数情况是作者忘了写，不代表禁止）。可以试试同作者的其他模块，或去作者的代码仓库提个 issue 请他补个 LICENSE。",
  quota: "今天的镜像下载额度已用完，稍后再试；也可以改用公开网络直连（来源风险需自担）。",
  takedown: "这个模块已按权利人要求从镜像下架，无法再提供下载。",
  no_download: "这个模块的发布清单里没有写下载地址（作者打包时漏了），镜像拿不到文件。可以去 Foundry 安装器或作者仓库手动装。",
  incompatible: "这个模块没有适配 Foundry v13 的版本，装上也跑不起来。可以找同功能的替代模块。",
  unknown: "镜像暂时无法提供这个模块；可以换个模块名再试，或改用公开网络直连（来源风险需自担）。",
});

const NOT_CONFIGURED_MESSAGE =
  "尚未配置 ArcaneSpark，镜像下载暂不可用。到设置里的模型/ArcaneSpark 配置好 key 后即可直接使用；"
  + "也可以先用 mod-manager 的 inspect/stage 走公开网络直连（来源风险需自担）。";
const UNAVAILABLE_MESSAGE =
  "暂时连不上 Arcane 模块镜像，请稍后再试；也可以改用公开网络直连安装（来源风险需自担）。";

const textResult = data => {
  const safe = jsonSafe(data);
  return { content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(safe) }], details: safe };
};

function loopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * sparkBaseUrl（…/v1）→ 同源 /v1/mods/jobs。生产只接受 HTTPS；HTTP 仅放行回环地址，
 * 供本地 relay/联调与 hermetic 测试使用，避免把 spark key 发往明文公网。
 */
export function modsJobsUrl(sparkBaseUrl) {
  const raw = String(sparkBaseUrl ?? "").trim();
  if (!raw) throw new Error("ArcaneSpark base URL is not configured");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ArcaneSpark base URL is invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHost(url.hostname))) {
    throw new Error("ArcaneSpark base URL must be HTTPS (HTTP is only allowed for loopback)");
  }
  if (url.username || url.password) throw new Error("ArcaneSpark base URL must not carry credentials");
  return `${url.origin}/v1/mods/jobs`;
}

/** 只回显契约内的身份/工件字段，避免把服务端多余负载原样带进对话。 */
function identityOf(value) {
  const result = {};
  for (const field of IDENTITY_FIELDS) {
    if (value?.[field] !== undefined && value[field] !== null) result[field] = value[field];
  }
  return result;
}

function blockedResult(reason, value, httpStatus) {
  const normalized = BLOCKED_REASONS.has(reason) ? reason : "unknown";
  const serverMessage = typeof value?.user_message === "string" && value.user_message.trim()
    ? value.user_message.trim()
    : null;
  return {
    status: "blocked",
    reason: normalized,
    ...(httpStatus != null ? { http_status: httpStatus } : {}),
    ...(typeof value?.code === "string" && value.code ? { code: value.code } : {}),
    ...(value?.module_id ? { module_id: value.module_id } : {}),
    user_message: serverMessage ?? BLOCKED_MESSAGES[normalized],
  };
}

function candidatesResult(candidates) {
  const rows = candidates.slice(0, 20).map((candidate) => {
    const row = {};
    for (const field of CANDIDATE_FIELDS) {
      if (candidate?.[field] !== undefined && candidate[field] !== null) row[field] = candidate[field];
    }
    return row;
  });
  return {
    status: "candidates",
    candidates: rows,
    user_message: `找到 ${rows.length} 个候选，请用确切的 module_id 再调用一次 foundry_module_prepare。`,
  };
}

/**
 * HTTP 状态 + JSON 体 → 五种结构化结果之一。导出供单测直接覆盖契约，
 * 不依赖真实网络。
 */
export function mapJobsResponse({ httpStatus, body }) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body : null;

  if (Array.isArray(value?.candidates)) return candidatesResult(value.candidates);

  const status = typeof value?.status === "string" ? value.status : "";
  if (status === "ready") {
    const id = value.module_id ?? value.id;
    const version = value.version;
    return {
      status: "ready",
      ...identityOf(value),
      ...(id && !value.module_id ? { module_id: id } : {}),
      user_message: `已就绪：${value.title || id || "模块"}${version ? ` ${version}` : ""}。可以直接下载安装。`,
    };
  }
  if (status === "preparing") {
    const id = value.module_id ?? value.id;
    return {
      status: "preparing",
      ...identityOf(value),
      ...(id && !value.module_id ? { module_id: id } : {}),
      user_message: `正在准备：${value.title || id || "模块"}${value.version ? ` ${value.version}` : ""}。通常十几秒内完成——`
        + "用返回的 poll_url 跑 mod-manager mirror-install --wait 120 一步装好，"
        + "或稍后再调一次 foundry_module_prepare，就绪后会立即返回。",
    };
  }
  if (status === "incompatible") {
    const max = value.max_foundry == null ? "未知" : String(value.max_foundry);
    return {
      status: "incompatible",
      max_foundry: max,
      ...identityOf(value),
      user_message: `不兼容：这个模块最高只支持 v${max}，当前 Foundry v13 世界跑不起来。`,
    };
  }
  if (status === "blocked") return blockedResult(value.reason, value, httpStatus === 200 ? undefined : httpStatus);

  // 无 JSON 体或非契约体：把 HTTP 语义折进 blocked / error，不外抛传输异常。
  if (httpStatus === 401) {
    return {
      status: "blocked",
      reason: "unknown",
      http_status: 401,
      code: "AUTH_FAILED",
      user_message: "ArcaneSpark 凭据无效或已过期，请到设置里重新配置 ArcaneSpark 后重试。",
    };
  }
  if (httpStatus === 402) return blockedResult("quota", value, 402);
  if (httpStatus === 404 && value) {
    return {
      status: "blocked",
      reason: "unknown",
      http_status: 404,
      code: "NOT_FOUND",
      user_message: "镜像目录里没有找到这个模块；可以换个名字再试，或改用公开网络直连（来源风险需自担）。",
    };
  }
  if (httpStatus === 410) return blockedResult("takedown", value, 410);
  if (httpStatus === 451) return blockedResult("license_proprietary", value, 451);

  return {
    status: "error",
    code: "MIRROR_UNAVAILABLE",
    ...(httpStatus ? { http_status: httpStatus } : {}),
    user_message: UNAVAILABLE_MESSAGE,
  };
}

/** 当前可用的 ArcaneSpark 凭据（key 只在主进程内使用）。 */
export function sparkCredential(host) {
  const spark = host?.searchDeps?.spark ? host.searchDeps.spark() : null;
  return {
    apiKey: spark?.apiKey ? String(spark.apiKey) : "",
    baseUrl: spark?.baseUrl ? String(spark.baseUrl) : "",
  };
}

/**
 * 一次 prepare 执行（tool execute 的内核）。永不 throw，失败也返回可转述的
 * 结构化结果；不打印、不回传 key。
 */
export async function prepareModule({ query, version, credential, fetchImpl = fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!credential?.apiKey) {
    return { status: "not_configured", code: "SPARK_NOT_CONFIGURED", user_message: NOT_CONFIGURED_MESSAGE };
  }
  let url;
  try {
    url = modsJobsUrl(credential.baseUrl);
  } catch {
    return { status: "error", code: "MIRROR_BASE_UNAVAILABLE", user_message: NOT_CONFIGURED_MESSAGE };
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.apiKey}`,
      },
      body: JSON.stringify({ query, ...(version ? { version } : {}) }),
      cache: "no-store",
      redirect: "follow",
      signal: requestSignal,
    });
  } catch {
    return { status: "error", code: "MIRROR_UNAVAILABLE", user_message: UNAVAILABLE_MESSAGE };
  }

  let body = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return mapJobsResponse({ httpStatus: response.status, body });
}

/** Definitions are mode-independent; activation belongs to the host's explicit allowlist. */
export function createModMirrorTools(host) {
  return [defineTool({
    name: "foundry_module_prepare",
    label: "Prepare Foundry Module",
    description:
      "Resolve a Foundry add-on module against the Arcane mirror and make it ready to download in one hop. "
      + "Pass the module id or name the DM asked for (query) and optionally an exact version. "
      + "Returns status=ready with a short-lived presigned download_url plus sha256/size, status=preparing with poll_url/retry_after, "
      + "status=candidates when the name is ambiguous, status=incompatible with max_foundry, or status=blocked with a reason and a user_message to relay. "
      + "No polling, downloading or installation happens in this tool: on preparing, use mod-manager mirror-install --poll-url <poll_url> --wait 120 "
      + "or curl the poll_url, then verify sha256 before installing. Poll/download URLs are short-lived job credentials; never share them outside this conversation. "
      + "Workflow: web_search to identify the module, then this tool. Read-only with respect to the Foundry world.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200, description: "Module id or the title the DM asked for." }),
      version: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Exact module version; omit for the latest v13-compatible release." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => textResult(await prepareModule({
      query: params.query,
      version: params.version,
      credential: sparkCredential(host),
      fetchImpl: host.searchDeps?.fetchImpl ?? fetch,
      signal,
    })),
  })];
}
