import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const VERSION = 1;
const DECISIONS = new Set(["allow", "deny"]);

export const PERSISTABLE_PERMISSION_KEYS = new Set([
  "media:audio",
  "media:video",
  "notifications",
  "speaker-selection",
]);

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function emptyData() {
  return { version: VERSION, origins: {} };
}

/** Persistent, exact-origin decisions for the small ASK_PERSIST allowlist. */
export class WebPermissionStore {
  constructor(filePath, log = console.log) {
    this.filePath = filePath;
    this.log = log;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      const data = emptyData();
      for (const [rawOrigin, rawPermissions] of Object.entries(parsed?.origins ?? {})) {
        const origin = normalizeOrigin(rawOrigin);
        if (!origin || !rawPermissions || typeof rawPermissions !== "object") continue;
        const permissions = {};
        for (const [key, decision] of Object.entries(rawPermissions)) {
          if (PERSISTABLE_PERMISSION_KEYS.has(key) && DECISIONS.has(decision)) {
            permissions[key] = decision;
          }
        }
        if (Object.keys(permissions).length > 0) data.origins[origin] = permissions;
      }
      return data;
    } catch {
      return emptyData();
    }
  }

  save() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const json = `${JSON.stringify(this.data, null, 2)}\n`;
    try {
      writeFileSync(tempPath, json, "utf8");
      renameSync(tempPath, this.filePath);
    } catch (error) {
      // Some Windows filesystems refuse replacing an existing destination by rename.
      // Preserve availability with a direct write, then remove only our exact temp file.
      try {
        writeFileSync(this.filePath, json, "utf8");
      } finally {
        rmSync(tempPath, { force: true });
      }
      this.log(`[permissions] atomic replace unavailable, used direct write: ${error.message}`);
    }
  }

  get(originValue, key) {
    const origin = normalizeOrigin(originValue);
    if (!origin || !PERSISTABLE_PERMISSION_KEYS.has(key)) return null;
    return this.data.origins[origin]?.[key] ?? null;
  }

  set(originValue, key, decision) {
    const origin = normalizeOrigin(originValue);
    if (!origin || !PERSISTABLE_PERMISSION_KEYS.has(key) || !DECISIONS.has(decision)) {
      return { ok: false, error: "invalid permission decision" };
    }
    this.data.origins[origin] ??= {};
    this.data.origins[origin][key] = decision;
    this.save();
    return { ok: true };
  }

  revoke(originValue, key) {
    const origin = normalizeOrigin(originValue);
    if (!origin || !PERSISTABLE_PERMISSION_KEYS.has(key)) return { ok: false, error: "invalid permission" };
    const permissions = this.data.origins[origin];
    if (!permissions || !(key in permissions)) return { ok: true };
    delete permissions[key];
    if (Object.keys(permissions).length === 0) delete this.data.origins[origin];
    this.save();
    return { ok: true };
  }

  clear(originValue) {
    const origin = normalizeOrigin(originValue);
    if (!origin) return { ok: false, error: "invalid origin" };
    if (!(origin in this.data.origins)) return { ok: true };
    delete this.data.origins[origin];
    this.save();
    return { ok: true };
  }

  list() {
    return Object.entries(this.data.origins)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([origin, permissions]) => ({
        origin,
        permissions: Object.entries(permissions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, decision]) => ({ key, decision })),
      }));
  }
}
