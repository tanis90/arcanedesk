# 流式期间输入双通道规范（冻结版）：备团排队 / 战斗打断

日期：2026-09-10 调研，2026-09-11 评审修订并冻结，2026-09-11 二次修订（§3⑤⑥：队列列表与排队操作，对齐 Kimi Code Web 的排队展示）。状态：**已冻结**，实施与验收以本文档为准。
调研底稿见 `streaming-input-queue-plan.md`（保留作决策记录，含 pi/Kimi Code 调研全文）；本文档取代其 §4–§7 成为实施契约。
行号以 `main@4ffade5` 为准；app 侧路径相对 `apps/desktop/src`，pi 侧相对 `node_modules/@earendil-works`（pi-coding-agent 与 pi-agent-core 均为 0.84.3，语义已对照本机安装源码核实）。

## 1. 需求

agent 运行中（streaming）用户再发消息时——

- **备团模式**：消息进入队列，不打断当前任务，本轮结束后按序处理；
- **战斗（跑团）模式**：保持现状的"打断"语义，消息尽快进入正在运行的轮次。

## 2. 技术结论

用 pi 原生双队列落地：`session.followUp()` = 备团排队，`session.steer()` = 战斗打断（软打断，维持现状）。已核实的关键事实：

- followUp 只在 run 即将结束时（无工具调用且 steering 清空）抽取，注入后同一 run 续跑；`agent_end` 在两条队列都清空后才发射（pi-agent-core/dist/agent-loop.js:160-172）；
- `session.prompt()` 的 promise 覆盖续跑全程，`isStreaming` 全程为 true（pi-agent-core/dist/agent.js:326-371）；
- `queue_update` 事件携带 `{ steering: string[], followUp: string[] }`，投递发生时 SDK 按文本从对应数组移除并重发（pi-coding-agent/dist/core/agent-session.js:301-307、346-364）；
- `_queueSteer`/`_queueFollowUp` 在 `steer()`/`followUp()` 调用内**同步** push 并 emit `queue_update`（agent-session.js:1019-1047）——`TaskCoordinator` 的 `queueing` 捕获窗口依赖这一同步性，§7 测试作为 pi 升级门禁；
- 扩展命令（"/" 开头且命中 extension command）在 push **之前**抛错（agent-session.js:989-993、1006-1010），两条通道一致。

## 3. 改动点

### ① 模式 profile 增加投递方式开关

- `main/agent-host.js` `COMBAT_PROFILE`（:113）增加 `streamingInput: "steer"`（战斗默认值，行为不变）；
- `main/main.js` 创建 prep host 的 profile（:755）增加 `streamingInput: "followUp"`。

### ② adapter 增加 followUp 透传并按 profile 投递

`main/agent-host.js` taskCoordinator adapter（:763-778）增加：

```js
followUp: (text, images) => this.session.followUp(text, images?.length ? images : undefined),
streamingDelivery: () => this.profile.streamingInput ?? "steer",
```

### ③ TaskCoordinator 按投递方式入队

`main/tasks/task-coordinator.js`：

- `queueSteer(input)` 改名 `queueInput(input)`：读 `adapter.streamingDelivery?.() ?? "steer"`，`"followUp"` 调 `adapter.followUp`，否则调 `adapter.steer`；调用前把投递方式记入 `input.delivery`；sync throw → reject 的兜底逻辑不变；
- `observe()` 的 `queue_update` 分支（:190-193）按 `this.queueing.delivery` 读 `event.followUp` / `event.steering` 对应数组取末位记 `expandedText`。两模式各只写一条队列，无歧义；
- `submit()` 构造 ack（:139-140）时增加 `delivery` 字段，取值规则：
  `supplement && adapter.isStreaming?.() ? adapter.streamingDelivery?.() ?? "steer" : null`。
  注意：busy 但非 streaming（如调度器排队中）时 input 停留在 app 层、无 SDK 投递，`delivery` 必须为 `null`，否则遥测会把未入 SDK 队列的输入误计为排队。

### ④ 遥测区分排队/打断

`main/main.js:1366` 目前对所有非 new_task 一律 `turnSteered(mode)`。改为：ack `delivery === "followUp"` → `turnQueued(mode)`，其余非 new_task → `turnSteered(mode)`（保持现状计数口径连续）。telemetry 增加 `turnQueued` 方法。

### ⑤ 备团队列列表（对齐 Kimi Code Web）

排队消息必须有"是哪几条"的可辨识度：**不进对话流**，而是在 composer 上方挂队列列表。

