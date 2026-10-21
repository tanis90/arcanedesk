/**
 * Deep-clone a value into something JSON.stringify always accepts: circular
 * references become "[Circular]" markers and BigInt becomes a decimal string.
 * Tool results cross three JSON boundaries (model transcript, session JSONL,
 * renderer IPC); values pulled live from the Foundry page via structured clone
 * can carry cycles (e.g. dnd5e document back-references) and must not take the
 * turn down when any of those layers serializes them.
 */
export function jsonSafe(value) {
  if (value === undefined) return undefined;
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }));
}
