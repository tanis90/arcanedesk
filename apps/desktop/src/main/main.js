import { app, BrowserWindow, desktopCapturer, dialog, Menu, WebContentsView, ipcMain, safeStorage, session, shell, systemPreferences } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import { configPath, migrateLegacyConfig } from "./config-dir.js";
import { VoiceStore } from "./voice/voice-store.js";
import { transcribe } from "./voice/asr.js";
import { WebPermissionStore } from "./permissions/web-permission-store.js";
import { WebPermissionPolicy } from "./permissions/web-permission-policy.js";
import { DisplayMediaController, installDevicePermissionDenials } from "./permissions/display-media.js";
import { err, errorToIpc } from "./i18n-error.mjs";
import { bootstrapFvttOpsRuntime } from "./fvtt-ops-runtime.mjs";
import { applyArcaneSubprocessEnvironment } from "./subprocess-env.mjs";
import { SecretStorage } from "./secret-storage.js";

// Pi shell tools and other Arcane-owned child processes inherit process.env.
// Establish the Windows UTF-8 contract before creating any of them.
applyArcaneSubprocessEnvironment();

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
const ARCANE_WEBSITE_URL = process.env.ARCANE_WEBSITE_URL || "https://arcanedesk.bitterbebop.cn";
const CHAT_WIDTH_RATIO = 0.3;
const CHAT_MIN_WIDTH = 320;
const CHAT_MAX_RATIO = 0.65;
const FOUNDRY_MIN_WIDTH = 640;
const SPLITTER_GUTTER = 6; // 分隔条占用的 chat 侧像素(归 chat 页面,接收拖拽事件)

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
let foundryView = null; // 按需创建:agent 调 foundry_open 或用户点顶栏开关时才打开
let foundryRuntime = null; // app 生命周期内唯一实例；始终通过 getter 访问当前 Foundry view
let telemetry = null; // 遥测总入口;授权默认关闭,开发版本地记录(§3.1)
let chatWidthPx = null; // 用户可拖;null = 按比例初始化
let foundryPermissionOrigin = null; // 仅在确认目标确为 Foundry 后设为 exact origin
let webPermissionPolicy = null;
let displayMediaController = null;

function sendToRenderer(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("arcane:event", event);
  }
}

function isTrustedChatIpc(event) {
  const chat = mainWindow?.webContents;
  if (!chat || event?.sender !== chat) return false;
  const senderFrameId = event.senderFrame?.frameTreeNodeId;
  return senderFrameId != null && senderFrameId === chat.mainFrame?.frameTreeNodeId;
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

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  if (!foundryView) {
    // 无面板:chat 全屏
    return;
  }
  const chatWidth = effectiveChatWidth(width);
  // chat 居左,Foundry 主视觉从右侧弹出。
  foundryView.setBounds({
    x: chatWidth + SPLITTER_GUTTER,
    y: 0,
    width: Math.max(0, width - chatWidth - SPLITTER_GUTTER),
    height,
  });
  // chat 页面是整窗的,告诉 renderer 把内容让出右屏(margin-right),
  // 否则 chat 内容被 Foundry view 直接盖住。
  sendToRenderer({ type: "panel_layout", open: true, chatWidth, gutter: SPLITTER_GUTTER });
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

/**
 * foundry_open 的宿主实现。
 * 幂等:面板已开且与目标同源时绝不导航(保护已登录的 world 会话)。
 * 只有跨源或当前页面失效时才导航。
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

  // 面板 renderer 可能已崩溃/被销毁:不可复用,重建
  if (foundryView && (!foundryView.webContents || foundryView.webContents.isDestroyed())) {
    foundryRuntime?.invalidate();
    clearFoundryPermissionState("foundry-renderer-gone");
    try {
      mainWindow?.contentView.removeChildView(foundryView);
    } catch {
      /* view already detached */
    }
    foundryView = null;
  }

  if (!foundryView) {
    foundryView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    mainWindow.contentView.addChildView(foundryView);
    const panelWebContents = foundryView.webContents;
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
    panelWebContents.once("destroyed", () => {
      foundryRuntime?.invalidate();
      clearFoundryPermissionState("foundry-view-destroyed");
    });
    if (isDev) foundryView.webContents.openDevTools({ mode: "detach" });
    sendToRenderer({ type: "panel_status", open: true });
    layoutViews(); // 立刻让出左屏,不等首次 load 完成
    syncTitleBarOverlay(); // 右上 overlay 三键换深色,融进 FVTT 区
    // 有记住的登录态:先回填 cookie,直接进 /game,跳过 /join
    const restored = await restoreSessionCookie(foundryView, origin);
    const initialUrl = restored ? new URL("/game", origin).href : target;
    const loaded = await loadFoundryPage(initialUrl);
    if (!loaded.ok) return loaded;
    dropIfSessionRejected(foundryView, origin, restored);
    void rememberSessionCookie(foundryView, origin);
    return { ok: true, page: loaded.page, summary: await describePanel(target, loaded.page) };
  }

  const current = foundryView.webContents.getURL();
  if (sameOrigin(current, target)) {
    // Same-origin idempotence only protects a real Foundry page. Chromium keeps
    // the failed URL after ERR_CONNECTION_RESET, so origin equality alone can
    // otherwise turn a blank/error page into a false-success tool result.
    const inspected = await readFoundryPageState(foundryView.webContents);
    if (inspected.ok && inspected.state?.detected) {
      trustFoundryPermissionOrigin(current);
      return { ok: true, page: inspected.state, summary: await describePanel(current, inspected.state) };
    }
    const retryUrl = current || target;
    let loaded = await loadFoundryPage(retryUrl);
    let landedUrl = retryUrl;
    if (!loaded.ok && retryUrl !== target) {
      // 当前页可能死在 Foundry 自己的错误页(如 /no "Critical Failure!"):
      // 原地重载只会复现同一页面、检测永远失败。退回 target 让服务器重新
      // 路由到 /setup、/license 或 /join。
      loaded = await loadFoundryPage(target);
      landedUrl = target;
    }
    if (!loaded.ok) return loaded;
    return { ok: true, page: loaded.page, summary: await describePanel(landedUrl, loaded.page) };
  }
  const restored = await restoreSessionCookie(foundryView, origin);
  const navUrl = restored ? new URL("/game", origin).href : target;
  const loaded = await loadFoundryPage(navUrl);
  if (!loaded.ok) return loaded;
  dropIfSessionRejected(foundryView, origin, restored);
  void rememberSessionCookie(foundryView, origin);
  return { ok: true, page: loaded.page, summary: await describePanel(target, loaded.page) };
}

