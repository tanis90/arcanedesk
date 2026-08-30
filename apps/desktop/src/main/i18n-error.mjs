// Structured user-facing errors cross IPC as { key, params } and are localized
// in the renderer. Internal errors remain plain strings for diagnostics.
"use strict";

export function err(key, params = {}) {
  return { key, params };
}

export class I18nError extends Error {
  constructor(key, params = {}) {
    super(`i18n:${key}`);
    this.name = "I18nError";
    this.i18nKey = key;
    this.i18nParams = params;
  }

  toIpc() {
    return err(this.i18nKey, this.i18nParams);
  }
}

const ERROR_CODE_KEYS = {
  INVALID_SESSION_MODE: "err.session.invalidMode",
  INVALID_SESSION_MARKER: "err.session.invalidMarker",
  CONFLICTING_SESSION_MARKERS: "err.session.conflictingMarkers",
  SESSION_MODE_MISMATCH: "err.session.modeMismatch",
  SESSION_MODE_MISSING: "err.session.missingMarker",
  SESSION_PATH_OUTSIDE_MODE_DIR: "err.session.pathOutside",
};

export function errorToIpc(error) {
  if (error instanceof I18nError) return error.toIpc();
  if (error?.code && ERROR_CODE_KEYS[error.code]) return err(ERROR_CODE_KEYS[error.code]);
  return String(error?.message ?? error ?? "");
}
