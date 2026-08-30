// 任务分类 v1(客户端方案 §11):确定性规则,按工具路径识别任务,不读 prompt。
export const TASK_TAXONOMY_VERSION = 2;
export const SUMMARY_VERSION = 1;

/** 工具名/内置名 -> tool family(§7.3 映射表)。 */
export function toolFamily(toolName) {
  switch (String(toolName ?? "")) {
    case "foundry_open":
      return "foundry.open";
    case "browser_evaluate":
      return "foundry.diagnose";
    case "foundry_screenshot":
      return "foundry.visual_inspect";
    case "world_status":
      return "world.inspect";
    case "combat_battle_context":
      return "combat.battle_context";
    case "combat_turn_context":
      return "combat.turn_context";
    case "combat_execute_turn":
      return "combat.execute";
    case "read":
      return "filesystem.read";
    case "write":
    case "edit":
      return "filesystem.write";
    case "bash":
      return "terminal.execute";
    default:
      return "other";
  }
}

/** side effect 分级(§7.3 表)。 */
export function sideEffectClass(toolName) {
  switch (toolFamily(toolName)) {
    case "foundry.open":
      return "navigation";
    case "combat.execute":
      return "world_write";
    case "filesystem.write":
      return "filesystem_write";
    case "foundry.diagnose":
    case "terminal.execute":
    case "other":
      return "unknown";
    default:
      return "read";
  }
}

/** fixed runtime action -> action family。 */
export function actionFamily(action) {
  switch (String(action ?? "")) {
    case "worldInfo":
      return "world_info";
    case "battleContext":
      return "battle_context";
    case "turnContext":
      return "turn_context";
    case "executeTurn":
      return "execute_turn";
    default:
      return "other";
  }
}

/**
 * 任务分类(§11 规则,按优先级匹配)。shape 是 [{family, count}] 有序序列,
 * receipts 是 execute_turn 的四态回执序列。combat.recover_uncertain 要求
 * 出现过 partial/indeterminate 且其后重新读取了 turn context(顺序敏感)。
 */
export function classifyTask({ shape, receipts = [] }) {
  const has = (family) => shape.some((s) => s.family === family);

  const sawUncertain = receipts.some((r) => r === "partial" || r === "indeterminate");
  const rereadAfterUncertain = sawUncertain && has("combat.execute") && has("combat.turn_context") &&
    shape.findLastIndex((s) => s.family === "combat.turn_context") > shape.findIndex((s) => s.family === "combat.execute");

  if (rereadAfterUncertain) return "combat.recover_uncertain";
  if (has("combat.execute")) return "combat.execute_action";
  if (has("combat.battle_context") || has("combat.turn_context")) return "combat.inspect";
  if (has("foundry.diagnose") || has("foundry.visual_inspect")) return "world.diagnose";
  if (has("world.inspect")) return "world.inspect";
  if (has("foundry.open")) return "world.open";
  if (has("filesystem.write")) {
    return has("terminal.execute") ? "prep.execute_and_verify" : "prep.mutate_files";
  }
  if (has("filesystem.read")) return "prep.read_only";
  return "other";
}
