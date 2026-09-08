import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside, readSessionMode, sessionDirForMode } from "../session-mode.js";

/** Disk-only discovery. Read failures must not masquerade as an empty inventory. */
export async function listStoredSessions(agentDir, mode) {
  const directory = sessionDirForMode(agentDir, mode);
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const rows = [];
  for (const name of names.filter(name => name.endsWith(".jsonl"))) {
    const file = path.join(directory, name);
    if (!isPathInside(directory, file)) throw new Error("Session file points outside its mode directory");
    const contents = await readFile(file, "utf8");
    const entries = contents.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    const header = entries[0];
    if (header?.type !== "session" || typeof header.id !== "string" || !/^[\w-]{1,128}$/.test(header.id)) {
      throw new Error(`Invalid session header: ${name}`);
    }
    if (readSessionMode({ getEntries: () => entries }) !== mode) throw new Error(`Invalid session mode: ${name}`);
    const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
    const first = messages.find(message => message.role === "user");
    const text = typeof first?.content === "string" ? first.content
      : (first?.content ?? []).filter(part => part.type === "text").map(part => part.text).join(" ");
    const info = entries.filter(entry => entry.type === "session_info").at(-1);
    rows.push({ id: header.id, path: file, cwd: header.cwd, name: info?.name ?? "",
      firstMessage: text.replace(/\s+/g, " ").trim().slice(0, 60),
      firstMessageI18n: messages.length ? null : "sessions.unsaved",
      modified: (await stat(file)).mtimeMs, messageCount: messages.length });
  }
  return rows.sort((a, b) => b.modified - a.modified);
}
