// Preload — typed IPC boundary between the chat renderer and the main host.
const { contextBridge, ipcRenderer } = require("electron");

const mainReady = ipcRenderer.invoke("app:ready");
async function invoke(channel, ...args) {
  const readiness = await mainReady;
  if (!readiness?.ok) throw new Error(readiness?.error || "Main process initialization failed");
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("arcane", {
  /** Send a user message to the agent session. images: [{ data: base64, mimeType }]. */
  prompt: (text, images, context) => invoke("chat:prompt", {
    text,
    replacesInputId: context?.replacesInputId,
    images,
    mode: context?.mode,
    generation: context?.generation,
    sessionId: context?.sessionId,
    taskId: context?.taskId,
    commandId: context?.commandId,
  }),
  /** Slash 候选:app 命令 + 当前会话的 skills / prompt 模板(按活动模式路由)。 */
  listSlash: (context) => invoke("slash:list", context),
  /** Abort the currently running agent turn. */
  abort: (context) => invoke("chat:abort", context),
  /** 排队输入操作(备团):action = "cancel"(删除/编辑召回) | "steer"(立即发送)。 */
  updateQueuedInput: (context, inputId, action) => invoke("chat:queued-input", {
    inputId,
    action,
    mode: context?.mode,
    generation: context?.generation,
    sessionId: context?.sessionId,
    taskId: context?.taskId,
  }),
  /** Manually open/close the Foundry panel (same path as the agent's foundry_open). */
  openPanel: () => invoke("panel:open"),
  closePanel: () => invoke("panel:close"),
  /** 当前面板档位快照:{ type, profileId, url, displayName };后续变化经 onEvent 的 panel_profile 推送。 */
  panelProfile: () => invoke("panel:get-profile"),
  /** F5: reload the right-pane surface (Foundry page, or re-read the open note). */
  reloadPanel: () => invoke("panel:reload"),
  /** Switch the right pane between the existing Foundry page and the open note. */
  switchPanelSurface: (target) => invoke("panel:switch", target),
  /** Open a Markdown note in the right-pane reader. Path validation happens in main. */
  openMdReader: (path) => invoke("md-reader:open", path),
  sessionIdentities: () => invoke("sessions:identities"),
  /** Sync the chat column width during splitter drags (throttled by renderer). */
  setChatWidth: (px) => invoke("panel:set-chat-width", px),
  /** While dragging the splitter, let mouse events pass through the Foundry view. */
  panelDragStart: () => invoke("panel:drag-start"),
  panelDragEnd: () => invoke("panel:drag-end"),
  /** Persist the UI theme (月之暗面 dark / 月之亮面 light) for the next launch. */
  setTheme: (theme) => invoke("ui:theme", theme),
  /** 界面语言:pref = "auto" | "zh-CN" | "en-US";auto = 每次启动跟随系统。 */
  setLocale: (pref) => invoke("ui:locale", pref),
  getLocalePref: () => invoke("ui:get-locale"),
  /** Mode switch: combat (战斗) / prep (备团); both agent hosts stay resident. */
  getMode: () => invoke("mode:get"),
  setMode: (mode) => invoke("mode:set", mode),
  /** Prep mode working directory (cwd anchor: tools, skills scan, session bucket). */
  prepGetDir: () => invoke("prep:get-dir"),
  /** Pick a prep directory via OS dialog; switching dir starts a NEW prep session. */
  prepChooseDir: (context) => invoke("prep:choose-dir", context),
  /** Switch to a recent prep directory picked from the in-app dropdown (no OS dialog); also starts a NEW prep session. */
  prepSetDir: (context, path) => invoke("prep:set-dir", { ...context, path }),
  /** Session management (Pi SessionManager JSONL sessions). */
  listSessions: (context) => invoke("sessions:list", context),
  sessionNavigation: () => invoke("sessions:navigation"),
  setSessionPinned: (sessionId, pinned) => invoke("sessions:setPinned", { sessionId, pinned }),
  renameSession: (sessionId, title) => invoke("sessions:rename", { sessionId, title }),
  archiveSession: sessionId => invoke("sessions:archive", { sessionId }),
  restoreSession: sessionId => invoke("sessions:restore", { sessionId }),
  deleteArchivedSession: sessionId => invoke("sessions:deleteArchived", { sessionId }),
  forkSession: (sessionId, title) => invoke("sessions:fork", { sessionId, title }),
  currentSession: () => invoke("sessions:current"),
  sessionSnapshot: (sessionId, historyQuery) => invoke("sessions:snapshot", sessionId, historyQuery),
  activitySnapshot: () => invoke("activity:snapshot"),
  getDesktopNotifications: () => invoke("notifications:get"),
  setDesktopNotifications: (enabled) => invoke("notifications:set", enabled),
  takeNotificationTarget: () => invoke("notifications:take-target"),
  activityOpened: (sessionId) => invoke("activity:opened", sessionId),
  respondToTask: (request) => invoke("tasks:respond", request),
  newSession: (context) => invoke("sessions:new", context),
  openSession: (path, context) => invoke("sessions:open", {
    path,
    mode: context?.mode,
    generation: context?.generation,
    sessionId: context?.sessionId,
  }),
  deleteSession: (path, context) => invoke("sessions:delete", {
    path,
    mode: context?.mode,
    generation: context?.generation,
    sessionId: context?.sessionId,
  }),
  /** Settings: provider management + default model. */
  getSettings: () => invoke("settings:get"),
  getModelAccess: (context) => invoke("settings:model-access", context),
  saveProvider: (provider) => invoke("settings:save-provider", provider),
  deleteProvider: (id) => invoke("settings:delete-provider", id),
  setDefaultModel: (providerId, modelId) =>
    invoke("settings:default-model", { providerId, modelId }),
  /** 会话内切换当前会话的模型(输入框旁的选择器);只影响当前模式的当前会话。 */
  setChatModel: (context, providerId, modelId) => invoke("chat:set-model", {
    mode: context?.mode,
    generation: context?.generation,
    sessionId: context?.sessionId,
    providerId,
    modelId,
  }),
  /** Privacy: inspect and explicitly change packaged-build telemetry consent. */
  getTelemetryConsent: () => invoke("telemetry:consent-get"),
  setTelemetryConsent: (enabled) => invoke("telemetry:consent-set", enabled),
  /** Foundry website permission prompts and persisted exact-origin decisions. */
  respondPermission: (requestId, decision) =>
    invoke("permissions:respond", { requestId, decision }),
  listWebPermissions: () => invoke("permissions:list"),
  revokeWebPermission: (origin, key) => invoke("permissions:revoke", { origin, key }),
  clearWebPermissions: (origin) => invoke("permissions:clear", origin),
  /** Complete or cancel an explicit getDisplayMedia source chooser. */
  respondDisplaySource: (requestId, sourceId, includeAudio) =>
    invoke("display-source:respond", { requestId, sourceId, includeAudio }),
  /** Provider 预设目录(内置供应商+模型视觉表)。 */
  getProviderCatalog: () => invoke("providers:catalog"),
  /** 用 baseUrl+apiKey 拉端点的 GET /models;key 留空/打码时仅可对原 credential target 复用。 */
  fetchProviderModels: (input) => invoke("providers:fetch-models", input),
  /** Open the Arcane Desk website in the user's default browser. */
  openArcaneWebsite: () => invoke("app:open-arcane-website"),
  /** 应用内更新（auto-update-design §5.3）：药丸/浮层的全部动作与状态订阅。 */
  checkUpdates: () => invoke("update:check"),
  downloadUpdate: () => invoke("update:download"),
  installUpdate: () => invoke("update:install"),
  updateState: () => invoke("update:state"),
  onUpdateState: (callback) => {
    const listener = (_event, payload) => {
      if (payload?.type === "update_state") callback(payload.state);
    };
    ipcRenderer.on("arcane:event", listener);
    return () => ipcRenderer.removeListener("arcane:event", listener);
  },
  /** Region 派生的对外链接:{ region, websiteUrl, supportLinks }（D1，renderer 不硬编码域名）。 */
  getAppLinks: () => invoke("app:links"),
  /** Packaged app version shown in Settings → General. */
  getAppVersion: () => invoke("app:get-version"),
  /** Voice input: ASR config + transcription (智谱 GLM-ASR-2512). */
  getVoiceConfig: () => invoke("voice:get-config"),
  saveVoiceConfig: (cfg) => invoke("voice:save-config", cfg),
  /** Prep web search: masked config view (mode/backend/key state). */
  getSearchConfig: () => invoke("search:get-config"),
  saveSearchConfig: (cfg) => invoke("search:save-config", cfg),
  /** wav: ArrayBuffer(16kHz mono PCM WAV)→ { ok, text?, latency?, error? } */
  transcribeAudio: (wav) => invoke("voice:transcribe", wav),
  /** macOS 首次录音前申请麦克风系统权限;其他平台恒 { ok: true }。 */
  ensureMicAccess: () => invoke("voice:ensure-mic"),
  /** Respond to a pending write-approval card. */
  respondApproval: (approvalId, approved) =>
    invoke("approval:respond", { approvalId, approved }),
  /** Subscribe to agent and panel events; returns an unsubscribe fn. */
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("arcane:event", listener);
    return () => ipcRenderer.removeListener("arcane:event", listener);
  },
});
