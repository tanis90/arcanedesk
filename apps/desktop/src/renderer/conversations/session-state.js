"use strict";

// Classic script: works on Electron file:// without a module loader.
(() => {
  class EventInbox {
    constructor(capacity = 512) { this.capacity = capacity; this.sessions = new Map(); this.retiredEpochs = new Map(); }
    record(event) {
      if (!event.sessionId || !Number.isInteger(event.seq)) return;
      let entry = this.sessions.get(event.sessionId);
      if (!entry || entry.epoch !== event.runtimeEpoch) {
        const retired = this.retiredEpochs.get(event.sessionId) ?? new Set();
        if (retired.has(event.runtimeEpoch)) return;
        if (entry) retired.add(entry.epoch);
        this.retiredEpochs.set(event.sessionId, retired);
        entry = { epoch: event.runtimeEpoch, events: new Map() };
        this.sessions.set(event.sessionId, entry);
      }
      entry.events.set(event.seq, event);
      while (entry.events.size > this.capacity) entry.events.delete(entry.events.keys().next().value);
    }
    after(sessionId, epoch, seq) {
      const entry = this.sessions.get(sessionId);
      if (!entry) return [];
      if (entry.epoch !== epoch) return null;
      const events = [...entry.events.values()].filter(e => e.seq > seq).sort((a, b) => a.seq - b.seq);
      for (const event of events) { if (event.seq !== ++seq) return null; }
      return events;
    }
  }

  class WorkspaceStore {
    constructor(database = globalThis.indexedDB) {
      this.cache = new Map();
      this.database = database;
      this.connection = null;
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
      if (!sessionId) return;
      const copy = structuredClone(value);
      this.cache.set(sessionId, copy);
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        tx.objectStore("sessions").put(copy, sessionId);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    async load(sessionId) {
      if (this.cache.has(sessionId)) return structuredClone(this.cache.get(sessionId));
      const db = await this.open();
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").get(sessionId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // An input edit while disk read was pending always wins.
      if (!this.cache.has(sessionId)) this.cache.set(sessionId, value ?? {});
      return structuredClone(this.cache.get(sessionId));
    }
  }
  globalThis.ArcaneConversationState = { EventInbox, WorkspaceStore };
})();
