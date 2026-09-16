// Only implemented tools are activated. Add prep content tools here as their slices land.
export const TOOL_NAMES_BY_MODE = Object.freeze({
  combat: Object.freeze(["foundry_open", "world_status", "browser_evaluate", "combat_battle_context",
    "combat_turn_context", "combat_execute_turn", "request_user_input", "open_document"]),
  prep: Object.freeze(["foundry_open", "foundry_screenshot", "browser_evaluate", "world_status",
    "foundry_play_context", "foundry_conditions_set", "foundry_content_search", "foundry_compendium_browse", "foundry_advancement_plan", "foundry_actor_get", "foundry_actor_create",
    "foundry_actor_update", "foundry_actor_grant_items", "foundry_actor_advance", "foundry_scene_get", "foundry_scene_apply", "foundry_image", "request_user_input", "open_document"]),
});

/** Explicit Desktop opt-in. The SDK's four default actions remain unchanged. */
export const DESKTOP_FOUNDRY_ACTIONS = /** @type {const} */ ([
  "worldInfo", "battleContext", "turnContext", "executeTurn",
  "staticContext", "playContext", "executeAction", "conditionsSet",
  "contentSearch", "advancementPlan", "compendiumBrowse",
  "actorRead", "actorCreate", "actorEdit", "actorGrantItems", "actorAdvance",
  "sceneRead", "sceneApply", "imageApply",
]);

export function activeToolNames(mode, platform = process.platform) {
  const names = TOOL_NAMES_BY_MODE[mode];
  if (!names) throw new Error(`Unknown tool mode: ${mode}`);
  return mode === "prep" ? [...names, "read", platform === "win32" ? "powershell" : "bash", "edit", "write"] : [...names];
}

export function verifyActiveTools(session, expected) {
  const actual = session.getActiveToolNames();
  if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Tool activation mismatch: expected ${expected.join(", ")}; received ${actual.join(", ")}`);
  }
}
