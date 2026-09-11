# 流式期间输入双通道技术方案：备团排队 / 战斗打断

日期：2026-09-10。状态：调研完成，待评审。

## 1. 需求与现状

**需求**：agent 运行中（streaming）用户再发消息时——

- 备团模式：消息进入队列，不打断当前任务，本轮结束后按序处理；
- 战斗（跑团）模式：保持现状的"打断"语义，消息尽快进入正在运行的轮次。

**现状**：两个模式行为一致，全部走 pi 的 steer（软打断）。链路：

```
renderer(chat.js) ──chat:prompt──> main.js ──> AgentHost.submitInput
  ──> TaskCoordinator.submit()                     (task-coordinator.js:127)
      busy && adapter.isStreaming() ──> queueSteer()   (task-coordinator.js:175)
        ──> adapter.steer ──> session.steer()      (agent-host.js:766)
```

输入状态机（accepted → queued → context → consumed）由 `TaskCoordinator.observe()` 依据 SDK 事件推进（task-coordinator.js:188），排队/打断语义差异只需要改"投递方式"这一环，状态机、drain 循环、持久化均可复用。

## 2. 调研一：pi 有没有原生实现 —— 有，且是一对原生双队列

依赖版本 `@earendil-works/pi-coding-agent@0.84.3`（apps/desktop/package.json）。以下语义均核对过安装在本机 node_modules 的实际源码，非仅凭文档。

### 2.1 两条原生队列

`Agent`（pi-agent-core）持有两个 `PendingMessageQueue`：`steeringQueue` 与 `followUpQueue`，各有抽取策略 `mode: "all" | "one-at-a-time"`（默认 one-at-a-time，逐条投递）。见 pi-agent-core/dist/agent.js:51-79、128-129。

`AgentSession` 暴露的 API（agent-session.d.ts / agent-session.js）：

| API | 语义 | 投递时机 |
| --- | --- | --- |
| `session.steer(text, images)` | 打断/转向（官方注释原文即 "interrupt"） | 当前 assistant turn 的工具调用执行完后、下一次 LLM 调用前注入（agent-session.js:989-998） |
| `session.followUp(text, images)` | 排队（"processed after the agent finishes"） | agent 没有更多工具调用且 steering 队列清空后才注入（agent-session.js:1006-1015） |
| `session.prompt(text, { streamingBehavior: "steer" \| "followUp" })` | 统一入口，streaming 时必须显式指定投递方式 | 内部按选项转调上面两者（agent-session.js:795-846） |
| `session.clearQueue()` | 清空两条队列并返回 `{ steering, followUp }` | 用于 abort 时回收排队内容 |
| `setSteeringMode / setFollowUpMode("all" \| "one-at-a-time")` | 抽取策略 | one-at-a-time = 逐条各跑一轮；"all" = 一次合并进下一轮 |

### 2.2 主循环里的投递点（关键差异）

pi-agent-core/dist/agent-loop.js 的 `runLoop`：

- steering：**每次 `turn_end` 之后**都会抽取一次（agent-loop.js:160），在下一个 assistant 响应前注入——所以 steer 是"软打断"：不打断在途的 LLM 流和在途工具调用，但在下一轮 LLM 调用前改道；
- followUp：**只有内层循环即将退出时**（无工具调用、steering 已清空）才抽取（agent-loop.js:162-167），注入后 run 继续；
- `agent_end` 只在两条队列都清空后才发射（agent-loop.js:172）——排队消息在同一个 run 内续跑，`session.prompt()` 的 promise 覆盖全部续跑，`isStreaming` 全程为 true。

### 2.3 事件与身份匹配

`queue_update` 事件携带两条队列的展开后文本：`{ steering: string[], followUp: string[] }`（agent-session.js:301-307）。投递发生时（`message_start` user）SDK 先把该消息从对应数组移除并重发 `queue_update`（agent-session.js:346-364）。

