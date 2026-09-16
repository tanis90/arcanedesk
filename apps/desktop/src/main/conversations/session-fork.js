import { SessionManager } from "@earendil-works/pi-coding-agent";

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 整段分叉交给 Pi 原生 forkFrom：新会话 id、header 写 parentSession 谱系、cwd 重写、
 * 全部非 header entries 原样复制（模式标记、标题、model_change 随之继承），立即落盘。
 * 不手动复制文件——那会撞会话 id、丢谱系。
 * @param {{sourcePath: string, cwd: string, sessionDir: string}} target
 * @returns {{id: string, path: string}} 新会话的 id 与文件路径
 */
export function forkStoredSession({ sourcePath, cwd, sessionDir }) {
  try {
    const manager = SessionManager.forkFrom(sourcePath, cwd, sessionDir);
    return { id: manager.getSessionId(), path: manager.getSessionFile() };
  } catch (error) {
    // 底层 fs 错误码（EPERM/ENOTDIR/ENOSPC…）不属于 IPC 契约，统一归一；
    // 原始信息保留在 message 文本里。
    throw fail("SESSION_FORK_FAILED", error.message);
  }
}
