#!/usr/bin/env node
// prepare-mtcompat-surface — A2 离线蒸馏管线（PRD agent-api §2.4/§2.5 的 Tier 0 背诵级）。
//
// 输入：GET api-surface.json（VTT 侧 M3 产物：域 + 条目 + 状态的静态声明面）。
//   默认取云端正典形态 https://vtt.arcanedesk.bitterbebop.cn:30002/user-files/compat/api-surface.json；
//   本地栈 / compat-<slug> 分支部署 / 离线联调用 --url 或 ARCANE_API_SURFACE_URL 覆盖
//   （本地 serve 是自签证书：--insecure 或 ARCANE_API_SURFACE_INSECURE=1 关本进程校验）。
// 过程：**钉住 revision** 蒸馏出 mtcompat 档的声明段——Top-N 坑位（按状态严重度排序）
//   + 扩展动词（status=extension 且 agent=prefer）+ §2.5 三规则逐字，整段预渲染成文本，
//   运行期 src/main/mtcompat-surface.mjs 只做读取与挂载，不做二次加工。
// 输出：generated/mtcompat-surface.json（构建产物，与 region.json 同规矩：.gitignore 的
//   generated/ 不入库，随包分发）。
// 离线构建：拉取失败/声明缺 revision/声明为空时，已有旧产物 → 警告并沿用（不重写、不炸）；
//   没有旧产物才失败退出。同一 revision 且段落逐字节相同的重跑不刷新产物（构建可复现）。
//   逃生舱（端点未部署时用）：ARCANE_API_SURFACE_ALLOW_MISSING=1 或 --allow-missing —— 无产物
//   继续，本次不产蒸馏段（mtcompat 档按无声明面运行）。发布链默认不开，硬门优先。
//
// 用法：node scripts/prepare-mtcompat-surface.mjs [--url <url>] [--top <n>] [--insecure] [--allow-missing]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_FILE = path.join(desktopRoot, "generated", "mtcompat-surface.json");

/** 云端正典地址形态（PRD §2.4；暂未部署时用 --url/env 指到本地栈或分支部署）。 */
export const DEFAULT_SURFACE_URL =
  "https://vtt.arcanedesk.bitterbebop.cn:30002/user-files/compat/api-surface.json";
export const SURFACE_URL_ENV = "ARCANE_API_SURFACE_URL";
export const SURFACE_TOP_ENV = "ARCANE_API_SURFACE_TOP";
export const SURFACE_INSECURE_ENV = "ARCANE_API_SURFACE_INSECURE";
/** 逃生舱：声明面端点尚未部署时允许「无产物继续」（见 reuseExistingArtifact 注释）。 */
export const SURFACE_ALLOW_MISSING_ENV = "ARCANE_API_SURFACE_ALLOW_MISSING";

/** 坑位数默认值：维持“十大坑位”量级，控制 prompt 预算（条数写进产物 meta）。 */
export const DEFAULT_PITFALL_LIMIT = 10;
/** 声明面体积上限：远端是自家服务，但产物解析不该无界。 */
export const MAX_SURFACE_BYTES = 2 * 1024 * 1024;
export const DISTILL_SCHEMA_VERSION = 1;
export const DISTILL_KIND = "mtcompat-surface-distill";

/**
 * §2.5 三规则（PRD 全文即此，**逐字**）。蒸馏段必须原样携带：这是 agent 侧纪律的
 * 唯一成文出口——Tier 1（apiSurface 定点查询）与 Tier 2（eval 的 touched/missing）
 * 都靠这三条被消费。
 */
export const SURFACE_RULES = Object.freeze([
  "优先用 typed action，eval 是兜底。",
  "要写 eval 碰某个域之前，先调 `apiSurface({prefix:\"<域>\"})` 看一眼。",
  "eval 返回里的 `touched`/`missing` 必须读；报了你踩桩，就按 note 绕开重写。",
]);

/**
 * 状态严重度档位（§2.5 Tier 0 排序：absent > stub-noop > stub-fixed > partial）。
 * full 只收带 delta 的条目（真面无语义差不进坑位榜）：URL 地址空间（FilePicker.upload）、
 * 单轨权限这类“能用但语义差”的面正是 Tier 0 最该背的东西。
 * 词汇表外的新状态一律跳过——宁可少报，不瞎排。
 */
const STATUS_TIERS = Object.freeze({
  absent: 0,
  "stub-noop": 1,
  "stub-fixed": 2,
  partial: 3,
  full: 4,
});

function warn(message) {
  process.stderr.write(`[prepare-mtcompat-surface] 警告：${message}\n`);
}

function isUsableEntry(entry) {
  return Boolean(entry && typeof entry === "object"
    && typeof entry.path === "string" && entry.path !== ""
    && typeof entry.status === "string" && entry.status !== "");
}

