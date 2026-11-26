// map_builder_source_attach — 把当前世界的自定义 Item 发布成用户合集并接入战役车卡器。
//
// 跨仓契约（Map 侧实现，Desk 只调用）：
//   play  : builderSourcePlan({sourceUuids,moduleId?,title?,version?})
//           → {status:"completed",plan,dump} | {status:"rejected",code,issues,retry:false}
//   lobby : builderSourceImportStart({dump}) → {jobId,plan}
//           终态继续用 lobbyImportStatus（复用 MtLobbyClient.statusJob）。
//   选包  : lobbyCampaignPacksGet / lobbyCampaignPacksUpdate（仅增量 add，漂移只重读）。
//
// 本文件不把 dump/base64 交给模型，也不把页面脚本交给模型：规划与落库都走 Map 的
// typed action；导入后的回读是固定只读脚本（play 页的包注册、UUID 解析与身份/法术表抽查）。
// 任何条目/素材失败、选包未完成或回读失败都只能 partial，绝不伪装 completed。
import { Type } from "typebox";
import { defineTool as definePiTool } from "@earendil-works/pi-coding-agent";
import { jsonSafe } from "./json-safe.js";
import { FoundryOperationStore } from "./foundry-operation-store.js";
import { MtLobbyError, isTerminalJob, jobPhaseOf } from "./mt-lobby-client.js";
import { callPageRuntime, navigatePlayToLobby, requireLobbyPrep } from "./lobby-tools.js";
import { PAGE_PROFILES } from "./page-profiles.js";

const TOOL_NAME = "map_builder_source_attach";
const ACTION = "builderSourceAttach";
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WORLD_ITEM_PATTERN = /^Item\.[A-Za-z0-9]{8,64}$/;
const IDENTITY_TYPES = new Set(["class", "subclass", "race", "background"]);
const SUCCESS_JOB_PHASES = new Set(["succeeded", "completed", "done", "success"]);
const JOB_WAIT_BUDGET_MS = 5 * 60_000;
const JOB_STATUS_WAIT_MS = 25_000;
const PLAY_READY_TIMEOUT_MS = 30_000;
const PACK_REVISION_READS = 3;

const exact = properties => Type.Object(properties, { additionalProperties: false });

function textResult(data) {
  const safe = jsonSafe(data);
  return {
    content: [{ type: /** @type {const} */ ("text"), text: `${statusText(safe)}\n\n${JSON.stringify(safe, null, 2)}` }],
    details: safe,
  };
}

function rejection(code, message, extra = {}) {
  const details = { status: "rejected", code, retry: false, message, ...extra };
  return {
    content: [{ type: /** @type {const} */ ("text"), text: `${code}: ${message}` }],
    details,
    isError: true,
  };
}

function errorCodeOf(error) {
  if (typeof error?.code === "string" && error.code) return error.code;
  const matched = /^([A-Z][A-Z0-9_]+)(?::|\b)/.exec(String(error?.message ?? ""));
  return matched?.[1] ?? "BUILDER_ATTACH_FAILED";
}

function errorResult(error) {
  const code = errorCodeOf(error);
  const message = String(error?.message ?? error).slice(0, 1600);
  let guidance = "";
  if (code === "LOGIN_REQUIRED") {
    guidance = " End the turn and let the user sign in directly in the panel; never evaluate the lobby or auth page.";
  } else if (code === "CAPABILITY_UNAVAILABLE" || code === "ACTION_UNKNOWN") {
    guidance = " The deployed Map runtime does not implement builderSourcePlan yet; do not substitute page eval, raw REST, or a hand-built ZIP.";
  } else if (code === "PROFILE_MISMATCH") {
    guidance = " Open the campaign play page first; this tool plans world Items on a ready play page and uses the typed lobby channel for the import.";
  } else if (code === "JOB_INDETERMINATE") {
    guidance = " The result is uncertain and was not replayed. Check map_lobby_import_job and the campaign packs before deciding whether to rerun.";
  } else if (code === "DECLINED") {
    guidance = " Do not retry this call.";
  }
  return rejection(code, `${message}${guidance}`);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MtLobbyError("ABORTED", "Cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MtLobbyError("ABORTED", "Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- plan / dump 归一（纯函数，便于聚焦测试） ----

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map(value => String(value ?? "")).filter(Boolean))];
}

/** 发布前的 canonical UUID → 导入后的 user-<moduleId> UUID；外部引用原样保留。 */
export function publishedUuid(uuid, moduleId) {
  const text = String(uuid ?? "");
  const matched = /^Compendium\.([^.]+)\.(.+)$/.exec(text);
  if (!matched) return text;
  const [, pkg, rest] = matched;
  if (pkg === `user-${moduleId}`) return text;
  if (pkg === moduleId) return `Compendium.user-${moduleId}.${rest}`;
  return text;
}

/** plan/dump 里的 pack 标识统一成导入后的完整 packId。 */
export function publishedPackId(packId, moduleId) {
  const raw = String(packId ?? "");
  if (!raw) return raw;
  if (raw.startsWith("user-")) return raw;
  if (raw.startsWith(`${moduleId}.`)) return `user-${moduleId}.${raw.slice(moduleId.length + 1)}`;
  return `user-${moduleId}.${raw}`;
}

/** dump 的 `packs/entries` 索引：按 _id 建根映射与 canonical UUID 闭包。 */
export function indexDump(dump, moduleId) {
  const docs = new Map();
  const known = new Set();
  const packs = [];
  for (const pack of asArray(dump?.packs)) {
    const name = String(pack?.name ?? "");
    if (!name) continue;
    const documentType = String(pack?.type ?? "Item");
    const entries = asArray(pack?.entries);
    packs.push({ name, documentType, system: pack?.system ?? null, label: pack?.label ?? null, entries: entries.length });
    for (const entry of entries) {
      const id = String(entry?._id ?? "");
      if (!id) continue;
      known.add(`Compendium.${moduleId}.${name}.${documentType}.${id}`);
      // 引用可能写成条目的具体 document type（如 Item 包里的 Item），两种都接受。
      known.add(`Compendium.${moduleId}.${name}.${String(entry?.type ?? documentType)}.${id}`);
      docs.set(id, { pack: name, documentType, entry });
    }
  }
  return { docs, known, packs };
}

