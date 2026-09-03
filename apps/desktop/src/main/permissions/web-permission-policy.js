import { randomUUID } from "node:crypto";
import { PERSISTABLE_PERMISSION_KEYS } from "./web-permission-store.js";

const FIXED_ALLOW = new Set(["fullscreen", "clipboard-sanitized-write"]);
const ASK_SESSION = new Set(["clipboard-read", "pointerLock"]);
const ASK_PERSIST = new Set(["notifications", "speaker-selection"]);

function exactOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

// 产品决策:本应用不使用摄像头(签名版 entitlements 只含 audio-input;
// hardened runtime 下无 camera entitlement 时请求摄像头会被系统直接杀进程,
// 所以 video 必须在策略层就被拒掉,不能走到系统授权)。
function mediaTypesFromRequest(details) {
  if (!Array.isArray(details?.mediaTypes)) return [];
  return [...new Set(details.mediaTypes.filter((type) => type === "audio"))];
}

function keysForRequest(permission, details) {
  if (permission === "media") return mediaTypesFromRequest(details).map((type) => `media:${type}`);
  if (ASK_SESSION.has(permission) || ASK_PERSIST.has(permission)) return [permission];
  return [];
}

function keyForCheck(permission, details) {
  if (permission !== "media") return permission;
  const type = details?.mediaType;
  return type === "audio" ? `media:${type}` : null;
}

function originMatches(value, expected) {
  return Boolean(expected) && exactOrigin(value) === expected;
}

/**
 * The single policy truth used by Electron's permission check and request handlers.
 * It deliberately has no Electron imports so the trust and lifecycle rules can be
 * covered by fast node:test unit tests.
 */
export class WebPermissionPolicy {
  constructor({
    store,
    getChatWebContents,
    getFoundryWebContents,
    getFoundryOrigin,
    sendToRenderer,
    requestTimeoutMs = 60_000,
    idFactory = () => `perm_${randomUUID()}`,
    log = console.log,
  }) {
    this.store = store;
    this.getChatWebContents = getChatWebContents;
    this.getFoundryWebContents = getFoundryWebContents;
    this.getFoundryOrigin = getFoundryOrigin;
    this.sendToRenderer = sendToRenderer;
    this.requestTimeoutMs = requestTimeoutMs;
    this.idFactory = idFactory;
    this.log = log;
    this.sessionGrants = new Set();
    this.denials = new Map();
    this.pending = new Map();
    this.pendingByKey = new Map();
  }

  surface(webContents) {
    if (webContents && webContents === this.getChatWebContents()) return "chat";
    if (webContents && webContents === this.getFoundryWebContents()) return "foundry";
    return "other";
  }

  trustedFoundryRequest(webContents, details) {
    const expected = exactOrigin(this.getFoundryOrigin());
    if (!expected || this.surface(webContents) !== "foundry" || details?.isMainFrame !== true) return null;
    if (!originMatches(details.requestingUrl, expected)) return null;
    if (details.securityOrigin && !originMatches(details.securityOrigin, expected)) return null;
    return expected;
  }

  trustedFoundryCheck(webContents, requestingOrigin, details) {
    const expected = exactOrigin(this.getFoundryOrigin());
    if (!expected || this.surface(webContents) !== "foundry" || details?.isMainFrame !== true) return null;
    if (!originMatches(requestingOrigin, expected)) return null;
    if (details.embeddingOrigin && !originMatches(details.embeddingOrigin, expected)) return null;
    if (details.securityOrigin && !originMatches(details.securityOrigin, expected)) return null;
    return expected;
  }

  grantToken(webContents, origin, key) {
    return `${webContents?.id ?? "gone"}|${origin}|${key}`;
  }

  isGranted(webContents, origin, key) {
    return this.sessionGrants.has(this.grantToken(webContents, origin, key)) || this.store.get(origin, key) === "allow";
  }

  check(webContents, permission, requestingOrigin, details = {}) {
    const surface = this.surface(webContents);
    if (surface === "chat") {
      return permission === "media" && details.mediaType === "audio";
    }

    const origin = this.trustedFoundryCheck(webContents, requestingOrigin, details);
    if (!origin) return false;
    if (FIXED_ALLOW.has(permission)) return true;

    const key = keyForCheck(permission, details);
    if (!key) return false;
    if (!ASK_SESSION.has(permission) && !PERSISTABLE_PERMISSION_KEYS.has(key)) return false;
    if (this.store.get(origin, key) === "deny") return false;
    return this.isGranted(webContents, origin, key);
  }

  request(webContents, permission, callback, details = {}) {
    const surface = this.surface(webContents);
    if (surface === "chat") {
      const mediaTypes = mediaTypesFromRequest(details);
      callback(permission === "media" && mediaTypes.length === 1 && mediaTypes[0] === "audio");
      return;
    }

    const origin = this.trustedFoundryRequest(webContents, details);
    if (!origin) {
      callback(false);
      return;
    }
    if (FIXED_ALLOW.has(permission) || permission === "display-capture") {
      // display-capture is authorized by the separate user-gesture/source picker handler.
      callback(true);
      return;
    }

    const requestedKeys = keysForRequest(permission, details);
    if (requestedKeys.length === 0) {
      callback(false);
      return;
    }
    if (requestedKeys.some((key) => this.store.get(origin, key) === "deny")) {
      callback(false);
      return;
    }
    const missingKeys = requestedKeys.filter((key) => !this.isGranted(webContents, origin, key));
    if (missingKeys.length === 0) {
      callback(true);
      return;
    }

    const denialKey = `${webContents.id}|${origin}|${permission}`;
    if ((this.denials.get(denialKey) ?? 0) >= 3) {
      callback(false);
      return;
    }
    this.enqueue({ webContents, origin, permission, missingKeys, callback, denialKey });
  }

