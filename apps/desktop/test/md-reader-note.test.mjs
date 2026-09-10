import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NOTE_MAX_BYTES,
  hasNoteExtension,
  loadNotePayload,
  normalizeNotePath,
  readNote,
  resolveNote,
} from "../src/main/md-reader-note.js";

const IS_WIN = process.platform === "win32";

function workspace(t) {
  const base = mkdtempSync(path.join(tmpdir(), "arcane-md-reader-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(path.join(base, "notes"), { recursive: true });
  return base;
}

// ---------- normalizeNotePath:§4.2 的覆盖形态 ----------

test("normalizeNotePath strips wrappers, line numbers and trailing punctuation", () => {
  const cases = [
    ["notes/npc.md", "notes/npc.md", null],
    ["  notes/npc.md  ", "notes/npc.md", null],
    ["`notes/npc.md`", "notes/npc.md", null],
    ['"notes/npc.md"', "notes/npc.md", null],
    ["'notes/npc.md'", "notes/npc.md", null],
    ["“notes/npc.md”", "notes/npc.md", null],
    ["「notes/npc.md」", "notes/npc.md", null],
    ["<notes/npc.md>", "notes/npc.md", null],
    ["`\"notes/npc.md\"`", "notes/npc.md", null],
    ["notes/npc.md:42", "notes/npc.md", 42],
    ["notes/npc.md:42:7", "notes/npc.md", 42],
    ["notes/npc.MARKDOWN:42", "notes/npc.MARKDOWN", 42],
    ["notes/npc.md。", "notes/npc.md", null],
    ["notes/npc.md,", "notes/npc.md", null],
    ["notes/npc.md)", "notes/npc.md", null],
    ["notes/archive).md", "notes/archive).md", null],
  ];
  for (const [raw, expectedPath, expectedLine] of cases) {
    assert.deepEqual(normalizeNotePath(raw), { path: expectedPath, line: expectedLine }, raw);
  }
});

test("normalizeNotePath keeps Windows drive letters intact and never invents a path", () => {
  assert.equal(normalizeNotePath("").path, "");
  assert.equal(normalizeNotePath("``").path, "");
  assert.equal(normalizeNotePath(undefined).path, "");
  if (!IS_WIN) return;
  assert.deepEqual(normalizeNotePath("C:\\campaign\\notes\\npc.md"), { path: "C:\\campaign\\notes\\npc.md", line: null });
  assert.deepEqual(normalizeNotePath("C:\\campaign\\notes\\npc.md:12"), { path: "C:\\campaign\\notes\\npc.md", line: 12 });
});

test("hasNoteExtension accepts only md and markdown", () => {
  assert.equal(hasNoteExtension("a.md"), true);
  assert.equal(hasNoteExtension("a.MD"), true);
  assert.equal(hasNoteExtension("a.markdown"), true);
  assert.equal(hasNoteExtension("a.txt"), false);
  assert.equal(hasNoteExtension("a.mdx"), false);
  assert.equal(hasNoteExtension("md"), false);
  assert.equal(hasNoteExtension(""), false);
});

// ---------- resolveNote:§7 围栏 ----------

test("resolveNote resolves relative paths inside the base directory", (t) => {
  const base = workspace(t);
  const resolved = resolveNote("notes/npc.md", base);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.absolute, path.join(base, "notes", "npc.md"));
  assert.equal(resolved.line, null);
});

test("resolveNote accepts an absolute path inside the base and keeps the line number", (t) => {
  const base = workspace(t);
  const absolute = path.join(base, "notes", "npc.md");
  const resolved = resolveNote(`${absolute}:7`, base);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.absolute, absolute);
  assert.equal(resolved.line, 7);
});

test("resolveNote rejects traversal, foreign absolute paths, wrong extension and a missing base", (t) => {
  const base = workspace(t);
  assert.equal(resolveNote("../escape.md", base).reason, "outside");
  assert.equal(resolveNote("notes/../../escape.md", base).reason, "outside");
  assert.equal(resolveNote(path.join(tmpdir(), "elsewhere.md"), base).reason, "outside");
  assert.equal(resolveNote("notes/npc.txt", base).reason, "extension");
  assert.equal(resolveNote("", base).reason, "empty");
  assert.equal(resolveNote("notes/npc.md", undefined).reason, "no-base");
  // 绝对路径没有基准目录时同样不放行:阅读器的授权范围就是工作目录
  assert.equal(resolveNote(path.join(base, "notes", "npc.md"), undefined).reason, "no-base");
});

