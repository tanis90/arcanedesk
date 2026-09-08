import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

async function names(directory) {
  try { return await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function remove(file) {
  try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

/** Associated data is disposable once a complete conversation inventory proves absence. */
export class StartupReconciler {
  constructor({ directory, listSessions, navigation, activity }) {
    this.directory = directory; this.listSessions = listSessions;
    this.navigation = navigation; this.activity = activity;
  }
  async cleanup(id) {
    this.activity()?.remove(id);
    this.navigation.patch(id, null);
    for (const folder of ["tasks", "pending-inputs"]) {
      const directory = path.join(this.directory, folder);
      for (const name of await names(directory)) {
        if (name.match(/^([\w-]+)\.jsonl?(?:\..+)?$/)?.[1] === id) await remove(path.join(directory, name));
      }
    }
  }
  async run() {
    // Finish every read before inferring that anything is absent.
    const rows = await this.listSessions();
    const existing = new Set(rows.map(row => row.id));
    const candidates = new Set([...Object.keys(this.navigation.rows), ...(this.activity()?.rows.keys() ?? [])]);
    for (const folder of ["tasks", "pending-inputs"]) {
      for (const name of await names(path.join(this.directory, folder))) {
        const id = name.match(/^([\w-]+)\.jsonl?(?:\..+)?$/)?.[1];
        if (id) candidates.add(id);
      }
    }
    for (const id of candidates) if (!existing.has(id)) await this.cleanup(id);
    await remove(path.join(this.directory, "session-deletions.jsonl"));
    return [...existing];
  }
}
