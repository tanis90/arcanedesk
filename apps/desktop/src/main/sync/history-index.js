import { messageKey } from "./message-identity.js";

const partsOf = message => Array.isArray(message.content) ? message.content : [];
const textOf = message => typeof message.content === "string" ? message.content
  : partsOf(message).filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("");
const identity = record => record.message.arcaneMessageKey ?? (record.id ? `entry:${record.id}` : messageKey(record.message));
const invalid = message => Object.assign(new Error(message), { code: "INVALID_HISTORY_QUERY" });

/** Index original branch records once; materialize only the requested window. */
export class HistoryIndex {
  constructor(records) {
    this.records = [];
    this.positions = new Map();
    this.results = new Map();
    const toolOwners = new Map();
    for (const record of records) {
      const message = record.message;
      if (!message) continue;
      const parts = partsOf(message);
      if (message.role === "toolResult") {
        const owner = toolOwners.get(message.toolCallId);
        if (owner) {
          let results = this.results.get(owner);
          if (!results) { results = new Map(); this.results.set(owner, results); }
          results.set(message.toolCallId, message);
        }
        continue;
      }
      const visible = message.role === "user"
        ? Boolean(textOf(message).trim() || parts.some(part => part?.type === "image" && part.data))
        : message.role === "assistant" && Boolean(textOf(message) || parts.some(part => part?.type === "toolCall" || (part?.type === "thinking" && part.thinking)));
      if (!visible) continue;
      const position = this.records.length;
      this.records.push(record);
      this.positions.set(identity(record), position);
      const legacy = `${message.role}:${message.timestamp}`;
      if (!this.positions.has(legacy)) this.positions.set(legacy, position);
      for (const part of parts) if (part?.type === "toolCall") {
        toolOwners.set(part.id, record); this.positions.set(`tool:${part.id}`, position);
      }
    }
  }

  render(record) {
    const message = record.message, parts = partsOf(message);
    const row = { role: message.role, ts: message.timestamp, key: identity(record),
      legacyKey: `${message.role}:${message.timestamp}`, text: textOf(message) };
    if (message.role === "user") return { ...row, images: parts.filter(part => part?.type === "image" && part.data)
      .map(part => ({ data: part.data, mimeType: part.mimeType ?? "image/png" })) };
    return { ...row, thinking: parts.filter(part => part?.type === "thinking" && typeof part.thinking === "string").map(part => part.thinking).join(""),
      toolCalls: parts.filter(part => part?.type === "toolCall").map(part => {
        const result = this.results.get(record)?.get(part.id);
        return { id: part.id, name: part.name, args: part.arguments, hasResult: Boolean(result),
          ...(result ? { isError: Boolean(result.isError), resultText: partsOf(result).filter(part => part?.type === "text").map(part => part.text).join("\n") } : {}) };
      }) };
  }

  all() { return structuredClone(this.records.map(record => this.render(record))); }

  /** @param {any} query */
  page(query = {}) {
    if (!query || typeof query !== "object" || Array.isArray(query)) throw invalid("History query must be an object");
    if (Object.keys(query).some(key => !["before", "after", "around", "limit"].includes(key))) throw invalid("Unknown history query field");
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("History page limit must be 1–200");
    const boundaries = ["before", "after", "around"].filter(key => query[key] !== undefined);
    if (boundaries.length > 1) throw invalid("Use one history boundary");
    let start = Math.max(0, this.records.length - limit), end = this.records.length;
    if (boundaries.length) {
      const kind = boundaries[0], key = query[kind];
      if (typeof key !== "string" || !key.length || key.length > 256) throw invalid("Invalid history cursor");
      // Work/thinking containers inherit their message's identity.
      const plain = key.replace(/^(?:think:|work:)/, "");
      const position = this.positions.get(key) ?? this.positions.get(plain);
      if (position === undefined) throw Object.assign(new Error("History cursor is no longer on this branch"), { code: "HISTORY_CURSOR_NOT_FOUND" });
      if (kind === "before") { end = position; start = Math.max(0, end - limit); }
      else if (kind === "after") { start = position + 1; end = Math.min(this.records.length, start + limit); }
      else { start = Math.max(0, position - Math.floor(limit / 2)); end = Math.min(this.records.length, start + limit); }
    }
    const records = this.records.slice(start, end);
    return { history: structuredClone(records.map(record => this.render(record))), historyPage: {
      total: this.records.length, firstKey: records.length ? identity(records[0]) : null,
      lastKey: records.length ? identity(records.at(-1)) : null,
      hasOlder: start > 0, hasNewer: end < this.records.length,
    } };
  }
}
