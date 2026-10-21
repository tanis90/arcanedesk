import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureSessionChainIntact } from "../src/main/conversations/session-integrity.js";

const TS = n => new Date(Date.parse("2026-10-21T05:20:40.000Z") + n * 1000).toISOString();

const header = () => ({ type: "session", version: 3, id: "integrity-test", timestamp: TS(0), cwd: "C:\\test" });
const marker = () => ({ type: "custom", customType: "arcane.session", data: { mode: "prep", schemaVersion: 1 }, id: "m1", parentId: null, timestamp: TS(1) });
const userMsg = (id, parentId, n) => ({ type: "message", id, parentId, timestamp: TS(n), message: { role: "user", content: [{ type: "text", text: `question ${id}` }], timestamp: n } });
const assistantCall = (id, parentId, callId, n) => ({ type: "message", id, parentId, timestamp: TS(n), message: { role: "assistant", content: [{ type: "text", text: "" }, { type: "toolCall", id: callId, name: "browser_evaluate", arguments: { code: "1" } }], api: "openai-completions", provider: "p", model: "m", stopReason: "toolUse", timestamp: n } });
const toolResult = (id, parentId, callId, n) => ({ type: "message", id, parentId, timestamp: TS(n), message: { role: "toolResult", toolCallId: callId, toolName: "browser_evaluate", content: [{ type: "text", text: "ok" }], isError: false, timestamp: n } });
const assistantText = (id, parentId, n) => ({ type: "message", id, parentId, timestamp: TS(n), message: { role: "assistant", content: [{ type: "text", text: `answer ${id}` }], api: "openai-completions", provider: "p", model: "m", stopReason: "stop", timestamp: n } });

function writeSession(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "arcane-session-integrity-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { dir, file };
}

const branchOf = (file, dir) => SessionManager.open(file, dir).getBranch();

test("healthy session file is left byte-identical", () => {
  const entries = [header(), marker(), userMsg("u1", "m1", 2), assistantCall("a1", "u1", "call_1", 3), toolResult("r1", "a1", "call_1", 4), assistantText("a2", "r1", 5)];
  const { dir, file } = writeSession(entries);
  const before = readFileSync(file, "utf8");
  const result = ensureSessionChainIntact(file);
  assert.deepEqual(result, { repaired: false, inserted: 0 });
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(branchOf(file, dir).length, entries.length - 1, "branch excludes the header");
  assert.ok(!existsSync(`${file}.chain-repair.bak`));
});

test("lost toolResult is synthesized in place and the full branch walks again", () => {
  // 复刻 2026-10-21 事故形态:r1 落盘失败,a2/thinking 的 parentId 指向幻影 r1。
  const brokenTail = { type: "thinking_level_change", id: "t1", parentId: "a2", timestamp: TS(6), thinkingLevel: "medium" };
  const entries = [header(), marker(), userMsg("u1", "m1", 2), assistantCall("a1", "u1", "call_1", 3), assistantText("a2", "r1", 5), brokenTail];
  const { dir, file } = writeSession(entries);
  assert.equal(branchOf(file, dir).length, 2, "pre-repair branch truncates at the missing parent");

  const result = ensureSessionChainIntact(file);
  assert.deepEqual(result, { repaired: true, inserted: 1 });

  const repaired = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(repaired.length, entries.length + 1);
  assert.equal(repaired.at(-1).id, "t1", "file-order leaf must stay the original tail");
  const synthetic = repaired.find(entry => entry.id === "r1");
  assert.equal(synthetic.parentId, "a1", "placeholder takes the append-order parent");
  assert.equal(synthetic.message.role, "toolResult");
  assert.equal(synthetic.message.toolCallId, "call_1");
  assert.equal(synthetic.message.isError, true);
  assert.ok(synthetic.timestamp > TS(3) && synthetic.timestamp < TS(5), "timestamp interpolates between neighbours");

  const branch = branchOf(file, dir);
  assert.equal(branch.length, repaired.length - 1, "whole file reachable from the leaf again (header excluded)");
  const results = new Set(branch.filter(e => e.message?.role === "toolResult").map(e => e.message.toolCallId));
  for (const e of branch) if (e.message?.role === "assistant") for (const part of e.message.content ?? []) if (part.type === "toolCall") assert.ok(results.has(part.id), `dangling toolCall ${part.id}`);
  assert.ok(existsSync(`${file}.chain-repair.bak`), "pre-repair backup preserved");
});

test("lost non-tool entry becomes an inert chain-repair placeholder", () => {
  const label = { type: "custom", customType: "arcane.note", data: { n: 1 }, id: "c1", parentId: "u1", timestamp: TS(3) };
  const entries = [header(), marker(), userMsg("u1", "m1", 2), assistantText("a1", "c1", 4)]; // c1 never persisted
  const { dir, file } = writeSession(entries);
  assert.equal(branchOf(file, dir).length, 1);
  const result = ensureSessionChainIntact(file);
  assert.deepEqual(result, { repaired: true, inserted: 1 });
  const synthetic = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.id === "c1");
  assert.deepEqual(synthetic, { type: "custom", customType: "arcane.chain-repair", data: { reason: "missing-parent" }, id: "c1", parentId: "u1", timestamp: synthetic.timestamp });
  assert.equal(branchOf(file, dir).length, entries.length, "header excluded");
});

test("two independent gaps are both repaired", () => {
  const entries = [
    header(), marker(),
    userMsg("u1", "m1", 2),
    assistantCall("a1", "lost1", "call_1", 3),   // gap 1: u1 -> [lost1] -> a1(toolCall)
    toolResult("r1", "a1", "call_1", 4),
    assistantText("a2", "lost2", 6),             // gap 2: r1 -> [lost2] -> a2
  ];
  const { dir, file } = writeSession(entries);
  const result = ensureSessionChainIntact(file);
  assert.deepEqual(result, { repaired: true, inserted: 2 });
  const repaired = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(repaired.find(entry => entry.id === "lost1").parentId, "u1");
  assert.equal(repaired.find(entry => entry.id === "lost2").parentId, "r1");
  assert.equal(branchOf(file, dir).length, entries.length + 1, "header excluded");
});

test("unparseable file is reported and left untouched", () => {
  const { file } = writeSession([header(), marker()]);
  writeFileSync(file, readFileSync(file, "utf8") + "{not json\n");
  const before = readFileSync(file, "utf8");
  const result = ensureSessionChainIntact(file);
  assert.equal(result.repaired, false);
  assert.equal(result.reason, "unreadable");
  assert.equal(readFileSync(file, "utf8"), before);
  assert.ok(!readdirSync(path.dirname(file)).some(name => name.includes("chain-repair")));
});