  enqueue({ webContents, origin, permission, missingKeys, callback, denialKey }) {
    // Merge concurrent audio requests into one understandable prompt. Other
    // duplicate permission requests share the same answer and callback lifecycle.
    const pendingKey = `${webContents.id}|${origin}|${permission}`;
    let request = this.pendingByKey.get(pendingKey);
    if (!request) {
      const requestId = this.idFactory();
      request = {
        requestId,
        pendingKey,
        webContents,
        origin,
        permission,
        keys: new Set(),
        callbacks: [],
        denialKey,
        canPersist: permission === "media" || ASK_PERSIST.has(permission),
        timer: null,
      };
      request.timer = setTimeout(() => this.finish(request, false, "timeout"), this.requestTimeoutMs);
      this.pending.set(requestId, request);
      this.pendingByKey.set(pendingKey, request);
    }
    for (const key of missingKeys) request.keys.add(key);
    request.callbacks.push(callback);
    this.emitRequest(request);
  }

  emitRequest(request) {
    try {
      this.sendToRenderer({
        type: "permission_request",
        requestId: request.requestId,
        origin: request.origin,
        permission: request.permission,
        mediaTypes: request.permission === "media"
          ? [...request.keys].map((key) => key.slice("media:".length)).sort()
          : undefined,
        canPersist: request.canPersist,
      });
    } catch (error) {
      this.log(`[permissions] failed to show request: ${error.message}`);
      this.finish(request, false, "renderer-unavailable");
    }
  }

  respond(requestId, decision) {
    const request = this.pending.get(String(requestId ?? ""));
    if (!request) return { ok: false, error: "permission request expired" };
    const allowed = decision === "allow-session" || decision === "allow-persist";
    const persist = decision === "allow-persist" || decision === "deny-persist";
    if (!allowed && decision !== "deny" && decision !== "deny-persist") {
      return { ok: false, error: "invalid permission decision" };
    }
    if (persist && !request.canPersist) return { ok: false, error: "permission cannot be persisted" };

    if (allowed) {
      for (const key of request.keys) {
        if (decision === "allow-persist") {
          try {
            this.store.set(request.origin, key, "allow");
          } catch (error) {
            // A disk problem must not turn the user's explicit Allow click into a
            // broken feature. Keep it for this panel and report the persistence loss.
            this.sessionGrants.add(this.grantToken(request.webContents, request.origin, key));
            this.log(`[permissions] could not persist allow for ${key}: ${error.message}`);
          }
        } else this.sessionGrants.add(this.grantToken(request.webContents, request.origin, key));
      }
    } else {
      this.denials.set(request.denialKey, (this.denials.get(request.denialKey) ?? 0) + 1);
      if (decision === "deny-persist") {
        for (const key of request.keys) {
          try {
            this.store.set(request.origin, key, "deny");
          } catch (error) {
            this.log(`[permissions] could not persist deny for ${key}: ${error.message}`);
          }
        }
      }
    }
    this.finish(request, allowed, "user");
    return { ok: true, granted: allowed };
  }

  pendingInfo(requestId) {
    const request = this.pending.get(String(requestId ?? ""));
    if (!request) return null;
    return {
      permission: request.permission,
      mediaTypes: request.permission === "media"
        ? [...request.keys].map((key) => key.slice("media:".length)).sort()
        : [],
    };
  }

  finish(request, granted, reason) {
    if (!this.pending.has(request.requestId)) return;
    clearTimeout(request.timer);
    this.pending.delete(request.requestId);
    this.pendingByKey.delete(request.pendingKey);
    for (const callback of request.callbacks.splice(0)) {
      try {
        callback(Boolean(granted));
      } catch {
        /* Chromium request already disappeared. */
      }
    }
    try {
      this.sendToRenderer({
        type: "permission_resolved",
        requestId: request.requestId,
        granted: Boolean(granted),
        reason,
      });
    } catch {
      /* Chat renderer is already gone. */
    }
  }

  cancelPending(reason = "navigation") {
    for (const request of [...this.pending.values()]) this.finish(request, false, reason);
  }

  clearSessionGrants(reason = "panel-closed") {
    this.cancelPending(reason);
    this.sessionGrants.clear();
    this.denials.clear();
  }

  revoke(origin, key) {
    const result = this.store.revoke(origin, key);
    if (!result.ok) return result;
    const suffix = `|${exactOrigin(origin)}|${key}`;
    for (const token of [...this.sessionGrants]) {
      if (token.endsWith(suffix)) this.sessionGrants.delete(token);
    }
    return { ok: true };
  }

  clearOrigin(origin) {
    const normalized = exactOrigin(origin);
    const result = this.store.clear(normalized);
    if (!result.ok) return result;
    for (const token of [...this.sessionGrants]) {
      if (token.includes(`|${normalized}|`)) this.sessionGrants.delete(token);
    }
    return { ok: true };
  }

  listPersisted() {
    return this.store.list();
  }
}
