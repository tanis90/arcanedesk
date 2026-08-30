// config-dir — app 自有 JSON 的统一存放处:userData/config/。
// 业务代码只认新路径;历史散落在 userData 根目录的 arcane-*.json
// 由 migrateLegacyConfig() 在启动时一次性 rename 搬进来(原型期临时逻辑,稳定后可删)。
import { app } from "electron";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

export function configDir() {
  const dir = path.join(app.getPath("userData"), "config");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(name) {
  return path.join(configDir(), name);
}

/** 启动时把 userData 根目录的 arcane-<name> 一次性搬进 config/<name>(目标已存在则不覆盖)。 */
export function migrateLegacyConfig(names) {
  const root = app.getPath("userData");
  for (const name of names) {
    const from = path.join(root, `arcane-${name}`);
    const to = configPath(name);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
      console.log(`[config] migrated arcane-${name} -> config/${name}`);
    } catch (error) {
      console.log(`[config] migrate arcane-${name} failed:`, error.message);
    }
  }
}
