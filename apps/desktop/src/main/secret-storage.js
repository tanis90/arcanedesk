const PROTECTED_SECRET_SCHEME = "electron-safe-storage-v1";

function secretStorageError(code, message, cause) {
  const error = /** @type {Error & { code: string, cause?: unknown }} */ (new Error(message));
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Small injectable boundary around Electron safeStorage.
 *
 * ProviderStore and VoiceStore are intentionally synchronous today. Electron's
 * async safeStorage API is preferable for a future store API migration, but
 * this adapter keeps the current call graph secure without exposing Electron to
 * unit tests. There is deliberately no plaintext fallback.
 */
export class SecretStorage {
  /**
   * @param {{
   *   isEncryptionAvailable: () => boolean,
   *   encryptString: (plainText: string) => Buffer,
   *   decryptString: (encrypted: Buffer) => string,
   * }} safeStorage
   */
  constructor(safeStorage) {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
      throw new TypeError("safeStorage adapter is required");
    }
    this.safeStorage = safeStorage;
  }

  /** @param {string} plainText */
  protect(plainText) {
    const value = String(plainText ?? "");
    if (!value) return null;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw secretStorageError(
        "DESKTOP_SECRET_STORAGE_UNAVAILABLE",
        "Operating-system secret storage is not available; refusing to persist an API key",
      );
    }
    try {
      return {
        scheme: PROTECTED_SECRET_SCHEME,
        data: this.safeStorage.encryptString(value).toString("base64"),
      };
    } catch (cause) {
      throw secretStorageError(
        "DESKTOP_SECRET_ENCRYPT_FAILED",
        "Could not protect an API key with operating-system secret storage",
        cause,
      );
    }
  }

  /** @param {unknown} protectedValue */
  reveal(protectedValue) {
    if (protectedValue == null) return "";
    const record = /** @type {{ scheme?: unknown, data?: unknown }} */ (protectedValue);
    if (
      typeof protectedValue !== "object" ||
      record.scheme !== PROTECTED_SECRET_SCHEME ||
      typeof record.data !== "string" ||
      !record.data
    ) {
      throw secretStorageError(
        "DESKTOP_SECRET_FORMAT_INVALID",
        "Stored API key has an unsupported protected format",
      );
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw secretStorageError(
        "DESKTOP_SECRET_STORAGE_UNAVAILABLE",
        "Operating-system secret storage is not available; the stored API key cannot be opened",
      );
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(record.data, "base64"));
    } catch (cause) {
      throw secretStorageError(
        "DESKTOP_SECRET_DECRYPT_FAILED",
        "Could not open an API key from operating-system secret storage",
        cause,
      );
    }
  }
}

export function createUnavailableSecretStorage() {
  return new SecretStorage({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
}
