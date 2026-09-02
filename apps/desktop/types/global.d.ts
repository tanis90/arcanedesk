// 渲染进程全局类型:preload.cjs 暴露的 window.arcane IPC 桥 + keycapture.js 的 window.ArcaneKeyCapture。
// 与 preload.cjs 保持同步 —— 改了桥接 API 就要改这里,typecheck 闸门靠它对齐两边。

interface ArcaneBridge {
  /** Send a user message to the agent session. images: [{ data: base64, mimeType }]. */
  prompt(text: string, images?: { data: string; mimeType: string }[], context?: ArcaneModeContext): Promise<any>;
  /** Slash 候选:app 命令 + 当前会话的 skills / prompt 模板(按活动模式路由)。 */
  listSlash(context?: ArcaneModeContext): Promise<any>;
  /** Abort the currently running agent turn. */
  abort(context?: ArcaneModeContext): Promise<any>;
  /** Manually open/close the Foundry panel (same path as the agent's foundry_open). */
  openPanel(): Promise<any>;
  closePanel(): Promise<any>;
  /** F5: reload the Foundry panel page (no-op when the panel is closed). */
  reloadPanel(): Promise<any>;
  /** Sync the chat column width during splitter drags (throttled by renderer). */
  setChatWidth(px: number): Promise<any>;
  /** While dragging the splitter, let mouse events pass through the Foundry view. */
  panelDragStart(): Promise<any>;
  panelDragEnd(): Promise<any>;
  /** Persist the UI theme (月之暗面 dark / 月之亮面 light) for the next launch. */
  setTheme(theme: string): Promise<any>;
  /** 界面语言:pref = "auto" | "zh-CN" | "en-US";auto = 每次启动跟随系统。 */
  setLocale(pref: string): Promise<any>;
  getLocalePref(): Promise<{ pref: string; resolved: string }>;
  /** Mode switch: combat (战斗) / prep (备团); both agent hosts stay resident. */
  getMode(): Promise<any>;
  setMode(mode: string): Promise<any>;
  /** Prep mode working directory (cwd anchor: tools, skills scan, session bucket). */
  prepGetDir(): Promise<any>;
  /** Pick a prep directory via OS dialog; switching dir starts a NEW prep session. */
  prepChooseDir(context?: ArcaneModeContext): Promise<any>;
  /** Session management (Pi SessionManager JSONL sessions). */
  listSessions(context?: ArcaneModeContext): Promise<any>;
  currentSession(): Promise<any>;
  newSession(context?: ArcaneModeContext): Promise<any>;
  openSession(path: string, context?: ArcaneModeContext): Promise<any>;
  deleteSession(path: string, context?: ArcaneModeContext): Promise<any>;
  /** Settings: provider management + default model. */
  getSettings(): Promise<any>;
  getModelAccess(context?: ArcaneModeContext): Promise<any>;
  saveProvider(provider: any): Promise<any>;
  deleteProvider(id: string): Promise<any>;
  setDefaultModel(providerId: string, modelId: string): Promise<any>;
  /** Privacy: inspect and explicitly change packaged-build telemetry consent. */
  getTelemetryConsent(): Promise<ArcaneTelemetryConsentStatus>;
  setTelemetryConsent(enabled: boolean): Promise<{
    ok: boolean;
    reason?: string;
    status: ArcaneTelemetryConsentStatus;
  }>;
  /** Foundry website permission prompts and persisted exact-origin decisions. */
  respondPermission(requestId: string, decision: "allow-session" | "allow-persist" | "deny" | "deny-persist"): Promise<any>;
  listWebPermissions(): Promise<Array<{
    origin: string;
    permissions: Array<{ key: string; decision: "allow" | "deny" }>;
  }>>;
  revokeWebPermission(origin: string, key: string): Promise<any>;
  clearWebPermissions(origin: string): Promise<any>;
  /** Complete or cancel an explicit getDisplayMedia source chooser. */
  respondDisplaySource(requestId: string, sourceId: string | null, includeAudio?: boolean): Promise<any>;
  /** Provider 预设目录(内置供应商+模型视觉表)。 */
  getProviderCatalog(): Promise<any>;
  /** 用 baseUrl+apiKey 拉端点的 GET /models;key 留空/打码时用已保存的同 id provider 的 key。 */
  fetchProviderModels(input: any): Promise<any>;
  /** Open the Arcane Desk website in the user's default browser. */
  openArcaneWebsite(): Promise<any>;
  /** Packaged app version shown in Settings → General. */
  getAppVersion(): Promise<string>;
  /** Voice input: ASR config + transcription (智谱 GLM-ASR-2512). */
  getVoiceConfig(): Promise<any>;
  saveVoiceConfig(cfg: any): Promise<any>;
  /** wav: ArrayBuffer(16kHz mono PCM WAV)→ { ok, text?, latency?, error? } */
  transcribeAudio(wav: ArrayBuffer): Promise<any>;
  /** macOS 首次录音前申请麦克风系统权限;其他平台恒 { ok: true }。 */
  ensureMicAccess(): Promise<any>;
  /** Respond to a pending write-approval card. */
  respondApproval(approvalId: string, approved: boolean): Promise<any>;
  /** Subscribe to agent/bridge events; returns an unsubscribe fn. */
  onEvent(callback: (payload: any) => void): () => void;
}

