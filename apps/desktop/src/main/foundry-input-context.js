import { evaluateNavigationSafe } from "./foundry-web.js";

// Read at admission, outside the write queue: selection must not drift while a task waits.
// This fixed expression reads identity only and has no Document or navigation side effects.
const INPUT_CONTEXT = `(() => {
  const game = globalThis.game, canvas = globalThis.canvas;
  if (!game?.ready || !game.user?.isGM) return null;
  return { world: { origin: location.origin, id: game.world?.id ?? null },
    sceneUuid: canvas?.scene?.uuid ?? null,
    selectedTokenUuids: (canvas?.tokens?.controlled ?? []).map(token => token.document?.uuid).filter(Boolean) };
})()`;

export async function captureFoundryInputContext(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return null;
  const result = await evaluateNavigationSafe(webContents, INPUT_CONTEXT, { timeoutMs: 3000 });
  if (result.status !== "completed" || !result.value?.world?.origin || !result.value?.world?.id) return null;
  return result.value;
}
