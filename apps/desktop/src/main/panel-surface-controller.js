// 右屏 surface 状态机(md-reader-spec §3)的唯一 owner(design-rules R2)。
//
// 不变量 1"任一时刻右屏最多一个 view 可见"只由 #applyVisibility() 执行;
// main.js 其余代码只调这里的公开动词,不许自己 setVisible / setBounds / 销毁 view。
//
// 本文件不 import electron:两个 view 都由 hooks 注入的工厂创建,因此整套四态 × 四事件
// 转移表可以在 node --test 里跑完(test/panel-surface-controller.test.mjs),不需要起窗口。

/** readerView 的内容推送通道(preload-reader.cjs 订阅)。 */
export const READER_CONTENT_CHANNEL = "arcane-reader:content";
/** readerView 的主题广播通道;主题切换时与内容分开发,避免重读文件。 */
export const READER_THEME_CHANNEL = "arcane-reader:theme";

/** §3.1 的四个状态。CLOSED 之外都由 (open, surface, origin) 三元组导出。 */
export const STATE = Object.freeze({
  CLOSED: "CLOSED",
  FOUNDRY: "FOUNDRY",
  READER_F: "READER_F",
  READER_C: "READER_C",
});

const SURFACE_FOUNDRY = "foundry";
const SURFACE_READER = "reader";

export class PanelSurfaceController {
  #hooks;
  #foundryView = null;
  #readerView = null;
  #open = false;
  #surface = null; // SURFACE_FOUNDRY | SURFACE_READER | null(CLOSED)
  #origin = null; // "foundry" | "closed":仅在本次 reader 打开周期内有值(§3.1)
  #lastContent = null; // ① 关面板时记下的现场,重开时恢复
  #readerPath = null; // 当前笔记的原始路径,F5 重读与 ① 恢复都用它
  #readerPayload = null; // 当前笔记内容;保活期间留在内存(§3.5 不变量 4)
  #theme = "light";

  /**
   * @param {object} hooks
   * @param {() => any} hooks.getWindow 当前 BrowserWindow(可能为 null)
   * @param {() => { bounds: object, chatWidth: number, gutter: number } | null} hooks.computeLayout
   * @param {(event: object) => void} hooks.emit 向 chat renderer 发 arcane:event
   * @param {() => any} hooks.createFoundryView 建 foundryView 并挂全部 Foundry 专属监听
   * @param {(view: any, reason: string) => void} hooks.destroyFoundryView
   * @param {() => any} hooks.createReaderView 建 readerView(loadFile + preload-reader)
   * @param {(view: any) => void} hooks.destroyReaderView
   * @param {() => Promise<any>} hooks.loadFoundry 真正加载 FVTT 页面(main 的 openFoundryView)
   * @param {() => Promise<any>} hooks.reloadFoundry F5 在 foundry surface 上的重载
   * @param {(rawPath: string) => object} hooks.readNote §7 读链,返回内容或 { error }
   */
  constructor(hooks) {
    this.#hooks = hooks;
  }

  // ---------- 只读投影 ----------

