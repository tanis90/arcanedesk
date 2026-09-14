import { FoundryOperationStore } from "./foundry-operation-store.js";
import { randomUUID } from "node:crypto";
import { readFoundryImage, validateDataImagePath } from "./foundry-assets.js";

const aliases = Object.freeze({
  "倒地": "prone", "中毒": "poisoned", "失明": "blinded", "魅惑": "charmed",
  "耳聋": "deafened", "恐慌": "frightened", "恐惧": "frightened", "擒抱": "grappled",
  "失能": "incapacitated", "隐形": "invisible", "麻痹": "paralyzed", "石化": "petrified",
  "束缚": "restrained", "震慑": "stunned", "昏迷": "unconscious", "专注": "concentrating",
  "concentration": "concentrating",
});

/** Per-session handles; the host supplies the shared page lease and runtime. */
export class FoundryServices {
  constructor({ sessionId, directory, mode, withPage, call, getCwd = null, withAssets = null, decodeImage = null }) {
    this.mode = mode;
    this.withPage = withPage;
    this.call = call;
    this.getCwd = getCwd;
    this.withAssets = withAssets;
    this.decodeImage = decodeImage;
    this.store = new FoundryOperationStore({ directory, sessionId });
    this.staticSnapshot = null;
    this.turnSnapshot = null;
    this.readRefs = new Map();
  }

  async readStatic(signal) {
    return this.withPage(signal, async () => {
      const data = await this.call("staticContext", {}, { signal, executionTimeoutMs: 30_000 });
      this.staticSnapshot = structuredClone(data);
      this.turnSnapshot = null;
      return data;
    });
  }

  async contentSearch(params, signal) {
    if (this.mode !== "prep") throw new Error("MODE_FORBIDDEN: content tools are prep-only");
    return this.withPage(signal, () => this.call("contentSearch", params, { signal, executionTimeoutMs: 30_000 }));
  }

  async contentList(params, signal) {
    if (this.mode !== "prep") throw new Error("MODE_FORBIDDEN: content tools are prep-only");
    return this.withPage(signal, () => this.call("contentList", params, { signal, executionTimeoutMs: 30_000 }));
  }

  async actorRead(params, signal) {
    return this.readContent("actorRead", params, signal);
  }

  async sceneRead(params, signal) {
    return this.readContent("sceneRead", params, signal);
  }

  async readContent(action, params, signal) {
    if (this.mode !== "prep") throw new Error("MODE_FORBIDDEN: Actor editing is prep-only");
    return this.withPage(signal, async () => {
      const { readState, ...data } = await this.call(action, params, { signal, executionTimeoutMs: 30_000 });
      const readRef = randomUUID();
      this.readRefs.set(readRef, structuredClone(readState));
      return { ...data, readRef };
    });
  }

  async writeActor(action, params, binding, toolCallId, signal) {
    return this.writeContent(action, params, binding, toolCallId, signal);
  }

  async writeScene(params, binding, toolCallId, signal) {
    return this.writeContent("sceneApply", params, binding, toolCallId, signal);
  }

