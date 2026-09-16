# Desktop 多会话设计规则

> 历史提案，已停止维护。2026-09-08 的讨论结论已收敛到 [本轮唯一技术方案与进度](simplification-plan.md)；下文未采纳或被后续讨论替代的规则不再生效。

日期：2026-09-08。状态：提案，待评审通过后生效。

本文是对 0.4.3（tag `0.4.3-06aad629`）至 main（`5cef239`）多会话变更的评审结论的总括。[architecture.md](architecture.md) 描述系统"是什么"，本文约束"怎么往上加"：任何新功能、新机制、新文案先过本文的规则，再谈实现。评审发现的逐项证据见第 5 节映射表。

背景一句话：多会话改造的功能主干（归档可撤销、等待用户时释放并发槽、克制通知）是健康的，但变更中混入了大量防御式编程——围栏叠围栏、为极小概率崩溃场景建事务基础设施、把内部协议摆到用户面前。本文把这些散点问题收敛为五条规则、一个信任边界模型、三个落地机制。

## 1. 信任边界

本系统的真实信任边界只有三个：

```
renderer ──① IPC──> main 编排层（main.js 的 ipcMain.handle）
                       │
                       ├──> coordinator / host（同进程，非边界）
                       │
                       ├──② 磁盘读写（JSONL、journal、缓存）
                       │
                       └──③ 子进程 / 上游 SDK（Pi、Foundry）
```

规则：输入校验、断言（assert*）、错误码转换只允许出现在 ①②③ 三处。同进程内部模块之间（编排层 ↔ coordinator ↔ host ↔ registry）是信任区，不做重复校验。任何不在边界上的断言，评审时必须给出独立理由，否则删除。

## 2. 五条核心规则

### R1 崩溃即常态，不为优雅路径建专用基础设施

桌面应用随时可能被强杀。任何持久化机制必须能回答"崩在中途会怎样"，且答案只许是"启动时对账自愈"，不许是"专用 WAL / 专用协调器 / 取消按钮"。既然崩溃恢复已经存在，优雅退出只需 best-effort。

- 违反实例：`session-deletions.js` 为"删两个文件"建四态 WAL（begin/cancel/commit/clean + 回放 + compact）；`shutdown-coordinator.js` + `main.js:1526-1548` + 常驻 `#shutdown-status` 条为"优雅退出"建带取消的协调器，而 `activity-center.js:51-53` 自己已写明崩溃后 running 一律转 interrupted 可恢复。
- 执行方式：全部启动恢复逻辑收敛到唯一的 StartupReconciler——扫描孤儿任务文件、未完成删除、stale 状态标记，差集清理。新增持久化格式前必须先证明"对账做不到"。

### R2 每个不变量只有一个执行者

一个不变量（"已归档才能删除""不在删除中才能提交"……）由且仅由一个层执行；一个状态机只有一个 owner，其他模块通过公开动词操作，不许旁路读写内部状态。

- 违反实例：`main.js:954` 与 `session-registry.js:64` 重复调用同一 `assertDeletable`；`main.js:1363` 与 `agent-host.js:782` 重复 `assertWritable`；`agent-host.js:892` 审批门直接拨 `tasks.task.state`，与 `task-coordinator.js:94-111` 的 `ask()` 是同一件事的两份实现。
- 执行方式：不变量归位表写进架构文档（哪个不变量、哪个执行者、哪个文件）；状态机修改一律走 owner 的公开入口（如给 TaskCoordinator 加 `waitForUser(promise)`）。

### R3 UI 只显示用户可行动的状态，内部状态经"用户语言层"投影

每个要上屏的状态先过两问：用户此刻能对它做什么？不知道它会损失什么？两问都答不上就不显示。错误信息必须含"发生了什么 + 下一步"，不道歉、不含糊、不解释内部流程。内部状态机的枚举值不许原样上屏。