/** plan 已经给出 uuidMap/roots 时优先采用，否则按设计约定用相同 _id 推导。 */
function planUuidMap(plan, moduleId) {
  const out = new Map();
  const consume = value => {
    if (!value || typeof value !== "object") return;
    const sourceUuid = String(value.sourceUuid ?? value.source ?? "").trim();
    const uuid = String(value.uuid ?? value.targetUuid ?? "").trim();
    if (sourceUuid && uuid) out.set(sourceUuid, publishedUuid(uuid, moduleId));
  };
  if (Array.isArray(plan?.roots)) plan.roots.forEach(consume);
  if (Array.isArray(plan?.uuidMap)) plan.uuidMap.forEach(consume);
  if (plan?.uuidMap && !Array.isArray(plan.uuidMap) && typeof plan.uuidMap === "object") {
    for (const [sourceUuid, uuid] of Object.entries(plan.uuidMap)) out.set(sourceUuid, publishedUuid(uuid, moduleId));
  }
  if (Array.isArray(plan?.published?.uuidMap)) plan.published.uuidMap.forEach(consume);
  return out;
}

function spellClassesOf(entry, moduleId) {
  const values = entry?.flags?.[moduleId]?.spellClasses;
  return Array.isArray(values) ? values.map(value => String(value)) : null;
}

/** 根期望表：published UUID、文档类型、identifier 与法术列表标注（用于导入后回读）。
 * @param {{ dump: any, moduleId: string, sourceUuids: string[], plan?: any }} input */
export function rootExpectations({ dump, moduleId, sourceUuids, plan }) {
  const index = indexDump(dump, moduleId);
  const provided = planUuidMap(plan, moduleId);
  const roots = sourceUuids.map(sourceUuid => {
    const id = sourceUuid.slice("Item.".length);
    const hit = index.docs.get(id) ?? null;
    if (!hit) return { sourceUuid, uuid: provided.get(sourceUuid) ?? null, missing: true };
    const uuid = provided.get(sourceUuid) ?? publishedUuid(`Compendium.${moduleId}.${hit.pack}.${hit.documentType}.${id}`, moduleId);
    const entry = hit.entry;
    return {
      sourceUuid,
      uuid,
      type: entry?.type != null ? String(entry.type) : null,
      identifier: entry?.system?.identifier != null ? String(entry.system.identifier) : null,
      pack: hit?.pack ?? null,
      spellClasses: entry?.type === "spell" ? spellClassesOf(entry, moduleId) : null,
    };
  });
  return { roots, index };
}

function normalizePlanPacks(plan, dump, moduleId) {
  const planned = asArray(plan?.packs);
  if (planned.length) {
    return planned.map(pack => {
      const raw = String(pack?.packId ?? pack?.id ?? pack?.name ?? "");
      return {
        packId: publishedPackId(raw, moduleId),
        name: raw.split(".").pop(),
        operation: pack?.operation ?? "update",
        entries: Number.isInteger(pack?.entries) ? pack.entries : (Number.isInteger(pack?.count) ? pack.count : null),
      };
    }).filter(pack => pack.packId);
  }
  return asArray(dump?.packs).map(pack => ({
    packId: `user-${moduleId}.${String(pack?.name ?? "")}`,
    name: String(pack?.name ?? ""),
    operation: "create",
    entries: asArray(pack?.entries).length,
  })).filter(pack => pack.name);
}

function normalizeAssets(assets) {
  if (!assets || typeof assets !== "object") return { reuse: 0, upload: 0, bytes: 0 };
  return {
    reuse: Number.isInteger(assets.reuse) ? assets.reuse : Number(assets.reuseCount ?? 0),
    upload: Number.isInteger(assets.upload) ? assets.upload : Number(assets.uploadCount ?? 0),
    bytes: Number(assets.bytes ?? assets.totalBytes ?? 0),
  };
}

function planIssues(plan) {
  const issues = plan?.issues && typeof plan.issues === "object" ? plan.issues : {};
  return {
    errors: asArray(issues.errors),
    warnings: asArray(issues.warnings),
  };
}

