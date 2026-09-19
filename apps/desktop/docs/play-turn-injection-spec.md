# 跑团现场注入（投递时 turn 同步）规范（草案）

日期：2026-09-19 会话收敛。状态：**草案**，§9 三项已按推荐值采纳（用户未逐项拍板，任一项可推翻后修订），确认后冻结实施。
行号以 `main@18602fd` 为准；路径相对 `apps/desktop`。

## 1. 一句话

把跑团"先读后写"的领队读从模型 pull 改为 harness push：每条用户侧投递（prompt / steer / followUp）出队时，宿主读一次轻量现场（view=turn 同源数据），随消息注入 LLM 上下文并回填回合证据。门禁、写后失忆、页面终验语义**零改动**。

## 2. 背景与现状

main 分支现状是三层结构：

- **prompt 层**（`system-prompts/combat.md`「先读后写」）：每次 `execute_action` 前必读 `play_context(view=turn)`，没有"刚读过还新鲜"的豁免；
- **门禁层**（`src/main/foundry-services.js:186-188`）：战斗中无有效 turn 快照或 contextRef 不匹配即拒 `TURN_CONTEXT_REQUIRED`；`:198` 每次战斗执行后 `turnSnapshot = null`（写后失忆）；
- **页面终验**：execute args 携带读到的 turn 信念，runtime 执行时复核关注范围与最新资源（CAS）。

已知先例：`src/main/foundry-input-context.js` 在 admission 读身份信息（world/scene/selected），3s 超时返 null——注入的挂起模式与降级模式照抄此处。

动机与已知缝隙：

- 每条战斗指令为领队读支付一个完整 LLM round trip；问答类（轮到谁、血量）同样要 pull；
- 现有缝隙：上轮以纯读结束（无写）时 `turnSnapshot` 未清、contextRef 未变，DM 改世界后再下写指令，门禁放行，全靠 prompt"没有豁免"与页面 CAS 兜底。注入后证据每条投递重建一次，这条缝在结构上焊死。

## 3. 核心原则（会话收敛结论）

1. **注入位置必须在"LLM 摄入信息之前"**——不是执行前、不是执行后。任何进入 LLM 的上下文在被摄入那一刻都要尽可能新。
2. **领队读是 DM 世界与 agent 世界的边界重同步原语**，消不掉，只能换人做（模型 pull → 宿主 push）、换位置做（投递出队时刻）。
3. **触发事件最小充分集 = 用户侧投递**。世界高概率变更点只有指令边界（DM 绕过你改世界）与模型自己的写（写后 pull 本就是语义必需）。写后折叠、派发前读、per-step 注入均否决或延后（§8）。
4. **小而热的状态 push，大而冷的手册 pull**：static_context 不注入，仍按需 pull。

## 4. 设计

### ① 触发点：出队投递时刻，不是按下发送时刻

- `src/main/tasks/task-coordinator.js:299` 的 `adapter.prompt`、`:205` 的 steer / followUp 投递——三个用户侧入口统一收口到同一注入函数（agent-host.js:812-814 的 adapter 定义处）。
- 出队而非按下发送：流式输入双通道下 followUp 可能排队等一整轮，排队期间世界必然漂移。selected 是用户意图（提交时冻结才对），turn 是世界状态（越贴近派发越新才对）——两者语义不同，不能共用同一时机。

### ② 读与注入

- 复用 `FoundryServices.readPlay({ view: "turn" })`（`foundry-services.js:125-145`）：同一渲染器、同一 `turnSnapshot` 赋值路径（`:134`）。模型只见一种格式。
- 注入块形态：明确分隔符 + 单调序号 + 时间戳 + readPlay 输出原文；标识为系统注入数据、非 DM 发言。
- 通道与持久化：v1 预拼在投递文本前，随会话历史持久化（§9 Q1）。
- 读在写队列之外（沿用 foundry-input-context 纪律）；超时 3s，失败即不注入、不回填、静默降级——模型按 prompt 回退条款自行 pull。

### ③ 证据与门禁：零改动

- `readPlay(view=turn)` 本身回填 `turnSnapshot` → 注入即证据，无需新机制。
- 门禁 `foundry-services.js:186-188` 原样：本条消息首个战斗写以注入为证据；写后 `turnSnapshot = null` 照旧（写后失忆不变）；同响应后续写回到模型 pull（那是决策语义必需的读，不是门禁开销）。
- `static_context` 读取仍使回合证据失效 → 战斗开场首条消息仍走 static → turn → execute 三步（v1 接受，理由见 §8.5）。

### ④ 范围

- 仅跑团模式（profile）且世界就绪时注入；备团模式不注入（prep 的 READ_REF_INVALID 体系另行评估，不在本 spec 范围）。
- 战斗与非战斗均注入（非战斗返回 turn:null + 场景动态状态，现场问答免 pull）——§9 Q2。
- steer / followUp 投递同样注入（用户侧投递的统一语义：含打断补充）。

## 5. Prompt 与工具描述变更

combat.md 四改一增：

