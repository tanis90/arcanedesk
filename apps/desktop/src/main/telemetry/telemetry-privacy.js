// 遥测隐私合同(客户端方案 §3.2/§17):任何事件落盘前递归扫描 key,
// 命中禁列即拒绝——这是第一道闸,服务端禁列扫描是第二道,两份清单必须一致。
const FORBIDDEN_KEYS = new Set([
  "prompt",
  "message",
  "text",
  "thinking",
  "args",
  "result",
  "command",
  "stdout",
  "stderr",
  "path",
  "cwd",
  "url",
  "origin",
  "world",
  "actor",
  "token",
  "player",
  "audio",
  "image",
  "cookie",
  "apiKey",
]);

const MAX_DEPTH = 8;
const MAX_STRING_BYTES = 256;

/**
 * 递归扫描 value 的所有 object key,返回命中的第一个禁列 key,未命中返回 null。
 * 只看 key 不看值:值本身由事件工厂的类型合同约束。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string | null}
 */
export function findForbiddenKey(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
    if (FORBIDDEN_KEYS.has(key)) return key;
    const hit = findForbiddenKey((/** @type {Record<string, unknown>} */ (value))[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 事件可序列化断言:禁列 key、过深结构、非有限数字、超长字符串一律抛错。 */
export function assertEventSerializable(event) {
  const hit = findForbiddenKey(event);
  if (hit) throw new Error(`telemetry: forbidden key "${hit}" in event`);
  checkValue(event, 0);
}

function checkValue(value, depth) {
  if (depth > MAX_DEPTH) throw new Error("telemetry: event nesting too deep");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("telemetry: non-finite number in event");
  }
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    throw new Error("telemetry: string exceeds 256 bytes");
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    checkValue(item, depth + 1);
  }
}
