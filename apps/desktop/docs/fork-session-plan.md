# 分叉会话（Fork Session）方案

2026-09-11。分支 `research/fork-session`，基于 main 369a4b7。状态：v1 已实现并验收（验收结果见第 8 节）。行为定义的权威归属仍是 [唯一技术方案](architecture.md)（分叉会话行为已并入其 1.2 节），本文保留调研与决策记录。

## 1. 目标

在会话 ⋯ 菜单增加"分叉会话"：把任一普通会话整段复制为一个独立新会话，并切换过去。对标 Kimi Code Web GUI 会话右键菜单的同名功能（用户截图 2026-09-11）。v1 只做整段分叉；"从某条消息分叉"留作 v2。

## 2. 参考来源

### Kimi Code（产品形态，贴身参考）

本轮下载到 `tmp-fork-session/kimi-code/`（未提交、不安装不运行，仅静态阅读）：

| 材料 | 路径 | 版本 |
| --- | --- | --- |
| npm 包 @moonshot-ai/kimi-code | `tmp-fork-session/kimi-code/moonshot-ai-kimi-code-0.42.0.tgz` + `package/` | 0.42.0 |
| 开源仓库 MoonshotAI/kimi-code（MIT） | `tmp-fork-session/kimi-code/repo/`（浅克隆） | 见 repo HEAD |
| 挖掘报告 | `tmp-fork-session/kimi-code/REPORT.md` | — |

关键事实：用户截图中的"桌面端"没有独立安装包，GUI 即 CLI 自带的 `kimi web`；截图右键菜单文案与 `package/dist-web/` bundle 内 i18n 字符串逐字吻合（`forkSession:"分叉会话"`）。官方文档：[Sessions and context](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)。

Kimi 三个端的 fork 行为不一致，需分别对待：

| 端 | 入口 | 分叉粒度 | fork 后是否切换 |
| --- | --- | --- | --- |
| TUI / CLI | `/fork`、`kimi fork [id]` | 整段 | **不切换**（保住源会话进行中的 turn 与后台任务，repo `apps/kimi-code/src/tui/commands/session.ts:61-101`） |
| Web GUI（用户截图） | 右键菜单"分叉会话" → `POST /sessions/{id}:fork` | 整段 | **自动切换**，无确认弹窗（dist-web bundle 内 `selectSession(新id)`；路由 `packages/kap-server/src/routes/sessions.ts:891-917`） |
| VS Code | 每条消息上的 fork 按钮 | 截到该 turn（turnIndex） | 确认弹窗后切换（`apps/vscode/webview-ui/src/components/ChatMessage.tsx:153-208`） |

Kimi 引擎侧已确认的规则（`packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts:497-685`）：源会话有 running 或**排队中**的 turn 时拒绝 fork；fork 互斥；新 id + `Fork: <源标题>` 标题 + `forkedFrom` 指针；不复制 goal、logs、排队 goal；失败删除半成品目录。置顶/emoji 是否继承、输入框草稿去向：未确认，不据此宣称。

### pi（技术实现，@earendil-works/pi-coding-agent 0.84.3）

ArcaneDesk 以**库 API** 集成 pi（`src/main/agent-host.js:12`，非 RPC），pi 的全部分叉原语都可直接调用，且当前均无人使用：

| 需求 | pi 原生 API | 出处（node_modules 内已核对） |
| --- | --- | --- |
| 整段复制为新会话文件 | `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` — 新 uuidv7 id、header 写 `parentSession` 谱系指针、重写 cwd、复制全部非 header entries（含 `arcane.session` 模式标记、`session_info` 标题、`model_change`），立即落盘并返回打开好的 manager | `dist/core/session-manager.d.ts:341`，实现 `session-manager.js:1235` |
| 从某条消息切出新文件（v2） | `createBranchedSession(leafId)` — 抽取 root→leaf 单路径写新文件 | `session-manager.d.ts:312` |
| 同文件分支（编辑重发用，非本功能） | `branch(branchFromId)` / `branchWithSummary()` | `session-manager.d.ts:294,306` |
| 按点分叉的进阶语义（v2 参考） | `AgentSessionRuntime.fork(entryId, {position:"before"\|"at"})` | `dist/core/agent-session-runtime.d.ts:87-93` |