/** @param {any} plan @param {{ dump?: any, moduleId?: string, rootCount?: number }} [context] */
export function planSummary(plan, { dump, moduleId, rootCount } = {}) {
  const issues = planIssues(plan);
  const warnings = [...issues.warnings, ...asArray(plan?.warnings)];
  const seen = new Set();
  return {
    digest: plan?.digest != null ? String(plan.digest) : null,
    rootCount: Number.isInteger(plan?.rootCount) ? plan.rootCount : rootCount ?? null,
    dependencyCount: Number.isInteger(plan?.dependencyCount)
      ? plan.dependencyCount
      : (Array.isArray(plan?.dependencies) ? plan.dependencies.length : null),
    exposure: plan?.exposure ?? null,
    packs: normalizePlanPacks(plan, dump, moduleId),
    assets: normalizeAssets(plan?.assets),
    warnings: warnings.filter(warning => {
      const key = JSON.stringify(warning);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

// ---- 引用闭包（canonical dump 内部） ----

const COMPENDIUM_REF = /Compendium\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)\.([A-Za-z0-9]{8,64})/g;
const WORLD_REF = /@UUID\[(?:Item|Actor|JournalEntry|Scene)\.([A-Za-z0-9]{8,64})\]/g;
const SKIP_KEYS = new Set(["bytesBase64", "bytes", "base64", "rawAssetBytes", "aliasedBytes", "assets", "entry"]);

function collectStrings(value, visit, depth = 0, state = { seen: new WeakSet(), nodes: 0 }) {
  if (depth > 40 || state.nodes > 200_000) return;
  if (typeof value === "string") {
    state.nodes += 1;
    visit(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, visit, depth + 1, state);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SKIP_KEYS.has(key)) continue;
    collectStrings(item, visit, depth + 1, state);
  }
}

/**
 * 只检查本模块 canonical 引用是否落在 dump 内；外部 Compendium 依赖由 Map 的 plan
 * 验证并原样保留。残留的世界 UUID（`@UUID[Item.xxx]`）说明改写不完整，按未解析处理。
 * @param {any} dump @param {{ moduleId?: string }} [options]
 */
export function inspectReferenceClosure(dump, { moduleId } = {}) {
  const { known, docs } = indexDump(dump, moduleId);
  const unresolved = new Set();
  const external = new Set();
  const worldRefs = new Set();
  collectStrings(dump, text => {
    COMPENDIUM_REF.lastIndex = 0;
    let match;
    while ((match = COMPENDIUM_REF.exec(text)) !== null) {
      const [uuid, pkg] = match;
      if (pkg === `user-${moduleId}`) continue;
      if (pkg === moduleId) {
        if (!known.has(uuid)) unresolved.add(uuid);
      } else {
        external.add(uuid);
      }
    }
    WORLD_REF.lastIndex = 0;
    while ((match = WORLD_REF.exec(text)) !== null) {
      const id = match[1];
      if (docs.has(id)) worldRefs.add(match[0]);
    }
  });
  return {
    unresolvedRefs: [...unresolved].sort(),
    worldRefs: [...worldRefs].sort(),
    externalRefs: [...external].sort(),
  };
}

// ---- 导入后回读（play 页固定只读脚本） ----

function verificationScript(expectations) {
  return `(async () => {
  const EXPECTED = ${JSON.stringify(expectations)};
  const missing = [];
  const register = { called: false, ok: false };
  try {
    if (typeof globalThis.__MT_REGISTER_USER_PACKS__ === "function") {
      register.called = true;
      await globalThis.__MT_REGISTER_USER_PACKS__();
      register.ok = true;
    } else {
      missing.push({ feature: "register" });
    }
  } catch (error) {
    missing.push({ feature: "register", error: String(error && error.message ? error.message : error) });
  }
  const packs = [];
  for (const packId of EXPECTED.packIds) {
    let pack = null;
    try { pack = game?.packs?.get?.(packId) ?? null; } catch (error) { pack = null; }
    if (!pack) {
      packs.push({ packId, present: false });
      missing.push({ feature: "pack", path: packId });
      continue;
    }
    let count = null;
    try {
      const index = await pack.getIndex();
      count = index?.size ?? index?.length ?? null;
    } catch (error) { count = null; }
    packs.push({ packId, present: true, count });
  }
  const roots = [];
  for (const row of EXPECTED.roots) {
    let doc = null;
    try { doc = await fromUuid(row.uuid); } catch (error) { doc = null; }
    if (!doc) {
      roots.push({ ...row, resolved: false });
      missing.push({ feature: "uuid", path: row.uuid });
      continue;
    }
    if (row.type && doc.type !== row.type) {
      missing.push({ feature: "type", path: row.uuid, expected: row.type, actual: doc.type ?? null });
    }
    if (row.identifier != null && doc.system?.identifier !== row.identifier) {
      missing.push({ feature: "identifier", path: row.uuid, expected: row.identifier, actual: doc.system?.identifier ?? null });
    }
    const spellClasses = Array.isArray(doc.flags?.[EXPECTED.moduleId]?.spellClasses)
      ? doc.flags[EXPECTED.moduleId].spellClasses.map(value => String(value))
      : null;
    roots.push({ ...row, resolved: true, actualType: doc.type ?? null,
      actualIdentifier: doc.system?.identifier ?? null, spellClasses });
  }
  return { register, packs, roots, missing };
})()`;
}

function sameStringSet(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
  const left = [...new Set(expected)].sort();
  const right = [...new Set(actual)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeVerification(value, expectations, localClosure) {
  const register = value?.register ?? {};
  const packs = asArray(value?.packs);
  const roots = asArray(value?.roots);
  const missing = asArray(value?.missing);
  const packRegistry = register.ok === true && expectations.packIds.every(packId => packs.some(pack => pack?.packId === packId && pack.present === true))
    ? "passed"
    : "failed";
  const identity = roots.filter(root => IDENTITY_TYPES.has(root?.type));
  const identityFailures = new Set(missing
    .filter(item => item?.feature === "uuid" || item?.feature === "type" || item?.feature === "identifier")
    .map(item => String(item?.path ?? "")));
  const identityPassed = identity.length === 0
    ? "not-applicable"
    : identity.every(root => root?.resolved === true && !identityFailures.has(String(root.uuid)))
      ? "passed"
      : "failed";
  const spellRoots = roots.filter(root => root?.type === "spell" && Array.isArray(root?.expectedSpellClasses) && root.expectedSpellClasses.length > 0);
  const spellLists = spellRoots.length === 0
    ? "not-applicable"
    : spellRoots.every(root => root.resolved === true && sameStringSet(root.expectedSpellClasses, root.spellClasses))
      ? "passed"
      : "failed";
  const unresolved = new Set([...asArray(localClosure?.unresolvedRefs), ...asArray(localClosure?.worldRefs)]);
  for (const item of missing) {
    if (item?.path) unresolved.add(String(item.path));
    else if (item?.feature) unresolved.add(String(item.feature));
  }
  return {
    packRegistry,
    identityCandidates: identityPassed,
    spellLists,
    dependencyResolution: unresolved.size === 0 && roots.every(root => root?.resolved !== false) ? "passed" : "failed",
    unresolvedRefs: [...unresolved].sort(),
  };
}

function verificationPassed(verification) {
  return verification.packRegistry === "passed"
    && ["passed", "not-applicable"].includes(verification.identityCandidates)
    && ["passed", "not-applicable"].includes(verification.spellLists)
    && verification.dependencyResolution === "passed"
    && verification.unresolvedRefs.length === 0;
}

// ---- 状态机 ----

function jobReport(status) {
  return status?.report && typeof status.report === "object" ? status.report : null;
}

function splitFailures(status) {
  const report = jobReport(status) ?? {};
  const entryFailures = asArray(report.entryFailures ?? report.entries?.failures ?? status?.entryFailures);
  const assetFailures = asArray(report.assetFailures ?? report.assets?.failures ?? status?.assetFailures);
  const failures = asArray(report.failures ?? status?.failures);
  return { entryFailures, assetFailures, failures };
}

function reportUuidMap(status, moduleId) {
  const report = jobReport(status) ?? {};
  const merged = new Map();
  for (const source of [status?.uuidMap, status?.roots, report.uuidMap, report.roots]) {
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (!entry || typeof entry !== "object") continue;
        const sourceUuid = String(entry.sourceUuid ?? entry.source ?? "").trim();
        const uuid = String(entry.uuid ?? entry.targetUuid ?? "").trim();
        if (sourceUuid && uuid) merged.set(sourceUuid, publishedUuid(uuid, moduleId));
      }
    } else if (source && typeof source === "object") {
      for (const [sourceUuid, uuid] of Object.entries(source)) {
        if (sourceUuid && uuid) merged.set(sourceUuid, publishedUuid(uuid, moduleId));
      }
    }
  }
  return merged;
}

function publishedFrom(plan, status, { roots, moduleId }) {
  const report = jobReport(status) ?? {};
  const map = new Map([...planUuidMap(plan, moduleId), ...reportUuidMap(status, moduleId)]);
  const uuidMap = roots.map(root => ({ sourceUuid: root.sourceUuid, uuid: map.get(root.sourceUuid) ?? root.uuid ?? null }))
    .filter(row => row.uuid);
  const { entryFailures, assetFailures } = splitFailures(status);
  return {
    batchId: report.batchId ?? report.batch?.batchId ?? status?.batchId ?? null,
    uuidMap,
    dependencyDocuments: Number.isInteger(report.dependencyDocuments)
      ? report.dependencyDocuments
      : (Number.isInteger(plan?.dependencyCount) ? plan.dependencyCount : null),
    entryFailures,
    assetFailures,
  };
}

function selectedPackIds(value) {
  const out = new Set();
  const selected = value?.selected;
  if (selected && typeof selected === "object" && !Array.isArray(selected)) {
    for (const [packId, enabled] of Object.entries(selected)) {
      if (enabled) out.add(packId);
    }
    return out;
  }
  for (const item of asArray(selected)) {
    if (typeof item === "string") out.add(item);
    else if (item && typeof item === "object") {
      const id = item.packId ?? item.fullId ?? item.id;
      if (id) out.add(String(id));
    }
  }
  return out;
}

function revisionOf(value) {
  const revision = value?.revision ?? value?.packsRev;
  return revision === undefined ? null : revision;
}

/** 选包增量 add；revision 漂移只重读选包，绝不重跑导入。 */
async function attachCampaignPacks(client, { campaignId, packIds, signal }) {
  let lastRevision = null;
  for (let attempt = 0; attempt < PACK_REVISION_READS; attempt += 1) {
    const current = await client.call("lobbyCampaignPacksGet", { campaignId }, { signal });
    lastRevision = revisionOf(current);
    const selected = selectedPackIds(current);
    const add = packIds.filter(packId => !selected.has(packId));
    if (!add.length) {
      return { attachedPackIds: packIds, packsRev: lastRevision, updated: false };
    }
    try {
      await client.call("lobbyCampaignPacksUpdate", {
        campaignId,
        expectedRevision: lastRevision,
        add,
      }, { signal });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "REVISION_MISMATCH" || /revision/i.test(String(error?.message ?? ""))) continue;
      throw error;
    }
    const after = await client.call("lobbyCampaignPacksGet", { campaignId }, { signal });
    lastRevision = revisionOf(after);
    const selectedAfter = selectedPackIds(after);
    const missing = packIds.filter(packId => !selectedAfter.has(packId));
    if (!missing.length) {
      return { attachedPackIds: packIds, packsRev: lastRevision, updated: true };
    }
    throw new MtLobbyError("PACK_SELECTION_INCOMPLETE", `Campaign pack selection did not include: ${missing.join(", ")}`);
  }
  throw new MtLobbyError("REVISION_MISMATCH", "Campaign pack selection kept changing; the import was not replayed");
}

async function waitForJob(client, jobId, signal) {
  const deadline = Date.now() + JOB_WAIT_BUDGET_MS;
  for (;;) {
    const status = await client.statusJob(jobId, { waitMs: JOB_STATUS_WAIT_MS, signal });
    if (isTerminalJob(status)) return status;
    if (Date.now() >= deadline) {
      throw new MtLobbyError("JOB_INDETERMINATE", `Import job ${jobId} did not reach a terminal state within the wait budget; it was not replayed`);
    }
  }
}

async function waitForPlay(client, campaignId, signal) {
  const deadline = Date.now() + PLAY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new MtLobbyError("ABORTED", "Cancelled");
    try {
      const page = client.classifyPanelUrl();
      if (page.kind === "play" && page.campaignId === campaignId) return page;
    } catch { /* navigation still settling */ }
    await delay(100, signal);
  }
  return null;
}

