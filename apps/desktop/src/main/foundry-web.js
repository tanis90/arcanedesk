import { PAGE_PROFILES, matchPageProfile } from "./page-profiles.js";

const DEFAULT_EVALUATE_TIMEOUT_MS = 10_000;

function errorMessage(error) {
  return error?.message ?? String(error);
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
        if (signal?.aborted) { return undefined; }
        return webContents.executeJavaScript(code, true);
      })
      .then(
        (value) => { finish({ status: "completed", value }); },
        (error) => { finish({ status: "error", error: errorMessage(error) }); }
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
    // 原始信号,档位语义(检测/就绪)由 decoratePageState 按页面档位裁决:
    // mtcompat 页面 pre-bootstrap 就有 window.game,Foundry 的 detected 公式
    // 对它不适用(反之 Keycloak 登录页两者都没有)。
    hasGame: Boolean(g),
    mtReady: Boolean(window.__MT_READY__),
    runtimeReady: Boolean(detected && path === '/game' && g?.ready && g?.user?.isGM),
    hasJoinForm,
    hasSetup,
    detected,
  };
})()`;

/**
 * 把页面内巡检的原始信号裁决成档位结论:state.profile 记页面属于哪档;
 * 非 Foundry 档按各自 profile 重算 detected/runtimeReady(Foundry 档逐字段
 * 原样保留 —— 与引入 profile 抽象之前完全一致)。
 * URL 模式命中优先(URL 是最强证据);未命中时用调用方给的 profileId
 * (打开/加载流程知道目标是什么档;Keycloak 登录跳转的 URL 不再匹配 play.html,
 * 但它仍属于那次 mtcompat 打开);两者都没有才回落 Foundry 开放默认档。
 * @param {any} state 页面内表达式返回的原始信号
 * @param {{ profileId?: string }} [options]
 */
export function decoratePageState(state, options = {}) {
  if (!state || typeof state !== "object") return state;
  const urlMatched = matchPageProfile(state.url);
  const fallbackId = urlMatched
    ? urlMatched.id
    : PAGE_PROFILES[options.profileId ?? ""]?.id ?? PAGE_PROFILES.foundry.id;
  const profile = PAGE_PROFILES[fallbackId];
  if (profile.id === PAGE_PROFILES.foundry.id) return { ...state, profile: profile.id };
  const detected = profile.detect(state);
  return { ...state, profile: profile.id, detected, runtimeReady: profile.isReady(state) };
}

/**
 * @param {any} webContents
 * @param {{ timeoutMs?: number, signal?: AbortSignal, profileId?: string }} [options]
 */
export async function readFoundryPageState(
  webContents,
  options = /** @type {{ timeoutMs?: number, signal?: AbortSignal, profileId?: string }} */ ({})
) {
  const outcome = await evaluateNavigationSafe(webContents, PAGE_STATE_EXPRESSION, {
    timeoutMs: options.timeoutMs ?? 3_000,
    signal: options.signal,
  });
  if (outcome.status === "completed") {
    return { ok: true, state: decoratePageState(outcome.value, options) };
  }
  return { ok: false, ...outcome };
}