function entryText(entry, key) {
  const value = entry[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** 坑位榜：严重度优先，同档内语义差（delta）优先，其余保持声明面原序。坏条目直接跳过。 */
export function rankPitfalls(entries) {
  return entries
    .filter(isUsableEntry)
    .map((entry, index) => ({ entry, index, tier: STATUS_TIERS[entry.status], hasDelta: Boolean(entryText(entry, "delta")) }))
    .filter((row) => row.tier !== undefined && (row.entry.status !== "full" || row.hasDelta))
    .sort((a, b) => a.tier - b.tier || Number(b.hasDelta) - Number(a.hasDelta) || a.index - b.index)
    .map((row) => row.entry);
}

/** 扩展动词：status=extension 且 agent=prefer（mt.* 面里优先于 FVTT 同名面的那些）。 */
export function preferredExtensions(entries) {
  return entries.filter((entry) => isUsableEntry(entry) && entry.status === "extension" && entry.agent === "prefer");
}

/** 「path：status——note（有 delta/use 带上）」单行；note 缺席时只留前两段。 */
export function renderEntryLine(entry) {
  const parts = [`\`${entry.path}\`：${entry.status}`];
  const note = entryText(entry, "note");
  if (note) parts.push(`——${note}`);
  const delta = entryText(entry, "delta");
  if (delta) parts.push(`；delta: ${delta}`);
  const use = entryText(entry, "use");
  if (use) parts.push(`；use: ${use}`);
  return `- ${parts.join("")}`;
}

function renderSegment({ revision, defaultPolicy, entryCount, domainCount, pitfalls, extensions }) {
  const lines = [];
  lines.push(
    `【arcaneVTT 支持面 · 离线蒸馏 rev ${revision}】`
    + `（声明 ${entryCount} 条 / ${domainCount} 域；defaultPolicy=${defaultPolicy}：清单没提的面按不存在对待）`,
  );
  lines.push(`坑位 Top ${pitfalls.length}（严重度 absent > stub-noop > stub-fixed > partial）：`);
  if (pitfalls.length === 0) lines.push("- （本次声明没有坑位条目）");
  for (const entry of pitfalls) lines.push(renderEntryLine(entry));
  lines.push("扩展动词（status=extension 且 agent=prefer；优先于 FVTT 同名面）：");
  if (extensions.length === 0) lines.push("- （本次声明没有优先扩展动词）");
  for (const entry of extensions) lines.push(renderEntryLine(entry));
  lines.push("纪律（逐字，PRD §2.5）：");
  SURFACE_RULES.forEach((rule, index) => lines.push(`${index + 1}. ${rule}`));
  return lines.join("\n");
}

/** 声明面计数（产物 meta；byStatus 按状态词聚合，含未进榜的状态）。 */
function countByStatus(entries) {
  const byStatus = {};
  for (const entry of entries) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  return Object.freeze(byStatus);
}

/**
 * 纯蒸馏：api-surface.json 解析结果 → 产物对象（含预渲染 segment）。
 * 缺 revision / 空声明一律抛错——调用方据此决定「沿用旧产物」还是失败。
 */
export function distillSurface(surface, { top = DEFAULT_PITFALL_LIMIT, sourceUrl = null, generatedAt = new Date().toISOString() } = {}) {
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
    throw new Error("api-surface.json must be a JSON object");
  }
  if (surface.revision === undefined || surface.revision === null || surface.revision === "") {
    throw new Error("api-surface.json is missing the revision pin");
  }
  const limit = Number(top);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`pitfall limit must be a non-negative integer; got: ${String(top)}`);
  const entries = (Array.isArray(surface.entries) ? surface.entries : []).filter(isUsableEntry);
  const domains = Array.isArray(surface.domains) ? surface.domains.filter((domain) => domain && typeof domain === "object") : [];
  if (entries.length === 0 && domains.length === 0) {
    throw new Error("api-surface.json declares no domains and no entries");
  }
  const pitfalls = rankPitfalls(entries).slice(0, limit);
  const extensions = preferredExtensions(entries);
  const defaultPolicy = typeof surface.defaultPolicy === "string" && surface.defaultPolicy !== ""
    ? surface.defaultPolicy
    : "unverified";
  const segment = renderSegment({
    revision: surface.revision,
    defaultPolicy,
    entryCount: entries.length,
    domainCount: domains.length,
    pitfalls,
    extensions,
  });
  return Object.freeze({
    schemaVersion: DISTILL_SCHEMA_VERSION,
    kind: DISTILL_KIND,
    sourceUrl,
    revision: surface.revision,
    defaultPolicy,
    generatedAt,
    counts: Object.freeze({
      domains: domains.length,
      entries: entries.length,
      pitfalls: pitfalls.length,
      extensions: extensions.length,
      byStatus: countByStatus(entries),
    }),
    pitfallLimit: limit,
    pitfalls: pitfalls.map((entry) => Object.freeze({ ...entry })),
    extensions: extensions.map((entry) => Object.freeze({ ...entry })),
    rules: SURFACE_RULES,
    segment,
  });
}

