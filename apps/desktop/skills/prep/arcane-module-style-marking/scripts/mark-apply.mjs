#!/usr/bin/env node
/**
 * mark-apply.mjs — 通用 callout 标注:把人工判定的朗读段/边栏区间包成 Obsidian callout。
 *
 * 用法见 SKILL.md 第四步。数据 JSON 格式见 mark-data.example.json。
 * 三阶段,缺一不可:先全部断言(不过则一个文件都不写)→ 备份 + 从底部往上写入 →
 * 剥除 callout 与备份逐行比对。
 *
 * 运行(用 ArcaneDesk 注入的 ARCANE_FVTT_NODE,或直接 node):
 *   node mark-apply.mjs <资料库根目录> <数据json路径> [--chapter-dir 章节] [--quote-header ...] [--sidebar-header ...]
 */
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

let libPath = null;
let dataPath = null;
let chapterDirName = "章节";
let quoteHeader = "> [!quote] 📖 朗读";
let sidebarHeader = "> [!example] 🎲 DM 设计思路";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--chapter-dir") chapterDirName = argv[++i];
  else if (argv[i] === "--quote-header") quoteHeader = argv[++i];
  else if (argv[i] === "--sidebar-header") sidebarHeader = argv[++i];
  else if (!libPath) libPath = argv[i];
  else if (!dataPath) dataPath = argv[i];
  else { console.error(`unexpected argument: ${argv[i]}`); process.exit(2); }
}
if (!libPath || !dataPath) {
  console.error("usage: mark-apply.mjs <资料库根目录> <数据json路径> [--chapter-dir 章节] [--quote-header ...] [--sidebar-header ...]");
  process.exit(2);
}

const fail = (message) => { console.error(message); process.exit(1); };
/** 读章节文件成行:BOM 剥掉,\r?\n 都认。 */
const readLines = (p) => readFileSync(p, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const chapterDir = path.join(libPath, chapterDirName);
const data = JSON.parse(readFileSync(dataPath, "utf8").replace(/^\uFEFF/, ""));

// ---------- 阶段一:解析 + 全部断言(不过则一个文件都不写) ----------
/** @type {Map<string, Array<{start: number, end: number, header: string}>>} */
const editsPerFile = new Map();
const addEdit = (fname, edit) => {
  if (!editsPerFile.has(fname)) editsPerFile.set(fname, []);
  editsPerFile.get(fname).push(edit);
};

for (const [fname, marks] of Object.entries(data.readaloud ?? {})) {
  const lines = readLines(path.join(chapterDir, `${fname}.md`));
  for (const m of marks) {
    const s = Number(m[0]), e = Number(m[1]), expect = String(m[2]);
    if (!(lines[s - 1] ?? "").startsWith(expect)) fail(`断言失败 ${fname}:${s} 应以「${expect}」开头,实际: ${(lines[s - 1] ?? "").slice(0, 20)}`);
    if (lines[e - 1].trim() === "") fail(`断言失败 ${fname}:${e} 结束行是空行`);
    if (s >= 2 && lines[s - 2].trim() !== "") fail(`断言失败 ${fname}:${s} 前一行非空(应为段落边界)`);
    if (e < lines.length && lines[e].trim() !== "") fail(`断言失败 ${fname}:${e} 后一行非空(应为段落边界)`);
    addEdit(fname, { start: s, end: e, header: quoteHeader });
  }
}

for (const [fname, sidebars] of Object.entries(data.sidebars ?? {})) {
  const lines = readLines(path.join(chapterDir, `${fname}.md`));
  for (const sb of sidebars) {
    const title = String(sb.t), n = Number(sb.n), after = String(sb.after);
    const heading = new RegExp(`^#+\\s*${escapeRegExp(title)}\\s*$`);
    const h = lines.findIndex(line => heading.test(line));
    if (h < 0) fail(`断言失败 ${fname} 找不到边栏标题「${title}」`);
    let j = h + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const bs = j;
    let seen = 0, be = -1, k = j;
    while (k < lines.length && seen < n) {
      if (lines[k].trim() !== "") {
        seen++;
        while (k < lines.length && lines[k].trim() !== "") k++;
        be = k - 1;
      } else k++;
    }
    if (seen < n) fail(`断言失败 ${fname}「${title}」正文不足 ${n} 段`);
    let m2 = be + 1;
    while (m2 < lines.length && lines[m2].trim() === "") m2++;
    const next = m2 < lines.length ? lines[m2] : null;
    if (after === "H") { if (!(next && next.startsWith("#"))) fail(`断言失败 ${fname}「${title}」之后应为标题,实际: ${next}`); }
    else if (after === "IMG") { if (!(next && next.startsWith("!["))) fail(`断言失败 ${fname}「${title}」之后应为插图,实际: ${next}`); }
    else if (after === "EOF") { if (next !== null) fail(`断言失败 ${fname}「${title}」之后应为文件尾,实际: ${next}`); }
    else if (!(next && next.startsWith(after))) fail(`断言失败 ${fname}「${title}」之后应以「${after}」开头,实际: ${next ? next.slice(0, 25) : "EOF"}`);
    addEdit(fname, { start: bs + 1, end: be + 1, header: sidebarHeader });
    console.log(`边栏定位: ${fname}「${title}」正文 L${bs + 1}-L${be + 1}`);
  }
}

for (const [fname, edits] of editsPerFile) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= sorted[i - 1].end) fail(`区间重叠: ${fname} L${sorted[i - 1].start}-${sorted[i - 1].end} vs L${sorted[i].start}-${sorted[i].end}`);
  }
}
console.log("阶段一通过:全部断言成立,区间无重叠");

// ---------- 阶段二:备份 + 从底部往上写入 ----------
const now = new Date();
const pad = (x) => String(x).padStart(2, "0");
const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const backup = path.join(libPath, "_备份", `章节-标记前-${ts}`);
cpSync(chapterDir, backup, { recursive: true });
console.log(`备份: ${backup}`);

for (const [fname, edits] of editsPerFile) {
  const file = path.join(chapterDir, `${fname}.md`);
  const lines = readLines(file);
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (const ed of sorted) {
    const block = [ed.header];
    for (let i = ed.start; i <= ed.end; i++) {
      const line = lines[i - 1];
      block.push(line.trim() === "" ? ">" : `> ${line}`);
    }
    lines.splice(ed.start - 1, ed.end - ed.start + 1, ...block);
  }
  writeFileSync(file, lines.join("\n"), "utf8");
}
console.log(`阶段二完成:已写入 ${editsPerFile.size} 个文件`);

// ---------- 阶段三:状态机剥除 callout,与备份逐行比对 ----------
// 只在 callout 块内剥 '> ' 前缀;块外的 '> ' 行(如导航引用行)不动。
let bad = 0;
for (const fname of editsPerFile.keys()) {
  const current = readLines(path.join(chapterDir, `${fname}.md`));
  const before = readLines(path.join(backup, `${fname}.md`));
  const stripped = [];
  let inCallout = false;
  for (const line of current) {
    if (/^> \[!(quote|example)\]/.test(line)) { inCallout = true; continue; }
    if (inCallout && line.startsWith(">")) stripped.push(line === ">" ? "" : line.slice(2));
    else { inCallout = false; stripped.push(line); }
  }
  const mismatch = before.length !== stripped.length || before.some((line, i) => line !== stripped[i]);
  if (mismatch) { console.error(`MISMATCH: ${fname}`); bad++; }
}
if (bad === 0) console.log("VERIFY OK: 剥除标记后全部文件与备份逐行一致,原文零改动");
else fail(`VERIFY FAILED: ${bad} 个文件`);
