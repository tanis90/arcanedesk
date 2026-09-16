"use strict";

// Classic script: works on Electron file:// without a module loader.
(() => {
  class SnapshotEvents {
    constructor() { this.pending = new Set(); }
    begin() { const events = []; this.pending.add(events); return events; }
    end(events) { this.pending.delete(events); }
    record(event) {
      if (!event.sessionId || !Number.isInteger(event.seq)) return;
      for (const events of this.pending) events.push(event);
    }
    after(captured, sessionId, epoch, seq) {
      const stream = captured.filter(event => event.sessionId === sessionId);
      if (stream.length && stream.at(-1).runtimeEpoch !== epoch) return null;
      const events = [...new Map(stream.filter(event => event.runtimeEpoch === epoch && event.seq > seq)
        .map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq);
      for (const event of events) if (event.seq !== ++seq) return null;
      return events;
    }
  }

  class WorkspaceStore {
    constructor(database = globalThis.indexedDB) {
      this.dirty = new Map(); this.revisions = new Map();
      this.database = database;
      this.connection = null;
      this.deleted = new Set();
    }
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
      const db = await this.open();
      if (this.deleted.has(sessionId)) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        const store = tx.objectStore("sessions");
        store.put(copy, sessionId);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      // Completion of an older write must not unpin a newer unsaved draft.
      if (this.dirty.get(sessionId) === copy) this.dirty.delete(sessionId);
    }
    async load(sessionId) {
      if (this.deleted.has(sessionId)) return {};
      if (this.dirty.has(sessionId)) return structuredClone(this.dirty.get(sessionId));
      const revision = this.revisions.get(sessionId);
      const db = await this.open();
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").get(sessionId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // An input edit while disk read was pending always wins.
      if (this.deleted.has(sessionId)) return {};
      if (value?._deleted) return {}; // Discard legacy tombstones.
      if (this.dirty.has(sessionId)) return structuredClone(this.dirty.get(sessionId));
      if (revision !== this.revisions.get(sessionId)) return this.load(sessionId);
      const result = value ?? {};
      return structuredClone(result);
    }
    async keys() {
      const db = await this.open();
      const stored = await new Promise((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return [...new Set([...stored, ...this.dirty.keys()])];
    }
    async remove(sessionId) {
      this.deleted.add(sessionId); this.dirty.delete(sessionId);
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        tx.objectStore("sessions").delete(sessionId);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    }
  }
  globalThis.ArcaneConversationState = { SnapshotEvents, WorkspaceStore };
})();
