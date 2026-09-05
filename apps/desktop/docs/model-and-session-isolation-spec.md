# 会话模型隔离与切换问题 Spec（2026-09-05）

本轮工作源于两个用户报告：①会话之间模型不隔离（在 A 切模型导致 B 跟着变）；
②切换会话/模式会打断运行中的回合。经代码核实：①属实并已修复（P0）；②部分属实，
其中"同模式内切换会话会中止回合"属实但本轮不实施（P1），仅记录结论与设计。

---

## P0（已实施）：模型改为"按会话生效"

### 根因（两层机制叠加）

1. **全局广播**：输入框旁的模型选择器走 `settings:default-model` →
   `switchHostsToModel` 对 combat/prep 两个 host 同时 `setCurrentModel`，并把选择
   持久化为全局 `providers.json` 的 `defaultModel`。在任一会话切模型，另一个
   host 的活动会话被立即 `session.setModel()`（model_change 写进对方 JSONL，
   运行中的回合下一轮 LLM 调用就换模型）。
2. **全局默认覆盖会话自身模型**：Pi SDK 支持按会话恢复模型（JSONL 的
   model_change 条目 + assistant 消息的 provider/model，见 SDK
   `createAgentSession`：仅当调用方不传 `options.model` 时恢复），但
   `AgentHost.attach()` 只要存在全局偏好就传 `options.model`，把会话自身的
   模型压掉。之后打开任何会话都拿到"最后在哪个会话切过的模型"。

### 新语义

| 入口 | 作用范围 | 持久化位置 |
| --- | --- | --- |
| 输入框旁模型选择器（`chat:set-model`，带 mode/generation 校验） | 当前模式的**当前会话** | 该会话 JSONL 的 `model_change`（SDK 原生） |
| 供应商表单"保存并使用" | 同上（会话内切换） | 同上 |
| 设置页"默认模型"（`settings:default-model`） | **新会话的初始模型** + 当前尚无消息的空会话 | 全局 `providers.json` |
| 删除供应商（`settings:delete-provider`） | 定向回退：仅"正在用被删 provider"或"尚无模型"的会话 | 受影响会话 JSONL |

进行中/有历史的会话永远不会被全局默认或另一会话的操作被动切模型。

### 变更清单

- `src/main/agent-host.js`
  - 新增 `initialModelRefForAttach(sessionContextModel, providerStore)`：会话
    自身有可恢复模型时返回 null（不传 `options.model`，SDK 恢复会话模型），
    否则用全局默认兜底。`attach()` 改用它。
  - `attach()` 后 `_currentModelRef`/`modelLabel` 一律以 `session.model`
    （会话实际持有的模型）为准，不再优先全局偏好。
  - `setCurrentModel`：会话已在该模型上时短路（不重复写 model_change），
    返回 `{ ok: true, noop: true }`；注释更新为按会话语义。
  - 新增 `sessionHasMessages()`：attach 的 SessionManager 是否已有 message
    条目（"空会话"判定，供全局默认接管用）。
- `src/main/main.js`
  - 移除 `switchHostsToModel`（双 host 广播）。
  - 新增 `applyDefaultModelToEmptySessions(target)`：默认模型只落到两模式下
    尚无消息的空会话。
  - 新增 `fallbackSessionsOffProvider(providerId)`：删除供应商后的定向回退。
  - `settings:default-model` / `settings:save-provider` / `settings:delete-provider`
    改用上述两个函数；新增 `chat:set-model` IPC（信任校验 + 模式上下文校验 +
    路由到活动 host 的 `setCurrentModel`）。
- `preload.cjs`：暴露 `setChatModel(context, providerId, modelId)`。
- `src/renderer/chat.js`
  - `selectChatModel`（选择器行点击）→ `setChatModel`（会话内切换）。
  - 供应商表单"保存并使用" → `setChatModel`。
  - 设置页默认模型下拉 → `setDefaultModel`（全局默认语义），label 是否变化
    由 host 的 `model_info` 事件决定（空会话被接管时才更新）。
- `src/shared/i18n/messages.js`：`sm.defaultModelNote` 文案改为"只作为新会话的
  初始模型"（zh/en）。
- `types/global.d.ts`：`ArcaneBridge` 增加 `setChatModel`。

### 测试

- `test/agent-host-tools.test.mjs` 新增三例：
  - `initialModelRefForAttach`：已有会话拒绝全局默认、新会话用默认兜底。
  - `sessionHasMessages`：未挂载/仅模式标记/有消息三态。
  - `setCurrentModel`：同模型短路不写 model_change，换模型仍落 `session.setModel`。
- 全量 `npm test`（288 例）与 `npm run typecheck` 通过。

### 兼容性说明

- 历史被污染的会话（此前被广播写入过别人的 model_change）打开时按其 JSONL
  恢复，不会自动纠正历史记录；用户可用选择器手动切回。
- `providers.json` 的 `defaultModel` 字段保留，语义缩小为"新会话初始模型"。
- 全新空会话在设置页改默认后仍会立即跟随（避免"设了默认但空聊天不生效"的
  割裂感）；一旦开始对话即固定。

---

## P1（记录，未实施）

### 2a. 同模式内切换会话会中止运行中回合 —— 属实