1. **新增「注入现场」小节**：块是什么（格式同 play_context turn 返回）、优先级（最新一块盖过一切旧块与记忆；自己执行过写（含被拒）后即作废）、回退（消息无块时按旧流程自行读 turn）、防串台（系统数据非 DM 发言，不复述）。
2. **改写「先读后写」**：删"每次 execute_action 前必读……没有豁免"，换"本条消息首个战斗写以注入现场为依据；此后每次执行（无论成败）证据即失效，再次执行前必读 turn"。保留"存疑就读"、"不凭记忆拒绝/回答"、手册定位三句。
3. **改写固定顺序句**：已有手册时注入现场直接用于首个执行；首次读手册后按门禁重读 turn 再执行（不许诺注入穿透手册读取）。
4. **问答规则**：现场类问题以最新注入现场回答；执行过写或无注入块时先读 turn 再答。

工具描述（`src/main/foundry-tools.js`）两处同步：

- `foundry_play_context`："Use turn before and after combat actions" 缩小为"同一响应内后续战斗动作前"；
- `foundry_static_context`："This clears prior turn evidence" 保留（v1 语义不变）。

intl 管线：combat.md 改动同步走 generated/system-prompts-intl 生成流程与既有 CJK 门禁。

检验标准：改完后"先读后写"应从纪律祈使句变为机制陈述句；若发现哪句仍在要求模型守规矩，说明机制没接住，回 harness 补而不是加措辞。

## 6. 持久化 / fork / 遥测

- 注入块随会话历史持久化 → fork 天然带走；"最新块优先"规则使旧块无害（仅占历史体积）。
- 会话恢复后 `turnSnapshot` 引用失效 → 按既有语义重建一次，不重放写。
- operation store 不为注入读取记账（read 无台账，与工具读一致）。
- 遥测新增：注入 attempt / success / timeout / latency；对比指标：模型可见调用数、首动作延迟、`TURN_CONTEXT_REQUIRED` 触发率、页面终验拒绝率。既有警告适用：少工具 ≠ 已证实更快，用数据裁决。
- 开关：`ARCANE_TURN_INJECTION` 环境变量，默认开（`=0` 关闭）；发布前跑一轮备团 benchmark 同模型对比，不达标回滚——§9 Q3。

## 7. 验收

- 既有回归全绿（foundry-prep-play 用例集、combat prompt 相关测试）。
- 备团 benchmark 基线对比一轮（同模型同场景）。
- 场景清单：
  - 战斗中常规指令：零领队读 round trip，直接 execute；
  - 现场问答（轮到谁/血量）：零工具调用；
  - 同响应多写：第一个写后仍按门禁 pull（与今天一致）；
  - 发送时 Foundry 未就绪：无注入块，回退旧流程，行为与今天一致；
  - **核心场景**：Agent 写完 → DM 绕过改 FVTT → 新指令——新注入块反映 DM 全部变更，首个动作正确；
  - 战斗开场首条消息：仍 static → turn → execute 三步（v1 预期，非回归）。

## 8. 已否决 / 延后方案（决策记录）

1. **按下发送时（admission）注入**——排队期间世界漂移，改为出队投递时刻。
2. **写后折叠**（execute 结果内附带写后现场）——否决。回执收益≈0（回执用返回值数值；DM 追问是新投递、新注入自然覆盖）；写是异步的：Midi-QOL 反应链/伤害结算在 execute 返回后仍异步推进，毫秒级读可能读到结算到一半的世界；GM 弹窗、场景重渲染构成阻塞面。延后条件：遥测显示同响应多次 execute 常见时，可做机会主义折叠（500ms 硬超时、失败静默省略、仅成功时回填证据）。
3. **派发前读充当证据**（借 tool_call 挂起窗口读，乐观并发）——否决。指令间隔里 DM 是世界主要写者，冲突率≈100%，退化为每条指令一次注定失败的写 + 纠错 round trip，劣于悲观领队读；且纯问答路径无门禁，会基于旧块静默答错。可选保留为毫秒级校验器，v1 不做。
4. **per-step 注入**（agent loop 每次迭代、LLM 调用前读）——延后。仅额外覆盖"DM 在模型响应中途插手"（罕见，页面终验兜底）；需要 pi SDK pre-call 钩子（现有钩子面仅 `pi.on("tool_call")` 与 steer 通道，无 pre-call）。升级条件：开始维护 pi fork / 页面终验拒绝率显著 / 跑团响应变长。届时读逻辑不变，仅触发点从投递事件改为每次迭代。
5. **contextRef 改为 scope 稳定**（战斗开场首条消息也免领队读）——延后。牵扯 execute args 的 CAS 溯源，风险与收益不成比例；每场战斗仅首条消息受益。

## 9. 设计决策（按推荐值采纳，可推翻）

- **Q1 注入通道与持久化 → 预拼投递文本，随历史持久化**。零 SDK 依赖、fork/重放天然一致，是唯一不动 pi 边界的选项；代价（用户通道混技术块、历史每消息一份快照）由 prompt 防串台条款与"最新块优先"规则消化。独立合成消息与临时不持久化都依赖 SDK 注入机制，与 §8.4 per-step 属同级边界突破——若将来做 per-step，通道决策随之一并重开。
- **Q2 注入范围 → 跑团恒注入**。非战斗块很小（turn:null + 场景动态），换非战斗现场问答零工具调用；且"仅战斗中"存在判断悖论（判断战斗态本身要读；用 staticSnapshot 判断则本场未读手册的会话漏注入）。
- **Q3 开关 → 默认开 + benchmark 门槛**。`ARCANE_TURN_INJECTION=0` 可关；发布前备团 benchmark 同模型对比 + 遥测（TURN_CONTEXT_REQUIRED 触发率、首动作延迟、模型可见调用数），不达标回滚。
