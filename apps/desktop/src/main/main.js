import { app, BrowserWindow, desktopCapturer, dialog, Menu, Notification, Tray, WebContentsView, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirectFoundryRuntime } from "./direct-foundry-runtime.js";
import { TelemetryClient } from "./telemetry/telemetry-client.js";
import { readFoundryPageState } from "./foundry-web.js";
import { AgentHost } from "./agent-host.js";
import { DEFAULT_NEW_API_BASE_URL, ProviderStore } from "./providers.js";
import { listPresets, fetchModels } from "./provider-catalog.js";
import { PrepStore } from "./prep-store.js";
import { ModeHostController } from "./mode-host-controller.js";
import { SessionNavigation, projectKey } from "./conversations/session-navigation.js";
import { SessionRegistry } from "./conversations/session-registry.js";
import { listStoredSessions } from "./conversations/session-catalog.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ActivityCenter } from "./conversations/activity-center.js";
import { DesktopNotifications } from "./conversations/desktop-notifications.js";
import { ExecutionScheduler } from "./scheduling/execution-scheduler.js";
import { StartupReconciler } from "./conversations/startup-reconciler.js";
import "../shared/i18n/messages.js";
import { configDir, configPath, migrateLegacyConfig } from "./config-dir.js";
import { VoiceStore } from "./voice/voice-store.js";
import { transcribe } from "./voice/asr.js";
import { WebPermissionStore } from "./permissions/web-permission-store.js";
import { WebPermissionPolicy } from "./permissions/web-permission-policy.js";
import { DisplayMediaController, installDevicePermissionDenials } from "./permissions/display-media.js";
import { err, errorToIpc } from "./i18n-error.mjs";
import { bootstrapFvttOpsRuntime } from "./fvtt-ops-runtime.mjs";
import { SkillsUpdater, bundleRevision } from "./skills-updater.mjs";
import { applyArcaneSubprocessEnvironment } from "./subprocess-env.mjs";
import { SecretStorage } from "./secret-storage.js";
import { PanelSurfaceController } from "./panel-surface-controller.js";
import { loadNotePayload, reloadNotePayload } from "./md-reader-note.js";
import { regionConfig } from "./region.mjs";

// Pi shell tools and other Arcane-owned child processes inherit process.env.
// Establish the Windows UTF-8 contract before creating any of them.
applyArcaneSubprocessEnvironment();

