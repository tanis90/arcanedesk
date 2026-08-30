const BOUND_CREDENTIAL_KIND = "arcane-bound-credential-v1";

/** Bind a secret and its allowed target inside the same OS-protected payload. */
export function encodeBoundCredential(secret, target) {
  if (!secret || !target) return "";
  return JSON.stringify({ kind: BOUND_CREDENTIAL_KIND, secret, target });
}

/** Decode a current payload or identify a pre-binding raw secret for migration. */
export function decodeBoundCredential(value) {
  const raw = String(value ?? "");
  if (!raw) return { secret: "", target: null, legacy: false };
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.kind === BOUND_CREDENTIAL_KIND &&
      typeof parsed.secret === "string" &&
      typeof parsed.target === "string"
    ) {
      return { secret: parsed.secret, target: parsed.target, legacy: false };
    }
  } catch {
    // Older protected values contain only the raw secret.
  }
  return { secret: raw, target: null, legacy: true };
}

