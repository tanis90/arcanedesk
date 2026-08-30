// Preload — typed IPC boundary between the chat renderer and the main host.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arcane", {
  /** Send a user message to the agent session. images: [{ data: base64, mimeType }]. */
  prompt: (text, images, context) => ipcRenderer.invoke("chat:prompt", {
    text,
    images,
    mode: context?.mode,
    generation: context?.generation,
  }),
  /** Slash 候选:app 命令 + 当前会话的 skills / prompt 模板(按活动模式路由)。 */
  listSlash: (context) => ipcRenderer.invoke("slash:list", context),
  /** Abort the currently running agent turn. */
  abort: (context) => ipcRenderer.invoke("chat:abort", context),
  /** Manually open/close the Foundry panel (same path as the agent's foundry_open). */
  openPanel: () => ipcRenderer.invoke("panel:open"),
  closePanel: () => ipcRenderer.invoke("panel:close"),
  /** F5: reload the Foundry panel page (no-op when the panel is closed). */
  reloadPanel: () => ipcRenderer.invoke("panel:reload"),
  /** Sync the chat column width during splitter drags (throttled by renderer). */
  setChatWidth: (px) => ipcRenderer.invoke("panel:set-chat-width", px),
  /** While dragging the splitter, let mouse events pass through the Foundry view. */
  panelDragStart: () => ipcRenderer.invoke("panel:drag-start"),
  panelDragEnd: () => ipcRenderer.invoke("panel:drag-end"),
  /** Persist the UI theme (月之暗面 dark / 月之亮面 light) for the next launch. */
  setTheme: (theme) => ipcRenderer.invoke("ui:theme", theme),
  /** 界面语言:pref = "auto" | "zh-CN" | "en-US";auto = 每次启动跟随系统。 */
  setLocale: (pref) => ipcRenderer.invoke("ui:locale", pref),
  getLocalePref: () => ipcRenderer.invoke("ui:get-locale"),
  /** Mode switch: combat (战斗) / prep (备团); both agent hosts stay resident. */
  getMode: () => ipcRenderer.invoke("mode:get"),
  setMode: (mode) => ipcRenderer.invoke("mode:set", mode),
  /** Prep mode working directory (cwd anchor: tools, skills scan, session bucket). */
  prepGetDir: () => ipcRenderer.invoke("prep:get-dir"),
  /** Pick a prep directory via OS dialog; switching dir starts a NEW prep session. */
  prepChooseDir: (context) => ipcRenderer.invoke("prep:choose-dir", context),
  /** Session management (Pi SessionManager JSONL sessions). */
  listSessions: (context) => ipcRenderer.invoke("sessions:list", context),
  currentSession: () => ipcRenderer.invoke("sessions:current"),
  newSession: (context) => ipcRenderer.invoke("sessions:new", context),
  openSession: (path, context) => ipcRenderer.invoke("sessions:open", {
    path,
    mode: context?.mode,
    generation: context?.generation,
  }),
  deleteSession: (path, context) => ipcRenderer.invoke("sessions:delete", {
    path,
    mode: context?.mode,
    generation: context?.generation,
  }),
  /** Settings: provider management + default model. */
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getModelAccess: () => ipcRenderer.invoke("settings:model-access"),
  saveProvider: (provider) => ipcRenderer.invoke("settings:save-provider", provider),
  deleteProvider: (id) => ipcRenderer.invoke("settings:delete-provider", id),
  setDefaultModel: (providerId, modelId) =>
    ipcRenderer.invoke("settings:default-model", { providerId, modelId }),
  /** Privacy: inspect and explicitly change packaged-build telemetry consent. */
  getTelemetryConsent: () => ipcRenderer.invoke("telemetry:consent-get"),
  setTelemetryConsent: (enabled) => ipcRenderer.invoke("telemetry:consent-set", enabled),
  /** Foundry website permission prompts and persisted exact-origin decisions. */
  respondPermission: (requestId, decision) =>
    ipcRenderer.invoke("permissions:respond", { requestId, decision }),
  listWebPermissions: () => ipcRenderer.invoke("permissions:list"),
  revokeWebPermission: (origin, key) => ipcRenderer.invoke("permissions:revoke", { origin, key }),
  clearWebPermissions: (origin) => ipcRenderer.invoke("permissions:clear", origin),
  /** Complete or cancel an explicit getDisplayMedia source chooser. */
  respondDisplaySource: (requestId, sourceId, includeAudio) =>
    ipcRenderer.invoke("display-source:respond", { requestId, sourceId, includeAudio }),
  /** Provider 预设目录(内置供应商+模型视觉表)。 */
  getProviderCatalog: () => ipcRenderer.invoke("providers:catalog"),
  /** 用 baseUrl+apiKey 拉端点的 GET /models;key 留空/打码时仅可对原 credential target 复用。 */
  fetchProviderModels: (input) => ipcRenderer.invoke("providers:fetch-models", input),
  /** Open the Arcane Desk website in the user's default browser. */
  openArcaneWebsite: () => ipcRenderer.invoke("app:open-arcane-website"),
  /** Voice input: ASR config + transcription (智谱 GLM-ASR-2512). */
  getVoiceConfig: () => ipcRenderer.invoke("voice:get-config"),
  saveVoiceConfig: (cfg) => ipcRenderer.invoke("voice:save-config", cfg),
  /** wav: ArrayBuffer(16kHz mono PCM WAV)→ { ok, text?, latency?, error? } */
  transcribeAudio: (wav) => ipcRenderer.invoke("voice:transcribe", wav),
  /** macOS 首次录音前申请麦克风系统权限;其他平台恒 { ok: true }。 */
  ensureMicAccess: () => ipcRenderer.invoke("voice:ensure-mic"),
  /** Respond to a pending write-approval card. */
  respondApproval: (approvalId, approved) =>
    ipcRenderer.invoke("approval:respond", { approvalId, approved }),
  /** Subscribe to agent and panel events; returns an unsubscribe fn. */
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("arcane:event", listener);
    return () => ipcRenderer.removeListener("arcane:event", listener);
  },
});