// Region 默认值表（D1）：环境变量 > region 默认值。intl 构建默认值即指向 .app 域名。
const REGION = regionConfig();
// M3 接线点：mod-manager 以子进程方式运行，经环境变量接收索引地址；
// 运维/联调可用 ARCANE_MOD_INDEX_URL 显式覆盖。
if (!String(process.env.ARCANE_MOD_INDEX_URL ?? "").trim()) {
  process.env.ARCANE_MOD_INDEX_URL = REGION.modIndexUrl;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARCANE_APP_ID = "cn.bitterbebop.arcanedesk";
const ARCANE_APP_ICON = path.join(
  __dirname,
  "..",
  "renderer",
  process.platform === "win32" ? "logo-icon.ico" : "logo-icon.png",
);

// --dev:detach 打开两侧 DevTools(chat renderer + Foundry view)
const isDev = process.argv.includes("--dev");

const DEFAULT_FOUNDRY_URL = process.env.ARCANE_FOUNDRY_URL || "http://localhost:30000";
const ARCANE_WEBSITE_URL = REGION.websiteUrl;
const CHAT_WIDTH_RATIO = 0.3;
const CHAT_MIN_WIDTH = 320;
const CHAT_MAX_RATIO = 0.65;
const FOUNDRY_MIN_WIDTH = 640;
const SPLITTER_GUTTER = 6; // 分隔条占用的 chat 侧像素(归 chat 页面,接收拖拽事件)
// Win frameless 的天头高度:与 renderer .chat-header 同高。面板打开时 Foundry 视图
// 整体下移这么多,顶部让出一条贯穿全窗的标题栏带,系统 overlay 三键落在带上,
// 不再压 Foundry 右上 UI。index.html 的 #panel-titlebar 高度改动要同步这里。
const TITLEBAR_HEIGHT = 36;

// 应用身份:userData 目录由 app 名决定(~/Library/Application Support/<name>)。
// 打包版用 productName "ArcaneDesk";dev(npm start)保持 "arcane-desktop",
// 继续用既有 userData,两份配置互不干扰。
if (!app.isPackaged) app.setName("arcane-desktop");
// Windows 任务栏按 Application User Model ID 识别和分组应用。开发版实际
// 运行的是 electron.exe；不给独立 ID 时，Shell 会继续显示 Electron 图标。
// dev 使用独立后缀，避免与已安装的正式版合并成同一个任务栏分组。
if (process.platform === "win32") {
  app.setAppUserModelId(app.isPackaged ? ARCANE_APP_ID : `${ARCANE_APP_ID}.development`);
}
// 打包版的 pi agent 目录收进 app 私有 userData,不与本机 pi CLI 共享 ~/.pi/agent——
// 否则 pi CLI 的 settings.json 默认模型(如 kimi-coding/k3)与同 cwd 会话会漏进 app。
// (SDK 的环境变量名见 dist/config.js:ENV_AGENT_DIR = PI_CODING_AGENT_DIR;
//  getAgentDir() 每次调用时现读,这里设置即可覆盖全部内部路径)
if (app.isPackaged) {
  const agentDir = path.join(app.getPath("userData"), "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
}

let mainWindow = null;
let foundryTargetUrl = DEFAULT_FOUNDRY_URL;
// 右屏两个 view(foundry / md 阅读器)的生命周期归 panel-surface 控制器(spec §8),
// main.js 只留只读访问,不再持有可变引用——否则 readerView 可见时下面这些直摸点会静默失效。
let panelSurfaces = null; // whenReady 里建;建好之前没有任何面板可排
let foundryRuntime = null; // app 生命周期内唯一实例；始终通过 getter 访问当前 Foundry view
let telemetry = null; // 遥测总入口;授权默认关闭,开发版本地记录(§3.1)
let chatWidthPx = null; // 用户可拖;null = 按比例初始化
let foundryPermissionOrigin = null; // 仅在确认目标确为 Foundry 后设为 exact origin
let webPermissionPolicy = null;
let displayMediaController = null;
let activityCenter = null;
let prepareExit = null, backgroundTray = null, quitAllowed = false, exitRequested = false;
function restoreMainWindow() {
  if (exitRequested) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function enableBackgroundEntry() {
  if (backgroundTray) return true;
  try {
    backgroundTray = new Tray(ARCANE_APP_ICON);
    backgroundTray.setToolTip("ArcaneDesk");
    const text = key => globalThis.ARCANE_MESSAGES[resolveLocale()][key];
    backgroundTray.setContextMenu(Menu.buildFromTemplate([
      { label: text("lifecycle.open"), click: restoreMainWindow },
      { label: text("lifecycle.quit"), click: () => app.quit() },
    ]));
    backgroundTray.on("click", restoreMainWindow);
    return true;
  } catch { backgroundTray?.destroy(); backgroundTray = null; return false; }
}
function requestExit() {
  if (exitRequested) return;
  exitRequested = true;
  // The deadline also covers pending loads, stop requests and Electron unload hooks.
  setTimeout(() => app.exit(0), 2000);
  void Promise.resolve().then(() => prepareExit?.()).catch(error => {
    console.error("[quit] best-effort cleanup failed", error);
  }).finally(() => { quitAllowed = true; app.quit(); });
}
let desktopNotifications = null;

function sendToRenderer(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("arcane:event", event);
  }
  // Deliver content first; a later activity update cannot acknowledge unseen content.
  if (event.runtimeEpoch) {
    try { activityCenter?.observe(event); }
    catch (error) { console.error("[activity] event projection failed", error.message); }
  }
  if (event.type === "activity_update") desktopNotifications?.reconcile(event.summary.sessionId);
  if (event.type === "activity_removed") desktopNotifications?.reconcile(event.sessionId);
}

function isTrustedChatIpc(event) {
  const chat = mainWindow?.webContents;
  if (!chat || event?.sender !== chat) return false;
  const senderFrameId = event.senderFrame?.frameTreeNodeId;
  return senderFrameId != null && senderFrameId === chat.mainFrame?.frameTreeNodeId;
}

/** readerView 发来的 IPC 是否可信(md-reader:back 的唯一门禁)。
    形状对齐 isTrustedChatIpc:同一个 webContents + 同一个主 frame。 */
function isTrustedReaderIpc(event) {
  const reader = panelSurfaces?.readerView?.webContents;
  if (!reader || reader.isDestroyed() || event?.sender !== reader) return false;
  const senderFrameId = event.senderFrame?.frameTreeNodeId;
  return senderFrameId != null && senderFrameId === reader.mainFrame?.frameTreeNodeId;
}

function clearFoundryPermissionState(reason, { keepSessionGrants = false } = {}) {
  if (keepSessionGrants) webPermissionPolicy?.cancelPending(reason);
  else webPermissionPolicy?.clearSessionGrants(reason);
  displayMediaController?.cancelAll(reason);
  if (!keepSessionGrants) foundryPermissionOrigin = null;
}

function trustFoundryPermissionOrigin(url) {
  try {
    const origin = new URL(url).origin;
    if (foundryPermissionOrigin && foundryPermissionOrigin !== origin) {
      webPermissionPolicy?.clearSessionGrants("foundry-origin-changed");
    }
    foundryPermissionOrigin = origin;
  } catch {
    clearFoundryPermissionState("invalid-foundry-origin");
  }
}

function effectiveChatWidth(winWidth) {
  if (chatWidthPx == null) chatWidthPx = Math.round(winWidth * CHAT_WIDTH_RATIO);
  const max = Math.min(Math.round(winWidth * CHAT_MAX_RATIO), winWidth - FOUNDRY_MIN_WIDTH - SPLITTER_GUTTER);
  chatWidthPx = Math.min(Math.max(CHAT_MIN_WIDTH, chatWidthPx), Math.max(CHAT_MIN_WIDTH, max));
  return chatWidthPx;
}

/** 右屏 Foundry 页面的只读访问。权限策略、direct-foundry-runtime 与 AgentHost 用它取页面;
    它们绝不能拿到 readerView(spec §8 收编表末行),所以这里只暴露 foundry 那一个。 */
const foundryView = () => panelSurfaces?.foundryView ?? null;

/** 右屏区域几何:chat 居左,面板从右侧弹出。Win frameless 下顶部让出 TITLEBAR_HEIGHT
    给贯穿全窗的标题栏带(overlay 三键落在带上),面板从带下沿开始,不被压;
    真全屏(F11)时三键与带子都消失,面板回满高。 */
function computePanelLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const [width, height] = mainWindow.getContentSize();
  const chatWidth = effectiveChatWidth(width);
  const topOffset = process.platform === "win32" && !mainWindow.isFullScreen() ? TITLEBAR_HEIGHT : 0;
  return {
    bounds: {
      x: chatWidth + SPLITTER_GUTTER,
      y: topOffset,
      width: Math.max(0, width - chatWidth - SPLITTER_GUTTER),
      height: Math.max(0, height - topOffset),
    },
    chatWidth,
    gutter: SPLITTER_GUTTER,
  };
}

/** 重排右屏。bounds 同时发给两个 view(隐藏的那个也保持正确尺寸,切换时不闪旧布局),
    并由控制器发一次 panel_layout 让 chat 页面 margin-right 让出右屏——事件协议不变。 */
function layoutViews() {
  panelSurfaces?.layout();
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Foundry 登录态记忆。
 * Foundry 的 session cookie 有约 24h 有效期,但新开的 WebContents 默认拿不到
 * (App 重启/强杀后 cookie store 可能没落盘),导致"world 明明在跑、别处也登录过,
 * 重开面板却掉回 /join"。GM 进 world 后把 cookie 记在内存里,下次开面板前
 * 先回填,直接落 /game。cookie 失效(如 Foundry 重启、session 过期)时 Foundry
 * 自己会退回 /join,agent/用户再登录一次后会被重新记住——自愈。
 */
const rememberedFoundrySessions = new Map(); // origin -> { name, value, expirationDate }

// Foundry 的 session cookie 不带 expires,Chromium 不会把它持久化;
// 自己落盘一份(userData/config/foundry-sessions.json),重启后回填。
// 服务端会话失效(Foundry 重启)时靠 dropIfSessionRejected 清掉 stale 条目。
function foundrySessionsPath() {
  return configPath("foundry-sessions.json");
}

function loadFoundrySessions() {
  try {
    const data = JSON.parse(readFileSync(foundrySessionsPath(), "utf8"));
    for (const [origin, entry] of Object.entries(data)) {
      if (entry?.name && entry?.value) rememberedFoundrySessions.set(origin, entry);
    }
  } catch {
    /* 首次运行或文件损坏:当作没有记住的会话 */
  }
}

function saveFoundrySessions() {
  try {
    writeFileSync(foundrySessionsPath(), JSON.stringify(Object.fromEntries(rememberedFoundrySessions), null, 2));
  } catch (error) {
    console.log("[panel] persist sessions failed:", error.message);
  }
}

async function rememberSessionCookie(view, origin) {
  for (let i = 0; i < 20; i++) {
    // 轮询中途面板可能被关闭:close() 之后 view.webContents 会变成 undefined,
    // 直接 .isDestroyed() 就抛 TypeError("打开面板失效"的日志来源)。
    if (!view?.webContents || view.webContents.isDestroyed()) return;
    let inGmGame = false;
    try {
      // The authenticated session cookie exists as soon as Foundry has built
      // the GM /game context. Do not wait for game.ready: large online worlds
      // can spend minutes drawing the canvas, longer than this capture loop.
      inGmGame = await view.webContents.executeJavaScript(
        "Boolean(location.pathname === '/game' && window.game?.user?.isGM)",
        true
      );
    } catch {
      return; // 页面不可用(崩溃/已销毁),放弃本轮记忆
    }
    if (inGmGame) {
      try {
        const cookies = await view.webContents.session.cookies.get({ url: origin, name: "session" });
        const cookie = cookies[0];
        if (cookie) {
          rememberedFoundrySessions.set(origin, {
            name: cookie.name,
            value: cookie.value,
            // Foundry 发的是会话 cookie(无 expires);补一个 30 天过期,
            // 否则恢复时 Chromium 仍把它当会话 cookie,落盘无意义。
            expirationDate: cookie.expirationDate ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          });
          saveFoundrySessions();
          console.log("[panel] remembered Foundry session for", origin);
        }
      } catch (error) {
        console.log("[panel] capture session cookie failed:", error.message);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function restoreSessionCookie(view, origin) {
  const remembered = rememberedFoundrySessions.get(origin);
  if (!remembered) return false;
  try {
    await view.webContents.session.cookies.set({
      url: origin,
      name: remembered.name,
      value: remembered.value,
      expirationDate: remembered.expirationDate,
    });
    console.log("[panel] restored remembered Foundry session for", origin);
    return true;
  } catch {
    return false;
  }
}

/**
 * 恢复 cookie 后直进 /game,若服务端会话已失效(Foundry 重启),
 * 会被重定向回 /join:清掉 stale 条目,避免每次启动都白试一次。
 */
function dropIfSessionRejected(view, origin, restored) {
  if (!restored || !view?.webContents || view.webContents.isDestroyed()) return;
  if (view.webContents.getURL().includes("/join")) {
    rememberedFoundrySessions.delete(origin);
    saveFoundrySessions();
    console.log("[panel] remembered session rejected by server, dropped for", origin);
  }
}

/** 从主窗口摘下并关闭一个 view。两个 surface 共用,销毁时机由控制器定。 */
function detachAndCloseView(view) {
  try {
    mainWindow?.contentView.removeChildView(view);
  } catch {
    /* view already detached */
  }
  try {
    if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
  } catch {
    /* view gone */
  }
}

/** 建 foundryView 并挂全部 Foundry 专属监听(指针、F11、导航权限、崩溃、devtools)。
    显隐、bounds 与销毁时机都不在这里——那是控制器的事(spec §8)。 */
function createFoundryView() {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.contentView.addChildView(view);
  const panelWebContents = view.webContents;
  panelWebContents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown") sendToRenderer({ type: "panel_pointer" });
  });
  if (process.platform === "win32") bindFullScreenHotkey(panelWebContents); // 焦点在 Foundry 里 F11 也生效
  panelWebContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame === false || isInPlace) return;
    foundryRuntime?.invalidate();
    let sameTrustedOrigin = false;
    try {
      sameTrustedOrigin = Boolean(foundryPermissionOrigin) && new URL(url).origin === foundryPermissionOrigin;
    } catch {
      /* Invalid navigation target is never trusted. */
    }
    clearFoundryPermissionState("foundry-navigation", { keepSessionGrants: sameTrustedOrigin });
  });
  // 阅读器盖住期间 Foundry 的 renderer 可能崩溃(WebGL 页面被 Chromium 判定 occlusion 后丢弃):
  // 崩溃后 isDestroyed() 仍是 false,不在这里作废 runtime 与权限授权的话,
  // 它们会握着一块死黑屏;重建由控制器 isUsable() 的 isCrashed 检查在下次使用时完成(review BUG-4)。
  panelWebContents.on("render-process-gone", (_event, details) => {
    console.error("[panel] Foundry renderer process gone:", details?.reason ?? "unknown");
    foundryRuntime?.invalidate();
    clearFoundryPermissionState("foundry-render-process-gone");
  });
  panelWebContents.once("destroyed", () => {
    foundryRuntime?.invalidate();
    clearFoundryPermissionState("foundry-view-destroyed");
  });
  if (isDev) panelWebContents.openDevTools({ mode: "detach" });
  return view;
}

/** 销毁 foundryView:runtime 句柄与权限授权跟着一起作废(reason 由控制器给)。 */
function destroyFoundryView(view, reason) {
  foundryRuntime?.invalidate();
  clearFoundryPermissionState(reason);
  detachAndCloseView(view);
}

/** 建 readerView:本地 md-reader.html + 专用小 preload(spec §7/§8)。
    内容只由 main 侧推送(§3.5 不变量 5),页面自身不读盘:F5 被 before-input-event
    接到控制器的 reloadSurface 重读磁盘;devtools Ctrl+R / 崩溃恢复造成的整页重载,
    由 did-finish-load → onReaderReady 重读重推,内容都必然回来。 */
function createReaderView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload-reader.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.contentView.addChildView(view);
  const contents = view.webContents;
  // 点阅读器也要能收起覆盖式抽屉(spec §8 收编表 before-mouse-event 行)
  contents.on("before-mouse-event", (_event, mouse) => {
    if (mouse.type === "mouseDown") sendToRenderer({ type: "panel_pointer" });
  });
  if (process.platform === "win32") bindFullScreenHotkey(contents); // 焦点在阅读器里 F11 也生效
  bindReaderReloadHotkey(contents); // 焦点在阅读器里 F5 = 重读当前笔记(spec §4.3)
  denyWindowOpenToSystemBrowser(contents); // target="_blank" 交系统浏览器,不开裸窗口(N14)
  // 与 foundryView 同款崩溃处理:崩溃后 isDestroyed() 仍是 false,这里记日志;
  // 重建由控制器 isUsable() 的 isCrashed 检查在下次 F5/② 时完成(review BUG-4 同型,N5)
  contents.on("render-process-gone", (_event, details) => {
    console.error("[reader] renderer process gone:", details?.reason ?? "unknown");
  });
  contents.on("did-finish-load", () => {
    if (contents.isDestroyed()) return;
    panelSurfaces?.onReaderReady();
  });
  if (isDev) contents.openDevTools({ mode: "detach" });
  void contents.loadFile(path.join(__dirname, "..", "renderer", "md-reader.html"), {
    // 只传 theme / lang:阅读器页没有可拖拽 chrome(win 下 view 已从标题栏带下沿开始),
    // 所以不需要 frameless。
    query: { theme: resolveTheme(), lang: resolveLocale() },
  }).catch(error => console.error("[reader] page load failed", error?.message ?? error));
  return view;
}

