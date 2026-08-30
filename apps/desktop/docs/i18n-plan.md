# Arcane Desk 双语（zh-CN / en-US）方案

状态：已在 `codex/desktop-i18n-main-integration` 基于当前 `main` 实施。

本文记录界面国际化的边界、运行机制和后续新增文案时必须通过的闸门。

## 1. 范围

本次覆盖产品 UI 文案：

- 顶栏、欢迎页、输入区、模型选择器、斜杠菜单和会话抽屉；
- 模型、语音、通用三个设置页；网站权限作为通用页中的管理区块；
- 工具卡、审批卡、状态行、网站权限卡和屏幕共享选择器；
- 主进程通过 IPC 返回的用户可见错误；
- provider 预设的显示名。

以下内容不是 UI，不做翻译：

- `skills/**` 和 `agent-host.js` 中发给 LLM 的提示词、工作目录围栏说明；
- ASR 默认 prompt / 热词；
- 会话标题、聊天记录等用户或模型生成的数据；
- 写入历史、但在渲染前剥离的图片附件契约标记。

切换语言不会回译已有的聊天数据，只刷新产品自身的界面和状态标签。

## 2. 运行机制

### 2.1 语言来源

`userData/config/ui.json` 的 `locale` 字段支持：

- `auto`：默认值，每次启动跟随系统首选语言；
- `zh-CN`：锁定简体中文；
- `en-US`：锁定英文。

主进程通过 `app.getPreferredSystemLanguages()` 解析 `auto`，再用 `loadFile` 的
`?lang=` query 把最终语言传给渲染层。`i18n-init.js` 在页面绘制前同步设置
`<html lang>` 和 `data-locale`，避免先按错误语言渲染。

设置页的语言选择会立即热切换，并通过 `ui:locale` IPC 保存偏好。开发模式没有
query 时，localStorage 只作为显式选择的兜底。

### 2.2 字典和渲染层

项目没有引入新的 i18n 依赖。`src/shared/i18n/messages.js` 是 classic script，向
`globalThis.ARCANE_MESSAGES` 写入双语字典；这样 file 页面可以直接加载，同时测试
也可以作为 ESM 副作用导入。

`src/renderer/i18n.js` 提供：

- `t(key, params)`：查词和 `{name}` 插值；
- `apply(root)`：更新 `data-i18n*` 标记的静态 DOM；
- `setLocale()` / `setLocaleForPref()`：运行时切换；
- `fmtIpc()`：把主进程的 `{ key, params }` 错误格式化为当前语言；
- `onLocaleChange()`：让动态状态组件重新渲染。

静态 HTML 使用 `data-i18n`、`data-i18n-title`、`data-i18n-placeholder`、
`data-i18n-prompt`、`data-i18n-alt`。JavaScript 动态创建的节点直接调用 `t()`。

### 2.3 主进程错误

面向用户的主进程错误以 `{ key, params }` 穿过 IPC：

- 返回值型 API 使用 `err(key, params)`；
- 抛错型 API 使用 `I18nError`；
- 带稳定 `code` 的 session 错误在 `errorToIpc()` 中映射；
- 纯诊断或第三方 SDK 错误仍保留原字符串，不伪造翻译。

渲染层在显示前统一调用 `fmtIpc()`。工具需要消费的英文 `summary` 仍作为内部字段
保留，不与面向用户的 `error` 混用。

## 3. 文件地图

| 文件 | 职责 |
|---|---|
| `src/shared/i18n/messages.js` | zh-CN / en-US 字典 |
| `src/renderer/i18n-init.js` | 首屏 locale 初始化 |
| `src/renderer/i18n.js` | 翻译、DOM 回填、热切换和 IPC 格式化 |
| `src/main/i18n-error.mjs` | 结构化错误和错误码映射 |
| `src/renderer/index.html` | 静态文案标记与通用设置页 |
| `src/renderer/chat.js` | 动态界面文案与语言切换联动 |
| `voice.js` / `keycapture.js` / `markdown.js` | 各自动态文案 |
| `src/main/main.js` | locale 解析、持久化 IPC 和主进程错误出口 |
| `providers.js` / `provider-catalog.js` / `asr.js` / `agent-host.js` | 结构化错误或事件 |
| `provider-catalog.json` | provider 英文显示名 |
| `preload.cjs` / `types/global.d.ts` | locale IPC 桥接与类型 |
| `test/i18n.test.mjs` | 发布闸门 |

## 4. 测试闸门

`test/i18n.test.mjs` 会验证：

1. 两种语言的 key 集合完全一致；
2. 每个 key 的插值占位符集合一致；
3. HTML 中所有 `data-i18n*` 引用均存在；
4. 动态 `t()`、`err()`、`I18nError` 的字面量 key 均存在；
5. 受扫描的 renderer / main 文件没有遗漏的中文 UI 字面量；
6. classic scripts 没有会令浏览器报 SyntaxError 的顶层重名；
7. 结构化错误保留 key 和参数，稳定 session 错误码能被映射。

LLM 提示词、ASR 词表以及由稳定错误码覆盖的内部错误模块是明确豁免项。豁免文件
列表在测试中集中维护，不能用来掩盖普通 UI 文案。

完整发布前还要运行：

```powershell
npm test
npm run typecheck
npm exec electron-builder -- --win --dir
node scripts/verify-package.mjs dist/win-unpacked/resources/app
```

并在 Electron 中人工确认中文启动、英文热切换、设置页、权限卡和屏幕共享选择器。

## 5. 新增文案 SOP

1. 在 `messages.js` 的两个语言块中同时增加 key。
2. 静态 HTML 添加相应的 `data-i18n*`；动态 DOM 使用 `t()`。
3. 主进程用户错误使用 `err()` / `I18nError`，不要直接拼中文最终字符串。
4. 渲染层展示 IPC 错误前调用 `fmtIpc()`。
5. 运行完整测试、类型检查和至少一次相应界面的热切换验收。

## 6. 后续项

- Windows NSIS 安装向导可单独限制 `en_US` / `zh_CN`；它与 App 内 locale 是两层
  独立机制，不应互相传状态。
- 英文 ASR 默认 prompt / 热词需要先验证识别服务效果，再决定是否按 locale 播种。
- 新增第三种语言前，应先引入复数规则和更严格的 locale fallback，而不是继续扩展
  当前的最小插值器。
