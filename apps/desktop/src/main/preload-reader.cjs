// readerView 专用小 preload(md-reader-spec §7)。
//
// 只有三个方法,全是单向订阅:内容/主题/语言由 main 推下来,页面没有任何上报通道。
// 阅读器页拿不到任何文件系统、会话或 agent 能力——它是一个只读的渲染面,
// 信任边界 ① 在 main 的 `md-reader:open` 上,不在这里。
//
// 频道名与 src/main/panel-surface-controller.js 的 READER_CONTENT_CHANNEL /
// READER_THEME_CHANNEL / READER_LOCALE_CHANNEL 必须一致;preload 是 CJS,
// 不能 import 那个 ESM 模块,所以在这里重复一次字面量(改一处就得改两处)。
const { contextBridge, ipcRenderer } = require("electron");

const CONTENT_CHANNEL = "arcane-reader:content";
const THEME_CHANNEL = "arcane-reader:theme";
const LOCALE_CHANNEL = "arcane-reader:locale";

contextBridge.exposeInMainWorld("arcaneReader", {
  /**
   * 订阅笔记内容。payload = { name, text, truncated, path } 或 { error, path };
   * error 取值对应 §5.5 的文案键:outside | missing | encoding。
   * path 是页面分辨"同一份笔记被唤回"与"换了一份"的依据(§2 滚动位置)。
   * 订阅而非一次性取值:阅读中换笔记(②再点)与 F5 重读都走同一条推送(§3.5 不变量 5)。
   * @returns {() => void} 退订函数
   */
  onContent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(CONTENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(CONTENT_CHANNEL, listener);
  },
  /** 订阅主题广播:切主题不重读文件,所以与内容分开发。 @returns {() => void} */
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on(THEME_CHANNEL, listener);
    return () => ipcRenderer.removeListener(THEME_CHANNEL, listener);
  },
  /** 订阅语言热切换广播(review M2):与主题同链路。 @returns {() => void} */
  onLocale: (callback) => {
    const listener = (_event, locale) => callback(locale);
    ipcRenderer.on(LOCALE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(LOCALE_CHANNEL, listener);
  },
});
