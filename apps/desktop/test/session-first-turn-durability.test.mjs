import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { readSessionMode } from "../src/main/session-mode.js";

test("new host session is discoverable before its first reply and SDK appends without replacing identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-first-turn-"));
  const host = new AgentHost({ sendToRenderer() {}, log() {} });
  host.cwd = () => root;
  host.sessionDir = () => path.join(root, "sessions");
  const manager = host.createSessionManager();
  const file = manager.getSessionFile();
  const id = manager.getSessionId();
  const reopened = SessionManager.open(file, host.sessionDir());
  assert.equal(reopened.getSessionId(), id);
  assert.equal(readSessionMode(reopened), host.profile.mode);
  manager.appendMessage({ role: "user", content: "first task", timestamp: 1 });
  assert.equal(SessionManager.open(file).getEntries().filter(entry => entry.type === "message").length, 1);
  assert.ok((await host.listOwnedSessionInfos()).some(row => row.id === id), "unfinished first turn is navigable after restart");
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2,
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.type === "session").length, 1);
  assert.equal(rows.filter(row => row.type === "message").length, 2);
  assert.equal(SessionManager.open(file).getSessionId(), id);
});