这正是 `TaskCoordinator.observe()` 现在依赖的匹配机制：`queue_update` 时取展开文本记为 `input.expandedText` 并置 `queued`；`message_start(user)` 文本匹配后置 `context`；`assistant message_start` 后置 `consumed`（task-coordinator.js:190-209）。**该机制对 followUp 队列同样成立**，只需按投递方式读对应数组。

### 2.4 pi 自家 TUI 的交互分工（佐证语义定位）

pi 交互模式默认 Enter = steer；`Alt+Enter`（Windows `Ctrl+Q`）= followUp 排队；`Alt+Q`/`Alt+Up` = 把排队消息召回编辑器（dist/core/keybindings.d.ts:293-297，docs/keybindings.md:161）。即 pi 官方定位：steer = 默认打断通道，followUp = 显式排队通道。

## 3. 调研二：Kimi Code 怎么做的

### 3.1 交互模型（官方文档）

Kimi Code CLI 在流式输出期间提供**双通道输入**：

- **Enter = 排队（默认）**：消息放入队列，当前轮次结束后自动发送；输入区标题显示排队计数（`── input · 2 queued ──`）；空输入框按 `↑` 召回最后一条排队消息编辑。Skill 斜杠命令忙碌时同样排队而不是被拒绝。 [Kimi CLI 文档·交互与输入](https://moonshotai.github.io/kimi-cli/zh/guides/interaction.html "citation")，[Kimi Code 文档·斜杠命令](https://www.kimi.com/code/docs/kimi-code-cli/reference/slash-commands.html "citation")
- **Ctrl+S = 立即注入**：把输入立即注入正在运行的轮次上下文，模型立刻看到。 [Kimi Code 文档·交互与输入](https://www.kimi.com/code/docs/kimi-code-cli/guides/interaction.html "citation")
- **Esc / Ctrl+C = 中断当前轮次**：中断时保留 assistant 已生成的部分输出，并提醒模型上一轮是被主动中断的。 [Kimi Code 变更记录 0.31.1](https://www.kimi.com/code/docs/kimi-code-cli/release-notes/changelog.html "citation")

### 3.2 实现层次（kimi-code 仓库源码，agent-core-v2 包）

排队和打断都实现在 **agent core 的状态机层**，不是 TUI 本地土法：

- **排队（Enter）**：`loopService.submit()` 为每条消息建 `reservation`（turn 状态 `queued`）压入队列；仅当空闲才立即 launch（loopService.ts:198-207）。状态机在一轮结束时 `queueDrained` 逐条取队首起新 turn（human/agent/machine.ts:476-485）。客户端收到 `prompt.queued` 事件（含 queueLength）用于显示计数（promptService.ts:327-355）。
- **注入（Ctrl+S）**：`promptService.submitSteer()` 先把消息入队，再立即调用 `steer([id])` 将其从队列"转换"为注入（promptService.ts:373-465）。`loopService.steer()` 做两件事：**abort 在途 LLM 请求的 steerController**（`abortError('Steered by new input')`），并通知状态机 `input.steer`——机器把消息从 queue 移入 notifications，作为**标准 user 消息**注入运行中的上下文，当前 step 带新消息重跑（loopService.ts:214-232，machine.ts:399-416）。即 Kimi 的 steer 是**硬打断在途请求**。
- 历史演进佐证：1.14.0 wire 协议新增 `steer` 请求；1.21.0 steer 内容从伪造 `_steer` toolCall 改为标准 User 消息（改善上下文序列化）；1.31.0 Shell 上线 Enter 排队 / Ctrl+S 注入双通道。 [Kimi CLI 变更记录](https://moonshotai.github.io/kimi-cli/zh/release-notes/changelog.html "citation")

### 3.3 对我们的启示

| | arcanedesk 现状 | pi 原生能力 | Kimi Code |
| --- | --- | --- | --- |
| 排队通道 | 无（busy 时一律 steer） | `followUp`：run 结束才投递，同 run 续跑 | core 状态机队列，轮次结束后起新 turn |
| 打断通道 | `steer`：软打断（turn 边界改道，在途工具调用执行完才生效） | 同上 | `steer`：硬打断（abort 在途 LLM 请求后立即注入重跑） |
| 排队 UX | 无计数、无召回 | `queue_update` 事件可供计数 | 输入区计数 + ↑ 召回 |
| 中断（停止） | abort，两队齐清 | `clearQueue()` + `abort()` | cancel turn，保留部分输出并告知模型被中断 |

结论：**"备团排队 / 战斗打断"用 pi 原生 followUp/steer 即可完整落地**，与 Kimi Code 的产品语义一一对应；差异仅在 Kimi 的 steer 会 abort 在途请求（见 §6 风险与边界）。

## 4. 技术方案（推荐：pi 原生 followUp，模式决定投递方式）

### 4.1 改动点（共 3 处，均在 main 进程）

**① 模式 profile 增加投递方式开关**——模式行为差异本就收敛在 profile（agent-host.js:48 的 M2 约定）：

- `COMBAT_PROFILE` 增加 `streamingInput: "steer"`（战斗默认值，行为不变）；
- main.js:755-760 创建 prep host 的 profile 增加 `streamingInput: "followUp"`。

**② adapter 增加 followUp 透传并按 profile 投递**（agent-host.js:758-773）：

```js
followUp: (text, images) => this.session.followUp(text, images?.length ? images : undefined),
streamingDelivery: () => this.profile.streamingInput ?? "steer",
```

**③ TaskCoordinator 按投递方式入队**（task-coordinator.js）：

- `queueSteer(input)` 改为 `queueInput(input)`：读 `adapter.streamingDelivery()`，`"followUp"` 调 `adapter.followUp`，否则调 `adapter.steer`；在 input 上记 `input.delivery`；
- `observe()` 的 `queue_update` 分支（task-coordinator.js:190-193）按 `this.queueing.delivery` 读 `event.followUp` / `event.steering` 对应数组取 `expandedText`；两模式各只写一条队列，无歧义。

### 4.2 明确不需要改的部分

- **drain 循环**（task-coordinator.js:219-254）：`adapter.prompt()` 的 promise 覆盖 followUp 续跑全程，循环退出条件与现状一致；
- **停止链路**：`stop()` 的 `clearQueue()` 本就同时清两条队列（pi 返回 `{ steering, followUp }`），排队输入按 `cancelled` 收尾，现状已覆盖；
- **输入状态机与持久化**：followUp 投递同样产生 `message_start(user)` → context → consumed；`PendingInputs` 落盘与重启置 interrupted 不变；
- **失败回退**：followUp reject（如 "/" 开头命中 extension 命令限制）时 input 由 queued 回退 accepted，run 结束后由 drain 兜底 dispatch——复用 queueSteer 现有 catch 逻辑；
- **renderer**：输入回执状态集合已含 `queued`（chat.js:329），主流程无改动。

### 4.3 遥测

main.js:1366 目前对所有非 new_task 一律 `turnSteered(mode)`；按 ack 增加投递方式（如 `disposition: "supplement", delivery: "followUp"`），区分 `turnQueued` / `turnSteered`，便于后续验证备团排队使用率。

### 4.4 备选方案 B：app 层队列（Kimi 早期 TUI 式）

prep 模式下 supplement 且 streaming 时不入队 SDK，让 input 停留在 accepted，当前 run 结束后由 drain 循环作为新 prompt dispatch（现有非 streaming 分支天然如此）。改动最小（只加 mode 判断），但：

- 投递更晚（SDK run 完全结束 + app 再调度），且中间多一次 agent_end/agent_start 生命周期，"工作过程"折叠块会被拆成两轮；
- 没有 `queue_update` 支撑排队计数与召回；
- 放弃 pi 原生队列等于把 Kimi Code 已演进掉的 client-side 方案再实现一遍。

仅在方案 A 遇到 pi 行为回归时作为降级储备。

## 5. UX 配套

- **最小可用**：主流程不动即可用（按回执修订，排队/分发/消费不渲染小字）。
- **建议本期做**：备团模式输入区显示排队计数（如输入框角标"已排队 N"），数据来自 input_state 事件（queued 状态计数），无新 IPC。
- **后续可选（对齐 Kimi Code）**：空输入框 `↑` 召回最后一条排队消息重新编辑（需 main 提供取消排队输入的接口，PendingInputs 删除 + `session.clearQueue()` 定向清理）；备团增加"立即发送"修饰键（Ctrl+Enter 走 steer）。

## 6. 语义边界与风险

1. **followUp 的投递点 = 整个 run 结束**（无工具调用且 steering 清空）。备团长工具链期间消息一直停留"排队中"，这是预期语义；排队计数 UX 用于缓解焦虑。
2. **prep 的 waiting_user（agent 提问中）发消息 → 排队**，不打断提问；attention 应答仍走 `tasks:respond`，不变。
3. **战斗模式的"打断"是 pi 的软打断**：在途 LLM 流与在途工具调用会执行完，消息在下一次 LLM 调用前生效——这是现状，本期保持。Kimi Code 的 steer 会 abort 在途请求（硬打断）；pi 0.84.3 无此原生 API，若未来要"立刻停下手上的活"，需 abort + 重组上下文重发，单独立项评估。
4. **战斗审批卡 pending 时发消息**：steer 消息要等审批解决、工具批结束后才生效——现状如此，不变。
5. **"/" 开头的 extension 命令不能入队**（steer/followUp 都会 throw），两模式一致，回退路径已覆盖；`/compact` 忙碌拒绝不变。
6. **多条排队消息默认 one-at-a-time 逐条各跑一轮**；如需"合并成一轮"可 `setFollowUpMode("all")`，建议默认不动。
7. **模式 = host 构造期静态值**：切模式 = 换 host（chat.js:168），`streamingInput` 无运行期切换问题。
8. **pi 升级回归风险**：followUp 语义依赖 0.84.3 源码核实的行为（agent-loop.js 投递点、agent_end 时机），升级 pi 时把 §7 单测作为门禁。

## 7. 测试计划

`apps/desktop/test/task-coordinator.test.mjs` 新增（mock adapter）：

- prep host（streamingDelivery="followUp"）busy+streaming 时 submit → followUp 被调、steer 未被调；ack.delivery="followUp"；
- `queue_update` 携带 followUp 数组 → input 置 queued 且 expandedText 取 followUp 末位；
- 投递（message_start user 匹配 expandedText）→ context；assistant message_start → consumed；全程 task 保持 busy 直到 agent_end；
- followUp reject → input 回退 accepted，drain 在 run 结束后兜底 dispatch；
- stop() → clearQueue 调用且排队输入 cancelled；
- combat 回归：busy+streaming 时 steer 被调、followUp 未被调，现有用例全绿。

冒烟（真实模型）：备团模式跑一个长任务（如生成模组）期间连发两条消息 → 当前任务不被打断，两条消息按序各跑一轮；战斗模式发消息 → 维持打断现状。

## 8. 结论

pi 有原生实现且语义完全覆盖需求：`followUp` = 备团排队，`steer` = 战斗打断。Kimi Code 的产品答案（Enter 排队 / Ctrl+S 注入 / Esc 中断）验证了"排队为默认、打断为显式"的交互正确性；其 core 状态机队列的实现方式也印证了"队列语义放在 agent 核心层而非 UI 层"的方向。推荐方案 A：3 处 main 进程改动 + 模式 profile 一个开关，状态机/持久化/停止链路零改动，备选方案 B 留作降级储备。
