// Page profiles — 右屏面板可以承载不止一种"VTT 页面"。Foundry 是开放默认档
// (任意 http(s) 源都可能是 Foundry 服务器);mtcompat 是我们自有的 VTT SPA
// (/user-files/compat[...]/play.html),页面侧模拟 Foundry API(window.game 等)。
// 每档 profile 描述:URL 识别、游戏路径判定、检测/就绪语义、会话 cookie 是否持久化、
// 登录落点。main.js 的打开流程、foundry-web.js 的页面巡检与 foundry-sdk 的
// preflight 判定全部以这里为唯一事实源;foundry 档的语义与引入 profile 之前逐字节等价。

/** mtcompat SPA 的规范页面路径(API 兼容层的生产部署形态)。 */
export const MT_COMPAT_PATH_SUFFIX = "/user-files/compat/play.html";

/**
 * mtcompat 页面路径契约(PRD A1):所有形态的 play.html URL 恒为
 * `/user-files/compat[...]/play.html` —— 生产是 compat,分支部署是 compat-<slug>
 * (如 compat-qa、compat-feat-agent-api)。路径是稳定锚点,host 不设防;
 * 对 pathname 匹配(查询串/哈希不参与),一次放宽后不再随部署形态漂移。
 */
export const MT_COMPAT_PATH_PATTERN = /\/user-files\/compat(?:-[\w-]+)?\/play\.html$/;

function foundryIsGamePath(pathname) {
  return String(pathname ?? "").replace(/\/+$/, "") === "/game";
}

