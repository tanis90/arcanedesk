// Page profiles — 右屏面板可以承载不止一种"VTT 页面"。Foundry 是开放默认档
// (任意 http(s) 源都可能是 Foundry 服务器);mtcompat 是我们自有的 VTT SPA
// (/user-files/compat/play.html),页面侧模拟 Foundry API(window.game 等)。
// 每档 profile 描述:URL 识别、游戏路径判定、检测/就绪语义、会话 cookie 是否持久化、
// 登录落点。main.js 的打开流程、foundry-web.js 的页面巡检与 foundry-sdk 的
// preflight 判定全部以这里为唯一事实源;foundry 档的语义与引入 profile 之前逐字节等价。

/** mtcompat SPA 的页面路径(API 兼容层部署在 /user-files/compat/play.html)。 */
export const MT_COMPAT_PATH_SUFFIX = "/user-files/compat/play.html";

function foundryIsGamePath(pathname) {
  return String(pathname ?? "").replace(/\/+$/, "") === "/game";
}

function mtCompatIsGamePath(pathname) {
  return String(pathname ?? "").endsWith(MT_COMPAT_PATH_SUFFIX);
}

/** Foundry 检测沿用页面内巡检的结论(window.game / join 表单 / setup / 标题)。 */
function foundryDetect(state) {
  return Boolean(state.detected);
}

/** Foundry 就绪 = GM 已进入 ready 的 /game world(与页面内 runtimeReady 公式一致)。 */
function foundryIsReady(state) {
  return Boolean(foundryDetect(state) && state.ready && state.gm && foundryIsGamePath(state.path));
}

/** mtcompat 页面 pre-bootstrap 就有 window.game:有 game 即视为"是这类页面"。 */
function mtCompatDetect(state) {
  return Boolean(state.hasGame);
}

/**
 * mtcompat 就绪 = SPA 引导完成(game.ready)且 world/user 已就位。不强制 isGM:
 * 自有部署的当前用户即 DM,Keycloak 登录完成后 user 才存在。
 */
function mtCompatIsReady(state) {
  return Boolean(
    mtCompatDetect(state) && state.ready && state.world && state.user && mtCompatIsGamePath(state.path)
  );
}

export const PAGE_PROFILES = Object.freeze({
  foundry: Object.freeze({
    id: "foundry",
    displayName: "Foundry VTT",
    // 开放默认档:没有 URL 模式,任何 http(s) 地址都按 Foundry 对待(resolvePageProfile 兜底)。
    urlPatterns: Object.freeze([]),
    // Foundry 的 session cookie 记住/回填/失效清理(main.js remember*/restore*/dropIf*)。
    sessionCookie: Object.freeze({ name: "session" }),
    landingPath: "/game",
    isGamePath: foundryIsGamePath,
    detect: foundryDetect,
    isReady: foundryIsReady,
  }),
  mtcompat: Object.freeze({
    id: "mtcompat",
    displayName: "MT Compat",
    // 同时覆盖 IP 直连与域名形态(路径是稳定锚点,host 不设防)。
    urlPatterns: Object.freeze([/\/user-files\/compat\/play\.html/]),
    // 认证在 Keycloak cookie + SPA sessionStorage:没有任何 cookie 需要我们持久化,
    // 打开流程跳过 remember/restore/dropIf;重启后的首次打开是一次静默 SSO 弹跳。
    sessionCookie: null,
    // 没有 /game 式落点:目标 URL 原样加载(landingPath 为 null)。
    landingPath: null,
    isGamePath: mtCompatIsGamePath,
    detect: mtCompatDetect,
    isReady: mtCompatIsReady,
  }),
});

/** 仅按 URL 模式匹配(mtcompat)。Foundry 无模式,永不因此命中。 */
export function matchPageProfile(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  for (const profile of Object.values(PAGE_PROFILES)) {
    if (profile.urlPatterns.some(pattern => pattern.test(parsed.href))) return profile;
  }
  return null;
}

/**
 * 目标 URL → 页面档位。mtcompat 模式命中优先;其余 http(s) 地址一律落 Foundry
 * 开放默认档(与引入 profile 前的行为一致);非 http(s)(file:// 等)或非法 URL → null。
 */
export function resolvePageProfile(url) {
  const matched = matchPageProfile(url);
  if (matched) return matched;
  try {
    const parsed = new URL(String(url));
    return /^https?:$/.test(parsed.protocol) ? PAGE_PROFILES.foundry : null;
  } catch {
    return null;
  }
}

/**
 * foundry-sdk preflight 的可选覆盖(foundry-sdk/src/client.ts 的 pageProfile 选项)。
 * foundry 档返回 undefined —— SDK 保持出厂判定(路径 /game + GM ready),零变化;
 * 其余档位把该 profile 的 isGamePath/isReady 语义注入 SDK 巡检循环。
 * @returns {{ id: string, isGamePath: (state: any) => boolean, isReady: (state: any) => boolean } | undefined}
 */
export function clientPageProfile(profile) {
  if (!profile || profile.id === PAGE_PROFILES.foundry.id) return undefined;
  return {
    id: profile.id,
    isGamePath: state => profile.isGamePath(String(state?.path ?? "")),
    isReady: state => Boolean(profile.isReady(state)),
  };
}
