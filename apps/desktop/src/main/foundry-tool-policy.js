// Only implemented tools are activated. Add prep content tools here as their slices land.
export const TOOL_NAMES_BY_MODE = Object.freeze({
  combat: Object.freeze(["foundry_open", "world_status", "foundry_static_context", "foundry_play_context",
    "foundry_execute_action", "foundry_conditions_set", "request_user_input"]),
  prep: Object.freeze(["foundry_open", "foundry_screenshot", "browser_evaluate", "world_status",
    "foundry_play_context", "foundry_conditions_set", "foundry_content_search", "foundry_actor_get", "foundry_actor_create",
    "foundry_actor_update", "foundry_actor_grant_items", "request_user_input"]),
});

/** Explicit Desktop opt-in. The SDK's four default actions remain unchanged. */
export const DESKTOP_FOUNDRY_ACTIONS = /** @type {const} */ ([
  "worldInfo", "battleContext", "turnContext", "executeTurn",
  "staticContext", "playContext", "executeAction", "conditionsSet",
  "contentSearch",
  "actorRead", "actorCreate", "actorEdit", "actorGrantItems",
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
