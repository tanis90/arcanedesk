/** Copy a receipt fragment so repeated object identities survive jsonSafe's cycle marker. */
function detached(value) {
  if (!value || typeof value !== "object") return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

/** Adapt SDK receipts at the Desktop boundary while preserving the legacy SDK protocol. */
export function normalizeFoundryWriteReceipt(value, { action, args }) {
  if (!value || !["completed", "rejected", "partial", "indeterminate"].includes(value.status)) return value;
  if (value.status === "rejected") return { ...value, message: value.message ?? value.code ?? "Request rejected before writing." };
  let steps = value.steps;
  if (!Array.isArray(steps) && action === "executeAction") {
    const targets = [...new Set((args.resolvedActions ?? []).map(entry => entry.sourceTokenUuid).filter(Boolean))];
    // The old receipt certifies execution, not resulting HP. Combat still requires its post-turn read.
    steps = [{ step: "execute-action", targets, state: value.status === "completed" ? "completed" : "unknown",
      requested: args.resolvedActions?.length ?? 0,
      ...(Number.isInteger(value.completed) ? { completed: value.completed } : {}),
      summary: value.status === "completed" ? "Native action execution confirmed; resulting combat state is read separately."
        : "Native execution is not fully confirmed; do not repeat the request." }];
  }
  // Runtime receipts commonly share nested values between `steps`, `verification` and top-level
  // fields (e.g. an import step's stats is the receipt's stats; verification reuses step targets).
  // jsonSafe marks any repeated identity as "[Circular]", so each entry gets its own copy here.
  // `verification` is either an entry array (actorEdit/imageApply/grantItems) or a single object
  // (actorAdvance reports level/HP/abilities/slots); the object form must survive verbatim.
  steps = (steps ?? []).map(step => {
    const copy = detached(step);
    const state = copy.state === "not-started" ? "not_started" : copy.state;
    const normalized = { ...copy, targets: Array.isArray(copy.targets) ? [...copy.targets] : [], state,
      summary: copy.summary ?? (copy.step !== undefined ? `${copy.step}: ${state}` : [copy.slot, copy.label].filter(Boolean).join(" ")) };
    if (copy.step === "upload-image") {
      normalized.dataPaths = normalized.targets;
      normalized.targets = [];
    }
    return normalized;
  });
  const verification = detachedVerification(value.verification);
  return value.status === "completed"
    ? { ...value, steps, verification: verification ?? [{ kind: "native-execution", confirmed: true }], warnings: value.warnings ?? [] }
    : {
      ...value,
      steps,
      ...(verification === undefined ? {} : { verification }),
      retry: false,
      message: value.message ?? "Execution is not fully confirmed; inspect this operation before any further action.",
    };
}

/** Entry arrays and single verification objects both keep their shape; only identity is copied. */
function detachedVerification(verification) {
  if (Array.isArray(verification)) return verification.map(entry => detached(entry));
  if (verification && typeof verification === "object") return detached(verification);
  return verification === undefined ? undefined : verification;
}
