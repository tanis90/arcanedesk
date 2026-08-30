import { SecretStorage } from "../src/main/secret-storage.js";

export function testSecretStorage() {
  return new SecretStorage({
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`test-protected:${plainText}`, "utf8"),
    decryptString: (encrypted) => {
      const value = encrypted.toString("utf8");
      if (!value.startsWith("test-protected:")) throw new Error("invalid test secret");
      return value.slice("test-protected:".length);
    },
  });
}
