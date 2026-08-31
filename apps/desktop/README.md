# Arcane Desk (MVP)

Agent-native desktop for Foundry VTT DMing — agent loop 是窗口本体:
启动即纯 chat;agent 调 `foundry_open` 后 Foundry 主视觉从右侧弹出,
chat 收缩为左栏(combat-only 工具白名单,无 shell)。左右分栏宽度可拖
(分界处的竖条),chat 默认占 30%,拖拽值在面板开关间保持。

UI 为 agent 原生三件套,全部在顶栏:

- ☰ **会话管理**:左侧抽屉列出历史会话(Pi SessionManager JSONL 持久化于
  agent 目录的 `sessions/--<cwd>--/`;dev 运行的 agent 目录是 `~/.pi/agent`,
  打包版收进 app 私有 `userData/agent`,与本机 pi CLI 互不可见),支持新建/
  切换/删除;切换时回放 user/assistant 消息与工具卡。抽屉可收起,战斗时不占主视觉。
- **思考透出**:模型的 thinking 流式显示为一行小字(思考中… → 思考过程 · Ns),
  点击展开完整思考内容;历史会话同样回放。参考 kimi code web 的 turn-fold。
- ☾/☀ **主题**:月之暗面(dark,默认)/ 月之亮面(light)黑白双版,
  切换带圆形扩散动画;选择持久化于 `userData/arcane-ui.json`。
- ⚙ **设置**:管理 LLM provider(新增/编辑/删除,apiKey 打码回显,
  存 `userData/arcane-providers.json`,运行时注册进 Pi ModelRuntime)
  + 切换默认模型(当前会话立即生效)。

## 甜点路径

```
用户在 chat 给 agent 一个本地 FVTT URL
  -> agent 调 foundry_open(url),Foundry 主视觉从右弹出
  -> 用户在右侧 Foundry 面板完成 GM 登录(密码不经过模型工具)
  -> App 在自己持有的 WebContentsView 中执行固定 direct runtime
  -> agent 调 world_status,chat 报告世界信息
  -> 用户进行战斗,agent 用 combat_* 工具推进
  -> 每步四态回执(审批默认关闭,ARCANE_APPROVALS=1 恢复 R2 审批卡)
```

登录态记忆:GM 进 world 后 session cookie 落盘到
`userData/config/foundry-sessions.json`(Foundry 发的是无 expires 的会话
cookie,Chromium 不会自己持久化);下次启动开面板直接回填进 /game。
服务端会话失效(Foundry 重启)被弹回 /join 时自动丢弃 stale 条目,
回到 agent 自主登录路径。应用的所有 JSON 配置都在 `userData/config/`
(ui/providers/voice/foundry-sessions),旧路径启动时自动迁移。

## 快捷键

全局快捷键由 `src/renderer/shortcuts.js` 统一注册:chord 语法
`F9` / `Ctrl+Space` / `Ctrl+Shift+K`,同一动作支持多绑定;分 tap
(按一下)和 hold(按住/松开,窗口失焦兜底释放)两类;焦点在输入框时
只放行功能键与带 Ctrl/Alt/Meta 的组合,裸字符键永不劫持打字。

| 键 | 动作 | 配置 |
|---|---|---|
| F9(默认,可改) | 长按模式:按住说话,松开识别 | 设置 → 语音 → 长按模式,点击录入,× 清除 = 不绑定 |
| 未绑定(默认) | 免按模式:按一下开始说话,再按一下结束 | 设置 → 语音 → 免按模式,同上 |
| F5 | 刷新右侧 Foundry 面板(卡渲染/丢帧自救) | 内置 |

录入支持修饰键组合(Ctrl/Shift/Alt/Win + 主键,含纯修饰组合如
「左 Ctrl+左 Win」);同一动作只绑一条键。设置页录入键位时全局快捷键
暂不响应,Esc 取消录入。

## macOS

源码级跨平台：在 monorepo 根目录安装后，用 workspace 命令即可在 macOS 上运行。平台差异已处理：

- mac 保留最小应用菜单(应用菜单 + Edit),否则 Cmd+C/V/A/Z 在输入框失效
  (macOS 的编辑快捷键由菜单 role 承载);Cmd+Q 退出按 mac 惯例。
- 首次录音向系统申请麦克风权限;被拒时按提示到系统设置 → 隐私与安全性 →
  麦克风开启。打包分发时须在 Info.plist 配 `NSMicrophoneUsageDescription`。
- 快捷键显示按平台区分:mac 上 Meta/Alt 显示为 Cmd/Opt。MacBook 的
  F5/F9 需配合 Fn,建议在设置里改绑组合键。

注意:快捷键目前只在左侧 Agent 面板聚焦时生效(右侧面板是独立
webContents),Windows/mac 皆然,属已知行为。

## 运行

前置:目标 Foundry 可访问(默认 `http://127.0.0.1:30000`)。dev 运行复用本机
Pi 配置(`~/.pi/agent/`);打包版的 pi agent 目录在 app 私有
`userData/agent`,不读 `~/.pi`,模型 Key 在设置页填写或由启动器注入(见下)。
Foundry 不需要安装 Arcane Bridge 模组，也不需要反向连接 Desktop。