  /** 当前状态(§3.1)。main.js 与测试都只读这个,不读内部字段。 */
  get state() {
    if (!this.#open) return STATE.CLOSED;
    if (this.#surface === SURFACE_READER) return this.#origin === SURFACE_FOUNDRY ? STATE.READER_F : STATE.READER_C;
    return STATE.FOUNDRY;
  }

  get surface() { return this.#open ? this.#surface : null; }
  get origin() { return this.#open && this.#surface === SURFACE_READER ? this.#origin : null; }
  get readerPath() { return this.#readerPath; }

  /** Foundry 权限策略、direct-foundry-runtime 与 AgentHost 仍按 foundryView 取页面;
      它们绝不能拿到 readerView(spec §8 收编表最后一行),所以这里只暴露 foundry 那一个。 */
  get foundryView() { return this.#foundryView; }

  /** 当前可见的 view:bounds 分发、分栏拖拽穿透、指针转发都消费它(spec §8 收编表)。 */
  activeView() { return this.#open ? (this.#surface === SURFACE_READER ? this.#readerView : this.#foundryView) : null; }

  // ---------- ④ FVTT 打开:foundryView 归位 ----------

  /**
   * 确保 foundryView 存在且可用,返回它。
   * 页面加载不在这里:cookie 回填、loadFoundryPage、会话记忆都是 Foundry 专属逻辑,留在 main.js。
   */
  ensureFoundryView() {
    // 面板 renderer 可能已崩溃/被销毁:不可复用,重建(原 main.js 的同名分支)
    if (this.#foundryView && !isUsable(this.#foundryView)) this.#destroyFoundry("foundry-renderer-gone");
    if (!this.#foundryView) this.#foundryView = this.#hooks.createFoundryView();
    return this.#foundryView;
  }

  /**
   * ④:任何使 foundryView 变为可见的路径(agent foundry_open、切战斗模式、① 恢复到 foundry)。
   * 阅读器若在场则隐藏保活——不销毁、不通知、不往 chat 推系统消息(§1 非目标)。
   */
  showFoundry() {
    // FOUNDRY 蕴含 foundryView 存在,这个不变量由控制器自己守住(R2),
    // 不依赖调用方先 ensureFoundryView()。重复调是幂等的。
    this.ensureFoundryView();
    this.#surface = SURFACE_FOUNDRY;
    this.#origin = null; // 阅读周期结束;下次 ② 重新快照现场
    this.#setOpen(true);
    this.#applyVisibility();
    this.layout();
    return { ok: true, state: this.state };
  }

  // ---------- ② 点 chat 里的 md 路径 ----------

  /**
   * ②:内容寻址。面板关着则顺带打开;阅读中再点 = 原地换内容,origin 不重置(§3.1)。
   * 读链失败也照样进入阅读器——错误页渲染在阅读器里,不在 chat 弹任何东西(§5.5)。
   * @param {string} rawPath chat 里点到的原始路径文本
   */
  showReader(rawPath) {
    const payload = this.#hooks.readNote(rawPath);
    // 只有开启新的阅读周期时才快照 origin;换笔记沿用本周期已有的值
    if (!this.#open || this.#surface !== SURFACE_READER) {
      this.#origin = isUsable(this.#foundryView) ? SURFACE_FOUNDRY : "closed";
    }
    this.#surface = SURFACE_READER;
    this.#readerPath = rawPath;
    this.#readerPayload = payload;
    this.#setOpen(true);
    this.#ensureReaderView();
    this.#applyVisibility();
    this.layout();
    this.#pushReaderContent();
    return { ok: true, state: this.state };
  }

  // ---------- ③ 阅读器内返回/关闭 ----------

  /**
   * ③:退出阅读。origin=foundry → 回 FOUNDRY(只做显隐切换,永不加载 FVTT,§3.5 不变量 2);
   * origin=closed → 关面板。
   */
  leaveReader() {
    if (!this.#open || this.#surface !== SURFACE_READER) return { ok: true, state: this.state };
    const origin = this.#origin;
    this.#origin = null;
    // foundryView 在读笔记期间崩掉是真实场景(R1):此时"返回 Foundry"没有可返回的东西,
    // 按 origin=closed 的分支关面板,而不是把一块白屏摆到用户面前。
    if (origin === SURFACE_FOUNDRY && isUsable(this.#foundryView)) {
      this.#surface = SURFACE_FOUNDRY;
      this.#applyVisibility();
      this.layout();
      return { ok: true, state: this.state };
    }
    return this.closePanel();
  }

  // ---------- ① 顶栏「面板」按钮 ----------

  /**
   * ①开:恢复关闭前的当前内容(§3.4 CLOSED 行)。
   * 关闭时两个 view 都销毁,所以重开笔记一律是 READER_C——foundryView 已不存在,
   * 按 §3.1 重新快照现场即 origin=closed,顺带避开"点一下开关就静默拉起一次 FVTT 加载"。
   */
  async openPanel() {
    if (this.#open) return { ok: true, state: this.state };
    const restore = this.#lastContent;
    this.#lastContent = null;
    if (restore?.surface === SURFACE_READER && restore.path) return this.showReader(restore.path);
    return this.#hooks.loadFoundry();
  }

  /** ①关:整个右屏收起,两个 view 都销毁(与现状对齐),现场记进 lastContent。 */
  closePanel() {
    if (!this.#open && !this.#foundryView && !this.#readerView) return { ok: true, state: this.state };
    this.#lastContent = this.#surface ? { surface: this.#surface, origin: this.#origin, path: this.#readerPath } : null;
    this.#destroyReader();
    this.#destroyFoundry("panel-closed");
    this.#open = false;
    this.#surface = null;
    this.#origin = null;
    this.#readerPath = null;
    this.#readerPayload = null;
    this.#hooks.emit({ type: "panel_status", open: false });
    this.#hooks.emit({ type: "panel_layout", open: false });
    return { ok: true, state: this.state };
  }

  // ---------- F5:surface 感知重载(§4.3) ----------

  /**
   * 既有 F5(panel:reload)按当前 surface 分派。
   * reader 分支让 READER_C 下的 F5 不再静默哑掉(design-rules R5)。
   */
  async reloadSurface() {
    if (!this.#open) return { ok: true, state: this.state };
    if (this.#surface === SURFACE_READER) {
      if (!this.#readerPath) return { ok: true, state: this.state };
      this.#readerPayload = this.#hooks.readNote(this.#readerPath);
      this.#pushReaderContent();
      return { ok: true, state: this.state };
    }
    return this.#hooks.reloadFoundry();
  }

  // ---------- 布局与指针(spec §8 收编表) ----------

  /**
   * 向两个 view 同时发 bounds:隐藏的那个也保持正确尺寸,切换时不会先闪一帧旧布局。
   * panel_layout 照旧只发一次,renderer 侧协议零改动(§8 末行)。
   */
  layout() {
    const window = this.#hooks.getWindow();
    if (!window || window.isDestroyed()) return;
    // 面板关着时由 closePanel() 发 panel_layout open:false,这里不重复发
    if (!this.#open) return;
    const computed = this.#hooks.computeLayout();
    if (!computed) return;
    for (const view of [this.#foundryView, this.#readerView]) {
      if (!isUsable(view)) continue;
      try { view.setBounds(computed.bounds); } catch { /* view 正在销毁 */ }
    }
    this.#hooks.emit({ type: "panel_layout", open: true, chatWidth: computed.chatWidth, gutter: computed.gutter });
  }

  /**
   * 分栏拖拽期间让当前可见 view 的鼠标事件穿透到下层 chat 页面。
   * 作用于 activeView():只绑 foundryView 的话,拖拽划过阅读器会在分栏边界断流。
   */
  setPointerPassthrough(ignore) {
    const view = this.activeView();
    if (!isUsable(view)) return;
    try { view.webContents.setIgnoreMouseEvents(ignore); } catch { /* view gone */ }
  }

  // ---------- readerView 内容与主题 ----------

  /** 主题切换广播:只推给阅读器页,不重读文件(ui:theme 处理器调用)。 */
  setTheme(theme) {
    this.#theme = theme === "dark" ? "dark" : "light";
    this.#sendToReader(READER_THEME_CHANNEL, this.#theme);
  }

  /**
   * readerView 每次加载完成时由 main 调用(did-finish-load)。
   * §3.5 不变量 5:内容只由 main 侧这一条推送路径供给,页面自身不读盘,
   * 所以焦点在阅读器里按 F5(Chromium 默认重载)后内容必然回来。
   */
  onReaderReady() {
    this.#sendToReader(READER_THEME_CHANNEL, this.#theme);
    this.#pushReaderContent();
  }

  // ---------- 生命周期 ----------

  /** 主窗口关闭:丢掉引用,不发任何事件(renderer 已经不在了)。 */
  dispose() {
    this.#foundryView = null;
    this.#readerView = null;
    this.#open = false;
    this.#surface = null;
    this.#origin = null;
    this.#lastContent = null;
    this.#readerPath = null;
    this.#readerPayload = null;
  }

  // ---------- 内部 ----------

  #setOpen(next) {
    if (this.#open === next) return;
    this.#open = next;
    if (next) this.#hooks.emit({ type: "panel_status", open: true });
  }

  /** 不变量 1 的唯一执行者。 */
  #applyVisibility() {
    for (const [surface, view] of [[SURFACE_FOUNDRY, this.#foundryView], [SURFACE_READER, this.#readerView]]) {
      if (!view) continue;
      try { view.setVisible(this.#open && this.#surface === surface); } catch { /* view 正在销毁 */ }
    }
  }

  #ensureReaderView() {
    if (this.#readerView && !isUsable(this.#readerView)) this.#destroyReader();
    if (!this.#readerView) this.#readerView = this.#hooks.createReaderView();
  }

  #destroyFoundry(reason) {
    const view = this.#foundryView;
    this.#foundryView = null;
    if (!view) return;
    this.#hooks.destroyFoundryView(view, reason);
  }

  #destroyReader() {
    const view = this.#readerView;
    this.#readerView = null;
    if (!view) return;
    this.#hooks.destroyReaderView(view);
  }

  #pushReaderContent() {
    if (!this.#readerPayload) return;
    // origin 随内容一起下发:返回按钮的文案("← 返回 Foundry" / "✕ 关闭")由它决定,
    // 而 origin 在一个阅读周期内不变,所以不需要第二条状态通道(§7)。
    this.#sendToReader(READER_CONTENT_CHANNEL, { ...this.#readerPayload, origin: this.#origin });
  }

  #sendToReader(channel, payload) {
    if (!isUsable(this.#readerView)) return;
    try { this.#readerView.webContents.send(channel, payload); } catch { /* view 正在销毁 */ }
  }
}

/** view 是否还能用:close() 之后 webContents 会变 undefined,直接 isDestroyed() 会抛 TypeError。 */
function isUsable(view) {
  return Boolean(view?.webContents) && !view.webContents.isDestroyed();
}