/**
 * foundry_open 的宿主实现。
 * 幂等:面板已开且与目标同源时绝不导航(保护已登录的 world 会话)。
 * 只有跨源或当前页面失效时才导航。
 * 这也是状态机的 ④(spec §3.2):归位由控制器执行,阅读器若在场则隐藏保活。
 */
async function openFoundryView(rawUrl) {
  const target = /^https?:\/\//i.test(rawUrl ?? "") ? rawUrl : DEFAULT_FOUNDRY_URL;
  let origin;
  try {
    origin = new URL(target).origin;
  } catch {
    return {
      ok: false,
      error: err("err.panel.invalidUrl", { url: rawUrl ?? "" }),
      summary: `ERROR: invalid URL: ${rawUrl}`,
    };
  }

  foundryTargetUrl = target;

  // ④ 归位:控制器保证 foundryView 存在(renderer 崩溃则重建)、两个 view 最多一个可见、
  // panel_status / panel_layout 各发一次。下面只管 Foundry 专属的 cookie 与页面加载。
  const before = foundryView();
  panelSurfaces.showFoundry();
  const view = foundryView();

  if (before !== view) {
    // 全新 view(首次打开或刚重建):有记住的登录态就先回填 cookie,直接进 /game,跳过 /join
    const restored = await restoreSessionCookie(view, origin);
    const initialUrl = restored ? new URL("/game", origin).href : target;
    const loaded = await loadFoundryPage(initialUrl);
    if (!loaded.ok) return loaded;
    dropIfSessionRejected(view, origin, restored);
    void rememberSessionCookie(view, origin);
    return { ok: true, page: loaded.page, summary: await describePanel(target, loaded.page) };
  }

  const current = view.webContents.getURL();
  if (sameOrigin(current, target)) {
    // Same-origin idempotence only protects a real Foundry page. Chromium keeps
    // the failed URL after ERR_CONNECTION_RESET, so origin equality alone can
    // otherwise turn a blank/error page into a false-success tool result.
    const inspected = await readFoundryPageState(view.webContents);
    if (inspected.ok && inspected.state?.detected) {
      trustFoundryPermissionOrigin(current);
      return { ok: true, page: inspected.state, summary: await describePanel(current, inspected.state) };
    }
    const loaded = await loadFoundryPage(target);
    if (!loaded.ok) return loaded;
    return { ok: true, page: loaded.page, summary: await describePanel(target, loaded.page) };
  }
  const restored = await restoreSessionCookie(view, origin);
  const navUrl = restored ? new URL("/game", origin).href : target;
  const loaded = await loadFoundryPage(navUrl);
  if (!loaded.ok) return loaded;
  dropIfSessionRejected(view, origin, restored);
  void rememberSessionCookie(view, origin);
  return { ok: true, page: loaded.page, summary: await describePanel(target, loaded.page) };
}

async function loadFoundryPage(url) {
  // 与 failedPage 同款守卫:调用方(reloadFoundry 等)检查过之后到这里之间,
  // view 仍可能被销毁/重建,无条件解引用 webContents 会抛 TypeError(review F3)。
  const contents = foundryView()?.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) {
    // 与其他 IPC 错误同款的 error 字段:chat 的 F5 只据 result.error 判定失败(N3)
    return {
      ok: false,
      error: err("err.panel.viewGone", { url }),
      summary: `ERROR: ${url} not loaded: the panel view is gone`,
    };
  }
  foundryTargetUrl = url;
  const failedPage = async () => {
    if (contents.isDestroyed() || foundryView()?.webContents !== contents) return;
    await contents.loadFile(path.join(__dirname, "../renderer/foundry-unavailable.html"), {
      query: { message: globalThis.ARCANE_MESSAGES[resolveLocale()]["panel.connectionFailed"], theme: resolveTheme() },
    }).catch(() => {});
  };
  try {
    await contents.loadURL(url);
  } catch (error) {
    if (error.code !== "ERR_ABORTED") await failedPage();
    return {
      ok: false,
      error: err("err.panel.loadFailed", { url, error: error.message }),
      summary: `ERROR: failed to load ${url}: ${error.message}`,
    };
  }
  const inspected = await readFoundryPageState(contents);
  if (!inspected.ok) {
    await failedPage();
    return {
      ok: false,
      error: err("err.panel.inspectFailed", { error: inspected.error ?? inspected.status }),
      summary: `ERROR: ${url} loaded but the page could not be inspected (${inspected.error ?? inspected.status})`,
    };
  }
  if (!inspected.state?.detected) {
    await failedPage();
    return {
      ok: false,
      error: err("err.panel.notFoundry", { url }),
      page: inspected.state,
      summary: `ERROR: ${url} responded, but it is not a Foundry Virtual Tabletop page`,
    };
  }
  trustFoundryPermissionOrigin(url);
  return { ok: true, page: inspected.state };
}

async function describePanel(url, knownState) {
  const inspected = knownState ? { ok: true, state: knownState } : await readFoundryPageState(foundryView()?.webContents);
  const pageState = inspected.ok ? JSON.stringify(inspected.state) : `(page not ready: ${inspected.error ?? inspected.status})`;
  return `panel at ${url}; page=${pageState}. ` +
    `runtimeReady is true only after a GM has entered a ready /game world. If path is /join, ask the user to select their GM account and enter any world password directly in the Foundry panel; never request or handle that password through a model tool.`;
}

function readUiState() {
  try {
    return JSON.parse(readFileSync(configPath("ui.json"), "utf8"));
  } catch {
    return {};
  }
}

/** 显式保存的暗色优先;新用户或无效值默认浅色。 */
function resolveTheme() {
  return readUiState().theme === "dark" ? "dark" : "light";
}

/** 读-改-写 ui.json;失败静默(原型期约定,同 ui:theme)。 */
function writeUiState(partial) {
  try {
    writeFileSync(configPath("ui.json"), JSON.stringify({ ...readUiState(), ...partial }));
  } catch {
    /* ignore */
  }
}

const UI_LOCALES = ["zh-CN", "en-US"];

/**
 * 解析本次启动的界面语言:ui.json 的显式选择优先;auto(默认/缺省)跟随系统首选
 * 语言,每次启动重新对齐(用户改系统语言后 app 跟上,等价于"安装即自动检测")。
 * 经 loadFile 的 ?lang= query 传给 i18n-init.js,与 theme 同链路。
 */
function resolveLocale() {
  const saved = readUiState().locale;
  if (UI_LOCALES.includes(saved)) return saved;
  const langs = app.getPreferredSystemLanguages?.() ?? [];
  const primary = String(langs[0] ?? app.getLocale?.() ?? "");
  return /^zh/i.test(primary) ? "zh-CN" : "en-US";
}

/** Win 隐藏标题栏的 overlay 三键配色:随主题,底色 = 天头/标题栏带的 --bg-soft。
    面板打开时 Foundry 视图已下移出天头区(layoutViews 的 topOffset),三键落在
    渲染层的标题栏带上,不再压 FVTT 右上 UI,故配色无需再随面板状态切换。
    height 是 overlay 唯一能调尺寸的旋钮(width 由 Windows 画死、按钮钉在窗口顶边,
    挪不下来):恒 TITLEBAR_HEIGHT,与天头/标题栏带垂直对齐。 */
function titleBarOverlayFor(theme) {
  return theme === "light"
    ? { color: "#eae2cc", symbolColor: "#2b2416", height: TITLEBAR_HEIGHT }
    : { color: "#10141d", symbolColor: "#e9ecf3", height: TITLEBAR_HEIGHT };
}

/** 主题切换后重刷 overlay 配色。 */
function syncTitleBarOverlay() {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitleBarOverlay(titleBarOverlayFor(resolveTheme()));
}

/** F11 切换真全屏(浏览器式沉浸)。before-input-event 抢在页面前面拿到按键,
    焦点在 chat 或 Foundry 视图里都生效;只绑 Win,mac 的 F11 是系统"显示桌面"。 */
function bindFullScreenHotkey(webContents) {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "F11") return;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
}

/** 阅读器里的 F5:surface 感知重载(spec §4.3),走控制器重读当前笔记,而不是整页 reload。
    不带修饰键才接管:Ctrl+R 等组合留给 devtools,整页重载由 onReaderReady 重读兜底(N8)。 */
function bindReaderReloadHotkey(webContents) {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "F5") return;
    if (input.control || input.alt || input.shift || input.meta) return;
    event.preventDefault();
    void panelSurfaces?.reloadSurface();
  });
}

/** target="_blank" / window.open 不在应用内开裸 Chromium 窗口:http(s) 交给系统浏览器,
    其余一律拒绝(N14)。foundryView 故意不挂——Foundry 是真实 web 应用,弹窗行为归它自己。 */
