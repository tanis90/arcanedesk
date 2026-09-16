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
  steps = (steps ?? []).map(step => {
    const state = step.state === "not-started" ? "not_started" : step.state;
    const normalized = { ...step, targets: step.targets ?? [], state,
      summary: step.summary ?? (step.step !== undefined ? `${step.step}: ${state}` : [step.slot, step.label].filter(Boolean).join(" ")) };
    if (step.step === "upload-image") {
      normalized.dataPaths = step.targets ?? [];
      normalized.targets = [];
    }
    return normalized;
  });
  return value.status === "completed"
    ? { ...value, steps, verification: value.verification ?? [{ kind: "native-execution", confirmed: true }], warnings: value.warnings ?? [] }
    : { ...value, steps, retry: false, message: value.message ?? "Execution is not fully confirmed; inspect this operation before any further action." };
}
