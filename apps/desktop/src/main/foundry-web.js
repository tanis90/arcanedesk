import { retainResourceUntil } from "./scheduling/resource-coordinator.js";

const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

function errorMessage(error) {
  return error?.message ?? String(error);
}

/** Returns the raw operation's settlement callback, independent of tool timeouts. */
export function trackPageOperation(webContents) {
  let endExecution;
  const completion = new Promise(done => { endExecution = done; });
  if (!retainResourceUntil(completion)) return () => {};
  let navigationPending = false;
  let rawSettled = false;
  const navigationFailed = (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame === false) return;
    navigationPending = false;
    if (rawSettled) executionEnded();
  };
  const navigationStarted = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame !== false && !isInPlace) navigationPending = true;
  };
  const executionEnded = () => {
    webContents.off?.("did-start-navigation", navigationStarted);
    webContents.off?.("did-fail-load", navigationFailed);
    webContents.off?.("did-navigate", executionEnded);
    webContents.off?.("destroyed", executionEnded);
    webContents.off?.("render-process-gone", executionEnded);
    endExecution();
  };
  // A navigation request can fail while the old page is still executing.
  webContents.on?.("did-navigate", executionEnded);
  webContents.on?.("did-start-navigation", navigationStarted);
  webContents.on?.("did-fail-load", navigationFailed);
  webContents.on?.("destroyed", executionEnded);
  webContents.on?.("render-process-gone", executionEnded);
  return () => { rawSettled = true; if (!navigationPending) executionEnded(); };
}

/**
 * Execute page JavaScript without allowing a navigation or a lost renderer
 * context to leave the agent tool pending forever.
 *
 * Electron's executeJavaScript() can remain unresolved when the evaluated code
 * submits a form or reloads the page. A main-frame navigation is therefore a
 * successful terminal outcome of the evaluation, not something to await from
 * the old JavaScript context.
 * @param {any} webContents
 * @param {string} code
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export function evaluateNavigationSafe(
  webContents,
  code,
  { timeoutMs = DEFAULT_EVALUATE_TIMEOUT_MS, signal } = /** @type {{ timeoutMs?: number, signal?: AbortSignal }} */ ({})
) {
  if (!webContents || webContents.isDestroyed?.()) {
    return Promise.resolve({ status: "error", error: "Foundry panel is not available" });
  }
  if (signal?.aborted) return Promise.resolve({ status: "aborted" });

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const executionEnded = trackPageOperation(webContents);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      webContents.off?.("did-start-navigation", onNavigation);
      webContents.off?.("destroyed", onDestroyed);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const onNavigation = (_event, url, isInPlace, isMainFrame) => {
      if (isMainFrame === false || isInPlace) return;
      finish({ status: "navigated", url });
    };
    const onDestroyed = () => finish({ status: "error", error: "Foundry panel was closed" });
    const onAbort = () => finish({ status: "aborted" });

    webContents.on?.("did-start-navigation", onNavigation);
    webContents.on?.("destroyed", onDestroyed);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ status: "timeout", timeoutMs }), timeoutMs);

    // Attach both handlers immediately. Even when navigation wins the race, a
    // later rejection from the abandoned renderer context must not become an
    // unhandled rejection.
    Promise.resolve()
      .then(() => {
        if (signal?.aborted) { executionEnded(); return undefined; }
        return webContents.executeJavaScript(code, true);
      })
      .then(
        (value) => { executionEnded(); finish({ status: "completed", value }); },
        (error) => { executionEnded(); finish({ status: "error", error: errorMessage(error) }); }
      );
  });
}

const PAGE_STATE_EXPRESSION = `(() => {
  const g = window.game;
  const title = document.title || "";
  const path = location.pathname;
  const hasJoinForm = Boolean(document.querySelector('#join-game-form, #join-game'));
  const hasSetup = Boolean(document.querySelector('#setup, #setup-packages, #worlds-list'));
  const detected = Boolean(g || hasJoinForm || hasSetup || /Foundry Virtual Tabletop/i.test(title));
  return {
    url: location.href,
    path,
    title,
    ready: Boolean(g?.ready),
    gm: Boolean(g?.user?.isGM),
    user: g?.user?.name ?? null,
    world: g?.world?.id ?? null,
    worldTitle: g?.world?.title ?? null,
    system: g?.system?.id ?? null,
    systemVersion: g?.system?.version ?? null,
    foundryVersion: g?.version ?? null,
    runtimeReady: Boolean(detected && path === '/game' && g?.ready && g?.user?.isGM),
    hasJoinForm,
    hasSetup,
    detected,
  };
})()`;

/**
 * @param {any} webContents
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function readFoundryPageState(
  webContents,
  options = /** @type {{ timeoutMs?: number, signal?: AbortSignal }} */ ({})
) {
  const outcome = await evaluateNavigationSafe(webContents, PAGE_STATE_EXPRESSION, {
    timeoutMs: options.timeoutMs ?? 3_000,
    signal: options.signal,
  });
  if (outcome.status === "completed") return { ok: true, state: outcome.value };
  return { ok: false, ...outcome };
}