  async writeContent(action, params, binding, toolCallId, signal) {
    const reject = (code, message) => ({ status: "rejected", code, message });
    if (this.mode !== "prep" || !["actorCreate", "actorEdit", "actorGrantItems", "actorAdvance", "sceneApply", "imageApply"].includes(action)) return reject("MODE_FORBIDDEN", "Content editing is prep-only");
    const replay = this.store.replay({ taskId: binding.taskId, toolCallId, action, input: params });
    if (replay) return replay;
    const { readRef, ...values } = params;
    const readState = readRef ? this.readRefs.get(readRef) : null;
    const sceneAction = action === "sceneApply";
    const creating = action === "imageApply" || action === "actorCreate" || (sceneAction && params.operation === "create");
    const identityKey = sceneAction ? "sceneUuid" : "actorUuid";
    if (!creating && (!readState || !params[identityKey] || readState[identityKey] !== params[identityKey])) return reject("READ_REF_INVALID", "Read this document in the current session first");
    const metadata = await binding.metadata;
    if (!metadata?.world) return reject("INPUT_WORLD_UNAVAILABLE", "Connect and submit an instruction in a ready world");
    const args = { ...values, world: metadata.world, ...(readState ? { readState } : {}) };
    const image = sceneAction ? values.scene?.background : ["actorCreate", "imageApply"].includes(action) ? values.image : values.changes?.image;
    const local = image && "sourcePath" in image;
    const cwd = local ? this.getCwd?.() : null;
    if (local && (!cwd || !this.withAssets || !this.decodeImage)) return reject("CAPABILITY_UNAVAILABLE", "Local image upload is unavailable");
    const lease = local ? operation => this.withAssets(cwd, signal, operation) : operation => this.withPage(signal, operation);
    return lease(async () => {
      if (signal?.aborted) return reject("ABORTED", "Cancelled before dispatch");
      let prepared;
      try {
        if (image) {
          if (Object.keys(image).some(key => !["sourcePath", "dataPath", "syncPlacedTokens"].includes(key))
            || (local && "dataPath" in image)) throw new Error("INPUT_INVALID: choose one image source");
          prepared = local ? await readFoundryImage({ cwd, sourcePath: image.sourcePath,
            decodeImage: (bytes, mimeType) => this.decodeImage(bytes, mimeType, signal) }) : null;
          if (!local) validateDataImagePath(image.dataPath);
        }
      } catch (error) { return reject(String(error.message).split(":")[0], String(error.message)); }
      if (signal?.aborted) return reject("ABORTED", "Cancelled before dispatch");
      // Only the digest enters the journal. Base64 exists inside the runtime dispatch, never model output.
      return this.store.execute({ taskId: binding.taskId, toolCallId, world: metadata.world, action, input: params,
        args: { ...args, ...(prepared ? { imageHash: prepared.hash } : {}) } }, ({ requestId }) => {
        let runtimeArgs = { ...args, requestId };
        if (prepared) {
          const runtimeImage = { dataPath: prepared.dataPath, syncPlacedTokens: image.syncPlacedTokens,
            upload: { base64: prepared.bytes.toString("base64"), hash: prepared.hash, extension: prepared.extension, mimeType: prepared.mimeType } };
          runtimeArgs = sceneAction ? { ...runtimeArgs, scene: { ...values.scene, background: runtimeImage } }
            : ["actorCreate", "imageApply"].includes(action) ? { ...runtimeArgs, image: runtimeImage }
            : { ...runtimeArgs, changes: { ...values.changes, image: runtimeImage } };
        }
        return this.call(action, runtimeArgs, { signal, executionTimeoutMs: 60_000 });
      });
    });
  }

  /** @param {{view?: "current" | "turn" | "operation", operationRef?: string}} [params] @param {AbortSignal} [signal] */
  async readPlay({ view = "current", operationRef } = {}, signal) {
    if (view === "operation") {
      const result = this.store.lookup(operationRef);
      return result ?? { status: "rejected", code: "OPERATION_NOT_FOUND", message: "Unknown operation in this session" };
    }
    return this.withPage(signal, async () => {
      const data = await this.call("playContext", {}, { signal, executionTimeoutMs: 30_000 });
      if (view === "turn") this.turnSnapshot = structuredClone(data);
      const valid = !!this.staticSnapshot && data.contextRef === this.staticSnapshot.contextRef;
      const combatants = data.combatants.map(token => {
        const definitions = valid ? this.staticSnapshot.combatants.find(value => value.tokenUuid === token.tokenUuid)?.actions ?? [] : [];
        const available = new Set(token.availableActionIds ?? []);
        return { ...token, availableActionIds: definitions.filter(action => action.resolution === "narrative"
          ? action.resource?.kind === "none" || Number(token.resources?.[action.resource?.key] ?? 0) > 0
          : available.has(action.id)).map(action => action.actionRef) };
      });
      return { ...data, combatants, staticContextValid: valid };
    });
  }