function mtCompatIsGamePath(pathname) {
  return MT_COMPAT_PATH_PATTERN.test(String(pathname ?? ""));
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
 * mtcompat 就绪 = SPA 引导完成(game.ready)且 world/user 已就位,且页面自证 runtime
 * 指纹(window.__MT_AGENT_RUNTIME_SOURCE__ / __MT_AGENT_RUNTIME__,见 foundry-web.js 的
 * hasMtAgentRuntime)。不强制 isGM:自有部署的当前用户即 DM,Keycloak 登录完成后 user 才存在。
 *
 * 指纹只是 isReady 的佐证,不做第二检测机制:识别(detect)始终以 URL/hasGame 为主,
 * URL 命中但指纹缺席的页面仍被识别为 mtcompat(detect 照常,状态里 hasMtAgentRuntime=false),
 * 只是不就绪(unattested 态)——runtime 没装上的页面 typed 调用本来也走不通。
 */
function mtCompatIsReady(state) {
  return Boolean(
    mtCompatDetect(state) && state.ready && state.world && state.user
      && mtCompatIsGamePath(state.path) && state.hasMtAgentRuntime
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
    // 同时覆盖 IP 直连、域名与 compat-<slug> 分支部署形态;路径契约是唯一锚点,
    // 模式对 URL 的 pathname 匹配(matchPageProfile),查询串/哈希不影响命中。
    urlPatterns: Object.freeze([MT_COMPAT_PATH_PATTERN]),
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

/**
 * 仅按 URL 模式匹配(mtcompat)。模式对 pathname 匹配 —— 拿 href 匹配时查询串会让
 * `$` 锚定失效(mtcompat 的 Keycloak 换码 URL 带 ?code=...);Foundry 无模式,永不因此命中。
 */
export function matchPageProfile(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  for (const profile of Object.values(PAGE_PROFILES)) {
    if (profile.urlPatterns.some(pattern => pattern.test(parsed.pathname))) return profile;
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

/** 隐藏 per-URL 档位覆盖的环境变量名(运维逃生舱,见 createPanelProfileOverrides)。 */
export const PANEL_PROFILE_OVERRIDE_ENV = "ARCANEDESK_PANEL_PROFILE_OVERRIDES";

const EMPTY_PROFILE_OVERRIDES = Object.freeze({
  entries: Object.freeze([]),
  resolve: () => null,
});

/**
 * 隐藏 per-URL 档位覆盖(PRD A1 的运维逃生舱,不做 UI):读环境变量
 * ARCANEDESK_PANEL_PROFILE_OVERRIDES,JSON 对象形如
 * `{"https://host:port/user-files/compat-dev": "mtcompat"}`。
 *
 * 键是 URL 或其前缀(尾部斜杠归一掉);命中要求 URL 在前缀处结束,或余部以
 * `/`、`?`、`#` 开头 —— 避免 `/compat` 误吃 `/compatfoo`。值必须是 PAGE_PROFILES
 * 里的 profileId(foundry 也可,用来把被模式误判的地址拉回开放默认档)。
 * 最长键优先(更具体的 URL 覆盖更宽的 origin)。
 *
 * 配错不挡路:空值/非法 JSON/非对象/坏条目一律忽略,坏配置记一条警告日志。
 * @param {string | undefined} raw 环境变量原文(缺省读 process.env)
 * @param {(message: string) => void} [log] 警告落点
 * @returns {{ entries: readonly { prefix: string, profileId: string }[], resolve: (url: any) => any }}
 */
export function createPanelProfileOverrides(raw = process.env[PANEL_PROFILE_OVERRIDE_ENV], log = () => {}) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return EMPTY_PROFILE_OVERRIDES;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    log(`[panel-profile] ignoring ${PANEL_PROFILE_OVERRIDE_ENV}: invalid JSON (${error?.message ?? error})`);
    return EMPTY_PROFILE_OVERRIDES;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log(`[panel-profile] ignoring ${PANEL_PROFILE_OVERRIDE_ENV}: expected a JSON object of { "<url prefix>": "<profileId>" }`);
    return EMPTY_PROFILE_OVERRIDES;
  }

  const entries = [];
  for (const [key, value] of Object.entries(parsed)) {
    const prefix = String(key).replace(/\/+$/, "");
    if (!prefix) {
      log(`[panel-profile] ignoring empty URL prefix in ${PANEL_PROFILE_OVERRIDE_ENV}`);
      continue;
    }
    if (typeof value !== "string" || !Object.hasOwn(PAGE_PROFILES, value)) {
      log(`[panel-profile] ignoring ${PANEL_PROFILE_OVERRIDE_ENV} entry ${key}: unknown profile ${JSON.stringify(value)}`);
      continue;
    }
    entries.push(Object.freeze({ prefix, profileId: value }));
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  return Object.freeze({
    entries: Object.freeze(entries),
    resolve(url) {
      const target = String(url ?? "");
      for (const { prefix, profileId } of entries) {
        if (!target.startsWith(prefix)) continue;
        const rest = target.slice(prefix.length);
        if (rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")) {
          return PAGE_PROFILES[profileId];
        }
      }
      return null;
    },
  });
}

/**
 * 面板档位推送的状态器(main.js 持有唯一实例):跟踪"面板当前档位 + URL",
 * 是 panel_profile 事件(arcane:event 总线)与 panel:get-profile 启动种子的
 * 共同数据源,两者同形:{ type, profileId, url, displayName }。
 * displayName 取自 PAGE_PROFILES;profileId 为 null(面板关闭/尚未打开)时
 * url/displayName 同为 null。初始即 null 档 —— activeProfileId 的 foundry
 * 默认值是 runtime 路由兜底,不代表面板已开。
 */
export function createPanelProfileState() {
  let current = null; // { profileId, url } | null(无面板)

  const payload = () => Object.freeze({
    type: "panel_profile",
    profileId: current?.profileId ?? null,
    url: current?.url ?? null,
    displayName: current === null ? null : PAGE_PROFILES[current.profileId].displayName,
  });

  return Object.freeze({
    /**
     * 记录面板当前档位与 URL。值变化(profileId 或 url 任一)返回本次应推送的
     * payload;未变返回 null(去重在这层完成,调用方见 null 即不发)。
     * 只认 PAGE_PROFILES 里的档;null 与未知 id 一律归一为"无面板",
     * 此时 url 强制为 null —— 宁可不报,不虚报档位。
     */
    set(profileId, url) {
      const nextId = typeof profileId === "string" && Object.hasOwn(PAGE_PROFILES, profileId) ? profileId : null;
      const nextUrl = nextId !== null && typeof url === "string" && url !== "" ? url : null;
      if ((current?.profileId ?? null) === nextId && (current?.url ?? null) === nextUrl) return null;
      current = nextId === null ? null : Object.freeze({ profileId: nextId, url: nextUrl });
      return payload();
    },
    /** 当前档位 payload(渲染层启动种子);无任何记录时返回 null 档。 */
    current() {
      return payload();
    },
  });
}