安装包资源白名单、宿主机前置、可写目录和 FVTT 安装路径见
[`docs/runtime-dependencies.md`](docs/runtime-dependencies.md)。构建后的资源目录用
`npm run verify:package -- "<Resources/app>"` 验收。

App 内置 `Arcane Spark`（provider id：`arcane-spark`），并在用户尚未选择默认模型时
将它设为默认。用户可以在设置页自行填写受限 Key，也可以由启动器注入：

```powershell
$env:ARCANE_SPARK_API_KEY_FILE = "D:\path\to\arcane-client.token"
$env:ARCANE_SPARK_BASE_URL = "https://llm.arcanedesk.bitterbebop.cn/v1" # 可省略
npm start
```

也可直接用 `ARCANE_SPARK_API_KEY` 注入；`ARCANE_SPARK_FORCE_DEFAULT=1`
会强制切换到内置模型，`ARCANE_SPARK_ENABLED=0` 禁用内置服务。令牌只发给
Desktop，上游供应商 key 始终留在 New API。Desktop 固定发送产品模型 ID `arcane-spark`，
NewAPI 再用渠道 `model_mapping` 映射到真实模型，因此更换上游不需要发布新版 Desktop。
Provider 与语音 Key 由 Electron `safeStorage` 使用操作系统凭据设施保护后再写入
`userData/config/*.json`；旧版明文配置会在首次启动时自动迁移，renderer 只接收掩码。

仓库中的 Arcane 域名只是官方发行版默认值，不含凭据，也不是 SDK/CLI 的运行前置。
自托管发行可设置 `ARCANE_SPARK_BASE_URL`、`ARCANE_TELEMETRY_ENDPOINT` 和
`ARCANE_WEBSITE_URL`；纯 BYOK 构建可设置 `ARCANE_SPARK_ENABLED=0` 与
`ARCANE_TELEMETRY_DISABLED=1`。

同一张 Key 也覆盖语音识别：设置 → 语音识别选「Arcane Spark（语音）」时，Key 与
中转地址留空即默认复用上面的 `arcane-spark` 配置（启动器注入一次,聊天+语音同时
生效）；语音页也可显式填写覆盖。凭据解析与网络请求只发生在主进程。

```bash
npm install
npm --workspace arcane-desktop start
ARCANE_FOUNDRY_URL=http://127.0.0.1:30101 npm --workspace arcane-desktop start
npm --workspace arcane-desktop start -- --dev
```

## 静态类型检查(强制闸门)

本目录是纯 JS,但通过 `checkJs + JSDoc` 接入了 tsc 静态检查:

```bash
npm run typecheck    # tsc --noEmit,必须 0 错误
```

**每次改完本目录下任何代码,提交前必须跑过 `npm run typecheck`。**
CI 也会在 `apps/desktop/**` 变更时强制执行。新增代码请补 JSDoc 类型标注；
`window.arcane` 等桥接 API 变更时同步更新 `types/global.d.ts`。

Desktop 直接依赖 `@arcanedesk/foundry-sdk`。页面 runtime 与调用安全语义由 SDK
提供；Desktop 只实现 Electron `WebContents` transport 和产品工具白名单。

备团模式通过 `arcane-fvtt-setup` skill 使用平台原生 shell 和 Arcane 随包的
Node 22 完成装机。用户可以提供既有安装、本地 Node.js ZIP、Windows EXE、
macOS DMG 或官方 timed URL；不要求系统 Node 或 Git Bash。App 启动时直接完成
私有 Node bootstrap，不再包含或向 Agent 暴露专用 FVTT 安装工具。

## 工具白名单(combat-only,无 shell)

战斗模式的系统提示是 `system-prompts/combat.md`(启动时全量替换 SDK
默认 prompt;安全边界、世界模型、回合循环纪律、四态回执处理、目标调用
合同都在里面)。改战斗行为就改这个文件,重启生效。

备团模式相反:保留 SDK 默认 coding prompt,把 `system-prompts/prep.md`
追加在后面(角色、装机硬顺序、cwd 围栏、世界写入纪律、Mermaid 图示偏好)。

| 工具 | 作用 |
|------|------|
| `foundry_open` | 按需打开/导航 Foundry 面板(幂等,同源不重导航) |
| `browser_evaluate` | 页面内 JS:有界诊断和有限 UI 操作,不处理凭据或绕过结构化战斗工具 |
| `world_status` | world/system/user/modules(只读) |
| `combat_battle_context` | Turn Protocol v2 battle-context(每场战斗读一次) |
| `combat_turn_context` | Turn Protocol v2 turn-context(每次决策前读) |
| `combat_execute_turn` | 提交动作,四态回执;审批开启时需 DM 确认 |

备团/运维模式在 `foundry_open` 和 `browser_evaluate` 之外额外开放只读的
`foundry_screenshot`，用于按需截取当前 Foundry viewport，辅助视觉诊断与修复后验收；
战斗模式的六工具合同不变。

## 调试

- main 进程日志:启动 App 的终端 stdout
- `--dev`:两侧 DevTools(chat + Foundry view)
- main 进程断点:`electron --inspect=9229 .` + `chrome://inspect`

## 架构

当前实现见 `docs/direct-foundry-runtime-mvp.md`；运行与打包边界见
`docs/runtime-dependencies.md`。
