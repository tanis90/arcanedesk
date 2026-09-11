// 右屏悬浮 surface 切换器(panel-switch.html)专用小 preload。
//
// 与 preload-reader.cjs 同型:只有切换器页这一个消费者,页面拿不到任何
// 会话 / agent / 文件系统能力。上报只此一条 switch 通道,信任校验在 main 的
// `panel-switch:switch`(只认切换器 view 自己的 webContents)。
const { contextBridge, ipcRenderer } = require("electron");

const STATUS_CHANNEL = "arcane-panel-switch:status";
const THEME_CHANNEL = "arcane-panel-switch:theme";
const LOCALE_CHANNEL = "arcane-panel-switch:locale";

contextBridge.exposeInMainWorld("arcanePanelSwitch", {
  /** 请求切换 surface;返回值与 panel:switch 同构:{ ok } | { ok:false, empty } | { ok:false, error } */
  switch: (target) => ipcRenderer.invoke("panel-switch:switch", target),
  /** 订阅面板开关与当前 surface;面板关闭时 main 直接隐藏整个 view,这里只维护选中态。 @returns {() => void} */
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on(STATUS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(STATUS_CHANNEL, listener);
  },
  /** 订阅主题热切换(与阅读器同链路):整页换变量,不重载。 @returns {() => void} */
  onTheme: (callback) => {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on(THEME_CHANNEL, listener);
    return () => ipcRenderer.removeListener(THEME_CHANNEL, listener);
  },
  /** 订阅语言热切换:只换「文档」段文案,不重载。 @returns {() => void} */
  onLocale: (callback) => {
    const listener = (_event, locale) => callback(locale);
    ipcRenderer.on(LOCALE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(LOCALE_CHANNEL, listener);
  },
});