结论：**v1 整段分叉所需能力 100% 由 pi 原生提供**，零新依赖、零新存储格式。fork 产物就是一个普通会话 JSONL，天然符合"对话文件是会话存在唯一依据"的设计规则，StartupReconciler 无需改动。不要手动复制文件（会撞会话 id、cwd 不更新、无谱系指针）。

## 3. 产品决策（v1）

| 决策点 | 结论 | 依据 |
| --- | --- | --- |
| 入口 | 普通会话 ⋯ 菜单加"分叉会话"，顺序 `[置顶/取消置顶, 重命名, 分叉会话, 归档会话]`；归档页不提供 | 对标 Kimi 菜单位置；归档会话先恢复再分叉，语义更清晰 |
| 粒度 | 整段复制 | Kimi 菜单 fork 即整段 |
| 切换 | fork 成功后**自动切换到新会话** | 跟 Kimi Web GUI；TUI 不切换的理由（保后台任务）在我们这里不成立——忙碌会话本就禁止 fork |
| 命名 | 写 `customTitle = 前缀 + 源显示标题`，前缀走 i18n（zh「分叉：」/ en "Fork: "）；源无标题时不写 customTitle，让 fork 走自动命名 | Kimi 用 `Fork: ` 前缀；我们的 customTitle 在 `session-navigation.json`，机制现成 |
| 忙碌防护 | 状态为 running/attention 时菜单项禁用并附说明（同归档先例），IPC 侧双重检查返回 `SESSION_BUSY` | `navigation-view.js:152` 归档禁用先例；Kimi 同样拒绝（含排队 turn） |
| 元数据继承 | 置顶不继承、归档状态不继承、`selectedModel` 继承（导航 patch）；模型上下文由被复制的 `model_change` entries 天然继承 | 模型恢复机制见 `agent-host.js:74` |
| 不复制 | `tasks/`、`pending-inputs/`、activity、renderer IndexedDB 草稿——均按 sessionId 隔离存放，天然不复制，符合预期 | 对应 Kimi 不复制 goal/排队项 |
| 空会话 | 允许 fork（ArcaneDesk 新建即落盘 header，forkFrom 复制零条 entries，结果为空会话） | 与 Kimi"源必须已落盘"约束不冲突 |
| 跨模式 | 不支持跨 combat/prep fork；菜单操作天然同模式，`arcane.session` 标记随 entries 复制，模式校验天然通过 | `src/main/session-mode.js` |
| 谱系 | header `parentSession` 由 pi 自动写入，v1 UI 不展示 | v2 展望 |

## 4. 实现改动清单（v1）

链路沿用现有 navigation 命令模式，改动面小：

1. **IPC**：`src/main/main.js` 在 `sessions:deleteArchived`（:1100 附近）旁新增 `sessions:fork`，复用 `navigationTarget(sessionId)`（:1076）解析 `{row, registry, host}`；边界校验沿用同组 handler 的 mode/generation 约定。
2. **fork 流程**（主进程内，建议落在 `SessionRegistry` 或小组件）：
   - host 存在且 busy → `SESSION_BUSY`；
   - host 驻留但空闲 → 先等落盘（复用 `waitForOperations()` / `persistForEviction()`，`agent-host.js:813` 的机制），保证源文件新鲜；
   - `SessionManager.forkFrom(row.path, row.cwd, sessionDir)` → 文件已落盘，关闭返回的 manager；
   - `navigation.patch(newId, { customTitle: 前缀+源标题, selectedModel: 源值 })`；源无标题则只 patch `selectedModel`；
   - 返回 `{ ok, sessionId }`。fork 本身**不在 main 内切换**。