test("resolveNote rejects another Windows drive as outside the working directory", (t) => {
  if (!IS_WIN) return t.skip("drive letters only exist on Windows");
  const base = "C:\\campaign";
  assert.equal(resolveNote("D:\\other\\npc.md", base).reason, "outside");
  assert.equal(resolveNote("C:\\campaign\\notes\\npc.md", base).ok, true);
  // Windows 路径不区分大小写:大小写不同的同一目录仍算在内
  assert.equal(resolveNote("c:\\CAMPAIGN\\notes\\npc.md", base).ok, true);
});

// ---------- readNote:上限、截断、编码 ----------

test("NOTE_MAX_BYTES is the 2 MB cap from the spec", () => {
  assert.equal(NOTE_MAX_BYTES, 2 * 1024 * 1024);
});

test("readNote returns name, text and truncated=false for a small note", (t) => {
  const base = workspace(t);
  const absolute = path.join(base, "notes", "npc.md");
  writeFileSync(absolute, "# NPC：张三\n正文。", "utf8");
  const note = readNote(absolute);
  assert.equal(note.ok, true);
  assert.equal(note.name, "npc.md");
  assert.equal(note.text, "# NPC：张三\n正文。");
  assert.equal(note.truncated, false);
});

test("readNote truncates at the cap without splitting a multi-byte character", (t) => {
  const base = workspace(t);
  const absolute = path.join(base, "notes", "big.md");
  // 每个"字"是三字节;16 字节的窗口会落在第 6 个字的中间
  writeFileSync(absolute, "字".repeat(64), "utf8");
  const note = readNote(absolute, 16);
  assert.equal(note.ok, true);
  assert.equal(note.truncated, true);
  assert.equal(note.text, "字".repeat(5));
  assert.equal(note.text.includes("\uFFFD"), false, "the split character must not reach the user");
});

test("readNote reports missing files and directories alike", (t) => {
  const base = workspace(t);
  assert.deepEqual(readNote(path.join(base, "notes", "gone.md")), { ok: false, reason: "missing" });
  assert.deepEqual(readNote(path.join(base, "notes")), { ok: false, reason: "missing" });
});

test("readNote refuses binary and non-UTF-8 payloads instead of rendering garbage", (t) => {
  const base = workspace(t);
  const binary = path.join(base, "notes", "bin.md");
  writeFileSync(binary, Buffer.from([0x68, 0x00, 0x69, 0x00, 0x21, 0x00]));
  assert.deepEqual(readNote(binary), { ok: false, reason: "encoding" });

  const utf16 = path.join(base, "notes", "utf16.md");
  writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# hi", "utf16le")]));
  assert.deepEqual(readNote(utf16), { ok: false, reason: "encoding" });

  const invalid = path.join(base, "notes", "invalid.md");
  writeFileSync(invalid, Buffer.alloc(120, 0xff));
  assert.deepEqual(readNote(invalid), { ok: false, reason: "encoding" });
});

// ---------- loadNotePayload:②/F5/① 共用的那条读链 ----------

test("loadNotePayload returns rendered content for a reachable note", (t) => {
  const base = workspace(t);
  writeFileSync(path.join(base, "notes", "npc.md"), "# NPC", "utf8");
  assert.deepEqual(loadNotePayload("`notes/npc.md`", base), { name: "npc.md", text: "# NPC", truncated: false });
});

test("loadNotePayload turns every fence and read failure into one of the three spec errors", (t) => {
  const base = workspace(t);
  writeFileSync(path.join(base, "notes", "bin.md"), Buffer.alloc(64, 0xff));
  assert.deepEqual(loadNotePayload("../escape.md", base), { error: "outside" });
  assert.deepEqual(loadNotePayload("notes/npc.txt", base), { error: "outside" });
  assert.deepEqual(loadNotePayload("notes/npc.md", undefined), { error: "outside" });
  assert.deepEqual(loadNotePayload("notes/gone.md", base), { error: "missing" });
  assert.deepEqual(loadNotePayload("notes/bin.md", base), { error: "encoding" });
});

test("loadNotePayload never throws away the click: a missing note still yields a page payload", (t) => {
  const base = workspace(t);
  // R5:围栏失败也要有响应,所以返回值永远是一个可直接渲染的 payload
  const payload = loadNotePayload("notes/gone.md", base);
  assert.equal(typeof payload, "object");
  assert.equal("error" in payload, true);
  assert.equal("text" in payload, false);
});
