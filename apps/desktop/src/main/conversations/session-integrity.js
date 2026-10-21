import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

/**
 * 会话链完整性守卫。
 *
 * Pi 的 SessionManager 追加条目时先推进内存 leafId 再落盘；落盘一抛
 * （序列化失败、磁盘满、EPIPE…），后续条目的 parentId 就会指向一个
 * 从未写入磁盘的幻影条目。重启后 buildSessionPath 从 leaf 沿 parentId
 * 回溯，遇到缺失节点**静默截断**——断点之前的整段历史在 UI 与模型
 * 上下文里同时消失（2026-10-21 环形 details 事故的实际形态）。
 *
 * 本模块在打开会话前检测并就地修复：Pi 严格按追加序写文件，健康文件里
 * 第 i 行的 parentId 就是第 i-1 行的 id，因此缺失条目的位置与父节点都能
 * 唯一重建。若缺失处前一条是带悬空 toolCall 的 assistant 消息，补一条
 * isError 的 toolResult（否则模型上下文带悬空调用，provider 会拒收）；
 * 其余情况补 arcane.chain-repair 占位条目，只负责把链接回。
 */

const isMessage = (entry, role) => entry?.type === "message" && entry.message?.role === role;

function parseLines(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line)); // 解析失败交给调用方按"不修"处理
  }
  return entries;
}

/** 文件中所有 toolResult 的 toolCallId 集合。 */
function resultedCallIds(entries) {
  const ids = new Set();
  for (const entry of entries) if (isMessage(entry, "toolResult") && entry.message.toolCallId) ids.add(entry.message.toolCallId);
  return ids;
}

function midTimestamp(prev, next) {
  const a = Date.parse(prev?.timestamp ?? ""), b = Date.parse(next?.timestamp ?? "");
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) return new Date((a + b) / 2).toISOString();
  return next?.timestamp ?? new Date().toISOString();
}

function placeholderEntry(id, parentId, timestamp, entries) {
  const prev = entries.find(entry => entry.id === parentId) ?? null;
  if (isMessage(prev, "assistant")) {
    const resulted = resultedCallIds(entries);
    const call = (Array.isArray(prev.message.content) ? prev.message.content : [])
      .find(part => part?.type === "toolCall" && part.id && !resulted.has(part.id));
    if (call) {
      return {
        type: "message", id, parentId, timestamp,
        message: {
          role: "toolResult", toolCallId: call.id, toolName: call.name ?? "unknown",
          content: [{ type: "text", text: "[结果缺失] 该工具调用的结果因持久化失败未能写入会话记录，原始内容不可恢复。相关数据请重新查询。" }],
          isError: true, timestamp: Date.parse(timestamp) || Date.now(),
        },
      };
    }
  }
  return { type: "custom", customType: "arcane.chain-repair", data: { reason: "missing-parent" }, id, parentId, timestamp };
}

/**
 * 检测并修复 sessionPath 的链断裂。
 * @param {string} sessionPath
 * @param {{log?: (line: string) => void}} [options]
 * @returns {{repaired: boolean, inserted: number, reason?: string}}
 */
export function ensureSessionChainIntact(sessionPath, { log } = {}) {
  let entries;
  try {
    entries = parseLines(readFileSync(sessionPath, "utf8"));
  } catch (error) {
    log?.(`[session-integrity] skip ${sessionPath}: ${error.message}`);
    return { repaired: false, inserted: 0, reason: "unreadable" };
  }
  const repaired = [];
  // 每轮修第一个断点；断点可能连续多个（连续多次落盘失败）。
  for (let pass = 0; pass < 16; pass++) {
    const ids = new Set(entries.map(entry => entry.id));
    const index = entries.findIndex(entry => entry.type !== "session" && entry.parentId && !ids.has(entry.parentId));
    if (index < 0) break;
    const child = entries[index];
    // 追加序不变式：缺失条目的父节点就是文件里它的前一行。
    const prev = entries.slice(0, index).reverse().find(entry => entry.type !== "session") ?? null;
    const entry = placeholderEntry(child.parentId, prev?.id ?? null, midTimestamp(prev, child), entries);
    entries.splice(index, 0, entry);
    repaired.push(entry);
  }
  if (!repaired.length) return { repaired: false, inserted: 0 };
  // 修完仍有断点（超过轮次上限）就不写盘，避免半修状态覆盖现场。
  const ids = new Set(entries.map(entry => entry.id));
  if (entries.some(entry => entry.type !== "session" && entry.parentId && !ids.has(entry.parentId))) {
    log?.(`[session-integrity] ${sessionPath}: chain still broken after repair passes, left untouched`);
    return { repaired: false, inserted: 0, reason: "unfixable" };
  }
  const backup = `${sessionPath}.chain-repair.bak`;
  if (!existsSync(backup)) writeFileSync(backup, readFileSync(sessionPath));
  const tmp = `${sessionPath}.chain-repair.tmp`;
  writeFileSync(tmp, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  renameSync(tmp, sessionPath);
  log?.(`[session-integrity] repaired ${repaired.length} missing entr${repaired.length === 1 ? "y" : "ies"} in ${sessionPath}`);
  return { repaired: true, inserted: repaired.length };
}
