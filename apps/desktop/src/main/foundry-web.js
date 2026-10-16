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
    // mtcompat 页面的 runtime 指纹:页内直调桩(__MT_AGENT_RUNTIME__)或宿主装载源
    // (__MT_AGENT_RUNTIME_SOURCE__)任一在位即自证。识别以 URL 为主,这个指纹只做
    // mtcompat 档 isReady 的佐证(缺失 = 未佐证态,页面仍被识别)。
    hasMtAgentRuntime: Boolean(window.__MT_AGENT_RUNTIME_SOURCE__ || window.__MT_AGENT_RUNTIME__),
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

// 页面真源读取(A1 runtime 源页面优先):只取源串,不带档位语义 —— 采用与否由
// 调用方(main.js 的面板就绪路径)按 mtcompat 档与 hasMtAgentRuntime 决定。
const PAGE_RUNTIME_SOURCE_EXPRESSION = `(() => {
  const source = window.__MT_AGENT_RUNTIME_SOURCE__;
  return typeof source === "string" ? source : null;
})()`;

/**
 * 读面板页面自持的 runtime 源串(window.__MT_AGENT_RUNTIME_SOURCE__,PRD A1 的真源)。
 * 与 readFoundryPageState 同款防悬挂:evaluate 期间主框架导航/视图销毁都按失败收口,
 * 绝不把调用方挂死。
 *
 * ok:false 的语义分两类,调用方要区别对待:
 * - reason "absent":页面没有源(Foundry 页面/未装载 runtime 的页面)——正常路径;
 * - 其余(导航/超时/aborted/error):页面不可读,值得落日志。
 * @param {any} webContents
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, source: string } | { ok: false, reason: string, error?: string }>}
 */
export async function readPageAgentRuntimeSource(
  webContents,
  options = /** @type {{ timeoutMs?: number, signal?: AbortSignal }} */ ({})
) {
  const outcome = await evaluateNavigationSafe(webContents, PAGE_RUNTIME_SOURCE_EXPRESSION, {
    timeoutMs: options.timeoutMs ?? 3_000,
    signal: options.signal,
  });
  if (outcome.status !== "completed") {
    return { ok: false, reason: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) };
  }
  const source = typeof outcome.value === "string" ? outcome.value : "";
  if (!source.trim()) return { ok: false, reason: "absent" };
  return { ok: true, source };
}
