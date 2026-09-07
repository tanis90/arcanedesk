import { FoundryOperationStore } from "./foundry-operation-store.js";

const aliases = Object.freeze({
  "倒地": "prone", "中毒": "poisoned", "失明": "blinded", "魅惑": "charmed",
  "耳聋": "deafened", "恐慌": "frightened", "恐惧": "frightened", "擒抱": "grappled",
  "失能": "incapacitated", "隐形": "invisible", "麻痹": "paralyzed", "石化": "petrified",
  "束缚": "restrained", "震慑": "stunned", "昏迷": "unconscious", "专注": "concentrating",
  "concentration": "concentrating",
});

/** Per-session handles; the host supplies the shared page lease and runtime. */
export class FoundryServices {
  constructor({ sessionId, directory, mode, withPage, call }) {
    this.mode = mode;
    this.withPage = withPage;
    this.call = call;
    this.store = new FoundryOperationStore({ directory, sessionId });
    this.staticSnapshot = null;
  }

  async readStatic(signal) {
    return this.withPage(signal, async () => {
      const data = await this.call("staticContext", {}, { signal, executionTimeoutMs: 30_000 });
      this.staticSnapshot = structuredClone(data);
      return data;
    });
  }

  /** @param {{view?: "scene" | "turn" | "operation", operationRef?: string}} [params] @param {AbortSignal} [signal] */
  async readPlay({ view = "scene", operationRef } = {}, signal) {
    if (view === "operation") {
      const result = this.store.lookup(operationRef);
      return result ?? { status: "rejected", code: "OPERATION_NOT_FOUND", message: "Unknown operation in this session" };
    }
    return this.withPage(signal, async () => {
      const data = await this.call("playContext", {}, { signal, executionTimeoutMs: 30_000 });
      return { ...data, staticContextValid: !!this.staticSnapshot && data.contextRef === this.staticSnapshot.contextRef };
    });
  }

  async setConditions(params, binding, toolCallId, signal) {
    const metadata = await binding.metadata;
    if (!metadata?.world) return { status: "rejected", code: "INPUT_WORLD_UNAVAILABLE",
      message: "No ready world was bound when this message was submitted. Connect and submit a new instruction." };
    const args = { targets: params.targets,
      conditions: params.conditions.map(condition => ({ ...condition, key: aliases[condition.key] ?? condition.key })),
      mode: this.mode, world: metadata.world, selectedTokenUuids: metadata.selectedTokenUuids ?? [] };
    return this.withPage(signal, async () => {
      if (signal?.aborted) return { status: "rejected", code: "ABORTED", message: "Cancelled before dispatch" };
      return this.store.execute({ taskId: binding.taskId, toolCallId, world: metadata.world,
        action: "conditionsSet", args }, () => this.call("conditionsSet", args, { signal, executionTimeoutMs: 30_000 }));
    });
  }
}
