// Arcane 会话模式直接落在 Pi 原生存储中：
// 1. combat / prep 各用独立 sessionDir，目录就是主要隔离边界；
// 2. 每个 JSONL 带一个不进入 LLM 上下文的 custom entry，移动/导入时仍可自证模式。
// 不再维护 path -> mode 的外部 sidecar。
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const ARCANE_SESSION_MARKER = "arcane.session";
export const ARCANE_SESSION_SCHEMA_VERSION = 1;

export class SessionModeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionModeError";
    this.code = code;
  }
}

export function assertSessionMode(mode) {
  if (mode !== "combat" && mode !== "prep") {
    throw new SessionModeError("INVALID_SESSION_MODE", `无效的会话模式:${mode}`);
  }
  return mode;
}

/**
 * 使用 Pi agentDir 下的两个直接子目录。Pi 的 listAll() 会扫描 sessions 的直接
 * 子目录，因此这种布局既隔离模式，也不让会话从 Pi 自己的全局列表中消失。
 */
export function sessionDirForMode(agentDir, mode) {
  return path.join(path.resolve(agentDir), "sessions", `arcane-desktop-${assertSessionMode(mode)}`);
}

function canonicalPath(input) {
  const resolved = path.resolve(String(input ?? ""));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** 对已经规范化的路径做纯结构判断；pathApi 让 Win/POSIX 语义可独立验证。 */
export function isDescendantPath(pathApi, root, candidate) {
  const relative = pathApi.relative(root, candidate);
  return Boolean(
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

/** 候选必须是 root 的后代；兼容盘符、UNC、POSIX 路径和软链接。 */
export function isPathInside(root, candidate) {
  return isDescendantPath(path, canonicalPath(root), canonicalPath(candidate));
}

/** 从 Pi SessionManager 的 custom entries 读取 Arcane 固有模式。 */
export function readSessionMode(sessionManager) {
  const markers = sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === ARCANE_SESSION_MARKER);
  if (markers.length === 0) return null;

  const modes = new Set();
  for (const marker of markers) {
    const data = marker.data;
    const mode = data && typeof data === "object" ? data.mode : undefined;
    const schemaVersion = data && typeof data === "object" ? data.schemaVersion : undefined;
    if ((mode !== "combat" && mode !== "prep") || schemaVersion !== ARCANE_SESSION_SCHEMA_VERSION) {
      throw new SessionModeError("INVALID_SESSION_MARKER", "会话包含无效的 Arcane 模式标记");
    }
    modes.add(mode);
  }
  if (modes.size !== 1) {
    throw new SessionModeError("CONFLICTING_SESSION_MARKERS", "会话包含互相冲突的 Arcane 模式标记");
  }
  return modes.values().next().value;
}

/**
 * 新 SessionManager 在 Pi 首次 assistant 消息前尚未创建 JSONL；此时把 marker
 * 追加到内存树，首次落盘会与 header/消息写进同一个文件。已有文件必须自带
 * marker，绝不根据所在目录静默认领，避免导入/误放后污染另一模式。
 */
export function claimSessionMode(sessionManager, expectedMode) {
  const mode = assertSessionMode(expectedMode);
  const actual = readSessionMode(sessionManager);
  if (actual) {
    if (actual !== mode) {
      throw new SessionModeError(
        "SESSION_MODE_MISMATCH",
        `会话属于 ${actual} 模式，不能由 ${mode} 模式打开`
      );
    }
    return actual;
  }

  const sessionFile = sessionManager.getSessionFile?.();
  if (sessionFile && existsSync(sessionFile)) {
    throw new SessionModeError("SESSION_MODE_MISSING", "已有会话缺少 Arcane 模式标记");
  }
  sessionManager.appendCustomEntry(ARCANE_SESSION_MARKER, {
    mode,
    schemaVersion: ARCANE_SESSION_SCHEMA_VERSION,
  });
  return mode;
}