- 违反实例：对话区四条常驻状态条 + "最后确认：{time} / 本次打开后尚未确认"（`index.html:1645-1648`、`chat.js:26-33`）；发送按钮在"开始新任务 / 补充当前任务 / 正在停止"三态间切换（`chat.js:52-64`）；"等待 {resource} · 正由另一个任务使用"泄露资源仲裁细节（`chat.js:96-103`）；四个内部输入态共用"等待处理…"（`messages.js:174-177`）。
- 执行方式：renderer 建唯一投影函数 `toUserStatus(internalState) → string | null`，返回 null 即不渲染；内部错误码禁止原文透传到界面。

### R4 机制准入：没有生产调用者的代码不进主干

新机制进主干需附带：至少一个生产代码调用者 + 一个真实发生过的故障场景描述。可配置项在出现第二个真实调用者需要不同值之前不许引入。推测性泛化（"以备将来"）一律放实验分支。

- 违反实例：`panel-commands.js:43-63` 恢复屏障 + `resource-coordinator.js:113-123` recoveryBarrier 仅测试调用；`session-state.js:6-23` `payloadWeight` 内存称重估算与从未使用的构造参数校验（`chat.js:202-213` 全部默认构造）；`agent-host.js:609` `deleteSession` + `sessions:delete` IPC + preload `deleteSession` 整套无调用者；`chat.js:71-75` `showPanelCommand` 空壳。
- 执行方式：push 前检查加一条——新增导出若 grep 不到测试以外的调用点，删除或说明理由。

### R5 永远不拒绝用户的明确意图；系统自身的损坏自愈并告知

用户点了关闭 / 退出 / 删除，系统的职责是执行并兜底，不是弹框教育用户。系统自己产生的数据损坏（journal、缓存、索引）隔离后重来，用一句人话告知，不许阻塞用户操作，不许英文黑话上屏。

- 违反实例：托盘创建失败弹阻塞错误框拒绝关窗（`main.js:594`）；journal 一条坏记录使会话永久无法提交（`input-journal.js:19` "refusing to discard committed history"）；删除确认框解释内部停止流程（`messages.js:161`）。
- 执行方式：错误路径评审清单加一问"这个错误拒绝了用户的明确意图吗"；损坏自愈范式统一为"隔离改名 + 从空白恢复 + i18n 一句告知"。

## 3. 附属规则：上游怪癖隔离

上游（Pi SDK、Foundry）的拼写怪癖、版本绑定行为只允许存在于单一的 upstream-compat 适配模块中：集中放置、注明绑定版本、策略一律保守（宁可误报冲突，不复刻上游拼写表）。主逻辑只消费适配器输出的规范化结果；升级上游时只动这一个文件。

- 违反实例：`resource-coordinator.js:18-32` 复刻 Pi 0.84 的文件路径拼写（NFD 规范化、窄不间断空格替换、弯引号替换、`existsSync` 四候选探测），Pi 升级即静默失效。

## 4. 落地机制

1. **StartupReconciler（新增，唯一）**：启动时对账所有持久化状态——孤儿任务文件、未完成删除、stale running 标记。取代 SessionDeletions 的事务日志与各处散落的启动清理。
2. **用户语言投影层（renderer，唯一）**：`toUserStatus` 集中管理"内部状态 → 界面文案或 null"。同步成功静默、失败才出现（`chat.syncFailed` 带重试的范式保留）；删除"最后确认"时间戳。
3. **upstream-compat 适配模块（main，唯一）**：收容资源路径规范化等上游绑定逻辑。
4. **评审清单**：并入 `PRE_PUSH_REVIEW.md`，六问：
   - 这个机制有生产调用者吗？防的场景真实发生过吗？（R4）
   - 这个断言在信任边界上吗？这个不变量的唯一执行者是它吗？（R1/R2）
   - 这个状态用户可行动吗？文案经过投影层吗？（R3）
   - 崩在中途会怎样——答案是对账吗？（R1）
   - 这个错误拒绝了用户的明确意图吗？（R5）
   - 文案含黑名单词吗（确认／游标／屏障／协调器／资源仲裁／ack）？（R3）
5. **文案黑名单 lint**：扫 `messages.js`，命中系统术语即报警，挂进 `scripts/verify-repository.mjs`。

## 5. 评审发现 → 规则映射与整改清单

