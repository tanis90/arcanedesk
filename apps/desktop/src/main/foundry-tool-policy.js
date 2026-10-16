// Tool policy — 激活名单的单一出口，按「页面档位 × 模式」两维取表。
//
// 档位维度（A2 起）：档案词汇与页面档位同一份事实源（page-profiles.js 的
// PAGE_PROFILES），机制语义是「页面档位决定策略面」——foundry 档（开放默认档）
// 行为必须与引入档位维度之前逐字节一致；mtcompat 档的策略面独立成表，A3 在其上
// 放 pageEval（foundry_page_eval，只进 mtcompat 备团档）。归一规则：词汇表外的 id
// （含 undefined/null）落开放默认档。
import { PAGE_PROFILES } from "./page-profiles.js";

/** foundry 档（开放默认档）工具面。改这张表前先想清楚 mtcompat 档要不要跟。 */
export const TOOL_NAMES_BY_MODE = Object.freeze({
  combat: Object.freeze(["foundry_open", "world_status", "foundry_static_context", "foundry_play_context",
    "foundry_execute_action", "foundry_conditions_set"]),
  prep: Object.freeze(["foundry_open", "foundry_screenshot", "browser_evaluate", "world_status",
    "foundry_play_context", "foundry_conditions_set", "foundry_content_search", "foundry_compendium_browse", "foundry_advancement_plan", "foundry_actor_get", "foundry_actor_create",
    "foundry_actor_update", "foundry_actor_grant_items", "foundry_actor_advance", "foundry_scene_get", "foundry_scene_apply", "foundry_image", "request_user_input", "open_document",
    "web_search"]),
});

/**
 * mtcompat 档工具面：独立成表（不是 foundry 表的别名）——A3 的 pageEval 只进这张表，
 * foundry 档不受影响。A3 起与 foundry 面的唯一分叉是备团的 foundry_page_eval：
 * 备团是「typed action 铺不满、eval 兜底」的主战场（PRD §2.5 规则 1），战斗模式保持
 * 纯 typed 面（与 foundry 档战斗档不给 eval 同理：任意代码执行在战斗中段的爆炸半径
 * 不可控，需要兜底时先出战斗再补）。
 */
const MTCOMPAT_TOOL_NAMES_BY_MODE = Object.freeze({
  combat: Object.freeze(["foundry_open", "world_status", "foundry_static_context", "foundry_play_context",
    "foundry_execute_action", "foundry_conditions_set"]),
  prep: Object.freeze(["foundry_open", "foundry_screenshot", "browser_evaluate", "foundry_page_eval", "world_status",
    "foundry_play_context", "foundry_conditions_set", "foundry_content_search", "foundry_compendium_browse", "foundry_advancement_plan", "foundry_actor_get", "foundry_actor_create",
    "foundry_actor_update", "foundry_actor_grant_items", "foundry_actor_advance", "foundry_scene_get", "foundry_scene_apply", "foundry_image", "request_user_input", "open_document",
    "web_search"]),
});

export const TOOL_NAMES_BY_PROFILE = Object.freeze({
  [PAGE_PROFILES.foundry.id]: TOOL_NAMES_BY_MODE,
  [PAGE_PROFILES.mtcompat.id]: MTCOMPAT_TOOL_NAMES_BY_MODE,
});

/** 开放默认档 id：档位归一与旧调用方的共同落点。 */
export const DEFAULT_POLICY_PROFILE = PAGE_PROFILES.foundry.id;
export const MTCOMPAT_POLICY_PROFILE = PAGE_PROFILES.mtcompat.id;

/** 档位 id 归一：只认页面档位词汇表里的 id，其余（含 undefined/null/笔误）落开放默认档。 */
export function normalizePolicyProfile(profileId) {
  return typeof profileId === "string" && Object.hasOwn(PAGE_PROFILES, profileId)
    ? profileId
    : DEFAULT_POLICY_PROFILE;
}

/** Explicit Desktop opt-in. The SDK's four default actions remain unchanged. */
export const DESKTOP_FOUNDRY_ACTIONS = /** @type {const} */ ([
  "worldInfo", "battleContext", "turnContext", "executeTurn",
  "staticContext", "playContext", "executeAction", "conditionsSet",
  "contentSearch", "advancementPlan", "compendiumBrowse",
  "actorRead", "actorCreate", "actorEdit", "actorGrantItems", "actorAdvance",
  "sceneRead", "sceneApply", "imageApply",
]);

/**
 * mtcompat 档 client 的 runtime 动作白名单（A3）：foundry 面 + pageEval。
 * pageEval 是 arcaneVTT 侧 runtime 的兜底 eval action（PRD §3.1），不在 SDK 的 foundry
 * 契约（ALL_DIRECT_ACTIONS）里——只随 mtcompat client 装配，foundry 档 client 的白名单
 * 与行为逐字不变。宿主侧 GM 门（requireGM 默认 true）与中断语义走 SDK 既有路径。
 */
export const MTCOMPAT_RUNTIME_ACTIONS = /** @type {const} */ ([...DESKTOP_FOUNDRY_ACTIONS, "pageEval"]);

/**
 * Pi built-ins for prep. The coding quartet plus the read-only trio
 * (grep/find/ls) for searching the prep directory without shelling out.
 * Pi 默认仍启用 Bash；Windows 必须显式选择一等公民的 PowerShell 工具。
 */
export function builtinToolNamesForPlatform(platform = process.platform) {
  return ["read", platform === "win32" ? "powershell" : "bash", "edit", "write", "grep", "find", "ls"];
}

function toolNamesFor(profileId, mode, platform) {
  const names = TOOL_NAMES_BY_PROFILE[normalizePolicyProfile(profileId)]?.[mode];
  if (!names) throw new Error(`Unknown tool mode: ${mode}`);
  return mode === "prep" ? [...names, ...builtinToolNamesForPlatform(platform)] : [...names];
}

/** 指定档位 × 模式的激活名单（旧调用方走下面的 activeToolNames，档位固定开放默认档）。 */
export function activeToolNamesForProfile(mode, profileId, platform = process.platform) {
  return toolNamesFor(profileId, mode, platform);
}

export function activeToolNames(mode, platform = process.platform) {
  return toolNamesFor(DEFAULT_POLICY_PROFILE, mode, platform);
}

/**
 * 池感知激活表：web_search 在 allowlist 里是静态成员，但只有工具池（已配置
 * 联网搜索）真的构造出它时才激活；session 创建与策略测试共用本判定。
 */
export function activeToolNamesForPoolInProfile(mode, pool, profileId, platform = process.platform) {
  const names = activeToolNamesForProfile(mode, profileId, platform);
  const hasWebSearch = (pool ?? []).some((tool) => tool?.name === "web_search");
  return hasWebSearch ? names : names.filter((name) => name !== "web_search");
}

export function activeToolNamesForPool(mode, pool, platform = process.platform) {
  return activeToolNamesForPoolInProfile(mode, pool, DEFAULT_POLICY_PROFILE, platform);
}

export function verifyActiveTools(session, expected) {
  const actual = session.getActiveToolNames();
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Tool activation mismatch: expected ${expected.join(", ")}; received ${actual.join(", ")}`);
  }
}