  async setConditions(params, binding, toolCallId, signal) {
    const replay = this.store.replay({ taskId: binding.taskId, toolCallId, action: "conditionsSet", input: params });
    if (replay) return replay;
    const metadata = await binding.metadata;
    if (!metadata?.world) return { status: "rejected", code: "INPUT_WORLD_UNAVAILABLE",
      message: "No ready world was bound when this message was submitted. Connect and submit a new instruction." };
    const args = { targets: params.targets,
      conditions: params.conditions.map(condition => ({ ...condition, key: aliases[condition.key] ?? condition.key })),
      mode: this.mode, world: metadata.world, selectedTokenUuids: metadata.selectedTokenUuids ?? [] };
    return this.withPage(signal, async () => {
      if (signal?.aborted) return { status: "rejected", code: "ABORTED", message: "Cancelled before dispatch" };
      return this.store.execute({ taskId: binding.taskId, toolCallId, world: metadata.world,
        action: "conditionsSet", args, input: params }, () => this.call("conditionsSet", args, { signal, executionTimeoutMs: 30_000 }));
    });
  }

  async executeAction(params, binding, toolCallId, signal) {
    const replay = this.store.replay({ taskId: binding.taskId, toolCallId, action: "executeAction", input: params });
    if (replay) return replay;
    // Snapshot handles before awaits; later reads/steering cannot replace this call's provenance.
    const snapshot = this.staticSnapshot, turn = this.turnSnapshot;
    const reject = (code, message) => ({ status: "rejected", code, message });
    if (!snapshot) return reject("STATIC_CONTEXT_REQUIRED", "Read static context once before using abilities");
    const specs = params.actions ?? (params.actionRef ? [params] : []);
    if (!specs.length || specs.length > 20 || (params.actions && params.actionRef)) return reject("INPUT_INVALID", "Specify a single action or a sequence");
    const resolvedActions = [];
    for (const spec of specs) {
      let match;
      for (const token of snapshot.combatants) {
        const action = token.actions.find(value => value.actionRef === spec.actionRef);
        if (action) { match = { token, action }; break; }
      }
      if (!match) return reject("ACTION_REFERENCE_UNKNOWN", "Reference is not in this session's current static context");
      const { token, action } = match;
      resolvedActions.push({ actionRef: action.actionRef, actionId: action.id, sourceTokenUuid: token.tokenUuid,
        actorUuid: token.actorUuid, itemId: action.itemId, activityId: action.activityId,
        ...(spec.targetTokenUuids ? { targetTokenUuids: spec.targetTokenUuids } : {}), ...(spec.input ? { input: spec.input } : {}) });
    }
    const metadata = await binding.metadata;
    if (!metadata?.world) return reject("INPUT_WORLD_UNAVAILABLE", "Connect and submit an instruction in a ready world");
    if (snapshot.scope.combatId && (!turn || turn.contextRef !== snapshot.contextRef)) {
      return reject("TURN_CONTEXT_REQUIRED", "Read current turn state before this combat action");
    }
    const args = { world: metadata.world, contextRef: snapshot.contextRef,
      turn: turn?.turn ?? null, resolvedActions, resolution: params.resolution ?? "auto", advance: params.advance === true };
    return this.withPage(signal, async () => {
      if (signal?.aborted) return reject("ABORTED", "Cancelled before dispatch");
      const result = await this.store.execute({ taskId: binding.taskId, toolCallId, world: metadata.world,
        action: "executeAction", args, input: params }, () => this.call("executeAction", args, { signal, executionTimeoutMs: 120_000 }));
      // Every combat execution needs a new turn read, including a failed or interrupted one.
      if (snapshot.scope.combatId) this.turnSnapshot = null;
      return result;
    });
  }
}