- renderer 按 commandId 跟踪 `input_state` 迁移（现有事件通道），`queued` 态输入在 `.composer` 上方（index.html composer-wrap 内）渲染队列列表，每行：消息文本（单行省略）+ 三个操作——**立即**（改道 steer）、**编辑**（取消并回填 composer 重新编辑，仅文本不还原图片）、**删除**（取消排队）；仅备团模式显示（战斗的 queued 是 steer 瞬时态）；
- **气泡迁移**：输入进入 `queued` 时移除对话流中的乐观气泡（main 本就不转发 user 消息事件，agent-host.js:882，气泡是 renderer 唯一的本地回显）；离开 `queued`（context/cancelled/failed/accepted 兜底）时在对话流底部重建气泡并应用回执——投递后的位置在时间上更真实；恢复快照时 `queued` 输入只建行不建气泡；
- composer placeholder：列表非空时改为"继续输入，消息将排队发送"（i18n `chat.input.queuePlaceholder`），恢复默认 `composer.placeholder`；
- 行数据：文本/图片来自提交时本地记录 + `input_state.inputId` 合并；恢复快照取自 inputs 快照（含 text）；
- i18n：`chat.input.queueNow` / `queueEdit` / `queueRemove` / `queuePlaceholder`（zh-CN / en-US）。

### ⑥ main 排队操作 API

pi 无单条删除 API，`clearQueue()` 两队全清——取消/改道都按"**全清 + 幸存者按序重排**"实现（重排走 `queueInput`，SDK 重跑展开结果确定，`setInputState` 幂等不重复发事件）：

- `TaskCoordinator.cancelQueuedInput(inputId)`：仅接受本任务 `queued` 态输入（否则 `STALE_INPUT`）；`clearQueue()` → 目标置 `cancelled`（走 drain 同款收尾，重启后可按 interrupted 召回）→ 幸存者 `queueInput` 重排；
- `TaskCoordinator.steerQueuedInput(inputId)`：同款守卫；`clearQueue()` → 目标 `delivery = "steer"` 并 `queueInput`（下个 turn 边界软打断生效；reject 时回退 accepted 由 drain 兜底）→ 幸存者重排；
- `setInputState` 幂等：同状态重复设置直接返回，不再发事件（改道时的 queued→queued 不再产生噪音事件）；
- IPC：`chat:queued-input`（`{...modeContext, inputId, action: "cancel" | "steer"}`，isTrustedChatIpc 校验 + validateModeRequest 路由 host）；preload 增加 `updateQueuedInput(context, inputId, action)`；steer 成功记 `turnSteered`（与取消排队的 `turnQueued` 成双成对）。

## 4. 明确不改的部分

- **drain 循环**（task-coordinator.js:219-254）：`adapter.prompt()` 的 promise 覆盖 followUp 续跑全程，退出条件与现状一致；
- **停止链路**：`stop()` 的 `clearQueue()` 本就同时清两条队列（pi 返回 `{ steering, followUp }`），排队输入按 `cancelled` 收尾；
- **输入状态机与持久化**：followUp 投递同样产生 `message_start(user)` → context → consumed；`PendingInputs` 落盘与重启置 interrupted 不变；
- **失败回退**：extension 命令在 push 前 reject（见 §2），`queue_update` 未发出，input **始终停留 accepted**（不存在"由 queued 回退"），run 结束后由 drain 兜底 dispatch——复用现有 catch 逻辑；
- **renderer 主流程**：输入回执状态集合已含 `queued`（renderer/chat.js:329），除 §3⑤⑥ 外无改动。

## 5. 后续可选（本期不做）

- 战斗模式硬打断（abort 在途请求后重发）：pi 0.84.3 无原生 API，如需"立刻停下手上的活"单独立项；
- 编辑召回不还原图片附件（仅文本回填，与 Kimi CLI `↑` 召回一致），如需还原图片另行评估。

## 6. 语义边界与风险

