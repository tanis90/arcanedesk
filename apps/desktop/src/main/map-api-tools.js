import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { jsonSafe } from "./json-safe.js";

function textResult(data) {
  const safe = jsonSafe(data);
  return { content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(safe, null, 2) }], details: safe };
}

function rejection(code, message, extra = {}) {
  const details = { status: "rejected", code, ...extra };
  return { content: [{ type: /** @type {const} */ ("text"), text: `${code}: ${message}` }], details, isError: true };
}

function requirePrep(host) {
  if (host.profile?.mode !== "prep") throw new Error("PROFILE_MISMATCH: Map API tools are only available in prep mode");
}

function callPageRuntime(host, action, args, options) {
  if (typeof host.callFoundryRuntime === "function") return host.callFoundryRuntime(action, args, options);
  const runtime = host.foundryRuntime;
  if (!runtime || (typeof runtime.call !== "function" && typeof runtime.callForSession !== "function")) {
    throw new Error("CAPABILITY_UNAVAILABLE: The mt-compat page runtime is not installed");
  }
  return typeof runtime.callForSession === "function"
    ? runtime.callForSession(host.telemetry ?? null, host.profile.mode, action, args, options)
    : runtime.call(action, args, options);
}

async function callMap(host, action, args, signal) {
  const client = typeof host.lobbyClient === "function" ? host.lobbyClient() : null;
  const page = client?.classifyPanelUrl?.();
  if (page?.kind === "lobby") return client.call(action, args, { signal });
  if (page && page.kind !== "play") {
    throw new Error("PROFILE_MISMATCH: Open a trusted mt-compat lobby or play page first");
  }
  return callPageRuntime(host, action, args, { signal, executionTimeoutMs: 30_000 });
}

function errorResult(error) {
  const message = String(error?.message ?? error).slice(0, 1600);
  const matched = /^([A-Z][A-Z0-9_]+):/.exec(message);
  const code = typeof error?.code === "string" ? error.code : matched?.[1] ?? "MAP_API_FAILED";
  const guidance = code === "JOB_INDETERMINATE"
    ? " The result is uncertain; do not replay. Re-open the page and inspect the resulting campaign/world state."
    : code === "CAPABILITY_UNAVAILABLE"
      ? " The deployed Map runtime does not expose this API yet; do not substitute raw REST or page eval."
      : "";
  return rejection(code, `${message}${guidance}`);
}

export function createMapApiTools(host) {
  const search = defineTool({
    name: "map_api_search",
    label: "Search Map APIs",
    description:
      "Search Map-owned runtime operations and API declarations only. Desk tools are discovered from the model tool list and activatedTools, not from this catalog. " +
      "Use query for text, prefix for an exact API/operation prefix, optional kind=action|workflow|job, and limit 1..20 (default 10). " +
      "On play, a prefix also returns matching apiSurface declarations. Search is read-only and never invokes an operation. " +
      "Only operations with kind=action may be called with map_api_call; workflow/job results are informational and are not generic-call instructions.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      prefix: Type.Optional(Type.String({ maxLength: 128 })),
      kind: Type.Optional(Type.Union([Type.Literal("action"), Type.Literal("workflow"), Type.Literal("job")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      try {
        requirePrep(host);
        const result = await callMap(host, "apiOperationSearch", params, signal);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const call = defineTool({
    name: "map_api_call",
    label: "Call Map API",
    description:
      "Invoke one Map-owned lightweight synchronous JSON action by registered id and args. Never send JavaScript, REST paths, files, or Desk tool names. " +
      "First use map_api_search to inspect the operation schema and example. Only kind=action is executable here; workflow and job return OPERATION_KIND_UNSUPPORTED without side effects. " +
      "Write actions use the existing approval flow. Partial/indeterminate outcomes must not be replayed; inspect actual state instead. " +
      "This does not replace dedicated Desk tools for scene/world imports, file uploads, actor advancement, combat, or other complex workflows.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      args: Type.Record(Type.String({ maxLength: 64 }), Type.Unknown()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    promptGuidelines: [
      "Use currently activated Desk tools first. Use this only for a Map-owned action discovered through map_api_search.",
      "Never invoke workflow or job operations with this tool; dedicated workflows have their own channels.",
    ],
    execute: async (_toolCallId, params, signal) => {
      try {
        requirePrep(host);
        const catalog = await callMap(host, "apiOperationSearch", { prefix: params.id, limit: 20 }, signal);
        const operation = Array.isArray(catalog?.operations)
          ? catalog.operations.find(candidate => candidate?.id === params.id)
          : null;
        if (!operation) return rejection("ACTION_UNKNOWN", `Map operation is not registered: ${params.id}`);
        if (operation.kind !== "action") {
          return rejection("OPERATION_KIND_UNSUPPORTED", `${params.id} is ${operation.kind}; generic api_call only accepts action`);
        }
        let preview = null;
        if (operation.requiresPreview) {
          preview = await callMap(host, "apiCall", { id: params.id, args: params.args, preview: true }, signal);
          if (preview?.status !== "preview") return rejection("PREVIEW_FAILED", `${params.id} did not return a valid impact preview`);
          if (preview.value?.expectedNameMatches === false) return rejection("TARGET_CHANGED", "The target name changed before deletion; do not retry with the old name");
        }
        if (operation.effect === "write" && typeof host.maybeRequestApproval === "function") {
          const previewText = preview?.value ? `；影响 ${JSON.stringify(preview.value).slice(0, 500)}` : "";
          const approved = await host.maybeRequestApproval({
            tool: "map_api_call",
            summary: `${operation.summary} (${operation.id})${previewText}`,
            args: { operationId: operation.id, kind: operation.kind, effect: operation.effect, preview: preview?.value ?? null },
          });
          if (!approved) return rejection("DECLINED", "The user declined this Map operation; do not retry it.");
        }
        const result = await callMap(host, "apiCall", { id: params.id, args: params.args }, signal);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
  return [search, call];
}
