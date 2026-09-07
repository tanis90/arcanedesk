import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const resourceLifetime = new AsyncLocalStorage();

/** A tool may return a timeout before its underlying operation has stopped. */
export function retainResourceUntil(completion) {
  const lifetime = resourceLifetime.getStore();
  if (!lifetime || lifetime.closed) return false;
  lifetime.pending.add(Promise.resolve(completion).then(() => {}, () => {}));
  return true;
}

/** Match Pi 0.84 file-tool path spelling before computing the resource identity. */
export function toolFilesystemPath(input, cwd, read = false) {
  let value = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !value.includes("\\")) {
    value = value.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_all, drive, suffix) => `${drive.toUpperCase()}:\\${(suffix ?? "").replaceAll("/", "\\")}`);
  }
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) value = path.join(homedir(), value.slice(2));
  if (value.startsWith("file://")) value = fileURLToPath(value);
  const resolved = path.resolve(cwd, value);
  if (!read || existsSync(resolved)) return resolved;
  const nfd = resolved.normalize("NFD");
  return [resolved.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, resolved.replaceAll("'", "\u2019"), nfd.replaceAll("'", "\u2019")]
    .find(candidate => existsSync(candidate)) ?? resolved;
}

/** Resolve existing ancestors too, so aliases of a not-yet-created file still conflict. */
export function filesystemResource(value) {
  let current = path.resolve(value); const suffix = [];
  while (true) {
    try { current = path.join(realpathSync.native(current), ...suffix); break; }
    catch (error) {
      if (!new Set(["ENOENT", "ENOTDIR"]).has(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
  const normalized = current.replaceAll("\\", "/").replace(/\/$/, "");
  return "fs:" + (process.platform === "win32" ? normalized.toLowerCase() : normalized);
}

function conflict(a, b) {
  return a === b || (a.startsWith("fs:") && b.startsWith("fs:") && (a.startsWith(b + "/") || b.startsWith(a + "/")));
}
const overlap = (a, b) => a.some(key => b.some(other => conflict(key, other)));
const cancelled = () => Object.assign(new Error("Resource wait cancelled"), { name: "AbortError" });

/** Atomic multi-resource admission: independent work bypasses blocked unrelated work. */
export class ResourceCoordinator {
  constructor() { this.active = new Map(); this.queue = []; this.draining = false; this.redrain = false; }

  acquire(resources, owner, signal, onWait = (_details) => {}) {
    if (signal?.aborted) return Promise.reject(cancelled());
    const keys = [...new Set(resources)].sort();
    return new Promise((resolve, reject) => {
      const entry = { resources: keys, owner, signal, resolve, reject, onWait, lastWait: "", cancel: null };
      entry.cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) { this.queue.splice(index, 1); signal?.removeEventListener("abort", entry.cancel); reject(cancelled()); this.drain(); }
      };
      signal?.addEventListener("abort", entry.cancel, { once: true });
      this.queue.push(entry); this.drain();
    });
  }

  drain() {
    if (this.draining) { this.redrain = true; return; }
    this.draining = true;
    try {
      let index = 0;
      while (index < this.queue.length) {
        const entry = this.queue[index];
        const holders = [...this.active.values(), ...this.queue.slice(0, index)].filter(other => overlap(entry.resources, other.resources));
        if (holders.length) {
          const details = { resources: entry.resources, holders: holders.map(holder => holder.owner) };
          const fingerprint = JSON.stringify(details);
          if (fingerprint !== entry.lastWait) {
            entry.lastWait = fingerprint;
            try { entry.onWait(structuredClone(details)); }
            catch (error) {
              const current = this.queue.indexOf(entry);
              if (current >= 0) this.queue.splice(current, 1);
              entry.signal?.removeEventListener("abort", entry.cancel); entry.reject(error); continue;
            }
          }
          if (this.queue[index] === entry) index++;
          continue;
        }
        this.queue.splice(index, 1); entry.signal?.removeEventListener("abort", entry.cancel);
        if (entry.signal?.aborted) { entry.reject(cancelled()); continue; }
        let finish;
        entry.finished = new Promise(resolve => { finish = resolve; });
        const token = Symbol("resource"); this.active.set(token, entry);
        entry.resolve({ detached: () => { entry.detached = true; }, release: () => {
          if (this.active.delete(token)) { finish(); this.drain(); }
        } });
      }
    } finally {
      this.draining = false;
      if (this.redrain) { this.redrain = false; this.drain(); }
    }
  }

  /** Fence new requests while recovering only operations whose tool call already returned. */
  recoveryBarrier(resources) {
    const held = [...this.active.values()].filter(entry => overlap(resources, entry.resources));
    if (held.some(entry => !entry.detached)) throw new Error("PAGE_OPERATION_RUNNING");
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const token = Symbol("recovery");
    this.active.set(token, { resources, owner: { name: "Foundry recovery" }, finished });
    this.drain();
    return { owners: held.map(entry => structuredClone(entry.owner)), drained: Promise.all(held.map(entry => entry.finished)),
      release: () => { if (this.active.delete(token)) { finish(); this.drain(); } } };
  }

  /** Wait for actual operations owned by this task, including deferred page execution. */
  async waitForOwner(sessionId, taskId, onWait = (_details) => {}) {
    while (true) {
      const held = [...this.active.values()].filter(entry => entry.owner.sessionId === sessionId && entry.owner.taskId === taskId);
      if (!held.length) return;
      let observerError;
      try { onWait({ resources: [...new Set(held.flatMap(entry => entry.resources))], holders: held.map(entry => entry.owner) }); }
      catch (error) { observerError = error; }
      await Promise.all(held.map(entry => entry.finished));
      if (observerError) throw observerError;
    }
  }

  async run(resources, owner, signal, onWait, operation) {
    const resolve = () => [...new Set(typeof resources === "function" ? resources() : resources)].sort();
    while (true) {
      const keys = resolve();
      const lease = await this.acquire(keys, owner, signal, onWait);
      let transferred = false;
      try {
        if (signal?.aborted) throw cancelled();
        // A queued shell may have replaced a symlink before we acquired its workspace.
        if (JSON.stringify(keys) !== JSON.stringify(resolve())) continue;
        const lifetime = { pending: new Set(), closed: false };
        transferred = true;
        try { return await resourceLifetime.run(lifetime, operation); }
        finally {
          lifetime.closed = true;
          if (lifetime.pending.size) {
            lease.detached();
            void Promise.allSettled([...lifetime.pending]).then(() => lease.release());
          } else lease.release();
        }
      } finally {
        // The normal operation path transfers release to its lifetime above.
        if (!transferred) lease.release();
      }
    }
  }
}