function denyWindowOpenToSystemBrowser(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function createWindow() {
  // mac 不能摘菜单:macOS 的 Cmd+C/V/A/Z 靠菜单 role 承载,null 菜单 = 输入框
  // 复制粘贴全废。darwin 装最小骨架(应用菜单带 Cmd+Q + 预置 Edit 菜单);
  // Windows/Linux 的编辑快捷键由 Chromium 控件原生实现,菜单照旧摘干净。
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: "quit" }] },
      { role: "editMenu" },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  loadFoundrySessions(); // 恢复上次记住的 Foundry 登录态(app 已 ready,userData 可用)
  const theme = resolveTheme();
  mainWindow = new BrowserWindow({
    // 默认宽度保证右屏 Foundry ≥1024px(Foundry 的最小可用宽度),
    // 否则左栏 30% chat 会把它压到 885px,触发尺寸警告横幅。
    width: 1520,
    height: 920,
    minWidth: 1080,
    minHeight: 640,
    title: "ArcaneDesk",
    icon: ARCANE_APP_ICON,
    backgroundColor: theme === "light" ? "#f0e9d6" : "#0c0f16",
    // Win 下摘原生标题栏:天头即标题栏,右上三键用系统 overlay(随主题换色);
    // 面板打开时 Foundry 视图下移 TITLEBAR_HEIGHT,三键落在标题栏带上(见 layoutViews)。
    // renderer 靠 query.frameless 切可拖拽形态;mac 保留原生红绿灯,不动。
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlayFor(theme) }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Win Shell 对 electron.exe 的默认图标有缓存；构造后显式重设一次真实 ICO，
  // 保证窗口的 HICON 与任务栏分组都不回落到 Electron。
  if (process.platform === "win32") mainWindow.setIcon(ARCANE_APP_ICON);

  // App 本体 = chat(agent loop);Foundry 面板按需打开。theme/lang 经 query 传给
  // theme-init.js / i18n-init.js,首屏即按持久化主题/语言渲染,避免闪帧。
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"), {
    query: { theme, frameless: process.platform === "win32" ? "1" : "0", lang: resolveLocale() },
  });
  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  if (process.platform === "win32") bindFullScreenHotkey(mainWindow.webContents);
  // chat 气泡里的 target="_blank" 链接(markdown.js 渲染)交系统浏览器打开(N14)
  denyWindowOpenToSystemBrowser(mainWindow.webContents);

  const relayout = () => layoutViews();
  mainWindow.on("resize", relayout);
  mainWindow.on("maximize", relayout);
  mainWindow.on("unmaximize", relayout);
  // 全屏进出:重排 Foundry 视图(topOffset 随全屏切换),并同步 renderer 收/展标题栏带
  const syncFullScreen = () => {
    relayout();
    sendToRenderer({ type: "fullscreen", on: mainWindow.isFullScreen() });
  };
  mainWindow.on("enter-full-screen", syncFullScreen);
  mainWindow.on("leave-full-screen", syncFullScreen);

  mainWindow.on("closed", () => {
    foundryRuntime?.invalidate();
    clearFoundryPermissionState("main-window-closed");
    mainWindow = null;
    // 窗口没了,两个 view 随之而去:只丢引用,不发任何事件(renderer 已经不在了)。
    panelSurfaces?.dispose();
  });
  mainWindow.on("close", event => {
    if (quitAllowed) return;
    event.preventDefault();
    if (enableBackgroundEntry()) mainWindow.hide();
    else requestExit();
  });
}

