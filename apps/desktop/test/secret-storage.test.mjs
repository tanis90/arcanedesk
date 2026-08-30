import assert from "node:assert/strict";
import test from "node:test";

import { SecretStorage } from "../src/main/secret-storage.js";
import { testSecretStorage } from "./test-secret-storage.mjs";

test("protects and reveals a secret without storing plaintext", () => {
  const storage = testSecretStorage();
  const protectedValue = storage.protect("sk-sensitive-value");

  assert.equal(protectedValue.scheme, "electron-safe-storage-v1");
  assert.equal(JSON.stringify(protectedValue).includes("sk-sensitive-value"), false);
  assert.equal(storage.reveal(protectedValue), "sk-sensitive-value");
  assert.equal(storage.protect(""), null);
  assert.equal(storage.reveal(null), "");
});

test("never falls back to plaintext when OS encryption is unavailable", () => {
  const storage = new SecretStorage({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });

  assert.throws(
    () => storage.protect("sk-sensitive-value"),
    (error) => error.code === "DESKTOP_SECRET_STORAGE_UNAVAILABLE",
  );
});
