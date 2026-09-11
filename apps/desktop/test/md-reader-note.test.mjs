import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NOTE_MAX_BYTES,
  hasNoteExtension,
  loadNotePayload,
  normalizeNotePath,
  readNote,
  reloadNotePayload,
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

// ---------- §7 围栏的符号链接复检(N1) ----------

test("resolveNote rejects a junction/symlink inside the base that points outside (N1)", (t) => {
  const base = workspace(t);
  const outside = mkdtempSync(path.join(tmpdir(), "arcane-md-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "secret.md"), "# secret", "utf8");
  const link = path.join(base, "notes", "link");
  try {
    // junction 在 Windows 上不需要管理员权限;POSIX 走 dir symlink
    symlinkSync(outside, link, IS_WIN ? "junction" : "dir");
  } catch (error) {
    return t.skip(`symlink not permitted here: ${error.code ?? error.message}`);
  }
  // 词法上 "notes/link/secret.md" 在 base 内;真实路径已逃逸
  assert.equal(resolveNote("notes/link/secret.md", base).reason, "outside");
  assert.equal(loadNotePayload("notes/link/secret.md", base).error, "outside");
});

test("resolveNote still accepts a note under a junction that stays inside the base", (t) => {
  const base = workspace(t);
  mkdirSync(path.join(base, "real"), { recursive: true });
  writeFileSync(path.join(base, "real", "npc.md"), "# NPC", "utf8");
  try {
    symlinkSync(path.join(base, "real"), path.join(base, "notes", "alias"), IS_WIN ? "junction" : "dir");
  } catch (error) {
    return t.skip(`symlink not permitted here: ${error.code ?? error.message}`);
  }
  // 内部 junction 不构成逃逸:base 与 target 取 realpath 后仍在内部
  const resolved = resolveNote("notes/alias/npc.md", base);
  assert.equal(resolved.ok, true);
});

test("resolveNote falls back to the missing flow when realpath fails on a nonexistent note", (t) => {
  const base = workspace(t);
  // 文件不存在 → realpath 抛错 → 不能崩,也不能误判 outside:readNote 报 missing
  const resolved = resolveNote("notes/gone.md", base);
  assert.equal(resolved.ok, true);
  assert.equal(loadNotePayload("notes/gone.md", base).error, "missing");
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

test("readNote strips a UTF-8 BOM so the first heading parses (N10)", (t) => {
  const base = workspace(t);
  const absolute = path.join(base, "notes", "bom.md");
  writeFileSync(absolute, "\uFEFF# 标题\n正文。", "utf8");
  const note = readNote(absolute);
  assert.equal(note.ok, true);
  assert.equal(note.text.startsWith("# 标题"), true);
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
  const payload = loadNotePayload("`notes/npc.md`", base);
  // absolute/baseDir 是 main 侧控制器快照用的(N4),页面拿到的副本由控制器剥掉
  assert.deepEqual(payload, {
    name: "npc.md",
    text: "# NPC",
    truncated: false,
    absolute: path.join(base, "notes", "npc.md"),
    baseDir: path.resolve(base),
  });
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

// ---------- reloadNotePayload:F5/① 恢复按打开时的基准复检(N4) ----------

test("reloadNotePayload re-reads the snapshot against its original base directory", (t) => {
  const base = workspace(t);
  const absolute = path.join(base, "notes", "npc.md");
  writeFileSync(absolute, "# v1", "utf8");
  const payload = reloadNotePayload(absolute, base);
  assert.deepEqual(payload, { name: "npc.md", text: "# v1", truncated: false });
  // 磁盘内容变了就拿到新内容:页面重载(devtools Ctrl+R)不靠缓存
  writeFileSync(absolute, "# v2", "utf8");
  assert.equal(reloadNotePayload(absolute, base).text, "# v2");
});

test("reloadNotePayload refuses a snapshot that no longer sits inside its base", (t) => {
  const base = workspace(t);
  const other = workspace(t); // 另一个"项目"的目录:同名文件但不是授权范围
  writeFileSync(path.join(other, "notes", "npc.md"), "# other project", "utf8");
  // 别的目录里的同名文件,拿当前 base 复检 = outside
  assert.deepEqual(reloadNotePayload(path.join(other, "notes", "npc.md"), base), { error: "outside" });
  // 基准目录没了 = 里面的笔记也随之不存在,按 missing 落到错误页
  const gone = path.join(base, "vanished");
  assert.deepEqual(reloadNotePayload(path.join(gone, "npc.md"), gone), { error: "missing" });
  // 快照里的文件被删了 = missing(交给错误页,不抛错)
  assert.deepEqual(reloadNotePayload(path.join(base, "notes", "gone.md"), base), { error: "missing" });
});
