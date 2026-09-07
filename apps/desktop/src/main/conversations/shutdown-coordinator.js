/** Coordinates graceful exit without treating a stop request as a stop result. */
export class ShutdownCoordinator {
  constructor({ registries, gate, quiesce, finish, emit = (_state) => {} }) {
    this.registries = registries; this.gate = gate; this.quiesce = quiesce; this.finish = finish; this.emit = emit;
    this.generation = 0; this.state = { state: "idle", remaining: 0 }; this.run = null;
  }
  hosts() { return this.registries.flatMap(registry => registry.allHosts()); }
  snapshot() { return { ...this.state }; }
  publish(value) { this.state = value; this.emit(this.snapshot()); }
  stop() {
    if (this.state.state === "stopping") return this.run;
    const generation = ++this.generation;
    this.gate(true);
    this.publish({ state: "stopping", remaining: this.hosts().filter(host => host.busy).length });
    this.run = Promise.resolve().then(async () => {
      await Promise.allSettled(this.registries.flatMap(registry => [...registry.pending.values()]));
      if (generation !== this.generation) return;
      const active = this.hosts().filter(host => host.busy);
      let remaining = active.length;
      this.publish({ state: "stopping", remaining });
      await Promise.all(active.map(async host => {
        const result = await host.abort(host.task?.id);
        if (result?.ok === false || host.busy) throw new Error("A task has not stopped");
        remaining--;
        if (generation === this.generation) this.publish({ state: "stopping", remaining });
      }));
      if (generation !== this.generation) return;
      await this.quiesce();
      if (generation === this.generation) await this.finish();
    }).catch(error => {
      if (generation !== this.generation) return;
      this.gate(false); this.publish({ state: "failed", remaining: this.hosts().filter(host => host.busy).length, error: error.message });
    });
    return this.run;
  }
  cancel() {
    if (this.state.state !== "stopping") return;
    this.generation++; this.gate(false); this.publish({ state: "cancelled", remaining: 0 });
  }
}