app.whenReady().then(async () => {
  // 原型期一次性配置迁移:userData 根目录的 arcane-*.json → config/(稳定后可删)。
  // 必须最先跑:createWindow 会读 ui.json,ProviderStore 会读 providers.json。
  migrateLegacyConfig(["ui.json", "providers.json", "foundry-sessions.json", "web-permissions.json"]);

  // Web permission P0:Chat 只拿 audio;Foundry 只信当前 view + exact origin +
  // main frame。ASK_* 走左栏非阻塞权限卡,未知能力 fail closed。
  const webPermissionStore = new WebPermissionStore(configPath("web-permissions.json"));
  webPermissionPolicy = new WebPermissionPolicy({
    store: webPermissionStore,
    getChatWebContents: () => mainWindow?.webContents ?? null,
    getFoundryWebContents: () => foundryView()?.webContents ?? null,
    getFoundryOrigin: () => foundryPermissionOrigin,
    sendToRenderer,
  });
  displayMediaController = new DisplayMediaController({
    desktopCapturer,
    getFoundryWebContents: () => foundryView()?.webContents ?? null,
    getFoundryOrigin: () => foundryPermissionOrigin,
    sendToRenderer,
  });
  const webSession = session.defaultSession;
  webSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return webPermissionPolicy.check(webContents, permission, requestingOrigin, details);
  });
  webSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    webPermissionPolicy.request(webContents, permission, callback, details);
  });
  webSession.setDisplayMediaRequestHandler((request, callback) => {
    void displayMediaController.handle(request, callback);
  }, { useSystemPicker: process.platform === "darwin" });
  installDevicePermissionDenials(webSession);

  createWindow();
  // 右屏 surface 状态机(spec §3/§8):两个 view 的创建、显隐、销毁与 bounds 分发全在这里。
  // hooks 引用的 foundryRuntime / prepUiCwd / modeController 都是惰性调用(用户点击或 agent 工具),
  // 不存在初始化时序问题。
  panelSurfaces = new PanelSurfaceController({
    getWindow: () => mainWindow,
    computeLayout: computePanelLayout,
    emit: sendToRenderer,
    createFoundryView,
    destroyFoundryView,
    createReaderView,
    destroyReaderView: detachAndCloseView,
    // ① 重开面板要回到关闭前那个 Foundry 地址,而不是默认地址(spec §3.4 CLOSED 行"恢复关闭前内容")。
    // foundryTargetUrl 初值就是 DEFAULT_FOUNDRY_URL,所以首次打开的行为与改造前一致;
    // 而"关掉面板再打开就从远端 world 掉回 localhost:30000"是既有缺陷,在这里一并修掉。
    loadFoundry: () => openFoundryView(foundryTargetUrl),
    reloadFoundry: async () => {
      // 崩掉的 view 先经控制器重建(N3):只查 isDestroyed 会让崩溃的 Foundry
      // (isDestroyed 仍是 false)漏进 loadFoundryPage,撞上 "view is gone" 守卫,
      // F5 就成了没有回音的死路。重建后的空 view 回落到 foundryTargetUrl。
      const view = panelSurfaces.ensureFoundryView();
      return loadFoundryPage(/^https?:/.test(view.webContents.getURL()) ? view.webContents.getURL() : foundryTargetUrl);
    },
    // §7 读链:基准 = 当前活动会话的工作目录,取不到时退回备团工作目录(spec §4.2)。
    readNote: rawPath => loadNotePayload(rawPath, noteBaseDir()),
    // F5/① 恢复的重读:按打开时快照的 absolute + baseDir 复检,不随当前 cwd 漂移(N4)。
    rereadNote: (absolute, baseDir) => reloadNotePayload(absolute, baseDir),
  });
  // 遥测先于窗口内的 Agent/Foundry 初始化失败也要能安全关闭(§16.1)
  try {
    telemetry = new TelemetryClient({
      userDataDir: app.getPath("userData"),
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
    });
    telemetry.start();
  } catch (error) {
    telemetry = null;
    console.log("[telemetry] initialization failed; continuing without telemetry:", error?.message ?? error);
  }
  foundryRuntime = new DirectFoundryRuntime({
    getWebContents: () => foundryView()?.webContents ?? null,
    onCallResult: (record) => telemetry?.foundryRuntimeResult(record),
  });

  const secretStorage = new SecretStorage(safeStorage);
  const providerStore = new ProviderStore(configPath("providers.json"), console.log, process.env, secretStorage);
  const voiceStore = new VoiceStore(
    configPath("voice.json"),
    console.log,
    secretStorage,
    providerStore.baseUrlForProvider("arcane-spark") ?? DEFAULT_NEW_API_BASE_URL,
  );
  const prepStore = new PrepStore(configPath("prep.json"));
  // Large, replaceable runtimes stay outside the signed/read-only app bundle.
  // Windows uses LocalAppData rather than roaming AppData; macOS/Linux use the
  // normal app userData directory.
  const runtimeRoot = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, app.getName(), "runtime")
    : path.join(app.getPath("userData"), "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const distributionFile = path.join(__dirname, "..", "..", "distribution", "community-distribution.json");
  // Agent shell scripts read the packaged policy directly with the bundled
  // Node. This is process-local and never changes the user's environment.
  process.env.ARCANE_FVTT_DISTRIBUTION_FILE = distributionFile;
  // 内置 skills 是系统的一部分,但文本可走独立下发通道:userData 里经完整性
  // 校验的激活副本优先于包内基线(见 skills-updater.mjs)。解析发生在每次
  // session 创建时,所以启动后刷新成功即对后续新 session 生效,无需重启。
  const skillsUpdater = new SkillsUpdater({
    bundledSkillsDir: path.join(__dirname, "..", "..", REGION.bundledSkillsDir),
    stateDir: path.join(app.getPath("userData"), "skills"),
    appVersion: app.getVersion(),
    // 运维联调可用 ARCANE_SKILLS_UPDATE_BASE_URL 指向本地源(仅 HTTPS 或精确 loopback);
    // 缺省走 region 默认值(D1,见 src/main/region.mjs)。
    baseUrl: process.env.ARCANE_SKILLS_UPDATE_BASE_URL || REGION.skillsUpdateBaseUrl,
    onActivated: (dir) => applyModManagerEnv(dir),
    // 通道自身的运维遥测:各 revision 分布/失败率/minAppVersion 拦截全靠这条。
    onRefreshResult: (report) => telemetry?.skillsUpdateCompleted(report),
  });
  function applyModManagerEnv(skillsDir) {
    process.env.ARCANE_FVTT_MOD_MANAGER = path.join(
      skillsDir,
      "arcane-fvtt-mods",
      "scripts",
      "mod-manager.mjs",
    );
  }
  applyModManagerEnv(skillsUpdater.resolveSkillsDir());
  // skill.loaded 的归因上下文:生效目录 + bundle revision,事件发生时现取,
  // refresh 激活新 bundle 后自动跟随;telemetry 为 null 时整条 skill 遥测静默关闭。
  telemetry?.setSkillsContext(() => {
    const dir = skillsUpdater.resolveSkillsDir();
    return { rootDir: dir, revision: bundleRevision(dir) };
  });
  // 启动后后台刷新一次;失败静默保留现状,绝不阻塞启动。
  skillsUpdater.refresh().catch((error) => console.error("[skills] unexpected refresh failure:", error));
  const bundledNodeRoot = app.isPackaged
    ? path.join(process.resourcesPath, "runtime", "node")
    : path.join(__dirname, "..", "..", "generated", "bundled-node");
  const fvttOpsRuntimeReady = bootstrapFvttOpsRuntime({
    runtimeRoot,
    distributionFile,
    bundledNodeRoot,
  }).then((runtime) => {
    console.log(`[fvtt-ops] Node ${runtime.version} ready at ${runtime.nodeBinary} (${runtime.reused ? "reused" : runtime.source})`);
    return runtime;
  });
  // Keep startup usable for settings/recovery, but retain the rejected promise
  // as the Agent gate. AgentHost awaits the same promise and therefore never
  // falls back to a system Node when the packaged bootstrap failed.
  fvttOpsRuntimeReady.catch((error) => {
    console.error("[fvtt-ops] packaged Node bootstrap failed; Agent sessions are disabled", error);
  });
  // Pi header 的 cwd 参与会话筛选。战斗模式不能用 process.cwd()：Finder、安装目录、
  // worktree 都会改变它。两个 Arcane-owned workspace 在 Win/macOS 都由 Electron
  // userData 派生；备团选过目录后改用真实项目 cwd。
  const workspaceRoot = path.join(app.getPath("userData"), "workspaces");
  const combatWorkspace = path.join(workspaceRoot, "combat");
  const prepFallbackWorkspace = path.join(workspaceRoot, "prep");
  mkdirSync(combatWorkspace, { recursive: true });
  mkdirSync(prepFallbackWorkspace, { recursive: true });
  // UI 只展示用户明确选择过的项目目录。prepFallbackWorkspace 只是让 Pi 在
  // 尚未选目录时也有稳定 cwd 的内部实现细节，不能冒充用户的备团项目。
  const prepUiCwd = () => prepStore.data.lastCwd ?? undefined;

  /** md 阅读器相对路径的 resolve 基准(spec §4.2):当前活动会话的工作目录。
      战斗模式下同样按此规则——一律用 prep cwd 会让战斗会话里的相对路径静默解析到
      别的目录、落"文件不存在"错误页,而用户看不出原因。会话未启动时退回备团目录。 */
  function noteBaseDir() {
    try {
      const cwd = modeController.snapshot().host?.cwd();
      if (cwd) return cwd;
    } catch {
      /* host 尚未启动 */
    }
    return prepUiCwd();
  }

  // Each mode owns a registry; command contexts capture an actual session host.
  const configuredCapacity = Number(process.env.ARCANE_TASK_CONCURRENCY ?? 2);
  const scheduler = new ExecutionScheduler({ capacity: Number.isInteger(configuredCapacity) && configuredCapacity >= 1 && configuredCapacity <= 16 ? configuredCapacity : 2 });
  const navigation = new SessionNavigation({ file: configPath("session-navigation.json"), emit: sendToRenderer });
  const listDiskSessions = async () => (await Promise.all(["prep", "combat"].map(mode => listStoredSessions(getAgentDir(), mode)))).flat();
  const reconciler = new StartupReconciler({ directory: configDir(), listSessions: listDiskSessions,
    navigation, activity: () => activityCenter });
  const hosts = {
    combat: new SessionRegistry({ cleanup: id => reconciler.cleanup(id), navigation, listStored: () => listStoredSessions(getAgentDir(), "combat"), createHost: (directory) => new AgentHost({
      foundryRuntime,
      getFoundryView: () => foundryView(),
      openFoundry: openFoundryView,
      sendToRenderer,
      providerStore,
      telemetry: telemetry?.forSession(), scheduler,
      runtimeReady: fvttOpsRuntimeReady,
      taskStorageDir: configPath("tasks"),
      getLocale: resolveLocale,
      profile: {
        getCwd: () => directory ?? combatWorkspace,
      },
    }) }),
    prep: new SessionRegistry({ cleanup: id => reconciler.cleanup(id), navigation, listStored: () => listStoredSessions(getAgentDir(), "prep"), createHost: (directory) => {
      const cwd = directory ?? prepStore.data.lastCwd ?? prepFallbackWorkspace;
      return new AgentHost({
      foundryRuntime,
      getFoundryView: () => foundryView(),
      openFoundry: openFoundryView,
      sendToRenderer,
      providerStore,
      telemetry: telemetry?.forSession(), scheduler,
      runtimeReady: fvttOpsRuntimeReady,
      taskStorageDir: configPath("tasks"),
      getLocale: resolveLocale,
      profile: {
        mode: "prep",
        getCwd: () => cwd,
        builtinTools: true,
        systemPrompt: "append",
        getSkillPaths: () => [skillsUpdater.resolveSkillsDir()],
        customToolNames: ["foundry_open", "foundry_screenshot", "browser_evaluate", "request_user_input"],
        fence: true,
        streamingInput: "followUp", // 备团:流式期间输入排队,不打断当前任务(见 docs/streaming-input-queue-spec.md)
      },
    }); } }),
  };
  const modeController = new ModeHostController({
    hosts,
    initialMode: readUiState().mode,
  });
  // Global provider changes visit resident sessions; task state stays on each host.
  const allSessionHosts = () => Object.values(hosts).flatMap(registry => registry.allHosts());
  activityCenter = new ActivityCenter({
    file: configPath("activity.json"),
    foreground: id => Boolean(mainWindow?.isFocused() && mainWindow?.isVisible()
      && modeController.snapshot().host?.describeCurrent()?.id === id),
    describe: id => {
      const host = allSessionHosts().find(host => host.describeCurrent()?.id === id);
      return host ? { ...host.describeCurrent(), mode: host.profile.mode } : null;
    },
    emit: sendToRenderer,
    notify: notice => {
      sendToRenderer({ type: "activity_notice", notice });
      desktopNotifications?.deliver(notice);
    },
    log: console.error,
  });
  try { await reconciler.run(); } catch (error) { console.error("[startup] conversation reconciliation failed", error.message); }
  desktopNotifications = new DesktopNotifications({ file: configPath("notifications.json"),
    supported: () => Notification.isSupported(),
    foreground: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && mainWindow.isVisible() && !mainWindow.isMinimized()),
    create: options => new Notification({ ...options, icon: ARCANE_APP_ICON }),
    lookup: id => activityCenter.get(id),
    text: kind => {
      const key = { completed: "chat.task.completed", failed: "chat.task.failed", waiting_user: "chat.task.waitingUser" }[kind];
      return globalThis.ARCANE_MESSAGES[resolveLocale()][key];
    },
    activate: () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
      sendToRenderer({ type: "notification_target" });
    }, log: console.error,
  });
  ipcMain.handle("notifications:get", event => isTrustedChatIpc(event) ? { ok: true, ...desktopNotifications.status() } : { ok: false });
  ipcMain.handle("notifications:set", (event, enabled) => isTrustedChatIpc(event) ? desktopNotifications.setEnabled(enabled) : { ok: false });
  ipcMain.handle("notifications:take-target", event => isTrustedChatIpc(event) ? desktopNotifications.takeTarget() : null);
  // Region 派生的对外链接（官网/社区支持）：renderer 不持有任何硬编码域名。
  ipcMain.handle("app:links", event => isTrustedChatIpc(event)
    ? { ok: true, region: REGION.region, websiteUrl: REGION.websiteUrl, supportLinks: REGION.supportLinks }
    : { ok: false });
  ipcMain.handle("activity:snapshot", event => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    return { ok: true, ...activityCenter.snapshot() };
  });
  ipcMain.handle("activity:opened", (event, sessionId) => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    if (typeof sessionId !== "string") return { ok: false, code: "INVALID_REQUEST" };
    return activityCenter.opened(sessionId);
  });

  function staleModeResponse() {
    const context = modeController.snapshot();
    return {
      ok: false,
      code: "STALE_MODE_CONTEXT",
      error: err("err.mode.staleContext"),
      ...modeController.publicSnapshot(context),
    };
  }

  async function validateModeRequest(request) {
    if (request?.sessionId) {
      let host;
      try {
        for (const registry of Object.values(hosts)) { host = await registry.getOrLoad(request.sessionId); if (host) break; }
      } catch (error) { return { ok: false, code: error.code ?? "SESSION_LOAD_FAILED", error: error.message }; }
      if (!host) return { ok: false, code: "SESSION_NOT_FOUND", error: "Session not found" };
      return { ok: true, context: { mode: host.profile.mode, generation: request.generation, host } };
    }
    await modeController.ensureStarted(modeController.snapshot().mode);
    const result = modeController.validateRequest(request);
    if (result.ok) return result;
    const key = "code" in result && result.code === "INVALID_MODE_CONTEXT"
      ? "err.mode.invalidContext"
      : "err.mode.staleContext";
    return { ...result, error: err(key) };
  }

  function activityHostPayload(host, historyQuery = undefined) {
    const payload = host.currentPayload(historyQuery);
    activityCenter.reconcile(payload, host.profile.mode);
    return payload;
  }

  async function currentModePayload() {
    const context = await modeController.readySnapshot();
    return {
      ...activityHostPayload(context.host),
      ...modeController.publicSnapshot(context),
      busy: context.host.busy,
      cwd: context.mode === "prep" ? context.host.cwd() : undefined,
      worldInfo: foundryRuntime.lastWorldInfo,
    };
  }

  Object.defineProperty(globalThis, "__arcaneAgentHost", { get: () => hosts.combat.activeHost });
  globalThis.__arcaneHosts = hosts;

  // ---- 模式切换 ----
  ipcMain.handle("mode:get", () => modeController.publicSnapshot());
  ipcMain.handle("mode:set", async (_event, mode) => {
    let switched;
    try {
      switched = await modeController.switchTo(mode);
    } catch (error) {
      return { ok: false, error: errorToIpc(error), ...modeController.publicSnapshot() };
    }
    const { host, requestedMode, stale, ...context } = switched;
    if (!stale) writeUiState({ mode: context.mode });
    return {
      ok: true,
      ...context,
      requestedMode,
      stale,
      busy: host.busy,
      ...activityHostPayload(host),
      cwd: context.mode === "prep" ? host.cwd() : undefined,
    };
  });

  // ---- 备团:工作目录 ----
  ipcMain.handle("prep:get-dir", () => ({ cwd: prepUiCwd() }));
  ipcMain.handle("prep:choose-dir", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok || validated.context.mode !== "prep") return staleModeResponse();
    const context = validated.context;
    if (!modeController.matches(context)) return staleModeResponse();
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    if (!modeController.matches(context)) return staleModeResponse();
    let cwd;
    try {
      cwd = prepStore.setCwd(picked.filePaths[0]);
    } catch (error) {
      return { ok: false, error: errorToIpc(error), ...modeController.publicSnapshot(context) };
    }
    const nextHost = await hosts.prep.select(null, true);
    nextHost.emit({ type: "session_switched", ...activityHostPayload(nextHost) });
    return { ok: true, cwd, ...modeController.publicSnapshot(context) };
  });

  // Navigation spans modes; commands resolve an owned session rather than the selected view.
  async function navigationRows() {
    const result = await Promise.all(["prep", "combat"].map(async mode => {
      return (await hosts[mode].listSessions()).map(row => ({ ...row, mode, projectKey: projectKey(row.cwd), activity: activityCenter.get(row.id) }));
    }));
    return result.flat();
  }
  async function navigationTarget(id) {
    const row = (await navigationRows()).find(row => row.id === id);
    if (!row) throw Object.assign(new Error("Session not found"), { code: "SESSION_NOT_FOUND" });
    const registry = hosts[row.mode];
    if (!registry.get(id)) await registry.select(row.path, false, -1);
    const host = registry.get(id);
    if (!host) throw Object.assign(new Error("Session not found"), { code: "SESSION_NOT_FOUND" });
    return { row, registry, host };
  }
  ipcMain.handle("sessions:navigation", async event => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    try { return { ok: true, sessions: await navigationRows(), warning: navigation.error }; }
    catch (error) { return { ok: false, code: error.code, error: error.message }; }
  });
  for (const [channel, action] of [["setPinned", "pin"], ["rename", "rename"], ["archive", "archive"], ["restore", "restore"]]) {
    ipcMain.handle("sessions:" + channel, async (event, request) => {
      if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
      try {
        const { row, host } = await navigationTarget(request?.sessionId);
        const metadata = navigation.mutate(row.id, action, action === "pin" ? request.pinned : request.title, host);
        return { ok: true, sessionId: row.id, metadata };
      } catch (error) { return { ok: false, code: error.code ?? "NAVIGATION_FAILED", error: error.message }; }
    });
  }
  ipcMain.handle("sessions:deleteArchived", async (event, request) => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    try {
      const { row, registry } = await navigationTarget(request?.sessionId);
      const result = await registry.deleteSession(row.path);
      return result;
    } catch (error) { return { ok: false, code: error.code ?? "SESSION_DELETE_FAILED", error: error.message }; }
  });
  ipcMain.handle("sessions:fork", async (event, request) => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    try {
      const title = typeof request?.title === "string" ? request.title.trim() : "";
      if (title.length > 200) throw Object.assign(new Error("Use a title between 1 and 200 characters"), { code: "INVALID_TITLE" });
      const { row, host } = await navigationTarget(request?.sessionId);
      if (row.archivedAt != null) throw Object.assign(new Error("Restore the session before forking it"), { code: "SESSION_ARCHIVED" });
      const forked = await host.fork();
      const metadata = { ...(title ? { customTitle: title } : {}), ...(row.selectedModel ? { selectedModel: row.selectedModel } : {}) };
      if (Object.keys(metadata).length) navigation.patch(forked.id, metadata);
      return { ok: true, sessionId: forked.id, path: forked.path };
    } catch (error) { return { ok: false, code: error.code ?? "SESSION_FORK_FAILED", error: error.message }; }
  });

  // ---- 会话管理(按活动模式路由；模式由 Pi sessionDir + JSONL marker 固有隔离) ----
  ipcMain.handle("sessions:list", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const list = await hosts[context.mode].listSessions();
    return {
      ok: true,
      ...modeController.publicSnapshot(context),
      sessions: list.map(row => ({ ...row, activity: activityCenter.get(row.id) })),
    };
  });
  ipcMain.handle("sessions:current", async () => {
    // readySnapshot 在模式变化时重试，响应中的 mode/host/history 必定来自同一快照。
    return currentModePayload();
  });
  ipcMain.handle("sessions:snapshot", async (_event, sessionId, historyQuery) => {
    if (!isTrustedChatIpc(_event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    let host;
    try {
      for (const registry of Object.values(hosts)) { host = await registry.getOrLoad(sessionId); if (host) break; }
    } catch (error) { return { ok: false, code: error.code ?? "SESSION_LOAD_FAILED", error: error.message }; }
    if (!host) return { ok: false, code: "SESSION_NOT_FOUND" };
    try { return { ok: true, ...activityHostPayload(host, historyQuery), mode: host.profile.mode, cwd: host.cwd() }; }
    catch (error) { return { ok: false, code: error.code ?? "HISTORY_LOAD_FAILED", error: error.message }; }
  });
  ipcMain.handle("sessions:identities", async event => {
    if (!isTrustedChatIpc(event)) return { ok: false };
    try { return { ok: true, sessionIds: (await listDiskSessions()).map(row => row.id) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("sessions:new", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const selection = ++hosts[context.mode].selection;
    let directory;
    if (request?.cwd != null) {
      directory = String(request.cwd);
      try { if (!path.isAbsolute(directory) || !statSync(directory).isDirectory()) throw new Error("Project directory is unavailable"); }
      catch (error) { return { ok: false, code: "PROJECT_UNAVAILABLE", error: error.message }; }
    }
    const nextHost = await hosts[context.mode].select(null, true, selection, directory);
    return { ok: true, ...activityHostPayload(nextHost), cwd: nextHost.cwd(), ...modeController.publicSnapshot(context) };
  });
  ipcMain.handle("sessions:open", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const selection = ++hosts[context.mode].selection;
    const sessionPath = String(request?.path ?? "");

    try {
      const nextHost = await hosts[context.mode].select(sessionPath, false, selection);
      return { ok: true, ...activityHostPayload(nextHost), cwd: nextHost.cwd(), ...modeController.publicSnapshot(context) };
    } catch (error) { return { ok: false, code: error.code ?? "SESSION_OPEN_FAILED", error: error.message }; }
  });
  ipcMain.handle("sessions:delete", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const sessionPath = String(request?.path ?? "");

    let result;
    try { result = await hosts[context.mode].deleteSession(sessionPath); }
    catch (error) { return { ok: false, code: error.code, error: error.message }; }
    return result;
  });

  // ---- 设置:LLM provider 管理 + 默认模型(默认只影响新会话;会话内切换走 chat:set-model) ----
  ipcMain.handle("settings:get", async (event) => {
    if (!isTrustedChatIpc(event)) return { providers: [], defaultModel: null, models: [] };
    const settings = providerStore.toPublic();
    const { host } = await modeController.readySnapshot();
    const models = await host.listModels();
    const known = new Set(models.map((model) => model.label));
    // Pi only reports models with usable auth. Settings must still show an unconfigured
    // Arcane Spark so a first-run user can select it and reach its Key field.
    for (const provider of settings.providers) {
      for (const model of provider.models) {
        const label = `${provider.id}/${model.id}`;
        if (known.has(label)) continue;
        models.push({ providerId: provider.id, modelId: model.id, label, name: model.name ?? model.id });
        known.add(label);
      }
    }
    return { ...settings, models };
  });
  ipcMain.handle("settings:model-access", async (event, request) => {
    if (!isTrustedChatIpc(event)) return { missingKey: null };
    const validated = await validateModeRequest(request);
    if (!validated.ok) return { ...validated, missingKey: null };
    const model = validated.context.host.currentModelRef();
    return { model, missingKey: validated.context.host.missingApiKeyForCurrentModel() };
  });

  // Saving credentials can activate a model already selected by a session;
  // it cannot assign the global default to an existing empty conversation.
  async function activateSelectedModels(providerId) {
    const results = await Promise.all(
      allSessionHosts().map(async (host) => {
        const selected = host.currentModelRef();
        if (host.busy || selected?.providerId !== providerId) return { ok: true, skipped: true };
        return host.setCurrentModel(selected.providerId, selected.modelId);
      }),
    );
    return results.find((result) => !result?.ok) ?? { ok: true };
  }

  /** 删除 provider 后的定向回退:只切"正在用被删 provider"或"尚无模型"的会话。 */
  async function fallbackSessionsOffProvider(providerId) {
    const fallback = providerStore.effectiveModel();
    if (!fallback) return { ok: true };
    const results = await Promise.all(
      allSessionHosts().map(async (host) => {
        const sessionModel = host.session?.model;
        if (sessionModel && host.currentModelRef()?.providerId !== providerId) {
          return { ok: true, skipped: true };
        }
        return host.setCurrentModel(fallback.providerId, fallback.modelId);
      }),
    );
    return results.find((result) => !result?.ok) ?? { ok: true };
  }

  ipcMain.handle("settings:save-provider", async (event, input) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const result = providerStore.upsertProvider(input ?? {});
    if (result.ok) {
      for (const host of allSessionHosts()) {
        if (host.modelRuntime) providerStore.applyToRuntime(host.modelRuntime);
      }
      const providerId = String(input?.id ?? "").trim();
      const activated = await activateSelectedModels(providerId);
      if (!activated.ok) return { ...activated, saved: true };
    }
    return result;
  });
  ipcMain.handle("settings:delete-provider", async (event, id) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const providerId = String(id ?? "");
    const result = providerStore.removeProvider(providerId);
    if (result.ok) {
      const switched = await fallbackSessionsOffProvider(providerId);
      if (!switched.ok) return { ...switched, deleted: true };
    }
    return result;
  });
  ipcMain.handle("settings:default-model", async (event, pref) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const pid = String(pref?.providerId ?? "");
    const mid = String(pref?.modelId ?? "");
    const selection = pid && mid ? { providerId: pid, modelId: mid } : null;
    const target = providerStore.modelForSelection(selection);
    if (!target) return { ok: false, error: "no default model available" };
    providerStore.setDefaultModel(pid, mid);
    return { ok: true, model: target };
  });

  // 会话内模型切换(输入框旁的选择器):只作用于当前模式的当前会话,
  // model_change 落进该会话自己的 JSONL;不影响其他会话,也不改全局默认。
  ipcMain.handle("chat:set-model", async (event, request) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const providerId = String(request?.providerId ?? "");
    const modelId = String(request?.modelId ?? "");
    if (!providerId || !modelId) return { ok: false, error: "invalid model selection" };
    const result = await validated.context.host.setCurrentModel(providerId, modelId);
    if (!result?.ok) return { ...result, ...modeController.publicSnapshot(validated.context) };
    return { ...result, model: { providerId, modelId }, ...modeController.publicSnapshot(validated.context) };
  });
  // ---- 隐私:正式版首次明确选择 + 设置页随时撤回 ----
  const unavailableTelemetryStatus = () => ({
    available: false,
    userControllable: false,
    enabled: false,
    decided: false,
    recording: false,
    mode: "unavailable",
  });
  ipcMain.handle("telemetry:consent-get", (event) => {
    if (!isTrustedChatIpc(event)) return unavailableTelemetryStatus();
    try {
      return telemetry?.consentStatus() ?? unavailableTelemetryStatus();
    } catch {
      return unavailableTelemetryStatus();
    }
  });
  ipcMain.handle("telemetry:consent-set", async (event, enabled) => {
    if (!isTrustedChatIpc(event)) {
      return { ok: false, reason: "untrusted", status: unavailableTelemetryStatus() };
    }
    try {
      const before = telemetry?.consentStatus() ?? unavailableTelemetryStatus();
      if (!telemetry || !before.userControllable) {
        return { ok: false, reason: "not-controllable", status: before };
      }
      if (enabled === true) await telemetry.consentEnabled();
      else if (enabled === false) await telemetry.consentDisabled();
      else return { ok: false, reason: "invalid-choice", status: before };
      return { ok: true, status: telemetry.consentStatus() };
    } catch (error) {
      console.log("[telemetry] consent change failed:", error?.message ?? error);
      let status = unavailableTelemetryStatus();
      try {
        status = telemetry?.consentStatus() ?? status;
      } catch {
        /* status fallback stays privacy-safe */
      }
      return { ok: false, reason: "persist-failed", status };
    }
  });
  // ---- 网站权限:只接受本地 Chat 主 frame 的响应与设置操作 ----
  ipcMain.handle("permissions:respond", async (event, payload) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: "untrusted permission response" };
    const decision = payload?.decision;
    const pending = webPermissionPolicy.pendingInfo(payload?.requestId);
    if (process.platform === "darwin" && pending?.permission === "media" &&
        (decision === "allow-session" || decision === "allow-persist")) {
      for (const mediaType of pending.mediaTypes) {
        const systemType = mediaType === "video" ? "camera" : "microphone";
        try {
          const status = systemPreferences.getMediaAccessStatus(systemType);
          if (status !== "granted" && !(await systemPreferences.askForMediaAccess(systemType))) {
            webPermissionPolicy.respond(payload?.requestId, "deny");
            return { ok: false, error: err("err.permission.systemDenied", { media: mediaType }) };
          }
        } catch (error) {
          webPermissionPolicy.respond(payload?.requestId, "deny");
          return { ok: false, error: error.message };
        }
      }
    }
    return webPermissionPolicy.respond(payload?.requestId, decision);
  });
  ipcMain.handle("permissions:list", (event) => {
    if (!isTrustedChatIpc(event)) return [];
    return webPermissionPolicy.listPersisted();
  });
  ipcMain.handle("permissions:revoke", (event, payload) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: "untrusted permission change" };
    return webPermissionPolicy.revoke(payload?.origin, payload?.key);
  });
  ipcMain.handle("permissions:clear", (event, origin) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: "untrusted permission change" };
    return webPermissionPolicy.clearOrigin(origin);
  });
  ipcMain.handle("display-source:respond", (event, payload) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: "untrusted display response" };
    return displayMediaController.respond(payload?.requestId, payload?.sourceId, payload?.includeAudio);
  });
  // provider 预设目录(设置页"模板"下拉)与 GET /models 拉取。
  // 拉取时 apiKey 留空或打码值("••••xxxx")= 仅在 credential target 不变时复用已保存 key。
  ipcMain.handle("providers:catalog", (event) => isTrustedChatIpc(event) ? listPresets() : []);
  ipcMain.handle("providers:fetch-models", (event, input) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const api = String(input?.api ?? "openai-completions");
    if (api !== "openai-completions") {
      return { ok: false, error: err("err.fetch.apiUnsupported") };
    }
    const credential = providerStore.resolveCredentialForRequest(input);
    if (!credential.ok || !("apiKey" in credential)) return credential;
    return fetchModels({ baseUrl: credential.baseUrl, apiKey: credential.apiKey });
  });
  ipcMain.handle("app:open-arcane-website", async () => {
    await shell.openExternal(ARCANE_WEBSITE_URL);
    return { ok: true };
  });
  ipcMain.handle("app:get-version", () => app.getVersion());

  // ---- 语音输入:ASR 配置 + 识别(智谱直连 / Arcane 中转,上游都是 GLM-ASR-2512) ----
  // 单 Key:relay 模式默认复用内置 arcane-spark provider 的 Key/地址(方案文档第 9 节)
  const arcaneSparkForVoice = () => {
    return providerStore.credentialForProvider("arcane-spark");
  };
  ipcMain.handle("voice:get-config", (event) => {
    if (!isTrustedChatIpc(event)) return null;
    return voiceStore.toPublic(arcaneSparkForVoice());
  });
  ipcMain.handle("voice:save-config", (event, input) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    return voiceStore.update(input ?? {}, arcaneSparkForVoice());
  });
  // macOS 麦克风要系统级授权:首次录音前调用,未授权则向系统申请;
  // 被拒时返回 false,renderer 提示用户去系统设置开。Windows/Linux 恒 true。
  ipcMain.handle("voice:ensure-mic", async (event) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    if (process.platform !== "darwin") return { ok: true };
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return { ok: true };
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return granted
      ? { ok: true }
      : { ok: false, error: err("err.voice.micDenied") };
  });
  ipcMain.handle("voice:transcribe", async (event, wav) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const spark = arcaneSparkForVoice();
    if (!voiceStore.usable(spark)) {
      return { ok: false, error: err("err.voice.notUsable") };
    }
    const buffer = Buffer.isBuffer(wav) ? wav : Buffer.from(wav ?? new ArrayBuffer(0));
    if (buffer.length < 1000) return { ok: false, error: err("err.voice.tooShort") };
    if (buffer.length > 25 * 1024 * 1024) return { ok: false, error: err("err.voice.tooLarge") };
    const credentials = voiceStore.credentialForUse(spark);
    try {
      const result = await transcribe({
        provider: voiceStore.data.provider,
        apiKey: credentials.apiKey,
        baseUrl: credentials.baseUrl,
        wavBuffer: buffer,
        prompt: voiceStore.data.prompt,
        hotwords: voiceStore.data.hotwords,
      });
      return { ok: true, text: result.text, latency: result.latency };
    } catch (error) {
      return { ok: false, error: errorToIpc(error) };
    }
  });

  // slash 命令:pi 原生展开 /skill:name 与 prompt 模板(session.prompt 内建),
  // 这里补两件 pi SDK 不管的事——列举候选(给输入框弹窗)与 app 级命令(/compact)。
  // TUI 的 BUILTIN_SLASH_COMMANDS 是终端 UI 命令,SDK 模式不生效,不往这里搬。
  const APP_SLASH_COMMANDS = [
    // 描述/提示是 UI 文案:传字典 key,渲染层按当前语言解析
    { name: "compact", descriptionKey: "slashCmd.compact.desc", argumentHintKey: "slashCmd.compact.hint" },
  ];
  ipcMain.handle("slash:list", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const { skills, templates } = context.host.listSlashCommands();
    return {
      ok: true,
      ...modeController.publicSnapshot(context),
      commands: APP_SLASH_COMMANDS,
      skills,
      templates,
    };
  });

  // 图片附件:数量/类型/大小白名单(base64 字符数 ≈ 字节数 * 4/3)
  const IMAGE_MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  const MAX_IMAGES = 6;
  const MAX_IMAGE_B64 = 2 * 1024 * 1024; // 与 renderer 单图上限一致；总请求适配 16MB 网关合同
  function sanitizeImages(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw.slice(0, MAX_IMAGES)) {
      const mime = String(item?.mimeType ?? "");
      const data = String(item?.data ?? "");
      if (!IMAGE_MIME_EXT[mime] || !data || data.length > MAX_IMAGE_B64) continue;
      out.push({ type: "image", data, mimeType: mime });
    }
    return out;
  }

  // 备团模式收到图片:除视觉输入外,落盘到 cwd/.arcane/inbox/ 并把路径写进 prompt——
  // agent 有 bash/read/write,拿到文件路径才能做"换头像"这类文件操作(模型无法输出二进制)。
  function savePrepInboxImages(host, images, commandId) {
    const dir = path.join(host.cwd(), ".arcane", "inbox");
    mkdirSync(dir, { recursive: true });
    const stamp = /^[a-zA-Z0-9-]{1,80}$/.test(commandId ?? "") ? commandId : new Date().toISOString().replace(/[:.]/g, "-");
    return images.map((img, i) => {
      const file = path.join(dir, `${stamp}-${i + 1}.${IMAGE_MIME_EXT[img.mimeType]}`);
      writeFileSync(file, Buffer.from(img.data, "base64"));
      return file;
    });
  }

  ipcMain.handle("chat:prompt", async (_event, payload) => {
    // 兼容旧形参:历史调用是 prompt(text),现在是 { text, images }
    let message = typeof payload === "string" ? payload : String(payload?.text ?? "");
    // 只按用户原始输入计算 bucket；prep 后续追加的本地 inbox 路径不能污染遥测。
    const telemetryInputText = message;
    const images = sanitizeImages(typeof payload === "string" ? null : payload?.images);
    if (!message && images.length === 0) return { ok: false, error: "empty message" };
    const validated = await validateModeRequest(typeof payload === "string" ? null : payload);
    if (!validated.ok) return validated;
    const context = validated.context;
    const { mode, host } = context;
    try {
      try { if (!statSync(host.cwd()).isDirectory()) throw new Error("Missing directory"); }
      catch { return { ok: false, code: "PROJECT_UNAVAILABLE", error: err("navigation.missingProject") }; }
      const missingKey = host.missingApiKeyForCurrentModel();
      if (missingKey) {
        return {
          ok: false,
          code: "MODEL_PROVIDER_KEY_REQUIRED",
          error: err("err.chat.modelNotConfigured"),
          ...missingKey,
        };
      }
      // app 级命令:/compact [instructions] → pi 手动压缩;compaction 期间禁止并发 prompt
      if (message === "/compact" || message.startsWith("/compact ")) {
        if (host.busy) return { ok: false, error: err("err.chat.busyCompact"), compacted: true };
        const instructions = message.slice("/compact".length).trim();
        try {
          const result = await host.compact(instructions);
          return { ...result, compacted: true, ...modeController.publicSnapshot(context) };
        } catch (error) {
          // compacted 标记让 renderer 不再重复报错(compaction_end 事件已透出)
          return { ok: false, error: error.message, compacted: true };
        }
      }
      const prepare = (text) => {
        if (images.length > 0 && mode === "prep") {
          try {
            const files = savePrepInboxImages(host, images, payload?.commandId);
            text += `\n\n[附带图片已存为本地文件:${files.join("; ")}]`;
          } catch (error) {
            console.log("[agent] save inbox images failed:", error.message);
          }
        }
        return text;
      };
      const result = host.submitInput(message, images, payload?.commandId, prepare, payload?.replacesInputId);
      if (result.ok && !result.duplicate) {
        if (result.disposition !== "new_task") {
          // delivery="followUp" 是排队(备团);null/"steer" 维持原 turnSteered 口径(见 spec §3④)。
          if (result.delivery === "followUp") host.telemetry?.turnQueued(mode);
          else host.telemetry?.turnSteered(mode);
        }
        host.telemetry?.inputSubmitted(mode, telemetryInputText, images.length, typeof payload === "object" ? payload?.submitMethod : undefined);
      }
      return { ...result, ...modeController.publicSnapshot(context) };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/No API key found/i.test(message)) {
        const missingKey = host.missingApiKeyForCurrentModel();
        return {
          ok: false,
          code: "MODEL_PROVIDER_KEY_REQUIRED",
          error: err("err.chat.modelNotConfigured"),
          ...(missingKey ?? {}),
        };
      }
      return { ok: false, error: message, ...(error?.code ? { code: error.code } : {}) };
    }
  });

  ipcMain.handle("approval:respond", (_event, payload) => {
    // 审批只有战斗模式会发;两个 host 各自查自己的 approvals map,天然路由
    for (const host of allSessionHosts()) {
      host.respondApproval(payload?.approvalId, payload?.approved);
    }
    return { ok: true };
  });

  ipcMain.handle("chat:abort", async (_event, request) => {
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const result = await validated.context.host.abort(request?.taskId);
    return { ...result, ...modeController.publicSnapshot(validated.context) };
  });
  ipcMain.handle("tasks:respond", async (event, request) => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    return validated.context.host.taskCoordinator().respond(request);
  });
  ipcMain.handle("chat:queued-input", async (event, request) => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    const validated = await validateModeRequest(request);
    if (!validated.ok) return validated;
    const { host, mode } = validated.context;
    // 队列操作仅备团:战斗的 queued 是 steer 瞬时态,无 UI 入口,只允许防御性拒绝。
    if (mode !== "prep") return { ok: false, code: "WRONG_MODE" };
    const inputId = typeof request?.inputId === "string" ? request.inputId : null;
    const action = request?.action;
    if (!inputId || !["cancel", "steer"].includes(action)) return { ok: false, code: "INVALID_REQUEST" };
    const coordinator = host.taskCoordinator();
    const result = action === "cancel" ? coordinator.cancelQueuedInput(inputId) : coordinator.steerQueuedInput(inputId);
    // 排队已记 turnQueued;改道立即发送与取消排队成双,记 turnSteered。
    if (result.ok && action === "steer") host.telemetry?.turnSteered(mode);
    return { ...result, ...modeController.publicSnapshot(validated.context) };
  });

  // 主题持久化:renderer 切换主题时写 userData/config/ui.json,
  // 下次启动 createWindow 用它决定 backgroundColor + 首屏 query。
  ipcMain.handle("ui:theme", (_event, theme) => {
    const next = theme === "light" ? "light" : "dark";
    try {
      writeFileSync(
        configPath("ui.json"),
        JSON.stringify({ ...readUiState(), theme: next })
      );
    } catch {
      /* ignore */
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(next === "light" ? "#f0e9d6" : "#0c0f16");
      syncTitleBarOverlay();
    }
    // 阅读器页不重读文件,只收一条主题广播(spec §7 arcaneReader.onTheme)。
    panelSurfaces?.setTheme(next);
    return { ok: true };
  });

  // 界面语言持久化(设置页「通用」tab):auto = 每次启动跟随系统,显式值 = 锁定。
  // 渲染层热切换已自行完成,这里只落盘;下次启动 resolveLocale() 消费。
  ipcMain.handle("ui:locale", (_event, pref) => {
    const next = UI_LOCALES.includes(pref) ? pref : "auto";
    writeUiState({ locale: next });
    // 与 ui:theme 对称:阅读器页也热切换语言,不必销毁重建(review M2)。
    // auto 推解析后的值:阅读器页拿不到 ui.json,无法自己跟随系统。
    panelSurfaces?.setLocale(next === "auto" ? resolveLocale() : next);
    return { ok: true, pref: next };
  });
  ipcMain.handle("ui:get-locale", () => {
    const saved = readUiState().locale;
    return { pref: UI_LOCALES.includes(saved) ? saved : "auto", resolved: resolveLocale() };
  });

  // 顶栏"面板"开关:右屏唯一的 chrome 开关(spec §3.2 ①)。三个动作全部委托控制器——
  // 它同时管 foundry 与 reader 两个 surface,重开时按 lastContent 恢复关闭前的内容(§3.4 CLOSED 行)。
  const panelOperations = {
    open: () => panelSurfaces.openPanel(),
    close: () => panelSurfaces.closePanel(),
    // F5 改为 surface 感知(spec §4.3):foundry → 等导航与巡检完成再报;reader → 重读当前文件。
    // 于是 READER_C 下的 F5 不再静默哑掉(design-rules R5)。
    reload: () => panelSurfaces.reloadSurface(),
  };
  for (const action of ["open", "close", "reload"]) {
    ipcMain.handle(`panel:${action}`, async event => {
      if (!isTrustedChatIpc(event)) return { ok: false };
      try { return await panelOperations[action](); }
      catch (error) { return { ok: false, error: error.message }; }
    });
  }

  // ---- Markdown 阅读器(spec §7) ----
  // ② chat 里点 md 路径。信任边界 ①:只认 chat 主 frame;路径规范化与围栏在
  // md-reader-note.js 里一次做完,这里不重复校验(design-rules R1)。
  // 读链失败也照样进阅读器——错误页渲染在阅读器里,不在 chat 弹任何东西(R5)。
  ipcMain.handle("md-reader:open", (event, rawPath) => {
    if (!isTrustedChatIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    if (typeof rawPath !== "string" || !rawPath.trim()) return { ok: false, code: "INVALID_REQUEST" };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, code: "NO_WINDOW" };
    try { return panelSurfaces.showReader(rawPath); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  // ③ 阅读器顶栏返回/关闭与 Esc。来源校验对齐 isTrustedChatIpc 的形状:
  // 只认阅读器自己的主 frame,chat 页面与 Foundry 页面都调不到它。
  ipcMain.handle("md-reader:back", event => {
    if (!isTrustedReaderIpc(event)) return { ok: false, code: "UNTRUSTED_CALLER" };
    try { return panelSurfaces.leaveReader(); }
    catch (error) { return { ok: false, error: error.message }; }
  });


  // 分栏拖拽:renderer 本地先动(体感零延迟),节流同步到 main 调整右屏 view 宽度。
  ipcMain.handle("panel:set-chat-width", (_event, px) => {
    const n = Number(px);
    if (!Number.isFinite(n)) return { ok: false };
    chatWidthPx = Math.round(n);
    layoutViews();
    return { ok: true };
  });
  // 拖拽期间让当前可见 view 的鼠标事件穿透到下层 chat 页面:指针划过左屏时
  // chat 仍能收到 pointermove/pointerup,拖拽不会在分栏边界"断流"。
  // 作用于 activeView():只绑 foundryView 的话,拖拽划过阅读器会在边界断流(spec §8)。
  ipcMain.handle("panel:drag-start", () => {
    panelSurfaces?.setPointerPassthrough(true);
    return { ok: true };
  });
  ipcMain.handle("panel:drag-end", () => {
    panelSurfaces?.setPointerPassthrough(false);
    layoutViews();
    return { ok: true };
  });

  prepareExit = async () => {
    const registries = Object.values(hosts);
    for (const registry of registries) {
      registry.closing = true;
      for (const host of registry.allHosts()) host.closing = true;
    }
    const stopHosts = allSessionHosts().map(async host => {
      try {
        host.session?.abortCompaction?.();
        await host.abort(host.task?.id);
        await host.waitForOperations();
        host.dispose();
      } catch (error) { console.error("[quit] host cleanup failed", error); }
    });
    await Promise.allSettled([...stopHosts,
      ...registries.flatMap(registry => [...registry.pending.values(), ...registry.deleting.values()]),
      telemetry?.close()]);
  };
  const reclaimTimer = setInterval(() => { for (const registry of Object.values(hosts)) registry.prune(); }, 60_000);
  reclaimTimer.unref();

  // agent session 的首次启动(拉起子进程,慢则秒级)必须放在所有 ipcMain.handle
  // 注册之后:await 会挂起 whenReady 回调,若注册被它截断,已加载的 renderer 的
  // invoke(如 telemetry:consent-get)会撞上 "No handler registered"。
  // handler 内部各自懒调 ensureStarted(共享同一 Promise),不会因顺序变化重复启动。
  try {
    await modeController.ensureStarted(modeController.snapshot().mode);
    // renderer 可能在 agent 就绪前就加载完(或之后):双方都拉一次 sessions:current,
    // 这个推送让早加载的 renderer 知道可以拉历史了。
    sendToRenderer({ type: "agent_ready" });
  } catch (error) {
    console.log("[agent] start failed:", error.message);
  }

  app.on("activate", () => {
    restoreMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", event => {
  if (!quitAllowed) { event.preventDefault(); requestExit(); return; }
  backgroundTray?.destroy(); backgroundTray = null;
  activityCenter?.flush();
  clearFoundryPermissionState("app-quit");
});
