import { randomUUID } from "node:crypto";

/** Window actions use the same page admission as task tools. */
export class PanelCommands {
  constructor({ resources, operations, emit = (_state) => {} }) {
    this.resources = resources; this.operations = operations; this.emit = emit;
    this.state = null; this.controller = null; this.run = null; this.revision = 0; this.recovering = false;
  }
  snapshot() { return { revision: this.revision, command: this.state ? structuredClone(this.state) : null }; }
  publish(changes) {
    this.state = { ...this.state, ...changes }; this.revision++;
    this.emit(this.snapshot());
  }
  request(action) {
    if (!Object.hasOwn(this.operations, action)) return { ok: false, code: "INVALID_ACTION" };
    if (this.run || this.recovering) return { ok: true, ...this.snapshot(), existing: true };
    const id = randomUUID(), controller = new AbortController(); this.controller = controller;
    this.state = { id, action, state: "queued", waitingFor: null };
    // Defer publication and work until run is assigned, so reentrant requests cannot replace it.
    this.run = Promise.resolve().then(async () => {
      this.publish({});
      try {
        const result = await this.resources.run(["foundry:page"], { commandId: id, name: "Foundry panel" }, controller.signal,
          waitingFor => this.publish({ state: "queued", waitingFor }), async () => {
            this.publish({ state: "running", waitingFor: null });
            return this.operations[action]();
          });
        this.publish({ state: result?.ok === false ? "failed" : "completed", result });
      } catch (error) {
        this.publish({ state: error.name === "AbortError" ? "cancelled" : "failed", error: error.message });
      }
    }).finally(() => { this.run = null; this.controller = null; });
    return { ok: true, ...this.snapshot() };
  }
  cancel(id) {
    if (id !== this.state?.id) return { ok: false, code: "STALE_COMMAND", ...this.snapshot() };
    if (this.state.state !== "queued") return { ok: false, code: "ALREADY_STARTED", ...this.snapshot() };
    this.controller?.abort(); return { ok: true };
  }

  async recover({ stopOwners, destroyPage, reopen }) {
    if (this.recovering) return { ok: false, code: "RECOVERY_RUNNING" };
    let barrier;
    try { barrier = this.resources.recoveryBarrier(["foundry:page"]); }
    catch (error) { return { ok: false, code: error.message }; }
    this.recovering = true;
    try {
      if (this.run) { this.controller?.abort(); await this.run; }
      this.state = { id: randomUUID(), action: "recover", state: "running", waitingFor: null };
      this.publish({});
      stopOwners(barrier.owners);
      await destroyPage();
      await barrier.drained;
      const result = await reopen();
      this.publish({ state: result?.ok === false ? "failed" : "completed", result });
      return { ok: result?.ok !== false, ...this.snapshot() };
    } catch (error) {
      this.publish({ state: "failed", error: error.message });
      return { ok: false, ...this.snapshot() };
    } finally { barrier.release(); this.recovering = false; }
  }
}
