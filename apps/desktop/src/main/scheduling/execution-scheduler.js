const cancelled = () => Object.assign(new Error("Execution cancelled"), { name: "AbortError" });

/** FIFO execution capacity. Selection and mode never affect admission order. */
export class ExecutionScheduler {
  constructor({ capacity = 2 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("Invalid execution capacity");
    this.capacity = capacity; this.active = new Map(); this.queue = [];
  }

  acquire(owner, signal, onQueued = () => {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const entry = { owner, resolve, reject, signal, cancel: null };
      entry.cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); signal?.removeEventListener("abort", entry.cancel);
        reject(cancelled()); this.drain();
      };
      signal?.addEventListener("abort", entry.cancel, { once: true });
      this.queue.push(entry);
      if (this.active.size >= this.capacity) {
        try { onQueued(); } catch (error) {
          const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener("abort", entry.cancel); reject(error); return;
        }
      }
      this.drain();
    });
  }

  drain() {
    while (this.active.size < this.capacity && this.queue.length) {
      const entry = this.queue.shift();
      entry.signal?.removeEventListener("abort", entry.cancel);
      if (entry.signal?.aborted) { entry.reject(cancelled()); continue; }
      const token = Symbol("lease"); this.active.set(token, entry.owner);
      entry.resolve({ release: () => { if (this.active.delete(token)) this.drain(); } });
    }
  }

  snapshot() { return structuredClone({ capacity: this.capacity, active: [...this.active.values()], queued: this.queue.map(entry => entry.owner) }); }
}

/** A task can suspend for user input and reacquire one shared slot before resuming. */
export class TaskAdmission {
  constructor(scheduler, owner, state) {
    this.scheduler = scheduler; this.owner = owner; this.state = state;
    this.controller = new AbortController(); this.lease = null; this.acquiring = null;
    this.started = false; this.users = 0; this.userWaiters = [];
  }

  async acquire() {
    if (this.users) await new Promise(resolve => this.userWaiters.push(resolve));
    if (this.controller.signal.aborted) throw cancelled();
    if (this.lease) return;
    if (!this.acquiring) {
      this.acquiring = this.scheduler.acquire(this.owner, this.controller.signal, () => this.state("queued"))
        .then(lease => {
          if (this.controller.signal.aborted) { lease.release(); throw cancelled(); }
          this.lease = lease; this.state("running");
        }).finally(() => { this.acquiring = null; });
    }
    await this.acquiring;
  }

  release() { this.lease?.release(); this.lease = null; }
  cancel() { this.controller.abort(); }

  async waitForUser(promise) {
    this.users++; this.state("waiting_user"); this.release();
    let result;
    try { result = await promise; }
    finally {
      this.users--;
      if (!this.users) for (const resume of this.userWaiters.splice(0)) resume();
    }
    await this.acquire();
    return result;
  }
}
