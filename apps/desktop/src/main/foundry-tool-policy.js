// Only implemented tools are activated. Add prep content tools here as their slices land.
export const TOOL_NAMES_BY_MODE = Object.freeze({
  combat: Object.freeze(["foundry_open", "world_status", "foundry_static_context", "foundry_play_context",
    "foundry_execute_action", "foundry_conditions_set"]),
  prep: Object.freeze(["foundry_open", "foundry_screenshot", "browser_evaluate", "world_status",
    "foundry_play_context", "foundry_conditions_set", "foundry_content_search", "foundry_compendium_browse", "foundry_advancement_plan", "foundry_actor_get", "foundry_actor_create",
    "foundry_actor_update", "foundry_actor_grant_items", "foundry_actor_advance", "foundry_scene_get", "foundry_scene_apply", "foundry_image", "request_user_input", "open_document",
    "web_search"]),
});

/** Explicit Desktop opt-in. The SDK's four default actions remain unchanged. */
export const DESKTOP_FOUNDRY_ACTIONS = /** @type {const} */ ([
  "worldInfo", "battleContext", "turnContext", "executeTurn",
  "staticContext", "playContext", "executeAction", "conditionsSet",
  "contentSearch", "advancementPlan", "compendiumBrowse",
  "actorRead", "actorCreate", "actorEdit", "actorGrantItems", "actorAdvance",
  "sceneRead", "sceneApply", "imageApply",
]);

/**
 * Pi built-ins for prep. The coding quartet plus the read-only trio
 * (grep/find/ls) for searching the prep directory without shelling out.
 * Pi 默认仍启用 Bash；Windows 必须显式选择一等公民的 PowerShell 工具。
 */
export function builtinToolNamesForPlatform(platform = process.platform) {
  return ["read", platform === "win32" ? "powershell" : "bash", "edit", "write", "grep", "find", "ls"];
}

export function activeToolNames(mode, platform = process.platform) {
  const names = TOOL_NAMES_BY_MODE[mode];
  if (!names) throw new Error(`Unknown tool mode: ${mode}`);
  return mode === "prep" ? [...names, ...builtinToolNamesForPlatform(platform)] : [...names];
}

/**
 * 池感知激活表：web_search 在 allowlist 里是静态成员，但只有工具池（已配置
 * 联网搜索）真的构造出它时才激活；session 创建与策略测试共用本判定。
 */
export function activeToolNamesForPool(mode, pool, platform = process.platform) {
  const names = activeToolNames(mode, platform);
  const hasWebSearch = (pool ?? []).some((tool) => tool?.name === "web_search");
  return hasWebSearch ? names : names.filter((name) => name !== "web_search");
}

export function verifyActiveTools(session, expected) {
  const actual = session.getActiveToolNames();
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Tool activation mismatch: expected ${expected.join(", ")}; received ${actual.join(", ")}`);
  }
}
