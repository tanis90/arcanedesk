// PrepStore — 备团模式配置持久化,照抄 VoiceStore 的模式。
// 数据存在 userData/config/prep.json。目前只有一个字段:lastCwd(备团工作目录)。
// lastCwd 是"站位"不是"围栏":决定内置工具的初始目录、AGENTS.md/skills 扫描、
// Pi 会按 header.cwd 过滤 prep sessionDir。持久化前取 realpath，避免软链接或
// 不同路径拼写让同一项目裂成两组会话。
import { realpathSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { I18nError } from "./i18n-error.mjs";

export function canonicalPrepCwd(dir) {
  const value = String(dir ?? "").trim();
  if (!value) return null;
  try {
    if (!statSync(value).isDirectory()) return null;
    return realpathSync.native(value);
  } catch {
    return null;
  }
}

export class PrepStore {
  constructor(filePath, log = console.log) {
    this.filePath = filePath;
    this.log = log;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      // 目录已不存在:当作没存过,避免 agent 落进幽灵目录
      return { lastCwd: canonicalPrepCwd(parsed.lastCwd) };
    } catch {
      return { lastCwd: null };
    }
  }

  save() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  setCwd(dir) {
    const cwd = canonicalPrepCwd(dir);
    if (!cwd) throw new I18nError("err.prep.invalidDir", { dir });
    this.data.lastCwd = cwd;
    this.save();
    return cwd;
  }
}