3. **preload**：`preload.cjs:47` 附近加 `forkSession(sessionId)`。
4. **renderer**：`src/renderer/conversations/navigation-view.js`
   - `openMenu()` :149 actions 数组在 `"rename"` 后插入 `"fork"`；running/attention 时禁用并附 `navigation.forkBusy` 说明（复用 :152 的模式）；
   - `action()` :214 加分支：调 `api.forkSession(row.id)`，成功后 `await this.load()` 并走现有 `open()` 打开新会话（完全复用 `sessions:open` 链路）；失败 toast（`SESSION_BUSY` → `forkBusy` 文案）。
5. **i18n**：`src/shared/i18n/messages.js` `navigation.*` 增加 `fork`、`forkBusy`、标题前缀模板（双语）。
6. **失败清理**：forkFrom 抛错时不留文件（源缺失即普通错误 toast）；fork 成功后 open 失败的最坏结果是列表里多一个合法会话，无需对账扩展（R1 崩溃即常态）。

## 5. 测试与验收

- 单测（`apps/desktop/test/`，node --test，仿 `history-index.test.mjs` 用临时目录）：fork 后源文件零改动、新文件 header 新 id + `parentSession` + 模式标记 + `session_info`/`model_change` 保留；导航 patch 的标题与 selectedModel；busy → `SESSION_BUSY`；源无标题 → 不写 customTitle。
- 回归（真实 SDK 会话）：fork 后打开新会话继续对话一轮，确认历史完整、模型恢复、消息渲染正常。**重点验证 entry id 跨文件重复无影响**（forkFrom 保留原 entry id；ArcaneDesk 的 HistoryIndex/messageKey 均按会话隔离，预期无碍，需实证）。
- 手工验收对照 Kimi GUI：菜单位置与文案、fork 后自动切换、新会话标题带前缀、忙碌时禁用、源会话无任何变化。

## 6. 风险与未确认项

- entry id 重复：见上，需真实会话回归确认。
- 驻留 host 的落盘新鲜度：依赖 fork 前 persist 步骤，实现时核对 SDK 是否有延迟 flush。
- pi 的 v4 lane API（pi-agent-core harness）疑似未接线，本方案不依赖。
- Kimi 侧未确认项（草稿去向、置顶/emoji 继承）不影响本方案——我们按自身机制定义，已在上表写明。

## 7. v2 展望（不在本方案）

- **从某条消息分叉**：消息气泡上加 fork 入口（对标 Kimi VS Code 端），主进程用驻留 manager 的 `createBranchedSession(leafId)`；leafId 与 `historyIndex()` 的映射现成。需要确认/确认弹窗（"该消息之后的内容不会带入分叉"）。
- 谱系展示：利用 header `parentSession` 在 UI 标注"分叉自 ×××"。
- 导出会话：Kimi 菜单有此项，ArcaneDesk 目前无导出功能，属独立功能另行评估。

## 8. 验收结果（2026-09-11）

- `npm test --workspace arcane-desktop`：471 全绿，含新增 `test/session-fork.test.mjs` 4 例（forkFrom 复制语义与源文件零改动、busy/operations 拒绝与空闲 flush 后分叉、导航元数据持久化往返、缺失源稳定错误码）。注意首次运行前需 `npm run build:sdk`，否则 direct-foundry-runtime 因缺 SDK dist 失败（环境前置，与本改动无关）。
- `npm run typecheck --workspace arcane-desktop`：通过（含 verify:source 边界检查）。
- `npm run docs:check`：通过；simplification-plan.md 的两条 dist 链接提示是本 worktree 未打包的既有环境噪声，与本改动无关。
- 分叉后继续对话的独立性已在测试覆盖（复制文件可打开、可追加、模式标记与标题/模型继承有效；entry id 跨文件重复经回归无碍——消息索引按会话隔离）。
- 未做 GUI 人工验收：需要真实桌面窗口与 Foundry 会话，按第 5 节手工清单留给发版前回归（菜单文案与位置、自动切换、忙碌禁用、源会话无变化）。