interface ArcaneModeContext {
  mode: "combat" | "prep";
  generation: number;
}

interface ArcaneTelemetryConsentStatus {
  available: boolean;
  userControllable: boolean;
  enabled: boolean;
  decided: boolean;
  recording: boolean;
  mode: "production" | "development" | "disabled" | "unavailable";
}

interface ArcaneKeyCaptureHandle {
  /** 重绘按钮(chip / 录入态 / 空态);get/set 外部值变化后调用。 */
  render(): void;
}

interface ArcaneKeyCaptureApi {
  /** 键位捕获控件:get() 读当前 chord 串,set(chord) 写入(空串 = 清除绑定)。 */
  attach(
    button: HTMLElement,
    opts: { get: () => string; set: (chord: string) => void },
  ): ArcaneKeyCaptureHandle;
  /** chord 串转显示文本:"Ctrl+Meta+MetaLeft" -> "左 Win + Ctrl"。 */
  display(chord: string): string;
}

/** shortcuts.js 的动作规格:tap = keydown 触发一次;hold = keydown 开始 / keyup 结束。 */
interface ArcaneShortcutSpec {
  chords: string[];
  onTap?: () => void;
  onPress?: () => void;
  onRelease?: () => void;
}

interface ArcaneShortcutsApi {
  /** 幂等:同 id 重注册 = 换绑。 */
  register(id: string, spec: ArcaneShortcutSpec): void;
  unregister(id: string): void;
}

interface ArcaneI18nApi {
  /** 查字典;params 做 {name} 插值,缺失 key 返回 key 本身(开发期暴露遗漏)。 */
  t(key: string, params?: Record<string, string | number>): string;
  /** 主进程 IPC 错误的统一出口:结构化 {key, params} → 本地化;其余按字符串透传。 */
  fmtIpc(error: any): string;
  /** 全量回填静态 data-i18n* 文案。 */
  apply(root?: ParentNode): void;
  /** 立即切换(已解析的 locale);回填静态文案并触发 onLocaleChange 回调。 */
  setLocale(locale: string): string;
  /** 设置页语言下拉的落点:auto 用 navigator 检测,显式值写 localStorage。 */
  setLocaleForPref(pref: string): string;
  getLocale(): string;
  onLocaleChange(fn: (locale: string) => void): void;
}

interface Window {
  arcane: ArcaneBridge;
  ArcaneI18n: ArcaneI18nApi;
  ArcaneKeyCapture: ArcaneKeyCaptureApi;
  ArcaneShortcuts?: ArcaneShortcutsApi;
  /** keycapture 录入态标记:为 true 时 shortcuts.js 的全局动作不响应。 */
  __arcaneKeyCapture?: boolean;
  /** voice.js 暴露的语音配置刷新:设置页保存后调用让麦克风按钮立刻生效。 */
  __arcaneRefreshVoice?: () => void;
  /** 缺少语音配置时打开语音设置,并聚焦接入方式或自有 API Key。 */
  __arcaneOpenVoiceSettings?: (focus?: "mode" | "apikey") => Promise<void>;
  /** 缺少 Arcane Spark Key 时直接打开对应模型服务配置。 */
  __arcaneOpenProviderSettings?: (providerId: string) => Promise<void>;
}

interface Navigator {
  /** Chromium UA-CH;Electron 渲染进程可用,TS DOM lib 未收录故在此补充。 */
  readonly userAgentData?: { readonly platform?: string };
}