/** 拉声明面：http(s)、2 MiB 上限、带超时；TLS 校验的放宽由调用方在 main 里显式开。 */
export async function fetchSurface(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`api-surface URL is invalid: ${String(url)}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`api-surface URL must be http(s): ${url}`);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_SURFACE_BYTES) {
    throw new Error(`GET ${url} declared ${declared} bytes (limit ${MAX_SURFACE_BYTES})`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_SURFACE_BYTES) {
    throw new Error(`GET ${url} returned more than ${MAX_SURFACE_BYTES} bytes`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`GET ${url} is not valid JSON: ${error.message}`);
  }
}

function readExistingArtifact(file = OUTPUT_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.segment === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 拉取/蒸馏失败时的离线兜底：旧产物在位就沿用（不重写文件，mtime 与内容都保持上一轮）；
 * 没有旧产物时默认把原始错误抛出去（离线构建可以旧，但不能悄悄产出空段）。
 *
 * allowMissing 是**给未部署端点的逃生舱**（VTT M3 的部署登记未落地前，云端
 * /user-files/compat/api-surface.json 还是 404）：置位时降级为响亮警告 + 不写产物，
 * 该档的蒸馏段缺席（mtcompat 行为回落到与 foundry 同面）。发布链默认不开。
 */
function reuseExistingArtifact(reason, { outputFile = OUTPUT_FILE, log = (message) => process.stdout.write(message), allowMissing = false } = {}) {
  const existing = readExistingArtifact(outputFile);
  if (!existing) {
    if (!allowMissing) {
      throw new Error(
        `${reason.message}；且没有可沿用的旧产物（${outputFile}）。`
        + `逃生舱（端点未部署时用）：${SURFACE_ALLOW_MISSING_ENV}=1 或 --allow-missing`,
      );
    }
    warn(`${reason.message}；且没有可沿用的旧产物（${outputFile}）——`
      + `${SURFACE_ALLOW_MISSING_ENV} 已放行，本次不产出蒸馏段（mtcompat 档按无声明面运行）`);
    return null;
  }
  warn(`${reason.message}；沿用旧产物 rev ${existing.revision}（生成于 ${existing.generatedAt}）`);
  log(
    `[prepare-mtcompat-surface] 离线沿用 ${outputFile}（rev ${existing.revision}，`
    + `坑位 ${existing.pitfalls?.length ?? "?"} 条，段落 ${existing.segment.length} 字符）\n`,
  );
  return existing;
}

function resolveTop(value) {
  const text = String(value ?? "").trim();
  if (text === "") return DEFAULT_PITFALL_LIMIT;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--top must be a non-negative integer; got: ${text}`);
  return parsed;
}

export function parseArgs(argv) {
  const result = { booleans: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--insecure" || key === "--allow-missing") {
      result.booleans.add(key.slice(2));
      continue;
    }
    if (!key?.startsWith("--")) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

export async function main(argv = process.argv.slice(2), { log = (message) => process.stdout.write(message), outputFile = OUTPUT_FILE, fetchImpl = undefined } = {}) {
  const args = parseArgs(argv);
  const url = String(args.url ?? process.env[SURFACE_URL_ENV] ?? "").trim() || DEFAULT_SURFACE_URL;
  const top = resolveTop(args.top ?? process.env[SURFACE_TOP_ENV]);
  const insecure = args.booleans.has("insecure") || String(process.env[SURFACE_INSECURE_ENV] ?? "").trim() === "1";
  if (insecure) {
    // 本地栈用自签证书。这是显式 opt-in 的构建开关（默认仍严格校验），只影响本进程。
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    warn(`TLS 证书校验已关闭（${SURFACE_INSECURE_ENV} / --insecure）`);
  }

  let artifact;
  try {
    artifact = distillSurface(await fetchSurface(url, fetchImpl ? { fetchImpl } : {}), { top, sourceUrl: url });
  } catch (error) {
    const allowMissing = args.booleans.has("allow-missing")
      || String(process.env[SURFACE_ALLOW_MISSING_ENV] ?? "").trim() === "1";
    reuseExistingArtifact(error, { outputFile, log, allowMissing });
    return;
  }

  const previous = readExistingArtifact(outputFile);
  if (previous && previous.revision === artifact.revision && previous.segment === artifact.segment) {
    log(`[prepare-mtcompat-surface] 声明面未变（rev ${artifact.revision}），保留现有产物\n`);
    return;
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  log(
    `[prepare-mtcompat-surface] 产物 ${outputFile}\n`
    + `[prepare-mtcompat-surface] revision=${artifact.revision} defaultPolicy=${artifact.defaultPolicy} `
    + `声明 ${artifact.counts.entries} 条 / ${artifact.counts.domains} 域；`
    + `坑位 ${artifact.counts.pitfalls} 条（限 ${artifact.pitfallLimit}）+ 扩展动词 ${artifact.counts.extensions} 条；`
    + `段落 ${artifact.segment.length} 字符，源 ${url}\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
