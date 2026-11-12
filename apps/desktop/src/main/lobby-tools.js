// mt-compat 大厅的 8 个 typed tool。实现静态注册；声明由 AgentHost 按真实页面档位
// 动态激活。写面只接 App 现有 maybeRequestApproval，不新增权限框架。
import { Type } from "typebox";
import { Value } from "typebox/value";
import { defineTool as definePiTool } from "@earendil-works/pi-coding-agent";
import { jsonSafe } from "./json-safe.js";
import { MtLobbyError, isTerminalJob, jobPhaseOf } from "./mt-lobby-client.js";
import { prepareLobbySourceFile } from "./mt-lobby-file.js";

const exact = properties => Type.Object(properties, { additionalProperties: false });
const ref = () => Type.String({ minLength: 1, maxLength: 256 });
const localFile = () => Type.String({ minLength: 1, maxLength: 4096 });
const revision = () => Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1, maxLength: 128 })]);

const DROP_KEYS = new Set([
  "preparationid", "keepassetids", "sourcepath", "realpath", "filepath", "path", "token",
  "accesstoken", "access_token", "refreshtoken", "refresh_token", "password", "authorization",
  "base64", "bytes", "zipbytes",
]);
const MAX_WAIT_MS = 25_000;

function redactPaths(text) {
  const remoteUrls = [];
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => {
      remoteUrls.push(url);
      return `${remoteUrls.length - 1}`;
    })
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[path]")
    .replace(/\\\\[^\\\s]+\\[^\s"'<>]+/g, "[path]")
    .replace(/\/(?:Users|home|tmp|var|opt|private)\/[^\s"'<>]+/g, "[path]")
    .replace(/(\d+)/g, (_marker, index) => remoteUrls[Number(index)]);
}

function bounded(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const text = redactPaths(value);
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 6) return "[depth limit]";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => bounded(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (DROP_KEYS.has(key.toLowerCase())) continue;
      result[key] = bounded(item, depth + 1, seen);
      if (++count >= 40) break;
    }
    return result;
  }
  return String(value);
}

function textResult(data, details) {
  const safe = jsonSafe(details ?? data);
  return { content: [{ type: /** @type {const} */ ("text"), text: jsonSafe(data) === undefined ? "undefined" : JSON.stringify(jsonSafe(data), null, 2) }], details: safe };
}

function rejection(code, message, extra = {}) {
  const safeMessage = redactPaths(message).slice(0, 1600);
  return {
    content: [{ type: "text", text: `${code}: ${safeMessage}` }],
    details: { status: "rejected", code, ...extra },
  };
}

function errorResult(error, extra = {}) {
  const code = typeof error?.code === "string" ? error.code : "LOBBY_ACTION_FAILED";
  let guidance = "";
  if (code === "LOGIN_REQUIRED") {
    guidance = " The user must sign in directly in the panel; end the turn and wait, then retry with foundry_open or world_status.";
  } else if (code === "PROFILE_MISMATCH") {
    guidance = " Open the mt-compat lobby page with foundry_open; play, login, and plain Foundry pages do not expose lobby actions.";
  } else if (code === "CAPABILITY_UNAVAILABLE") {
    guidance = " The lobby service/runtime on this page is missing or too old; do not fall back to raw REST or page eval.";
  } else if (code === "JOB_INDETERMINATE") {
    guidance = " The job was not replayed. Re-open the lobby and verify campaigns, packs, and import batches before deciding whether to rerun.";
  } else if (code === "FILE_OUTSIDE_FENCE") {
    guidance = " Choose a source file inside the current prep directory or an existing Arcane mirror staging directory.";
  } else if (code === "DECLINED") {
    guidance = " Do not retry this call.";
  }
  return {
    content: [{ type: "text", text: `${code}: ${redactPaths(String(error?.message ?? error)).slice(0, 1600)}${guidance}` }],
    details: { status: "rejected", code, ...extra },
    isError: true,
  };
}

// 与 foundry-tools.js 同一套 provider 兼容处理：对象根 + 精确 union 预校验。
function defineTool(definition) {
  const contract = definition.parameters;
  if (!Array.isArray(contract.anyOf)) return definePiTool(definition);
  const branches = /** @type {any[]} */ (contract.anyOf);
  const properties = /** @type {Record<string, any>} */ ({});
  const required = /** @type {any} */ (Type.Required);
  for (const key of new Set(branches.flatMap(branch => Object.keys(branch.properties)))) {
    const variants = [...new Map(branches.filter(branch => key in branch.properties)
      .map(branch => { const schema = required(exact({ value: branch.properties[key] })).properties.value; return [JSON.stringify(schema), schema]; })).values()];
    const schema = variants.length === 1 ? variants[0] : Type.Union(variants);
    properties[key] = branches.every(branch => branch.required?.includes(key)) ? schema : Type.Optional(schema);
  }
  return definePiTool({ ...definition, parameters: exact(properties), execute: async (id, params, signal, update, context) => {
    if (!Value.Check(contract, params)) return rejection("INPUT_INVALID", "Arguments do not match a supported parameter combination; no action was dispatched.");
    return definition.execute(id, params, signal, update, context);
  } });
}

function sameRevision(left, right) {
  return left === right || String(left) === String(right);
}

function requirePrep(host) {
  if (host.profile?.mode !== "prep") {
    throw new MtLobbyError("PROFILE_MISMATCH", "Lobby tools are only available in prep mode");
  }
  if (typeof host.lobbyClient !== "function") {
    throw new MtLobbyError("CAPABILITY_UNAVAILABLE", "The lobby client is not configured for this session");
  }
  return host.lobbyClient();
}

async function approve(host, tool, summary, args) {
  if (typeof host.maybeRequestApproval !== "function") return true;
  return Boolean(await host.maybeRequestApproval({ tool, summary: redactPaths(summary), args }));
}

function planSummary(plan) {
  if (!plan || typeof plan !== "object") return "plan pending";
  const kind = plan.kind ?? plan.targetKind ?? "import";
  const counts = [];
  for (const key of ["assets", "files", "entries", "documents", "campaigns"]) {
    const value = plan[key];
    if (Array.isArray(value)) counts.push(`${key}=${value.length}`);
    else if (Number.isInteger(plan[`${key}Count`])) counts.push(`${key}=${plan[`${key}Count`]}`);
  }
  for (const key of ["entryCount", "assetCount", "campaignRefs"]) {
    if (Number.isInteger(plan[key])) counts.push(`${key}=${plan[key]}`);
  }
  if (plan.totals && typeof plan.totals === "object") {
    for (const key of ["packs", "entries", "batches", "campaigns", "assets"]) {
      if (Number.isInteger(plan.totals[key])) counts.push(`${key}=${plan.totals[key]}`);
    }
  }
  return `${kind}${counts.length ? ` (${counts.join(", ")})` : ""}`;
}

function fileRoots(host) {
  const roots = typeof host.lobbyFileRoots === "function" ? host.lobbyFileRoots() : [];
  if (Array.isArray(roots) && roots.length > 0) return roots;
  return typeof host.cwd === "function" ? [host.cwd()] : [];
}

function compactJobStatus(value) {
  if (!value || typeof value !== "object") return bounded(value);
  const phase = jobPhaseOf(value);
  /** @type {Record<string, any>} */
  const result = {
    jobId: value.jobId,
    status: phase,
    terminal: isTerminalJob(value),
    ...(value.phase !== undefined && value.phase !== phase ? { phase: value.phase } : {}),
    ...(value.progress !== undefined ? { progress: bounded(value.progress) } : {}),
    ...(value.currentItem !== undefined ? { currentItem: bounded(value.currentItem) } : {}),
    ...(value.failureCount !== undefined ? { failureCount: value.failureCount } : {}),
  };
  if (isTerminalJob(value)) {
    if (value.report !== undefined) result.report = bounded(value.report);
    if (value.failures !== undefined) result.failures = bounded(value.failures);
    if (value.warnings !== undefined) result.warnings = bounded(value.warnings);
    if (value.error !== undefined) result.error = bounded(value.error);
  }
  return result;
}

/** @param {any} host */
export function createLobbyTools(host) {
  const rulesetsList = defineTool({
    name: "foundry_lobby_rulesets_list",
    label: "mt-compat supported rulesets",
    description:
      "List the rulesets supported by the current mt-compat deployment as {id, label, system, supportLevel?}. Read-only. " +
      "Always call this before asking the user to choose ruleset for a world import; present the returned choices without hardcoding DND editions or other rules.",
    parameters: exact({}),
    execute: async (_toolCallId, _params, signal) => {
      try {
        const data = await requirePrep(host).call("lobbyRulesetsList", {}, { signal });
        const rulesets = Array.isArray(data?.rulesets) ? data.rulesets.slice(0, 100).map(ruleset => bounded(ruleset)) : [];
        return textResult({ rulesets }, { rulesets });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const importStart = defineTool({
    name: "foundry_lobby_import_start",
    label: "Import into mt-compat lobby",
    description:
      "Import one local FVTT world zip or pack-collection zip into the mt-compat lobby. Only available on the trusted mt-compat lobby page after foundry_open; " +
      "the source file must be a regular file inside the current prep directory or an existing Arcane mirror staging directory (mod-manager world/module stage). " +
      "For a world import (including auto-detection), ruleset is required: call foundry_lobby_rulesets_list, ask the user to choose from the current deployment's supported rules, and never infer the choice from metadata, descriptions, or lobby defaults. Collection imports do not require ruleset. " +
      "The tool binds the real File in the panel, inspects it, asks for approval, then starts ONE import job. " +
      "Returns {jobId, plan}; poll with foundry_lobby_import_job. Never pass credentials, base64, or zip contents. " +
      "On LOGIN_REQUIRED, end the turn and let the user sign in directly in the panel.",
    parameters: Type.Union([
      exact({
        sourcePath: localFile(),
        expectedKind: Type.Optional(Type.Literal("world")),
        campaignName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        ruleset: Type.String({ minLength: 1, maxLength: 100 }),
        failurePolicy: Type.Optional(Type.Union([Type.Literal("abort"), Type.Literal("continue")])),
      }),
      exact({
        sourcePath: localFile(),
        expectedKind: Type.Literal("collection"),
        campaignName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        ruleset: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        failurePolicy: Type.Optional(Type.Union([Type.Literal("abort"), Type.Literal("continue")])),
      }),
    ]),
    executionMode: "sequential",
    promptGuidelines: [
      "Use the exact sourcePath the user provided; never invent or search outside the prep directory.",
      "For world imports, ask the user for ruleset before calling this tool; there is no default and the choice is immutable after campaign creation.",
      "Continue after a failed import only when the user explicitly asks for failurePolicy=continue.",
    ],
    execute: async (_toolCallId, params, signal) => {
      let file;
      let runDispatched = false;
      try {
        const client = requirePrep(host);
        if (params.expectedKind !== "collection") {
          const supported = await client.call("lobbyRulesetsList", {}, { signal });
          const rulesets = Array.isArray(supported?.rulesets) ? supported.rulesets : [];
          if (!rulesets.some(ruleset => ruleset?.id === params.ruleset)) {
            return rejection(
              "INPUT_INVALID",
              "The selected ruleset is not supported by the current deployment; call foundry_lobby_rulesets_list and ask the user to choose a returned id",
              { supportedRulesets: rulesets.map(ruleset => bounded(ruleset)).slice(0, 100), jobStarted: false },
            );
          }
        }
        file = await prepareLobbySourceFile(params.sourcePath, { roots: fileRoots(host), signal });
        const target = client.captureTarget();
        // 外部已发布词汇保持 world|collection；调 runtime 前把 collection 归一到 module。
        const runtimeExpectedKind = params.expectedKind === "collection" ? "module" : params.expectedKind;
        const inspection = await client.inspectImportFile(target, file, {
          ...(runtimeExpectedKind ? { expectedKind: runtimeExpectedKind } : {}),
          ...(params.campaignName ? { campaignName: params.campaignName } : {}),
          ...(params.ruleset ? { ruleset: params.ruleset } : {}),
          ...(params.failurePolicy ? { failurePolicy: params.failurePolicy } : {}),
        }, signal);
        const plan = bounded(inspection.plan);
        const summary = `Import ${file.filename} (${file.size} bytes, sha256 ${file.sha256.slice(0, 12)}…) as ${inspection.kind ?? params.expectedKind ?? "auto"}: ${planSummary(inspection.plan)}${params.failurePolicy === "continue" ? "; continue on per-item failures" : ""}`;
        const approved = await approve(host, "foundry_lobby_import_start", summary, {
          filename: file.filename,
          size: file.size,
          sha256: file.sha256,
          ...(inspection.kind ?? params.expectedKind ? { kind: inspection.kind ?? params.expectedKind } : {}),
          ...(params.campaignName ? { campaignName: params.campaignName } : {}),
          ...(params.ruleset ? { ruleset: params.ruleset } : {}),
          ...(params.failurePolicy ? { failurePolicy: params.failurePolicy } : {}),
        });
        if (!approved) return rejection("DECLINED", "The user declined this import; do not retry it.", { jobStarted: false });
        runDispatched = true;
        const started = await client.runImport(target, inspection.preparationId, signal);
        return textResult(
          `Import started as job ${started.jobId}. Poll with foundry_lobby_import_job (action=status); the full report is only returned in a terminal state.`,
          { jobId: started.jobId, plan: bounded(started.plan ?? inspection.plan) },
        );
      } catch (error) {
        // run 已经发出后，结果可能是 JOB_INDETERMINATE 或其他未知态；不能谎报“未开始”。
        return errorResult(error, {
          ...(runDispatched ? { jobStarted: "unknown" } : { jobStarted: false }),
          ...(file ? { filename: file.filename } : {}),
        });
      }
    },
  });

  const importJob = defineTool({
    name: "foundry_lobby_import_job",
    label: "mt-compat import job",
    description:
      "Read or cancel one mt-compat lobby import job started by foundry_lobby_import_start. " +
      "action=status may wait up to 25000 ms and returns phase/progress/currentItem/failureCount; the full report/failures appear only in a terminal state. " +
      "action=cancel only means the cancel was accepted — it is not proof that the job stopped and cleaned up; poll status. " +
      "If the lobby page navigated, reloaded, or crashed, the job becomes indeterminate and is never replayed automatically.",
    parameters: Type.Union([
      exact({ jobId: ref(), action: Type.Literal("status"), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })) }),
      exact({ jobId: ref(), action: Type.Literal("cancel") }),
    ]),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      try {
        const client = requirePrep(host);
        if (params.action === "cancel") {
          const result = await client.cancelJob(params.jobId, { signal });
          const compact = compactJobStatus(result);
          return textResult(
            `Cancel accepted for job ${params.jobId} (status ${compact.status}); accepted is not proof of stop/cleanup. Poll status before reporting the final state.`,
            compact,
          );
        }
        const result = await client.statusJob(params.jobId, { waitMs: params.waitMs ?? 0, signal });
        const compact = compactJobStatus(result);
        const terminal = isTerminalJob(result);
        return textResult(
          `${terminal ? "Terminal" : "Job"} state for ${params.jobId}: ${compact.status}${compact.phase ? ` (${compact.phase})` : ""}.` +
            (terminal ? " The full report/failures are included when the service provided them." : " Poll again; do not start a second import for the same file."),
          compact,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const campaignsList = defineTool({
    name: "foundry_lobby_campaigns_list",
    label: "mt-compat campaigns",
    description:
      "List mt-compat lobby campaigns visible to the signed-in user: {id, name, ruleset, owner, playUrl}. Read-only; use it to resolve a campaign name to an id. " +
      "Only available on the trusted mt-compat lobby page after foundry_open.",
    parameters: exact({}),
    execute: async (_toolCallId, _params, signal) => {
      try {
        const data = await requirePrep(host).call("lobbyCampaignsList", {}, { signal });
        const campaigns = Array.isArray(data?.campaigns) ? data.campaigns.slice(0, 200).map(campaign => bounded(campaign)) : [];
        return textResult({ campaigns }, { campaigns });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const campaignPacksGet = defineTool({
    name: "foundry_lobby_campaign_packs_get",
    label: "mt-compat campaign packs",
    description:
      "Read one campaign's current pack selection: selected refs, missing refs, built-in read-only groups, SRD flags, enabledSources, and the selection revision. " +
      "This revision is required by foundry_lobby_campaign_packs_update. Read-only and only available on the mt-compat lobby page.",
    parameters: exact({ campaignId: ref() }),
    execute: async (_toolCallId, params, signal) => {
      try {
        const data = await requirePrep(host).call("lobbyCampaignPacksGet", { campaignId: params.campaignId }, { signal });
        const safe = bounded(data);
        return textResult(safe, safe);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const campaignPacksUpdate = defineTool({
    name: "foundry_lobby_campaign_packs_update",
    label: "Update mt-compat campaign packs",
    description:
      "Incrementally update one campaign's pack selection. Read foundry_lobby_campaign_packs_get first and pass its exact revision as expectedRevision. " +
      "add/remove touch only the named refs; enabledSourcesPatch is an exact {srd2014?, srd2024?} boolean object and merges only those keys. Never a full packsSet. " +
      "The tool re-reads and rejects a stale revision with zero writes, asks for the existing approval, writes once, then reads back. " +
      "Only available on the mt-compat lobby page.",
    parameters: exact({
      campaignId: ref(),
      expectedRevision: revision(),
      add: Type.Optional(Type.Array(ref(), { maxItems: 200, uniqueItems: true })),
      remove: Type.Optional(Type.Array(ref(), { maxItems: 200, uniqueItems: true })),
      enabledSourcesPatch: Type.Optional(exact({
        srd2014: Type.Optional(Type.Boolean()),
        srd2024: Type.Optional(Type.Boolean()),
      })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      try {
        const patchProvided = params.enabledSourcesPatch !== undefined;
        const patchKeys = patchProvided && params.enabledSourcesPatch && typeof params.enabledSourcesPatch === "object"
          ? Object.keys(params.enabledSourcesPatch) : [];
        const hasPatch = patchKeys.length > 0;
        if (patchProvided && (!hasPatch
          || patchKeys.some(key => key !== "srd2014" && key !== "srd2024")
          || patchKeys.some(key => typeof params.enabledSourcesPatch[key] !== "boolean"))) {
          return rejection("INPUT_INVALID", "enabledSourcesPatch must be exactly {srd2014?: boolean, srd2024?: boolean} with at least one boolean.");
        }
        if (!(params.add?.length) && !(params.remove?.length) && !hasPatch) {
          return rejection("INPUT_INVALID", "Supply at least one of add, remove, or enabledSourcesPatch.");
        }
        const client = requirePrep(host);
        const current = await client.call("lobbyCampaignPacksGet", { campaignId: params.campaignId }, { signal });
        if (!sameRevision(current?.revision, params.expectedRevision)) {
          return rejection(
            "REVISION_MISMATCH",
            `Campaign pack selection changed (current revision ${String(current?.revision)}, expected ${String(params.expectedRevision)}); no write was made. Read it again.`,
            { revision: bounded(current?.revision) },
          );
        }
        const summary = `Update campaign ${params.campaignId} packs: add ${params.add?.length ?? 0}, remove ${params.remove?.length ?? 0}, enabledSources fields ${hasPatch ? Object.keys(params.enabledSourcesPatch).length : 0}`;
        const approved = await approve(host, "foundry_lobby_campaign_packs_update", summary, {
          campaignId: params.campaignId,
          expectedRevision: params.expectedRevision,
          add: params.add ?? [],
          remove: params.remove ?? [],
          ...(hasPatch ? { enabledSourcesPatch: params.enabledSourcesPatch } : {}),
        });
        if (!approved) return rejection("DECLINED", "The user declined this pack-selection update; do not retry it.");
        const updated = await client.call("lobbyCampaignPacksUpdate", {
          campaignId: params.campaignId,
          expectedRevision: current.revision,
          ...(params.add?.length ? { add: params.add } : {}),
          ...(params.remove?.length ? { remove: params.remove } : {}),
          ...(hasPatch ? { enabledSourcesPatch: params.enabledSourcesPatch } : {}),
        }, { signal });
        let readBack = null;
        try {
          readBack = await client.call("lobbyCampaignPacksGet", { campaignId: params.campaignId }, { signal });
        } catch (error) {
          host.log?.(`[lobby] campaign packs readback failed: ${error?.code ?? error?.message ?? error}`);
        }
        return textResult(
          `Campaign ${params.campaignId} pack selection updated.${readBack ? ` Current revision: ${String(readBack.revision)}.` : " Read it back with foundry_lobby_campaign_packs_get before further edits."}`,
          { update: bounded(updated), current: bounded(readBack) },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const packsRead = defineTool({
    name: "foundry_lobby_packs_read",
    label: "Read mt-compat pack library",
    description:
      "Two read-only shapes. Omit packId (optionally moduleId) to list the personal pack library with its revision and modules. " +
      "Pass packId to page one pack's entries; use query/cursor/limit (limit max 50) and follow nextCursor. " +
      "Entries are always paginated and bounded. Only available on the mt-compat lobby page.",
    parameters: Type.Union([
      exact({ moduleId: Type.Optional(ref()) }),
      exact({ packId: ref(), query: Type.Optional(Type.String({ maxLength: 256 })), cursor: Type.Optional(ref()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    ]),
    execute: async (_toolCallId, params, signal) => {
      try {
        const client = requirePrep(host);
        if (params.packId) {
          const data = await client.call("lobbyPackRead", {
            packId: params.packId,
            ...(params.query ? { query: params.query } : {}),
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          }, { signal });
          const safe = {
            pack: bounded(data?.pack),
            entries: Array.isArray(data?.entries) ? data.entries.slice(0, 50).map(entry => bounded(entry)) : [],
            nextCursor: data?.nextCursor ?? null,
          };
          return textResult(safe, safe);
        }
        const data = await client.call("lobbyPacksList", params.moduleId ? { moduleId: params.moduleId } : {}, { signal });
        const safe = {
          revision: bounded(data?.revision),
          packCount: data?.packCount,
          modules: Array.isArray(data?.modules) ? data.modules.slice(0, 50).map(module => bounded(module)) : [],
        };
        return textResult(safe, safe);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const packsDelete = defineTool({
    name: "foundry_lobby_packs_delete",
    label: "Delete mt-compat packs",
    description:
      "Delete one or more personal pack-library entries by packId. Read the library first and pass its revision as expectedRevision. " +
      "The tool re-reads the library, rejects a stale revision with zero writes, requests an impact preview, uses the existing approval, then deletes and reads the library back. " +
      "It never detaches campaign references: untouched references keep their existing missing semantics. Only available on the mt-compat lobby page.",
    parameters: exact({
      packIds: Type.Array(ref(), { minItems: 1, maxItems: 100, uniqueItems: true }),
      expectedRevision: revision(),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      try {
        const client = requirePrep(host);
        const current = await client.call("lobbyPacksList", {}, { signal });
        if (!sameRevision(current?.revision, params.expectedRevision)) {
          return rejection(
            "REVISION_MISMATCH",
            `The pack library changed (current revision ${String(current?.revision)}, expected ${String(params.expectedRevision)}); no delete was made. Read it again.`,
            { revision: bounded(current?.revision) },
          );
        }
        const preview = await client.call("lobbyPacksDeletePreview", {
          packIds: params.packIds,
          expectedRevision: current.revision,
        }, { signal });
        const summary = `Delete ${params.packIds.length} pack(s): ${params.packIds.slice(0, 8).join(", ")}${params.packIds.length > 8 ? ", …" : ""}. ${planSummary(preview)}`;
        const approved = await approve(host, "foundry_lobby_packs_delete", summary, {
          packIds: params.packIds,
          expectedRevision: current.revision,
        });
        if (!approved) return rejection("DECLINED", "The user declined this pack deletion; do not retry it.", { preview: bounded(preview) });
        const deleted = await client.call("lobbyPacksDelete", {
          packIds: params.packIds,
          expectedRevision: current.revision,
        }, { signal });
        let readBack = null;
        try {
          readBack = await client.call("lobbyPacksList", {}, { signal });
        } catch (error) {
          host.log?.(`[lobby] pack library readback failed: ${error?.code ?? error?.message ?? error}`);
        }
        return textResult(
          `Deleted ${params.packIds.length} pack(s).${readBack ? ` Library revision is now ${String(readBack.revision)}.` : " Read the library back with foundry_lobby_packs_read."}`,
          { preview: bounded(preview), delete: bounded(deleted), revision: bounded(readBack?.revision) },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return [rulesetsList, importStart, importJob, campaignsList, campaignPacksGet, campaignPacksUpdate, packsRead, packsDelete];
}