class BuilderSourceAttachService {
  constructor(host, { page, client }) {
    this.host = host;
    this.page = page;
    this.client = client;
  }

  async plan({ sourceUuids, moduleId, title, version, signal }) {
    const args = { sourceUuids, moduleId };
    if (title !== undefined) args.title = title;
    if (version !== undefined) args.version = version;
    return callPageRuntime(this.host, "builderSourcePlan", args, { signal, executionTimeoutMs: 120_000 });
  }

  async apply({ params, sourceUuids, moduleId, signal }) {
    const stages = [];
    const stage = (step, state, summary) => stages.push({ step, state, ...(summary ? { summary } : {}) });
    const campaignId = this.page.campaignId;
    const base = { module: null, target: { campaignId, system: null }, stages };

    let planned;
    try {
      planned = await this.plan({ sourceUuids, moduleId, title: params.title, version: params.version, signal });
    } catch (error) {
      return {
        ...base,
        status: "rejected",
        code: errorCodeOf(error),
        retry: false,
        message: `builderSourcePlan failed before any write: ${String(error?.message ?? error)}`,
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }
    if (!planned || planned.status === "rejected") {
      return {
        ...base,
        status: "rejected",
        code: String(planned?.code ?? "PLAN_REJECTED"),
        retry: false,
        issues: planned?.issues ?? null,
        message: String(planned?.message ?? "The Map planner rejected this content before any write."),
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }
    if (planned.status !== "completed" || !planned.plan || !planned.dump) {
      return {
        ...base,
        status: "rejected",
        code: "PLAN_PROTOCOL_INVALID",
        retry: false,
        message: "builderSourcePlan returned no completed plan/dump; nothing was written.",
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }

    const plan = planned.plan;
    const dump = planned.dump;
    const dumpModuleId = String(dump?.moduleId ?? dump?.moduleJson?.id ?? "").trim();
    if (!dumpModuleId || dumpModuleId !== moduleId) {
      return {
        ...base,
        status: "rejected",
        code: "PLAN_PROTOCOL_INVALID",
        retry: false,
        message: `The planner returned module '${dumpModuleId || "unknown"}' for requested module '${moduleId}'; nothing was written.`,
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }
    if (!asArray(dump.packs).length) {
      return {
        ...base,
        status: "rejected",
        code: "PLAN_PROTOCOL_INVALID",
        retry: false,
        message: "The planner returned no packs; nothing was written.",
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }

    const issues = planIssues(plan);
    if (issues.errors.length) {
      return {
        ...base,
        status: "rejected",
        code: "PLAN_ISSUES",
        retry: false,
        issues,
        plan: planSummary(plan, { dump, moduleId, rootCount: sourceUuids.length }),
        message: "The plan still reports blocking issues; nothing was written.",
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }

    const { roots } = rootExpectations({ dump, moduleId, sourceUuids, plan });
    const missingRoots = roots.filter(root => root.missing || !root.uuid);
    if (missingRoots.length) {
      return {
        ...base,
        status: "rejected",
        code: "ROOT_NOT_PUBLISHED",
        retry: false,
        missingRoots: missingRoots.map(root => root.sourceUuid),
        message: "At least one source world Item is not part of the planned dump; nothing was written.",
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }

    const closure = inspectReferenceClosure(dump, { moduleId });
    if (closure.unresolvedRefs.length || closure.worldRefs.length) {
      return {
        ...base,
        status: "rejected",
        code: "DEPENDENCY_CLOSURE_FAILED",
        retry: false,
        unresolvedRefs: [...closure.unresolvedRefs, ...closure.worldRefs],
        message: "The planned dump still contains unresolvable internal or world references; nothing was written.",
        stages: [...stages, { step: "plan", state: "failed" }],
      };
    }

    const summary = planSummary(plan, { dump, moduleId, rootCount: sourceUuids.length });
    const module = {
      id: moduleId,
      title: plan?.module?.title ?? dump.title ?? dump.moduleJson?.title ?? dumpModuleId,
      version: plan?.module?.version ?? (dump.version != null ? String(dump.version) : null),
    };
    const target = {
      campaignId,
      system: plan?.target?.system ?? plan?.system ?? asArray(dump.packs)[0]?.system ?? null,
    };
    base.module = module;
    base.target = target;
    base.plan = summary;
    stage("plan", "completed", `${summary.rootCount ?? sourceUuids.length} roots, ${summary.dependencyCount ?? "?"} dependencies`);

    // 进入大厅；这一步只导航，不写内容。
    let navigation;
    try {
      navigation = await navigatePlayToLobby(this.host, this.client, this.page, { signal });
      stage("lobby", "completed", "Lobby service is ready");
    } catch (error) {
      const code = errorCodeOf(error);
      const status = code === "JOB_INDETERMINATE" ? "indeterminate" : "rejected";
      return {
        ...base,
        status,
        code,
        retry: false,
        ...(status === "indeterminate" ? { jobId: null } : {}),
        message: `Could not reach the campaign lobby; no content write was dispatched: ${String(error?.message ?? error)}`,
        stages: [...stages, { step: "lobby", state: "failed" }],
        navigation: { returnedToPlay: false, url: null },
      };
    }

    // 选包前置读取：读不到就不导入，避免写进一个无法启用的战役。
    try {
      await this.client.call("lobbyCampaignPacksGet", { campaignId }, { signal });
      stage("campaign_preflight", "completed");
    } catch (error) {
      return {
        ...base,
        status: "rejected",
        code: errorCodeOf(error),
        retry: false,
        message: `Campaign pack preflight failed; no import was started: ${String(error?.message ?? error)}`,
        stages: [...stages, { step: "campaign_preflight", state: "failed" }],
        navigation: { returnedToPlay: false, url: null },
      };
    }

    const neededPackIds = uniqueStrings(summary.packs.map(pack => pack.packId));
    let started;
    let importDispatched = false;
    try {
      const targetSnapshot = this.client.captureTarget();
      started = await this.client.call("builderSourceImportStart", { dump }, { signal, timeoutMs: 120_000 });
      importDispatched = true;
      if (typeof started?.jobId === "string" && started.jobId) {
        this.client.registerJob(started.jobId, targetSnapshot);
      }
    } catch (error) {
      const code = errorCodeOf(error);
      const preDispatch = ["CAPABILITY_UNAVAILABLE", "LOGIN_REQUIRED", "INPUT_INVALID", "ACTION_UNKNOWN"].includes(code);
      return {
        ...base,
        status: preDispatch ? "rejected" : "indeterminate",
        code,
        retry: false,
        jobId: null,
        message: preDispatch
          ? `The lobby rejected the prepared import before starting a job: ${String(error?.message ?? error)}`
          : `The prepared import may have started but its job id is unknown; do not replay: ${String(error?.message ?? error)}`,
        stages: [...stages, { step: "import", state: preDispatch ? "failed" : "unknown" }],
        navigation: { returnedToPlay: false, url: null },
      };
    }

    const jobId = typeof started?.jobId === "string" && started.jobId ? started.jobId : null;
    if (!jobId) {
      return {
        ...base,
        status: "indeterminate",
        code: "IMPORT_JOB_UNKNOWN",
        retry: false,
        jobId: null,
        message: "The lobby accepted the prepared import but returned no job id; inspect the lobby before any retry.",
        stages: [...stages, { step: "import", state: "unknown" }],
        navigation: { returnedToPlay: false, url: null },
      };
    }
    if (importDispatched) stage("import", "started", `job ${jobId}`);

    let status;
    try {
      status = await waitForJob(this.client, jobId, signal);
    } catch (error) {
      return {
        ...base,
        status: "indeterminate",
        code: errorCodeOf(error),
        retry: false,
        jobId,
        message: `Import job ${jobId} did not reach a confirmed terminal state. Do not replay; use map_lobby_import_job to reconcile.`,
        stages: [...stages, { step: "import", state: "unknown" }],
        navigation: { returnedToPlay: false, url: null },
      };
    }

    const phase = jobPhaseOf(status);
    const succeeded = SUCCESS_JOB_PHASES.has(phase.toLowerCase());
    const { entryFailures, assetFailures, failures } = splitFailures(status);
    const reportMap = new Map([...planUuidMap(plan, moduleId), ...reportUuidMap(status, moduleId)]);
    const publishedRoots = roots.map(root => ({ ...root, uuid: reportMap.get(root.sourceUuid) ?? root.uuid }));
    const published = publishedFrom(plan, status, { roots: publishedRoots, moduleId });
    if (!succeeded || entryFailures.length || assetFailures.length || failures.length) {
      return {
        ...base,
        status: "partial",
        code: succeeded ? "IMPORT_ENTRY_FAILURES" : "IMPORT_FAILED",
        retry: false,
        jobId,
        published,
        message: `Import job ${jobId} ended as ${phase} with ${entryFailures.length} entry and ${assetFailures.length} asset failures. Do not replay; reconcile with map_lobby_import_job and the campaign packs.`,
        stages: [...stages, { step: "import", state: succeeded && !entryFailures.length && !assetFailures.length && !failures.length ? "completed" : "failed", summary: phase }],
        campaign: { attachedPackIds: [], packsRev: null },
        verification: null,
        navigation: { returnedToPlay: false, url: null },
      };
    }
    stage("import", "completed", `job ${jobId} (${phase})`);

    let packsResult;
    try {
      packsResult = await attachCampaignPacks(this.client, { campaignId, packIds: neededPackIds, signal });
      stage("campaign", "completed", `${packsResult.attachedPackIds.length} packs attached`);
    } catch (error) {
      return {
        ...base,
        status: "partial",
        code: errorCodeOf(error),
        retry: false,
        jobId,
        published,
        message: `The import completed, but campaign pack selection did not: ${String(error?.message ?? error)}. Do not replay the import; re-read the campaign packs and retry only the selection.`,
        stages: [...stages, { step: "campaign", state: "failed" }],
        campaign: { attachedPackIds: [], packsRev: null },
        verification: null,
        navigation: { returnedToPlay: false, url: null },
      };
    }

    // 回原 play；导航结果未知时不得继续把回读当成功。
    let playPage = null;
    try {
      const outcome = await this.host.openFoundry(navigation.returnPlayUrl);
      if (!outcome?.ok) throw new MtLobbyError("NAVIGATION_FAILED", outcome?.summary ?? outcome?.error ?? "foundry_open refused the return URL");
      playPage = await waitForPlay(this.client, campaignId, signal);
    } catch (error) {
      return {
        ...base,
        status: "indeterminate",
        code: errorCodeOf(error),
        retry: false,
        jobId,
        published,
        campaign: { attachedPackIds: packsResult.attachedPackIds, packsRev: packsResult.packsRev },
        message: `The import and pack selection completed, but returning to the campaign play page was not confirmed: ${String(error?.message ?? error)}. Do not replay; reopen the play page and verify the packs.`,
        stages: [...stages, { step: "navigation", state: "unknown" }],
        verification: null,
        navigation: { returnedToPlay: false, url: navigation.returnPlayUrl ?? null },
      };
    }
    if (!playPage) {
      return {
        ...base,
        status: "indeterminate",
        code: "RETURN_TO_PLAY_UNCONFIRMED",
        retry: false,
        jobId,
        published,
        campaign: { attachedPackIds: packsResult.attachedPackIds, packsRev: packsResult.packsRev },
        message: "The panel did not confirm the original campaign play page in time; do not replay. Reopen the play page and verify the packs.",
        stages: [...stages, { step: "navigation", state: "unknown" }],
        verification: null,
        navigation: { returnedToPlay: false, url: navigation.returnPlayUrl ?? null },
      };
    }
    stage("navigation", "completed", "Returned to the original campaign play page");

    let verification;
    try {
      const expectations = {
        moduleId,
        packIds: neededPackIds,
        roots: publishedRoots.map(root => ({
          sourceUuid: root.sourceUuid,
          uuid: root.uuid,
          type: root.type,
          identifier: root.identifier,
          ...(Array.isArray(root.spellClasses) && root.spellClasses.length
            ? { expectedSpellClasses: root.spellClasses }
            : {}),
        })),
      };
      const receipt = await callPageRuntime(this.host, "pageEval", { code: verificationScript(expectations) }, { signal, executionTimeoutMs: 45_000 });
      if (receipt?.status !== "completed" || !receipt.value) {
        throw new MtLobbyError("VERIFICATION_FAILED", "The play page did not return a verification receipt");
      }
      verification = normalizeVerification(receipt.value, expectations, closure);
    } catch (error) {
      return {
        ...base,
        status: "partial",
        code: errorCodeOf(error) === "VERIFICATION_FAILED" ? "VERIFICATION_FAILED" : "VERIFICATION_UNAVAILABLE",
        retry: false,
        jobId,
        published,
        campaign: { attachedPackIds: packsResult.attachedPackIds, packsRev: packsResult.packsRev },
        message: `The import and pack selection completed, but the play-page read-back failed: ${String(error?.message ?? error)}. Do not replay; verify the user pack and campaign selection manually.`,
        stages: [...stages, { step: "verification", state: "failed" }],
        verification: null,
        navigation: { returnedToPlay: true, url: navigation.returnPlayUrl ?? null },
      };
    }

    if (!verificationPassed(verification)) {
      return {
        ...base,
        status: "partial",
        code: "VERIFICATION_FAILED",
        retry: false,
        jobId,
        published,
        campaign: { attachedPackIds: packsResult.attachedPackIds, packsRev: packsResult.packsRev },
        message: "The import and pack selection completed, but post-import verification did not pass. Do not replay; reconcile the unresolved entries and packs.",
        stages: [...stages, { step: "verification", state: "failed" }],
        verification,
        navigation: { returnedToPlay: true, url: navigation.returnPlayUrl ?? null },
      };
    }
    stage("verification", "completed");

    return {
      status: "completed",
      ...base,
      jobId,
      published,
      campaign: { attachedPackIds: packsResult.attachedPackIds, packsRev: packsResult.packsRev },
      verification,
      navigation: { returnedToPlay: true, url: navigation.returnPlayUrl ?? null },
    };
  }
}

// ---- 工具 ----

function dedupeSourceUuids(values) {
  return uniqueStrings(values);
}

function assertSourceUuids(sourceUuids) {
  if (sourceUuids.length < 1 || sourceUuids.length > 20) {
    throw new MtLobbyError("INPUT_INVALID", "sourceUuids must contain 1..20 distinct world Item UUIDs");
  }
  const invalid = sourceUuids.filter(uuid => !WORLD_ITEM_PATTERN.test(uuid));
  if (invalid.length) {
    throw new MtLobbyError("INPUT_INVALID", `sourceUuids must be world Item.<id> UUIDs; invalid: ${invalid.join(", ")}`);
  }
}

function resolveModuleId(params, campaignId) {
  const moduleId = params.moduleId !== undefined ? String(params.moduleId) : `homebrew-${campaignId}`;
  if (!MODULE_ID_PATTERN.test(moduleId) || moduleId.startsWith("user-")) {
    throw new MtLobbyError("INPUT_INVALID", "moduleId must be a stable lowercase id without the user- prefix; leave it out to use homebrew-<campaignId>");
  }
  return moduleId;
}

function operationStore(host) {
  const directory = host.operationStorageDir;
  const sessionId = typeof host.describeCurrent === "function" ? host.describeCurrent()?.id : null;
  if (!directory || !sessionId) return null;
  return new FoundryOperationStore({ directory, sessionId });
}

async function approve(host, summary, args) {
  if (typeof host.maybeRequestApproval !== "function") return true;
  return Boolean(await host.maybeRequestApproval({ tool: TOOL_NAME, summary, args }));
}

function completedText(details) {
  const { module, target, published, campaign, verification } = details;
  return `Published ${module.id} ${module.version ?? ""} to campaign ${target.campaignId}. ` +
    `${published.uuidMap.length} root UUIDs confirmed; ${campaign.attachedPackIds.length} packs attached. ` +
    `Verification: packRegistry=${verification.packRegistry}, identityCandidates=${verification.identityCandidates}, ` +
    `spellLists=${verification.spellLists}, dependencyResolution=${verification.dependencyResolution}. ` +
    "This receipt covers publication and read-back only; it is not proof that a real player completed character creation.";
}

function statusText(details) {
  if (details.status === "preview") {
    return `Dry run only; nothing was written. ${details.plan.rootCount ?? "?"} roots, ${details.plan.dependencyCount ?? "?"} dependencies, digest ${details.plan.digest ?? "unknown"}.`;
  }
  if (details.status === "completed") return completedText(details);
  if (details.status === "partial") {
    return `${details.code}: ${details.message}`
      + (details.jobId ? ` Use map_lobby_import_job (action=status, jobId=${details.jobId}) and re-read the campaign packs before any retry.` : "");
  }
  if (details.status === "indeterminate") {
    return `${details.code}: ${details.message}`
      + (details.jobId ? ` Job ${details.jobId}; check map_lobby_import_job and the campaign packs; never replay.` : " Never replay; reconcile the lobby state first.");
  }
  return `${details.code}: ${details.message ?? "Rejected before writing."}`;
}

/** @param {any} host */
export function createBuilderSourceTools(host) {
  const tool = definePiTool({
    name: TOOL_NAME,
    label: "Attach custom content to the character builder",
    description:
      "Publish custom Items from the current mt-compat play world as a campaign user pack and enable it for character creation. " +
      "Pass 1..20 world Item UUIDs (Item.<id>) as sourceUuids — for example a custom class with its subclass, features, spells and starting equipment. " +
      "Dependencies, exposure and output packs are derived by the Map planner; never pass pack ids, owner ids, revisions, user-* module ids, ZIPs, dumps or Base64. " +
      "moduleId is optional and must not start with user-; it defaults to homebrew-<campaignId>. version is optional; when omitted the planner decides. " +
      "The default call validates the plan, returns to the campaign lobby, imports the prepared dump, enables every required pack, returns to the original play page and reads back pack registration, root UUIDs, identity candidates, spell lists and the reference closure. " +
      "Example: {sourceUuids:[\"Item.aaaaaaaaaaaaaaaa\",\"Item.bbbbbbbbbbbbbbbb\"], title:\"灰烬秘法\"}. " +
      "Set dryRun:true to return only the structured plan and coverage; a dry run performs zero writes and never returns the dump or Base64 bytes. " +
      "completed means the import had no entry/asset failures, every required pack is selected, and post-import verification passed; it never claims a real player finished character creation. " +
      "partial carries jobId plus the actual failures; indeterminate means the result is unknown. For either, do not replay: inspect map_lobby_import_job and the campaign pack selection first.",
    parameters: exact({
      sourceUuids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 20 }),
      moduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    executionMode: "sequential",
    promptGuidelines: [
      "Read the arcane-builder-source-attach skill first; create or edit the world Items with arcane-item-update before calling this tool.",
      "Use exact world Item.<id> UUIDs, not compendium UUIDs, names, pack ids, revisions, ZIP paths or Base64.",
      "Use dryRun:true when the publishing impact or dependency closure is uncertain; decide yourself, there is no separate approval step.",
      "A successful world Item creation is not proof that players can use it. Report the returned campaign packs and verification, not an imagined player build.",
      "For partial/indeterminate, reconcile with map_lobby_import_job and the campaign pack selection; never replay this tool automatically.",
    ],
    execute: async (toolCallId, params, signal) => {
      try {
        const client = requireLobbyPrep(host);
        const panelProfile = typeof host.panelProfileId === "function" ? host.panelProfileId() : null;
        if (panelProfile !== null && panelProfile !== undefined && panelProfile !== PAGE_PROFILES.mtcompat.id) {
          throw new MtLobbyError("PROFILE_MISMATCH", `${TOOL_NAME} is only available on the mt-compat page profile`);
        }
        const page = client.classifyPanelUrl();
        if (page.kind !== "play") {
          throw new MtLobbyError("PROFILE_MISMATCH", "Open the campaign play page first; world Items are planned from the ready game page");
        }
        const sourceUuids = dedupeSourceUuids(params.sourceUuids);
        assertSourceUuids(sourceUuids);
        const moduleId = resolveModuleId(params, page.campaignId);

        if (params.dryRun === true) {
          let planned;
          try {
            planned = await callPageRuntime(host, "builderSourcePlan", {
              sourceUuids,
              moduleId,
              ...(params.title !== undefined ? { title: params.title } : {}),
              ...(params.version !== undefined ? { version: params.version } : {}),
            }, { signal, executionTimeoutMs: 120_000 });
          } catch (error) {
            return errorResult(error);
          }
          if (!planned || planned.status === "rejected") {
            return rejection(String(planned?.code ?? "PLAN_REJECTED"),
              String(planned?.message ?? "The Map planner rejected this content; nothing was written."),
              { issues: planned?.issues ?? null, retry: false });
          }
          if (planned.status !== "completed" || !planned.plan) {
            return rejection("PLAN_PROTOCOL_INVALID", "builderSourcePlan returned no completed plan; nothing was written.");
          }
          const dump = planned.dump ?? null;
          const summary = planSummary(planned.plan, { dump, moduleId, rootCount: sourceUuids.length });
          const issues = planIssues(planned.plan);
          const details = {
            status: "preview",
            module: {
              id: moduleId,
              title: planned.plan?.module?.title ?? dump?.title ?? moduleId,
              version: planned.plan?.module?.version ?? (dump?.version != null ? String(dump.version) : null),
            },
            target: {
              campaignId: page.campaignId,
              system: planned.plan?.target?.system ?? planned.plan?.system ?? asArray(dump?.packs)[0]?.system ?? null,
            },
            plan: summary,
            coverage: planned.plan?.coverage ?? null,
            issues,
          };
          return textResult(details);
        }

        if (typeof host.openFoundry !== "function") {
          return rejection("CAPABILITY_UNAVAILABLE", "The panel navigation entry is unavailable; no content was published.");
        }
        const approved = await approve(host,
          `Publish ${sourceUuids.length} world Items to ${moduleId} and enable it for campaign ${page.campaignId}`,
          { sourceUuids, moduleId, ...(params.title !== undefined ? { title: params.title } : {}), ...(params.version !== undefined ? { version: params.version } : {}) });
        if (!approved) return rejection("DECLINED", "The user declined this publication; do not retry it.");

        const binding = host.taskCoordinator().currentInputBinding();
        const metadata = await binding.metadata;
        if (!metadata?.world?.origin || !metadata?.world?.id) {
          return rejection("INPUT_WORLD_UNAVAILABLE", "Connect a ready world and submit a new instruction before publishing content.");
        }
        const store = operationStore(host);
        if (!store) {
          return rejection("OPERATION_STORE_UNAVAILABLE", "This session has no durable operation journal; no content was published.");
        }
        const service = new BuilderSourceAttachService(host, { page, client });
        const result = await store.execute({
          taskId: binding.taskId,
          toolCallId,
          world: metadata.world,
          action: ACTION,
          input: params,
          args: { sourceUuids, moduleId, ...(params.title !== undefined ? { title: params.title } : {}), ...(params.version !== undefined ? { version: params.version } : {}) },
        }, () => service.apply({ params, sourceUuids, moduleId, signal }));
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
  return [tool];
}