async function loadFoundryPage(url) {
  try {
    await foundryView.webContents.loadURL(url);
  } catch (error) {
    return {
      ok: false,
      error: err("err.panel.loadFailed", { url, error: error.message }),
      summary: `ERROR: failed to load ${url}: ${error.message}`,
    };
  }
  const inspected = await readFoundryPageState(foundryView.webContents);
  if (!inspected.ok) {
    return {
      ok: false,
      error: err("err.panel.inspectFailed", { error: inspected.error ?? inspected.status }),
      summary: `ERROR: ${url} loaded but the page could not be inspected (${inspected.error ?? inspected.status})`,
    };
  }
  if (!inspected.state?.detected) {
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
  const inspected = knownState ? { ok: true, state: knownState } : await readFoundryPageState(foundryView?.webContents);
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

/** Win 隐藏标题栏的 overlay 三键配色:FVTT 面板打开时融进右侧深色区,否则随主题(底色 = header 的 --bg-soft)。
    height 是 overlay 唯一能调尺寸的旋钮(width 由 Windows 画死、按钮钉在窗口顶边,挪不下来):
    面板关 = 44,与 44px 天头的图标垂直对齐;面板开 = 32,矮一档少压 FVTT 右上 UI
    (此时三键和天头图标隔着整块面板,高差看不出来)。 */
function titleBarOverlayFor(theme, panelOpen) {
  if (panelOpen) return { color: "#10141d", symbolColor: "#e9ecf3", height: 32 };
  return theme === "light"
    ? { color: "#eae2cc", symbolColor: "#2b2416", height: 44 }
    : { color: "#10141d", symbolColor: "#e9ecf3", height: 44 };
}

/** 面板开/关、主题切换后重刷 overlay 配色。 */
function syncTitleBarOverlay() {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  const theme = resolveTheme();
  mainWindow.setTitleBarOverlay(titleBarOverlayFor(theme, Boolean(foundryView)));
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
    // Win 下摘原生标题栏:天头即标题栏,右上三键用系统 overlay(随主题换色)。
    // renderer 靠 query.frameless 切可拖拽形态;mac 保留原生红绿灯,不动。
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlayFor(theme, false) }
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

  const relayout = () => layoutViews();
  mainWindow.on("resize", relayout);
  mainWindow.on("maximize", relayout);
  mainWindow.on("unmaximize", relayout);

  mainWindow.on("closed", () => {
    foundryRuntime?.invalidate();
    clearFoundryPermissionState("main-window-closed");
    mainWindow = null;
    foundryView = null;
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
    getFoundryWebContents: () => foundryView?.webContents ?? null,
    getFoundryOrigin: () => foundryPermissionOrigin,
    sendToRenderer,
  });
  displayMediaController = new DisplayMediaController({
    desktopCapturer,
    getFoundryWebContents: () => foundryView?.webContents ?? null,
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
    getWebContents: () => foundryView?.webContents ?? null,
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
  process.env.ARCANE_FVTT_MOD_MANAGER = path.join(
    __dirname,
    "..",
    "..",
    "skills",
    "prep",
    "arcane-fvtt-mods",
    "scripts",
    "mod-manager.mjs",
  );
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

  // ---- 双模式 host(M1):并存常驻,切模式不杀 session;IPC 全部路由到活动 host ----
  const hosts = {
    combat: new AgentHost({
      foundryRuntime,
      getFoundryView: () => foundryView,
      openFoundry: openFoundryView,
      sendToRenderer,
      providerStore,
      telemetry,
      runtimeReady: fvttOpsRuntimeReady,
      profile: {
        getCwd: () => combatWorkspace,
      },
    }),
    prep: new AgentHost({
      foundryRuntime,
      getFoundryView: () => foundryView,
      openFoundry: openFoundryView,
      sendToRenderer,
      providerStore,
      telemetry,
      runtimeReady: fvttOpsRuntimeReady,
      profile: {
        mode: "prep",
        getCwd: () => prepStore.data.lastCwd ?? prepFallbackWorkspace,
        builtinTools: true,
        systemPrompt: "append",
        skillPaths: [path.join(__dirname, "..", "..", "skills", "prep")],
        customToolNames: ["foundry_open", "foundry_screenshot", "browser_evaluate"],
        fence: true,
      },
    }),
  };
  const modeController = new ModeHostController({
    hosts,
    initialMode: readUiState().mode,
  });
  // 每模式各一个 busy 标志:两 host 可各跑各的 turn,steer 语义归请求快照。
  const busyByMode = { combat: false, prep: false };

  function staleModeResponse() {
    const context = modeController.snapshot();
    return {
      ok: false,
      code: "STALE_MODE_CONTEXT",
      error: err("err.mode.staleContext"),
      ...modeController.publicSnapshot(context),
    };
  }

  function validateModeRequest(request) {
    const result = modeController.validateRequest(request);
    if (result.ok) return result;
    const key = "code" in result && result.code === "INVALID_MODE_CONTEXT"
      ? "err.mode.invalidContext"
      : "err.mode.staleContext";
    return { ...result, error: err(key) };
  }

  async function currentModePayload() {
    const context = await modeController.readySnapshot();
    return {
      ...context.host.currentPayload(),
      ...modeController.publicSnapshot(context),
      busy: busyByMode[context.mode],
      cwd: context.mode === "prep" ? prepUiCwd() : undefined,
      worldInfo: foundryRuntime.lastWorldInfo,
    };
  }

  globalThis.__arcaneAgentHost = hosts.combat; // dom-dump 等调试脚本的既有入口
  globalThis.__arcaneHosts = hosts;
  try {
    await modeController.ensureStarted(modeController.snapshot().mode);
    // renderer 可能在 agent 就绪前就加载完(或之后):双方都拉一次 sessions:current,
    // 这个推送让早加载的 renderer 知道可以拉历史了。
    sendToRenderer({ type: "agent_ready" });
  } catch (error) {
    console.log("[agent] start failed:", error.message);
  }

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
      busy: busyByMode[context.mode], // 后台模式的运行态:切回时恢复 busy 指示
      ...host.currentPayload(),
      cwd: context.mode === "prep" ? prepUiCwd() : undefined,
    };
  });

  // ---- 备团:工作目录 ----
  ipcMain.handle("prep:get-dir", () => ({ cwd: prepUiCwd() }));
  ipcMain.handle("prep:choose-dir", async (_event, request) => {
    const validated = validateModeRequest(request);
    if (!validated.ok || validated.context.mode !== "prep") return staleModeResponse();
    const context = validated.context;
    await modeController.ensureStarted(context.mode);
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
    await context.host.newSession(); // pi 无运行时切 cwd API:换目录 = 新 session
    return { ok: true, cwd, ...modeController.publicSnapshot(context) };
  });

  // ---- 会话管理(按活动模式路由；模式由 Pi sessionDir + JSONL marker 固有隔离) ----
  ipcMain.handle("sessions:list", async (_event, request) => {
    const validated = validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    await modeController.ensureStarted(context.mode);
    const list = await context.host.listSessions();
    return {
      ok: true,
      ...modeController.publicSnapshot(context),
      sessions: list,
    };
  });
  ipcMain.handle("sessions:current", async () => {
    // readySnapshot 在模式变化时重试，响应中的 mode/host/history 必定来自同一快照。
    return currentModePayload();
  });
  ipcMain.handle("sessions:new", async (_event, request) => {
    const validated = validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    await modeController.ensureStarted(context.mode);
    const result = await context.host.newSession();
    return { ...result, ...modeController.publicSnapshot(context) };
  });
  ipcMain.handle("sessions:open", async (_event, request) => {
    const validated = validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const sessionPath = String(request?.path ?? "");
    await modeController.ensureStarted(context.mode);
    const list = await context.host.listSessions();
    if (!list.some((s) => s.path === sessionPath)) {
      return { ok: false, code: "SESSION_MODE_MISMATCH", error: err("err.session.modeMismatch") };
    }
    const result = await context.host.openSession(sessionPath);
    return { ...result, ...modeController.publicSnapshot(context) };
  });
  ipcMain.handle("sessions:delete", async (_event, request) => {
    const validated = validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    const sessionPath = String(request?.path ?? "");
    await modeController.ensureStarted(context.mode);
    const list = await context.host.listSessions();
    if (!list.some((s) => s.path === sessionPath)) {
      return { ok: false, code: "SESSION_MODE_MISMATCH", error: err("err.session.modeMismatch") };
    }
    const result = await context.host.deleteSession(sessionPath);
    return result;
  });

  // ---- 设置:LLM provider 管理 + 默认模型(两 host 共享偏好,各自切换) ----
  ipcMain.handle("settings:get", async (event) => {
    if (!isTrustedChatIpc(event)) return { providers: [], defaultModel: null, models: [] };
    const settings = providerStore.toPublic();
    const models = await hosts.combat.listModels();
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
  ipcMain.handle("settings:model-access", (event) => (
    isTrustedChatIpc(event)
      ? { missingKey: providerStore.missingApiKeyForDefault() }
      : { missingKey: null }
  ));
  ipcMain.handle("settings:save-provider", (event, input) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const result = providerStore.upsertProvider(input ?? {});
    if (result.ok) {
      for (const host of Object.values(hosts)) {
        if (host.modelRuntime) providerStore.applyToRuntime(host.modelRuntime);
      }
    }
    return result;
  });
  ipcMain.handle("settings:delete-provider", (event, id) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    return providerStore.removeProvider(String(id ?? ""));
  });
  ipcMain.handle("settings:default-model", (event, pref) => {
    if (!isTrustedChatIpc(event)) return { ok: false, error: err("err.provider.untrustedRequest") };
    const pid = String(pref?.providerId ?? "");
    const mid = String(pref?.modelId ?? "");
    for (const host of Object.values(hosts)) void host.setDefaultModel(pid, mid);
    return { ok: true };
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
    const validated = validateModeRequest(request);
    if (!validated.ok) return validated;
    const context = validated.context;
    await modeController.ensureStarted(context.mode);
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
  function savePrepInboxImages(host, images) {
    const dir = path.join(host.cwd(), ".arcane", "inbox");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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
    const validated = validateModeRequest(typeof payload === "string" ? null : payload);
    if (!validated.ok) return validated;
    const context = validated.context;
    const { mode, host } = context;
    const missingKey = providerStore.missingApiKeyForDefault();
    if (missingKey) {
      return {
        ok: false,
        code: "MODEL_PROVIDER_KEY_REQUIRED",
        error: err("err.chat.modelNotConfigured"),
        ...missingKey,
      };
    }
    try {
      await modeController.ensureStarted(mode);
      if (images.length > 0 && mode === "prep") {
        try {
          const files = savePrepInboxImages(host, images);
          message += `\n\n[附带图片已存为本地文件:${files.join("; ")}]`;
        } catch (error) {
          console.log("[agent] save inbox images failed:", error.message); // 落盘失败不阻塞视觉输入
        }
      }
      // app 级命令:/compact [instructions] → pi 手动压缩;compaction 期间禁止并发 prompt
      if (message === "/compact" || message.startsWith("/compact ")) {
        if (busyByMode[mode]) return { ok: false, error: err("err.chat.busyCompact"), compacted: true };
        const instructions = message.slice("/compact".length).trim();
        try {
          const result = await host.compact(instructions);
          return { ...result, compacted: true, ...modeController.publicSnapshot(context) };
        } catch (error) {
          // compacted 标记让 renderer 不再重复报错(compaction_end 事件已透出)
          return { ok: false, error: error.message, compacted: true };
        }
      }
      if (busyByMode[mode]) {
        telemetry?.inputSubmitted(mode, telemetryInputText, images.length, typeof payload === "object" ? payload?.submitMethod : undefined);
        telemetry?.turnSteered(mode);
        await host.steer(message, images);
        return { ok: true, steered: true, ...modeController.publicSnapshot(context) };
      }
      telemetry?.turnStarted(mode);
      telemetry?.inputSubmitted(mode, telemetryInputText, images.length, typeof payload === "object" ? payload?.submitMethod : undefined);
      busyByMode[mode] = true;
      try {
        await host.prompt(message, images);
      } finally {
        busyByMode[mode] = false;
      }
      return { ok: true, ...modeController.publicSnapshot(context) };
    } catch (error) {
      busyByMode[mode] = false;
      telemetry?.turnFailed(mode, error);
      const message = String(error?.message ?? error);
      if (/No API key found/i.test(message)) {
        return {
          ok: false,
          code: "MODEL_PROVIDER_KEY_REQUIRED",
          error: err("err.chat.modelNotConfigured"),
        };
      }
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("approval:respond", (_event, payload) => {
    // 审批只有战斗模式会发;两个 host 各自查自己的 approvals map,天然路由
    for (const host of Object.values(hosts)) {
      host.respondApproval(payload?.approvalId, payload?.approved);
    }
    return { ok: true };
  });

  ipcMain.handle("chat:abort", async (_event, request) => {
    const validated = validateModeRequest(request);
    if (!validated.ok) return validated;
    telemetry?.turnAborted(validated.context.mode);
    await validated.context.host.abort();
    return { ok: true, ...modeController.publicSnapshot(validated.context) };
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
    return { ok: true };
  });

  // 界面语言持久化(设置页「通用」tab):auto = 每次启动跟随系统,显式值 = 锁定。
  // 渲染层热切换已自行完成,这里只落盘;下次启动 resolveLocale() 消费。
  ipcMain.handle("ui:locale", (_event, pref) => {
    const next = UI_LOCALES.includes(pref) ? pref : "auto";
    writeUiState({ locale: next });
    return { ok: true, pref: next };
  });
  ipcMain.handle("ui:get-locale", () => {
    const saved = readUiState().locale;
    return { pref: UI_LOCALES.includes(saved) ? saved : "auto", resolved: resolveLocale() };
  });

  // 顶栏"面板"开关:用户手动打开/关闭 Foundry 面板,不必经过 agent。
  ipcMain.handle("panel:open", async () => {
    return await openFoundryView(); // 默认地址(ARCANE_FOUNDRY_URL / localhost:30000)
  });
  ipcMain.handle("panel:close", () => {
    if (!foundryView) return { ok: true };
    foundryRuntime.invalidate();
    clearFoundryPermissionState("panel-closed");
    mainWindow?.contentView.removeChildView(foundryView);
    if (!foundryView.webContents.isDestroyed()) foundryView.webContents.close();
    foundryView = null;
    syncTitleBarOverlay(); // 面板关闭,overlay 三键回到主题色
    sendToRenderer({ type: "panel_status", open: false });
    sendToRenderer({ type: "panel_layout", open: false });
    return { ok: true };
  });

  // F5:玩家手动刷新右侧 Foundry 页面(卡渲染/丢帧时自救)。面板没开时不动作。
  ipcMain.handle("panel:reload", () => {
    if (!foundryView || foundryView.webContents.isDestroyed()) return { ok: false };
    foundryView.webContents.reload();
    return { ok: true };
  });

  // 分栏拖拽:renderer 本地先动(体感零延迟),节流同步到 main 调整 Foundry view 宽度。
  ipcMain.handle("panel:set-chat-width", (_event, px) => {
    const n = Number(px);
    if (!Number.isFinite(n)) return { ok: false };
    chatWidthPx = Math.round(n);
    layoutViews();
    return { ok: true };
  });
  // 拖拽期间让 Foundry view 鼠标事件穿透到下层 chat 页面:指针划过左屏时
  // chat 仍能收到 pointermove/pointerup,拖拽不会在分栏边界"断流"。
  ipcMain.handle("panel:drag-start", () => {
    try {
      foundryView?.webContents?.setIgnoreMouseEvents(true);
    } catch {
      /* view gone */
    }
    return { ok: true };
  });
  ipcMain.handle("panel:drag-end", () => {
    try {
      foundryView?.webContents?.setIgnoreMouseEvents(false);
    } catch {
      /* view gone */
    }
    layoutViews();
    return { ok: true };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  clearFoundryPermissionState("app-quit");
  void telemetry?.close(); // best-effort flush,最多 500ms(§4.2)
});
