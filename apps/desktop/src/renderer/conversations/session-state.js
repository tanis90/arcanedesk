"use strict";

// Classic script: works on Electron file:// without a module loader.
(() => {
  // Approximate retained payload size, bounded work even for very large objects.
  function payloadWeight(value, ceiling) {
    let size = 0, visits = 0;
    const pending = [value], seen = new Set();
    while (pending.length) {
      const item = pending.pop();
      if (++visits > 10000) return ceiling + 1;
      if (typeof item === "string") size += item.length * 2;
      else if (item && typeof item === "object" && !seen.has(item)) {
        seen.add(item); size += 32;
        for (const key in item) if (Object.hasOwn(item, key)) {
          if (pending.length + visits > 10000) return ceiling + 1;
          size += key.length * 2; pending.push(item[key]);
        }
      } else size += 8;
      if (size > ceiling) return ceiling + 1;
    }
    return size;
  }

  class BoundedCache extends Map {
    /** @param {{maxEntries?: number, maxWeight?: number, canEvict?: (key: any) => boolean}} [options] */
    constructor({ maxEntries = 8, maxWeight = 8 * 1024 * 1024, canEvict = () => true } = {}) {
      super();
      if (!Number.isInteger(maxEntries) || maxEntries < 0 || !Number.isFinite(maxWeight) || maxWeight < 0) throw new RangeError("Invalid cache capacity");
      this.maxEntries = maxEntries; this.maxWeight = maxWeight; this.canEvict = canEvict;
      this.weights = new Map(); this.weight = 0;
    }
    get(key) {
      const value = super.get(key);
      if (super.has(key)) { super.delete(key); super.set(key, value); }
      return value;
    }
    set(key, value) {
      this.delete(key); super.set(key, value);
      const weight = payloadWeight(value, this.maxWeight);
      this.weights.set(key, weight); this.weight += weight; this.prune(); return this;
    }
    delete(key) {
      this.weight -= this.weights.get(key) ?? 0; this.weights.delete(key); return super.delete(key);
    }
    clear() { super.clear(); this.weights.clear(); this.weight = 0; }
    prune() {
      for (const key of [...this.keys()]) {
        if (this.size <= this.maxEntries && this.weight <= this.maxWeight) break;
        if (this.canEvict(key)) this.delete(key);
      }
    }
  }

  class EventInbox {
    constructor(capacity = 512, { maxSessions = 32, maxWeight = 16 * 1024 * 1024 } = {}) {
      if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(maxSessions) || maxSessions < 0 || !Number.isFinite(maxWeight) || maxWeight < 0) throw new RangeError("Invalid event cache capacity");
      this.capacity = capacity; this.sessions = new Map(); this.retiredEpochs = new Map(); this.deleted = new Set();
      this.cursors = new Map(); this.maxSessions = maxSessions; this.maxWeight = maxWeight; this.weight = 0;
    }
    evict(sessionId) { this.weight -= this.sessions.get(sessionId)?.weight ?? 0; this.sessions.delete(sessionId); }
    prune() {
      while (this.sessions.size > this.maxSessions || this.weight > this.maxWeight) this.evict(this.sessions.keys().next().value);
    }
    remove(sessionId) { this.deleted.add(sessionId); this.evict(sessionId); this.cursors.delete(sessionId); this.retiredEpochs.delete(sessionId); }
    epoch(sessionId) { return this.cursors.get(sessionId)?.epoch ?? null; }
    acceptSnapshot(sessionId, epoch, observedEpoch = undefined) {
      if (this.deleted.has(sessionId) || !epoch || this.retiredEpochs.get(sessionId)?.has(epoch)) return false;
      const entry = this.cursors.get(sessionId);
      if (entry?.epoch === epoch) return true;
      // Only a fresh request that observed the current epoch may replace it.
      // Cached snapshots and requests overtaken by a new runtime must resync.
      if (entry && entry.epoch !== observedEpoch) return false;
      const retired = this.retiredEpochs.get(sessionId) ?? new Set();
      if (entry) retired.add(entry.epoch);
      this.retiredEpochs.set(sessionId, retired);
      this.evict(sessionId);
      this.cursors.set(sessionId, { epoch, seq: 0 });
      this.sessions.set(sessionId, { epoch, events: new Map(), weights: new Map(), weight: 0 });
      this.prune();
      return true;
    }
    record(event) {
      if (!event.sessionId || this.deleted.has(event.sessionId) || !Number.isInteger(event.seq)) return;
      let entry = this.sessions.get(event.sessionId);
      if (!entry || entry.epoch !== event.runtimeEpoch) {
        const retired = this.retiredEpochs.get(event.sessionId) ?? new Set();
        if (retired.has(event.runtimeEpoch)) return false;
        const cursor = this.cursors.get(event.sessionId);
        if (cursor && cursor.epoch !== event.runtimeEpoch) retired.add(cursor.epoch);
        this.retiredEpochs.set(event.sessionId, retired);
        this.evict(event.sessionId);
        entry = { epoch: event.runtimeEpoch, events: new Map(), weights: new Map(), weight: 0 };
        this.sessions.set(event.sessionId, entry);
      }
      const cursor = this.cursors.get(event.sessionId);
      this.cursors.set(event.sessionId, { epoch: event.runtimeEpoch, seq: Math.max(cursor?.epoch === event.runtimeEpoch ? cursor.seq : 0, event.seq) });
      const weight = payloadWeight(event, this.maxWeight), previousWeight = entry.weights.get(event.seq) ?? 0;
      entry.weight += weight - previousWeight; this.weight += weight - previousWeight;
      entry.weights.set(event.seq, weight);
      entry.events.set(event.seq, event);
      while (entry.events.size > this.capacity) {
        const seq = entry.events.keys().next().value, removedWeight = entry.weights.get(seq);
        entry.events.delete(seq); entry.weights.delete(seq); entry.weight -= removedWeight; this.weight -= removedWeight;
      }
      this.sessions.delete(event.sessionId); this.sessions.set(event.sessionId, entry); this.prune();
    }
    after(sessionId, epoch, seq) {
      const entry = this.sessions.get(sessionId);
      const cursor = this.cursors.get(sessionId);
      if (cursor && (cursor.epoch !== epoch || (!entry && seq < cursor.seq))) return null;
      if (!entry) return [];
      if (entry.epoch !== epoch) return null;
      const events = [...entry.events.values()].filter(e => e.seq > seq).sort((a, b) => a.seq - b.seq);
      for (const event of events) { if (event.seq !== ++seq) return null; }
      if (seq < cursor.seq) return null;
      return events;
    }
  }

  class WorkspaceStore {
    constructor(database = globalThis.indexedDB, { maxEntries = 16, maxWeight = 16 * 1024 * 1024 } = {}) {
      this.dirty = new Map(); this.revisions = new Map(); this.active = null;
      this.cache = new BoundedCache({ maxEntries, maxWeight, canEvict: id => id !== this.active && !this.dirty.has(id) });
      this.database = database;
      this.connection = null;
      this.deleted = new Set();
    }
    setActive(id) { this.active = id; this.cache.prune(); }
    open() {
      if (!this.connection) this.connection = new Promise((resolve, reject) => {
        if (!this.database) { reject(new Error("Draft storage unavailable")); return; }
        const request = this.database.open("arcane-conversation-workspace", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("sessions");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return this.connection;
    }
    async save(sessionId, value) {
      if (!sessionId || this.deleted.has(sessionId)) return;
      const copy = structuredClone(value);
      this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
      this.dirty.set(sessionId, copy);
      this.cache.set(sessionId, copy);
      const db = await this.open();
      if (this.deleted.has(sessionId)) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        const store = tx.objectStore("sessions");
        const existing = store.get(sessionId);
        existing.onsuccess = () => {
          if (existing.result?._deleted || this.deleted.has(sessionId)) {
            this.deleted.add(sessionId); this.cache.delete(sessionId); this.dirty.delete(sessionId);
          } else store.put(copy, sessionId);
        };
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      // Completion of an older write must not unpin a newer unsaved draft.
      if (this.dirty.get(sessionId) === copy) this.dirty.delete(sessionId);
      this.cache.prune();
    }
    async load(sessionId) {
      if (this.deleted.has(sessionId)) return {};
      if (this.cache.has(sessionId)) return structuredClone(this.cache.get(sessionId));
      const revision = this.revisions.get(sessionId);
      const db = await this.open();
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").get(sessionId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // An input edit while disk read was pending always wins.
      if (value?._deleted || this.deleted.has(sessionId)) { this.deleted.add(sessionId); this.cache.delete(sessionId); return {}; }
      if (this.cache.has(sessionId)) return structuredClone(this.cache.get(sessionId));
      if (revision !== this.revisions.get(sessionId)) return this.load(sessionId);
      const result = value ?? {};
      this.cache.set(sessionId, result);
      return structuredClone(result);
    }
    async remove(sessionId) {
      this.deleted.add(sessionId); this.dirty.delete(sessionId); this.cache.delete(sessionId);
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        tx.objectStore("sessions").put({ _deleted: true }, sessionId);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    }
  }
  globalThis.ArcaneConversationState = { EventInbox, WorkspaceStore, BoundedCache };
})();
