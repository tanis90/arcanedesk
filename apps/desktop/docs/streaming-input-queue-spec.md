# 流式期间输入双通道规范（冻结版）：备团排队 / 战斗打断

日期：2026-09-10 调研，2026-09-11 评审修订并冻结。状态：**已冻结**，实施与验收以本文档为准。
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

### ⑤ 备团输入区排队计数

- renderer 监听 `input_state` 事件（现有通道，无新 IPC），按会话维护 `queued` 状态计数，在 composer 提示区（`.hint-left`，index.html:1683-1686）显示角标"已排队 N"，N=0 时隐藏；会话切换/恢复快照时按 inputs 快照重算；
- 仅备团模式显示（战斗模式的 queued 是 steer 软打断的瞬时态，计数无意义）；
- i18n：`chat.input.queuedCount`（zh-CN / en-US 各一条）。

## 4. 明确不改的部分

- **drain 循环**（task-coordinator.js:219-254）：`adapter.prompt()` 的 promise 覆盖 followUp 续跑全程，退出条件与现状一致；
- **停止链路**：`stop()` 的 `clearQueue()` 本就同时清两条队列（pi 返回 `{ steering, followUp }`），排队输入按 `cancelled` 收尾；
- **输入状态机与持久化**：followUp 投递同样产生 `message_start(user)` → context → consumed；`PendingInputs` 落盘与重启置 interrupted 不变；
- **失败回退**：extension 命令在 push 前 reject（见 §2），`queue_update` 未发出，input **始终停留 accepted**（不存在"由 queued 回退"），run 结束后由 drain 兜底 dispatch——复用现有 catch 逻辑；
- **renderer 主流程**：输入回执状态集合已含 `queued`（renderer/chat.js:329），除 §3⑤ 角标外无改动。

## 5. 后续可选（本期不做）

- 空输入框 `↑` 召回最后一条排队消息重新编辑。约束：pi 无单条删除 API，`clearQueue()` 两队全清；"召回末条、保留其余"只能全清后重新入队幸存者，且重新入队会重跑 skill/template 展开（对已展开文本二次展开通常无害，设计时需知晓）；
- 备团"立即发送"修饰键（Ctrl+Enter 走 steer）；
- 战斗模式硬打断（abort 在途请求后重发）：pi 0.84.3 无原生 API，如需"立刻停下手上的活"单独立项。

## 6. 语义边界与风险

1. **followUp 的投递点 = 整个 run 结束**（无工具调用且 steering 清空）。备团长工具链期间消息一直停留"排队中"，是预期语义；§3⑤ 排队计数用于缓解焦虑。
2. **prep 的 waiting_user（agent 提问中）发消息 → 排队**，不打断提问；attention 应答仍走 `tasks:respond`，不变。
3. **战斗模式的"打断"是 pi 的软打断**：在途 LLM 流与在途工具调用执行完，消息在下一次 LLM 调用前生效——现状，本期保持。
4. **战斗审批卡 pending 时发消息**：steer 要等审批解决、工具批结束后才生效——现状，不变。
5. **"/" 开头的 extension 命令不能入队**（steer/followUp 都在 push 前 throw），两模式一致，回退路径已覆盖；`/compact` 忙碌拒绝不变。
6. **多条排队消息默认 one-at-a-time 逐条各跑一轮**；如需"合并成一轮"可 `setFollowUpMode("all")`，默认不动。
7. **模式 = host 构造期静态值**：切模式 = 换 host（renderer/chat.js:168），`streamingInput` 无运行期切换问题。
8. **pi 升级回归风险**：followUp 语义依赖 0.84.3 源码核实的行为（agent-loop.js 投递点、agent_end 时机、queue_update 同步 emit），升级 pi 时以 §7 单测为门禁。
9. **搁浅竞态（评审新增，缓解已存在）**：pi 只在固定点抽取队列——followUp 在末次 `getFollowUpMessages` drain（agent-loop.js:163）之后、`finishRun`（agent.js:366）之前入队时，消息搁浅在 SDK 队列无人投递，且 `followUp()` 非 streaming 时不抛错（agent.js:177-179 无 activeRun 检查）；steer 存在同款竞态（现状即有）。app 侧兜底：input 停在 `queued`（属 pendingStates），drain 的 while 循环重新捡到 → `clearQueue()` 丢掉 SDK 副本 → 作为新 prompt 重发，消息不丢、不重复；代价是该罕见情形下多一轮 agent_start/agent_end 生命周期。§7 增加对应用例固化该兜底。

## 7. 测试计划

`apps/desktop/test/task-coordinator.test.mjs` 新增（mock adapter）：

1. prep（streamingDelivery="followUp"）busy+streaming 时 submit → followUp 被调、steer 未被调；ack.delivery="followUp"；
2. `queue_update` 携带 followUp 数组 → input 置 queued 且 expandedText 取 followUp 末位；
3. 投递（message_start user 匹配 expandedText）→ context；assistant message_start → consumed；全程 task 保持 busy 直到 agent_end；
4. followUp reject（extension 命令）→ input 始终 accepted（未经 queued），drain 在 run 结束后兜底 dispatch；
5. stop() → clearQueue 调用且排队输入 cancelled；
6. combat 回归：busy+streaming 时 steer 被调、followUp 未被调，现有用例全绿；
7. 连排两条 followUp：两次 `queue_update` 各自取末位，两条 input 的 expandedText 各自正确、按序投递（评审新增）；
8. 搁浅竞态：followUp 入队成功但 run 直接结束（无投递）→ drain 循环将其作为新 prompt 重发，文本只发一次、clearQueue 被调（评审新增）。

遥测单测（如已有 telemetry 测试文件则随其约定）：非 new_task 且 delivery="followUp" → turnQueued；delivery=null/​"steer" → turnSteered。

## 8. 验收标准

- `node --test test/task-coordinator.test.mjs` 全绿（含 §7 新用例）；
- `npm test`（apps/desktop）全量通过，与 main@4ffade5 基线（392 通过 / 0 失败）一致，无新增失败；
- 手动冒烟（真实模型，需人工执行，不阻塞合并）：备团模式跑长任务（如生成模组）期间连发两条消息 → 当前任务不被打断、输入区显示排队计数、两条消息按序各跑一轮；战斗模式发消息 → 维持打断现状。

## 9. 降级储备

备选方案 B（app 层队列）：prep 模式 supplement 且 streaming 时不入 SDK 队列，input 停留 accepted，run 结束后由 drain 作为新 prompt dispatch。改动最小但投递更晚、拆分生命周期折叠块、无 `queue_update` 支撑计数与召回。仅在方案 A 遇到 pi 行为回归时启用。