1. **followUp 的投递点 = 整个 run 结束**（无工具调用且 steering 清空）。备团长工具链期间消息一直停留"排队中"，是预期语义；§3⑤ 队列列表让等待可见可操作。
2. **prep 的 waiting_user（agent 提问中）发消息 → 排队**，不打断提问；attention 应答仍走 `tasks:respond`，不变。
3. **战斗模式的"打断"是 pi 的软打断**：在途 LLM 流与在途工具调用执行完，消息在下一次 LLM 调用前生效——现状，本期保持。
4. **战斗审批卡 pending 时发消息**：steer 要等审批解决、工具批结束后才生效——现状，不变。
5. **"/" 开头的 extension 命令不能入队**（steer/followUp 都在 push 前 throw），两模式一致，回退路径已覆盖；`/compact` 忙碌拒绝不变。
6. **多条排队消息默认 one-at-a-time 逐条各跑一轮**；如需"合并成一轮"可 `setFollowUpMode("all")`，默认不动。
7. **模式 = host 构造期静态值**：切模式 = 换 host（renderer/chat.js:168），`streamingInput` 无运行期切换问题。
8. **pi 升级回归风险**：followUp 语义依赖 0.84.3 源码核实的行为（agent-loop.js 投递点、agent_end 时机、queue_update 同步 emit），升级 pi 时以 §7 单测为门禁。
9. **搁浅竞态（评审新增，缓解已存在）**：pi 只在固定点抽取队列——followUp 在末次 `getFollowUpMessages` drain（agent-loop.js:163）之后、`finishRun`（agent.js:366）之前入队时，消息搁浅在 SDK 队列无人投递，且 `followUp()` 非 streaming 时不抛错（agent.js:177-179 无 activeRun 检查）；steer 存在同款竞态（现状即有）。app 侧兜底：input 停在 `queued`（属 pendingStates），drain 的 while 循环重新捡到 → `clearQueue()` 丢掉 SDK 副本 → 作为新 prompt 重发，消息不丢、不重复；代价是该罕见情形下多一轮 agent_start/agent_end 生命周期。§7 增加对应用例固化该兜底。
10. **取消/立即的竞态**：操作只接受 `queued` 态；若 SDK 已把消息 drain 进 loop 但 `message_start` 尚未到达（仍显示 queued），取消/改道不会生效——消息已被 pi 抽走，将照常进入上下文（Kimi 同款竞态，窗口极小）；此时 input 不再匹配 queued 态跟踪，按未跟踪消息处理。

## 7. 测试计划

`apps/desktop/test/task-coordinator.test.mjs` 新增（mock adapter）：

1. prep（streamingDelivery="followUp"）busy+streaming 时 submit → followUp 被调、steer 未被调；ack.delivery="followUp"；
2. `queue_update` 携带 followUp 数组 → input 置 queued 且 expandedText 取 followUp 末位；
3. 投递（message_start user 匹配 expandedText）→ context；assistant message_start → consumed；全程 task 保持 busy 直到 agent_end；
4. followUp reject（extension 命令）→ input 始终 accepted（未经 queued），drain 在 run 结束后兜底 dispatch；
5. stop() → clearQueue 调用且排队输入 cancelled；
6. combat 回归：busy+streaming 时 steer 被调、followUp 未被调，现有用例全绿；
7. 连排两条 followUp：两次 `queue_update` 各自取末位，两条 input 的 expandedText 各自正确、按序投递（评审新增）；
8. 搁浅竞态：followUp 入队成功但 run 直接结束（无投递）→ drain 循环将其作为新 prompt 重发，文本只发一次、clearQueue 被调（评审新增）；
9. cancelQueuedInput：目标置 cancelled 且不再重发（run 结束后 drain 不 dispatch）；幸存者按序重新入队（followUp 重放仅含幸存者）、clearQueue 被调；非 queued 态 → STALE_INPUT；
10. steerQueuedInput：目标改道后 steer 被调、followUp 不再含目标；幸存者重排；目标经 steering 投递 → context → consumed；重复 queued 事件不重复 emit（setInputState 幂等）。

遥测单测（如已有 telemetry 测试文件则随其约定）：非 new_task 且 delivery="followUp" → turnQueued；delivery=null/​"steer" → turnSteered；turnQueued 不影响 summary 的 user_intervention。

## 8. 验收标准

- `node --test test/task-coordinator.test.mjs` 全绿（含 §7 新用例）；
- `npm test`（apps/desktop）全量通过，与 main@4ffade5 基线（392 通过 / 0 失败）一致，无新增失败；
- 手动冒烟（真实模型，需人工执行，不阻塞合并）：备团模式跑长任务（如生成模组）期间连发两条消息 → 当前任务不被打断、composer 上方出现队列列表（两条消息可见，对话流中无对应气泡）、按序各跑一轮（投递时气泡落回对话流）；列表行的 立即/编辑/删除 三操作各验一次；战斗模式发消息 → 维持打断现状。

## 9. 降级储备

备选方案 B（app 层队列）：prep 模式 supplement 且 streaming 时不入 SDK 队列，input 停留 accepted，run 结束后由 drain 作为新 prompt dispatch。改动最小但投递更晚、拆分生命周期折叠块、无 `queue_update` 支撑计数与召回。仅在方案 A 遇到 pi 行为回归时启用。
