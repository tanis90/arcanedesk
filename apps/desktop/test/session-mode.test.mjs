import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ARCANE_SESSION_MARKER,
  claimSessionMode,
  isDescendantPath,
  isPathInside,
  readSessionMode,
  sessionDirForMode,
  SessionModeError,
} from "../src/main/session-mode.js";

function tempLayout() {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-native-session-mode-"));
  const agentDir = path.join(root, "agent");
  const cwdA = path.join(root, "project-a");
  const cwdB = path.join(root, "project-b");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  return {
    root,
    agentDir,
    cwdA,
    cwdB,
    combatDir: sessionDirForMode(agentDir, "combat"),
    prepDir: sessionDirForMode(agentDir, "prep"),
  };
}

function appendPersistedTurn(manager, label) {
  manager.appendMessage({ role: "user", content: `hello-${label}`, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `world-${label}` }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

test("uses two Pi-native direct session directories", () => {
  const { agentDir, combatDir, prepDir } = tempLayout();
  assert.equal(combatDir, path.join(agentDir, "sessions", "arcane-desktop-combat"));
  assert.equal(prepDir, path.join(agentDir, "sessions", "arcane-desktop-prep"));
  assert.notEqual(combatDir, prepDir);
});

test("stores the mode marker inside Pi JSONL on first assistant flush", () => {
  const { cwdA, prepDir } = tempLayout();
  const manager = SessionManager.create(cwdA, prepDir);
  const sessionFile = manager.getSessionFile();

  claimSessionMode(manager, "prep");
  assert.equal(existsSync(sessionFile), false, "Pi defers a new JSONL until an assistant message exists");
  assert.equal(readSessionMode(manager), "prep");

  appendPersistedTurn(manager, "prep");
  assert.equal(existsSync(sessionFile), true);
  const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].type, "session");
  assert.equal(lines[1].type, "custom");
  assert.equal(lines[1].customType, ARCANE_SESSION_MARKER);
  assert.deepEqual(lines[1].data, { mode: "prep", schemaVersion: 1 });

  const reopened = SessionManager.open(sessionFile, prepDir);
  assert.equal(readSessionMode(reopened), "prep");
});

test("custom sessionDir keeps modes physical and still filters prep projects by header cwd", async () => {
  const { cwdA, cwdB, combatDir, prepDir } = tempLayout();
  const sessions = [
    { cwd: cwdA, dir: combatDir, mode: "combat", label: "combat-a" },
    { cwd: cwdB, dir: combatDir, mode: "combat", label: "combat-b" },
    { cwd: cwdA, dir: prepDir, mode: "prep", label: "prep-a" },
  ];
  for (const item of sessions) {
    const manager = SessionManager.create(item.cwd, item.dir);
    claimSessionMode(manager, item.mode);
    appendPersistedTurn(manager, item.label);
  }

  const combatA = await SessionManager.list(cwdA, combatDir);
  const combatB = await SessionManager.list(cwdB, combatDir);
  const prepA = await SessionManager.list(cwdA, prepDir);
  assert.equal(combatA.length, 1);
  assert.equal(combatB.length, 1);
  assert.equal(prepA.length, 1);
  assert.match(combatA[0].firstMessage, /combat-a/);
  assert.match(prepA[0].firstMessage, /prep-a/);
});

test("rejects missing or conflicting markers instead of silently defaulting to combat", () => {
  const { cwdA, combatDir } = tempLayout();
  const unmarked = SessionManager.create(cwdA, combatDir);
  appendPersistedTurn(unmarked, "legacy");
  const unmarkedFile = unmarked.getSessionFile();
  assert.throws(
    () => claimSessionMode(SessionManager.open(unmarkedFile, combatDir), "combat"),
    (error) => error instanceof SessionModeError && error.code === "SESSION_MODE_MISSING"
  );

  const marked = SessionManager.create(cwdA, combatDir);
  claimSessionMode(marked, "combat");
  assert.throws(
    () => claimSessionMode(marked, "prep"),
    (error) => error instanceof SessionModeError && error.code === "SESSION_MODE_MISMATCH"
  );
});

test("mode directory containment rejects traversal and sibling-prefix paths", () => {
  const { root, combatDir } = tempLayout();
  const child = path.join(combatDir, "session.jsonl");
  const siblingPrefix = path.join(root, "agent", "sessions", "arcane-desktop-combat-copy", "session.jsonl");
  assert.equal(isPathInside(combatDir, child), true);
  assert.equal(isPathInside(combatDir, path.join(combatDir, "..", "arcane-desktop-prep", "session.jsonl")), false);
  assert.equal(isPathInside(combatDir, siblingPrefix), false);
  assert.equal(isPathInside(combatDir, combatDir), false);
});

test("directory containment has the same boundary semantics on Windows and POSIX", () => {
  const windowsRoot = "C:\\Users\\dm\\.pi\\agent\\sessions\\arcane-desktop-combat";
  assert.equal(isDescendantPath(path.win32, windowsRoot, path.win32.join(windowsRoot, "session.jsonl")), true);
  assert.equal(
    isDescendantPath(path.win32, windowsRoot, "C:\\Users\\dm\\.pi\\agent\\sessions\\arcane-desktop-combat-copy\\session.jsonl"),
    false
  );
  assert.equal(isDescendantPath(path.win32, windowsRoot, "D:\\sessions\\session.jsonl"), false);

  const posixRoot = "/Users/dm/.pi/agent/sessions/arcane-desktop-combat";
  assert.equal(isDescendantPath(path.posix, posixRoot, path.posix.join(posixRoot, "session.jsonl")), true);
  assert.equal(
    isDescendantPath(path.posix, posixRoot, "/Users/dm/.pi/agent/sessions/arcane-desktop-combat-copy/session.jsonl"),
    false
  );
  assert.equal(isDescendantPath(path.posix, posixRoot, "/Users/dm/.pi/agent/sessions/arcane-desktop-prep/session.jsonl"), false);
});
