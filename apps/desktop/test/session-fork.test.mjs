import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentHost } from "../src/main/agent-host.js";
import { SessionNavigation } from "../src/main/conversations/session-navigation.js";
import { forkStoredSession } from "../src/main/conversations/session-fork.js";
import { claimSessionMode, readSessionMode } from "../src/main/session-mode.js";

/** 仿 AgentHost.createSessionManager：marker 与 header 在首个 turn 前抢先落盘。 */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-fork-"));
  const cwd = path.join(root, "project"); mkdirSync(cwd, { recursive: true });
  const sessionDir = path.join(root, "sessions", "arcane-desktop-prep"); mkdirSync(sessionDir, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDir);
  claimSessionMode(manager, "prep");
  manager.appendMessage({ role: "user", timestamp: 1, content: "整理法术位" });
  manager.appendMessage({ role: "assistant", timestamp: 2, content: [{ type: "text", text: "已备好" }] });
  manager.appendModelChange("kimi", "k3-256k");
  manager.appendSessionInfo("整理法术位");
  const file = manager.getSessionFile();
  writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { cwd, sessionDir, file, manager: SessionManager.open(file, sessionDir) };
}

test("forkStoredSession 复制出独立新会话：新 id、parentSession 谱系、entries 全保留、源文件零改动", () => {
  const { cwd, sessionDir, file, manager } = fixture();
  const before = readFileSync(file, "utf8");
  const forked = forkStoredSession({ sourcePath: file, cwd, sessionDir });
  assert.notEqual(forked.id, manager.getSessionId());
  assert.notEqual(forked.path, file);
  assert.ok(forked.path.startsWith(sessionDir));
  assert.equal(readFileSync(file, "utf8"), before);

  const copy = SessionManager.open(forked.path, sessionDir);
  const header = copy.getHeader();
  assert.equal(header.id, forked.id);
  assert.equal(header.parentSession, path.resolve(file));
  assert.equal(header.cwd, path.resolve(cwd));
  assert.deepEqual(copy.getEntries(), manager.getEntries());
  assert.equal(readSessionMode(copy), "prep");
  assert.equal(copy.getSessionName(), "整理法术位");

  copy.appendMessage({ role: "user", timestamp: 3, content: "换个方向" });
  assert.ok(copy.getEntries().length > manager.getEntries().length);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("AgentHost.fork 在忙碌/有在途操作时拒绝，空闲时 flush 后分叉", async () => {
  const { cwd, sessionDir, manager } = fixture();
  const host = new AgentHost({ sendToRenderer() {}, log() {} });
  host.sessionManager = manager; host.cwd = () => cwd; host.sessionDir = () => sessionDir;
  host.tasks = { busy: true };
  await assert.rejects(() => host.fork(), { code: "SESSION_BUSY" });
  host.tasks = null; host.operations = 1;
  await assert.rejects(() => host.fork(), { code: "SESSION_BUSY" });
  host.operations = 0;
  const forked = await host.fork();
  assert.notEqual(forked.id, manager.getSessionId());
  assert.equal(readSessionMode(SessionManager.open(forked.path, sessionDir)), "prep");
});

test("fork 的导航元数据（标题前缀 + 继承模型）可持久化往返", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "arcane-nav-")), "session-navigation.json");
  const navigation = new SessionNavigation({ file });
  navigation.patch("fork-id", { customTitle: "分叉：整理法术位", selectedModel: { providerId: "kimi", modelId: "k3-256k" } });
  assert.deepEqual(new SessionNavigation({ file }).get("fork-id"), { customTitle: "分叉：整理法术位", selectedModel: { providerId: "kimi", modelId: "k3-256k" } });
});

test("forkStoredSession 对缺失源文件抛出稳定错误码", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arcane-fork-"));
  const sessionDir = path.join(root, "sessions"); mkdirSync(sessionDir, { recursive: true });
  assert.throws(() => forkStoredSession({ sourcePath: path.join(sessionDir, "missing.jsonl"), cwd: root, sessionDir }), { code: "SESSION_FORK_FAILED" });
});

test("forkStoredSession 把底层文件系统错误归一为 SESSION_FORK_FAILED", () => {
  const { cwd, file } = fixture();
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), "arcane-fork-")), "not-a-dir");
  writeFileSync(blocker, "");
  assert.throws(() => forkStoredSession({ sourcePath: file, cwd, sessionDir: blocker }), { code: "SESSION_FORK_FAILED" });
});