处置分四类：删（直接删除）、并（并入唯一机制）、收（归位到唯一执行者）、隔（移入投影层/适配层）。优先级 P0 为纯删代码不删能力，可立即执行；P1 需要小幅重构；P2 涉及行为变更需确认。

| # | 发现 | 规则 | 处置 | 优先级 |
|---|------|------|------|--------|
| 1 | 恢复屏障 recoveryBarrier 死代码（panel-commands.js:43-63、resource-coordinator.js:113-123） | R4 | 删 | P0 |
| 2 | 旧删除链路残留（agent-host.js:609、sessions:delete IPC、preload deleteSession） | R4 | 删 | P0 |
| 3 | showPanelCommand 空壳（chat.js:71-75） | R4 | 删 | P0 |
| 4 | session-state.js 称重估算与未用构造选项 | R4 | 删 | P0 |
| 5 | 四内部输入态合并文案残留（messages.js:174-177 等死 key） | R3 | 删 | P0 |
| 6 | 托盘失败弹框阻止关窗（main.js:594） | R5 | 删（改为直接退出） | P0 |
| 7 | SessionDeletions 四态 WAL（session-deletions.js） | R1 | 并 → StartupReconciler | P1 |
| 8 | ShutdownCoordinator + 取消退出 UI | R1 | 并 → best-effort abort 后直接退出 | P1 |
| 9 | journal 损坏宁崩不弃（input-journal.js:19、task-coordinator.js:35） | R1/R5 | 并 → 隔离改名 + 空白恢复 | P1 |
| 10 | 删除/提交路径重复断言（main.js:954/1363、session-registry.js:64、agent-host.js:782） | R2 | 收 → 各留唯一执行者 | P1 |
| 11 | AgentHost 旁路拨 TaskCoordinator 状态（agent-host.js:892） | R2 | 收 → waitForUser 公共入口 | P1 |
| 12 | ActivityCenter 已读事务化（activity-center.js:183-195） | R1 | 收 → lastReadSeq 单调递增 | P1 |
| 13 | 同步确认常驻指示与"最后确认"时间戳 | R3 | 隔 → 投影层，失败才显示 | P1 |
| 14 | 发送按钮三态 / 资源仲裁细节 / "未确认"文案 | R3 | 隔 → 投影层用户语言 | P1 |
| 15 | ResourceCoordinator 复刻 Pi 0.84 路径拼写 | R6 | 隔 → upstream-compat + 保守策略 | P1 |
| 16 | 删除围栏过深：必须先归档才能删除 | R5 | 删除入口放开，确认文案砍短 | P2 |
| 17 | 侧边栏列表强制拉起两模式子进程（main.js:919-923） | R4 | 列表走纯磁盘路径 | P2 |
| 18 | canEvict 混入模型引用状态（agent-host.js:830-836） | R2 | 驱逐只看"有无未保存工作" | P2 |
| 19 | 空状态无行动引导（chat.js:2137） | R3 | 空状态放"新建会话" | P2 |
| 20 | 归档横幅两套文案（index.html:1642 vs messages.js:35） | R3 | 统一进字典 | P0 |

符合规则、应予保留的设计（正面清单，防误删）：归档+撤销 toast；运行中归档禁用并附原因"任务结束后可归档"；桌面通知默认关闭/仅后台/去重/点击才聚焦；等待用户时释放并发槽（execution-scheduler.js:70-80）；面板命令静默去重（panel-commands.js:18）；errorDetail 错误分类+折叠详情（chat.js:748-762）；模型指令"不提不必要的审批请求"（agent-host.js:1017）；窗口 focus 静默 resync、失败才显示。

## 6. 生效与验收

- 本文评审通过后，architecture.md 顶部加链接指向本文；两文冲突时本文管"怎么加"，architecture.md 管"是什么"。
- P0 项一次性提交完成；P1/P2 按"删 → 并 → 收 → 隔"分批，每批附静态检查与单测结果。
- 全部整改完成后，本文第 5 节表格归档为历史证据（仿 architecture-history.md 的先例），规则本体长期有效。