每个 `AgentHost`（每模式一个）只持有一个活动 `AgentSession`；
`openSession`/`newSession`/`deleteSession(当前)`/`prep:choose-dir` 的第一步都是
`await this.abort()` 再 `detach()`（agent-host.js）。备团开 A、B 两个会话来回切，
运行中的回合被直接中止。

**修复设计（多会话并存 + 活动指针）**，待实施：

- `AgentHost` 维护 live 会话注册表 `Map<sessionPath, {session, manager,
  unsubscribe, busy}>`；`openSession` 只切 active 指针（目标未存活才新建
  attach），切换路径不再 abort/detach。中止只发生在用户点停止或删除会话。
- 事件负载加 `sessionId`；`busyByMode` 升级为 per-session busy；renderer
  `onEvent` 过滤条件在 mode 之上加 sessionId；抽屉列表给后台运行中的会话加
  运行标记。
- 资源上限：每模式并存会话数设上限（如 3），LRU 回收且绝不回收运行中的。
- 模型隔离（本轮 P0）是它的自然前提：每个存活会话各自持有模型。

### 2b. 跨模式切换：回合不会中止，但存在 UI 伪打断 —— 确定性 bug

结论（静态穷举验证）：`mode:set` 不触碰另一 host，全库仅有的 abort/detach
调用点都在同模式会话操作上；双 host 并存常驻（main.js"切模式不杀 session"
注释 + `busyByMode`）。备团回合在切到战斗期间于主进程继续运行。

但切回时 `renderHistory` 整体重建对话，而流式中的半截回复在 SDK 内部
`streamingMessage`、`message_end` 才进 `session.messages`；进行中的工具卡片虽
在历史里（assistant 消息已落盘）但被立即标记为已完成。结果：正在看的回答和
工具过程瞬间消失、显示"会话已恢复"，回合处在长工具执行阶段时空窗可持续很久
——观感与"被打断"一致。

**修复设计（in-flight 快照 + 重建后补水）**，待实施：

- `AgentHost.forwardEvent` 维护当前回合现场快照 `this._inFlight`：
  `agent_start` 重置；`message_update` 记 `{key, text, thinking}`（key 与
  renderer 同款 `${role}:${timestamp}`）；`tool_execution_start/end` 维护运行中
  工具集合；`message_end` 清 streaming；`auto_retry_start` 丢弃失败尝试的半截；
  `agent_end` 清空。`detach()` 时清掉。
- `currentPayload()` 增加 `inFlight` 字段——该 payload 已流向全部恢复入口
  （`mode:set` 响应、`sessions:current`/启动 `pullCurrentSession`、
  `session_switched` 事件），无需新 IPC。SDK 无公开 streamingMessage 访问器，
  自缓存是正路。
- renderer：`renderHistory(entries, inFlight)` 对运行中的 toolCall 只建卡
  （`ensureToolCard` 默认 running 态）不 `finishToolCard`（后续真实
  `tool_execution_end` 事件正常收尾）；`inFlight.streaming` 用现有
  `streamBubble(key)`/`thinkBlock(key)` 重建气泡——key 一致则后续 delta 与
  终稿无缝更新同一气泡；备团模式注意跳过 `closeWorkBlock` 折叠。busy 时
  "会话已恢复"状态行改为"回合仍在进行"（新 i18n key，zh/en）。
- 主进程部分可用现有测试模式（构造 AgentHost 直接驱动 `forwardEvent` 断言
  `currentPayload().inFlight` 生命周期）覆盖；renderer 无测试基建，靠手动验证。
- 该方案同时是 2a 多会话并存所需的基建（届时 inFlight 按会话各存一份）。

### 2c. 两模式共享 Foundry 面板的工具级互踩 —— 已知交互，暂不处理

combat/prep 的 agent 操作同一个 Foundry WebContents：一方的面板导航会让另一方
in-flight 的 `browser_evaluate`/`foundry_screenshot` 以 `navigated`/超时失败
（有防御、不会挂死，agent 收到结构化错误自行恢复）。`world_status`/`combat_*`
走共享 runtime 实例的串行队列（备团白名单不含 runtime 工具，实际只有战斗在
用；超时从出队起算，排队不误伤）。可选缓解：两模式都有回合在跑时给状态提示。

### 验证方法

主进程日志带 `[agent:prep]`/`[agent:combat]` 前缀，回合生命周期事件均有日志。
开发模式 `npm start` 看终端；打包版 `--enable-logging`。备团发消息后切战斗，
若 `[agent:prep]` 日志持续推进并打出 `turn ended`，即证明后台回合存活。

### 已否决的替代方案

- **renderer 双模式 DOM 保活**（切模式只切显隐）：`messages` 容器被全代码假设
  为单一现场，牵扯滚动/状态行/工作块；且救不了 `session_switched`/新建会话等
  同样需要重建的路径。快照补水对所有恢复入口是同一份逻辑。
- **切换即中止 + 回切自动续跑（re-prompt）**：丢流式状态、重复消耗 token，
  体验劣于并存方案。

---

## 非目标

- 不在本轮实现同模式多会话并存架构（P1 另行排期）。
- 不修改 Pi SDK（`@earendil-works/pi-coding-agent`）本身。
- 不处理历史会话 JSONL 中已被污染的 model_change 记录。
