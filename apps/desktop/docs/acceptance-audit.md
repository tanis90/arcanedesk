# 多会话规格验收审计

日期：2026-09-07。当前复核基线：`78b6c78`（M8n4）；最初审计基线为 `26776eb`。依据：[spec](spec.md)、[architecture](architecture.md)。

结论：整体未完成。G1–G6、G9、G10 的指定修复及联合场景已完成；G7 的 Windows 关闭/取消/最小化/停止退出和多尺寸渲染布局已有证据，系统托盘及通知真实点击尚未通过。M8n3 性能复核通过。G8 最终复核仍在进行。

下表以当前证据为准，历史修复过程见 [milestones](milestones.md)。原表剩余行为集成统一列为 G10 后，生产删除由 M8o2/E20 完成，工具失败恢复与产物保留由 M8o3/E21 完成，实际页面慢停止及说明由 M8o4/E22 完成。G6 的关闭不用于推断其他条款；每项仍以对应证据和限制判断。

本文不改写原规格。编号如 `4.1-2` 表示该小节第二条要求；同一行列出多个编号时，所列要求共享证据与限制。后续修复应更新对应行和缺口清单，不能只增加通过的测试总数。

## 证据目录及适用范围

本轮阅读了规格、关键主进程/页面实现与对应测试断言。执行结果来自 [milestones](milestones.md) 记录；本轮审计不声称重新运行全部命令。

| 编号 | 可复查的来源 | 能证明什么、不能证明什么 |
| --- | --- | --- |
| E1 | [production main fixture](../test/fixtures/production-main-smoke.cjs)、`node apps/desktop/test/smoke-production-main.mjs` | 真实主进程/IPC/SDK，同模式并发、跨模式完成、reload 无重复请求、停止退出。模型为 loopback SSE；窗口隐藏；对话框决策受控，托盘回调程序触发。M8f/M8g2 通过 |
| E2 | [crash runner](../test/smoke-crash-recovery.mjs)、E1 fixture | runner 强制结束自己的真实子进程；同数据重启恢复首轮中断任务和已完成结果；显式继续只产生新请求。M8g2 通过；不是断电、磁盘故障或外部工具副作用测试 |
| E3 | [conversation fixture](../test/fixtures/conversation-smoke.cjs)、`node apps/desktop/test/smoke-conversations.mjs` | 真实 renderer/preload/IndexedDB，IPC 数据受控；半截回复、工具起始时间、草稿附件、阅读锚点、回答、重试、epoch 与恢复草稿。M8g1 通过 |
| E4 | [activity fixture](../test/fixtures/activity-smoke.cjs)、`node apps/desktop/test/smoke-activity.mjs` | 活动/已读/提示、任务状态、资源等待与面板恢复、删除屏障、关闭反馈。真实页面与活动模块，模拟 native notification；不是 OS 送达证明。M8e 最近记录通过 |
| E5 | [history fixture](../test/fixtures/history-smoke.cjs)、`node apps/desktop/test/smoke-history.mjs` | 原生 SessionManager/真实页面，1,200 条历史、翻页、锚点、展开状态、失败重试、缓存回收后 IndexedDB 恢复。M8e 通过 |
| E6 | [session projection tests](../test/session-projection.test.mjs)、[renderer protocol tests](../test/conversation-renderer.test.mjs) | 快照/事件顺序、断档、epoch、迟到事件、缓存和持久工作区竞争。模块级证据 |
| E7 | [registry tests](../test/session-registry.test.mjs)、[mode controller tests](../test/mode-host-controller.test.mjs)、[reclamation tests](../test/session-reclamation.test.mjs) | 目标隔离、最后选择生效、停止/删除竞争、实例回收。M8k 已覆盖空选择恢复与并发合并，G5 已关闭 |
| E8 | [task tests](../test/task-coordinator.test.mjs)、[SDK tests](../test/task-sdk.test.mjs)、[journal tests](../test/journal-compaction.test.mjs) | 持久接收、幂等、真实 SDK 消费边界、终态竞争、回答、取消、中断无自动重放。SDK 测试为受控 provider |
| E9 | [scheduler tests](../test/execution-scheduler.test.mjs)、[resource tests](../test/resource-coordinator.test.mjs)、[Foundry fixture](../test/fixtures/foundry-resources-smoke.cjs) | 额度、公平排队、受控文件冲突、取消、页面操作实际生命周期。Foundry fixture 使用受控页面，不证明实际世界操作的完整行为 |
| E10 | [activity tests](../test/activity-center.test.mjs)、[notification tests](../test/desktop-notifications.test.mjs) | 未读、持久提醒去重、偏好、失效目标、通知失败。native API 为替身，不证明平台展示 |
| E11 | [deletion tests](../test/session-deletions.test.mjs)、[shutdown tests](../test/shutdown-coordinator.test.mjs) | 删除日志恢复、停止/退出准入与等待、取消退出。生产组装和 OS 范围另见 E1/E2 |
| E12 | [telemetry tests](../test/telemetry-events.test.mjs)、[性能方法和结果](performance-baseline.md) | 会话/任务范围诊断和字段边界；16 并发、每会话一万条历史的隐藏 Electron 基准。M8e；不是所有硬件或任意单条输出大小的承诺 |
| E13 | [production tool runner](../test/smoke-production-tool.mjs)、E1 fixture 的 long-tool 分支 | Windows 真实 PowerShell 工具等待隔离文件信号；跨模式/刷新同一工具实例与原始起点，停止 A 不影响 B，工具结果回到 SDK 后生成终稿，结束耗时刷新前后一致。M8m1 通过；不是实际 Foundry 或其他平台 shell 验收 |
| E14 | [production context runner](../test/smoke-production-context.mjs)、E1 fixture 的 context-isolation 分支 | 真实目录/模型/provider/default IPC；原生 SessionManager 目录与 host 目录一致；A/B/C 三次真实 SDK HTTP 请求分别携带预期模型；现有空会话模型不被默认覆盖，新会话使用新默认，B 当前任务不被延后设置中途改变。目录选择结果由 fixture 提供，不是人工对话框验收 |

E15：[production retry runner](../test/smoke-production-retry.mjs)、E1 fixture 的 retry-scenario 分支。真实 SDK 对受控 overloaded 错误执行退避重试；生产 IPC/renderer 验证跨模式、等待时刷新、重试请求中刷新、原任务身份、成功清除提示，以及停止等待后超过退避时间仍无新请求。A 两次、B 一次、C 一次 HTTP 请求；B 不受 C 停止影响。模型端点为 loopback，不证明远端服务可用性。

E16：[production navigation runner](../test/smoke-production-navigation.mjs)、E1 fixture 的 navigation-scenario 分支。使用生产侧栏点击、IPC、真实 SDK，包装真实 IPC handler 仅延迟已经生成的回复。A→B 缓存→A 后才释放旧 B 回包，验证前后端都选中 A、草稿独立、无 B 内容。另截留 running 快照，让 A 实际完成并显示终稿后再返回旧快照，等待整个同步完成后验证没有状态回退和终稿重复。B 独立完成，模型请求严格为 A/B 各一次；不是所有随机调度顺序的穷举。

E17：[production metadata runner](../test/smoke-production-metadata.mjs)、E1 fixture 的 metadata-scenario 分支。生产 main/IPC/renderer/SDK 验证 A/B 首轮未结束时标题分别为 production-A/B、计数为 1；后台 A 和当前 B 完成后各为 2。抽屉打开时保存节点引用，逐个断言更新后节点和顺序完全不变；请求严格为 A/B 各一次。注册表测试另验证内存日志优先于旧磁盘摘要、计数包括原生日志分支且不虚构修改时间。

E18：[Foundry runner](../test/review-production-foundry.mjs)、[实际资源验收记录](foundry-resource-acceptance.md)。生产 main/IPC/SDK/browser_evaluate 与真实 Foundry 13.351/dnd5e 5.3.3；独立临时世界副本，GM 登录后运行同页面等待/取消及唯一文档创建与清理。模型请求 A/B/A，B 的代码未执行，A 仅执行一次。

E19：[多尺寸布局记录](layout-evidence/README.md)、[layout runner](../test/review-layout.mjs)。M8n4 验证最小/宽窗口与 456/320px 聊天分屏的真实 renderer 控件边界和四张截图；生产 ActivityCenter 提供运行计数。会话 IPC 受控，右侧 Foundry 覆盖层未加载，不证明物理拖动、系统缩放或通知展示。

E20：[生产删除 runner](../test/smoke-production-deletion.mjs)、[删除场景](../test/fixtures/production-deletion.cjs)。M8o2 使用生产侧栏删除按钮、IPC/registry 和真实 SDK，确认文案被捕获并校验，确认选择受控。暂缓 SDK abort 调用期间验证 A 为 stopping、原实例/文件/列表仍存在且删除禁用；放行实际取消后才移除，B 流持续并完成，模型请求严格 A/B 各一次。这是取消延迟屏障测试，不代替真实慢工具退出验收。

E21：[工具恢复 runner](../test/smoke-production-tool-recovery.mjs)、[实际工具场景](../test/fixtures/production-tool-recovery.cjs)。M8o3 使用生产 IPC/renderer/真实 SDK 和 PowerShell。先 exit 1，确认失败结果进入模型上下文、工具卡失败而任务继续；同 taskId 再执行成功写文件，随后停止，文件与两张过程卡在刷新后保留。A 不受影响并正常完成，HTTP 请求 A/B/B/B。模型决策受控，实际工具没有替身；不代表任意外部系统具有事务恢复能力。

E22：[慢停止 runner](../test/smoke-production-slow-stop.mjs)、E21 场景的 slow-stop 分支。真实 Electron WebContentsView 执行可释放的页面 Promise，evaluateNavigationSafe 已超时但任务资源仍被实际页面操作持有。通过生产 IPC 停止真实 SDK，验证 stopping 与 Foundry 等待说明，刷新仍未确认停止；页面释放后才进入 stopped。页面操作由测试直接登记到该任务的生产 ResourceCoordinator，未经过模型调用 browser_evaluate，也不是实际 Foundry 世界；实际世界工具调用见 E18。两者分别证明工具集成和残留页面生命周期，不能混称同一个端到端场景。

`自动化覆盖` 表示已有相关断言及已记录通过结果，并不等于跨平台最终验收。`缺口` 表示当前代码与条款不符；`待集成` 表示证据范围不足，仍不可计为整体完成。

## §§1–3 终态、故事与对象

| 要求 | 当前证据及判断 |
| --- | --- |
| §1 切换只改变查看对象；两模式一致 | E1/E3/E7 自动化覆盖 |
| §1 能辨认进行中、待处理、离开后的进展 | E4/E10 自动化覆盖；E19 覆盖最小及分屏渲染布局；系统交互见 G7 |
| §2-1 立即回显与任务开始 | E1/E8 覆盖；最终任务归属由接收侧决定；M8i/E3 已验证发送语义，G1 已关闭 |
| §2-2 新建 B、A 工具过程与侧栏状态 | E1 验证文本并发，E3/E4 验证工具/侧栏；E13 已通过真实长工具与生产页面联合验收 |
| §2-3 跨模式汇总 | E4 自动化覆盖 |
| §2-4 待处理提示、定位、不抢焦点 | E4/E10 自动化覆盖；物理焦点与系统入口待集成 |
| §2-5 回答继续、B 草稿/锚点/展开 | E3/E5/E8 自动化覆盖 |
| §2-6 后台完成、未读和阅读分界 | E1 验证后台完成，E4 验证未读分界 |
| §2-7 读最新才清未读、完成状态保留 | E4/E10 自动化覆盖 |
| §3 会话稳定身份与上下文隔离 | E1/E2/E5/E7；首轮持久身份回归见 [durability test](../test/session-first-turn-durability.test.mjs) |
| §3 每会话单活动任务、运行时补充 | E8 自动化覆盖 |
| §3 当前选择不拥有执行、模式归属固定 | E7 及 [mode tests](../test/session-mode.test.mjs) 自动化覆盖 |
| §3 未读独立、不按流片累计 | E10 自动化覆盖 |
| §3 接收侧决定补充或新任务并回执 | E8 自动化覆盖；前端呈现语义由 M8i/E3 验证 |

## §4 界面结构

| 要求 | 当前证据及判断 |
| --- | --- |
| 4.1-1、6 宽屏侧栏、窄屏入口、持续计数 | [activity.css](../src/renderer/conversations/activity.css)、E4 有覆盖；E19 覆盖多尺寸渲染布局，不证明物理窗口拖动 |
| 4.1-2 模式列表与跨模式活动直达 | E4 自动化覆盖 |
| 4.1-3 标题、任务、未读、选择分别表达 | [ActivityView](../src/renderer/conversations/activity-view.js) 分别渲染文字和 aria-current；E4 |
| 4.1-4 普通进度不反复重排 | ActivityView 原位置更新；E17 验证普通会话列表首轮与后台/当前任务完成更新的节点和顺序不变；流片不触发元数据读取 |
| 4.1-5 完成保留至查看/清除、仍可从历史找到 | E4/E10 覆盖活动；E1/E2 覆盖历史打开 |
| 4.2-1 标题、权威状态、停止入口 | E1/E4；M8i/E3 已覆盖停止请求即时反馈 |
| 4.2-2、3 过程详情、原始耗时、不虚假完成 | E3/E6；E13 已通过真实长工具及刷新计时验收 |
| 4.2-4 半截回复/思考同身份继续 | E1/E3/E6 及 [message identity tests](../test/message-identity.test.mjs) |
| 4.2-5 区分失败、停止、等待、成功 | E4 状态覆盖；M8j/E3 已验证恢复失败原因与下一步 |
| 4.2-6 无虚构百分比 | [chat.js](../src/renderer/chat.js) 过程按事件呈现；未知响应等待的完整场景仍需审查 |
| 4.3-1 独立草稿附件 | E3/E5 自动化覆盖 |
| 4.3-2 发送入口清楚区分新任务/补充 | M8i/E3 验证新任务/补充的可见语义及可访问名称 |
| 4.3-3、4 接收与消费分开、不等同完成 | E3/E8；回执为独立 input_state |
| 4.3-5 失败原文附件与幂等重试 | E3/E8 自动化覆盖 |
| 4.3-6 停止过程中保留草稿、暂不注入 | M8i/E3 验证停止请求与 stopping 期间按钮、Enter、重试均保留草稿附件且不提交 |

## §5 状态与同步

| 要求 | 当前证据及判断 |
| --- | --- |
| 状态权威来源、视图不更改终态 | E1/E6/E8 |
| 空闲、排队及取消、运行 | E4/E8/E9；发送语义另由 M8i/E3 覆盖 |
| 等待资源、需要用户及可停止 | E4/E8/E9；E18 实际 Foundry 等待及取消已通过 |
| 正在停止与真实停止确认 | E8/E9/E11 执行侧覆盖；前端停止窗口由 M8i/E3 覆盖 |
| 已完成与结果、再开始任务 | E1/E2 |
| 失败原因、成果和下一步 | M8j/E3 已验证快照恢复原因、文本安全、下一步及无原因说明 |
| 已停止原因、进展、可新输入 | 新任务 E8；M8j/E3 已验证停止原因恢复及新任务清理 |
| 补充-1 单工具失败不代表整任务失败 | E8/E9 模块覆盖；E21 真实 PowerShell 失败后同任务继续并成功写入已通过 |
| 补充-2 自动重试展示真实阶段 | E6 投影覆盖；E15 已验证真实 SDK 重试阶段、刷新与取消 |
| 补充-3 长时间无文字不伪称结束 | 工具计时 E3；M8l/E3 已验证静默只读校准与超时提示，不以静默推断终态 |
| 补充-4 同步状态独立、最后更新时间与恢复 | M8l/E3 已验证最后确认时间、缓存待校准、十秒超时及重试 |
| 补充-5 排队取消准确 | E4/E8/E9 |
| 补充-6 停止与完成竞态以执行侧为准 | E8 |

## §§6–7 切换、返回与后台反馈

| 要求 | 当前证据及判断 |
| --- | --- |
| 6.1-1 新建/打开/跨模式/收起/最小化不停止 | E1 覆盖前三类与隐藏；收起/最小化实际 OS 行为待集成 |
| 6.1-2 不等待旧任务、不自动发送/重复提交 | E1 |
| 6.1-3 最后一次选择生效 | E7 模块覆盖；E16 已验证生产页面受控乱序导航 |
| 6.1-4 A 的迟到事件/回执不污染 B | E3/E6/E7；停止请求反馈见 M8i/E3 |
| 6.2-1 缓存优先、轻量同步不清欢迎页 | E5/E12；慢同步诊断由 M8l/E3 覆盖 |
| 6.2-2 历史、半截、工具、问题、真实状态 | E1/E3/E5/E6；失败恢复详情由 M8j/E3 覆盖 |
| 6.2-3 底部跟随 | E3/E5 |
| 6.2-4、5 原阅读锚点、新进展、消息身份 | E3/E5/E6 |
| 6.2-6 实际可见且到达新增才已读 | E4/E10 |
| 6.2-7 后台完成返回直接终态 | E1；M8l/E3 已验证缓存等待校准标识，E16 验证旧快照不覆盖终态 |
| §7 表：普通进度前台更新、后台状态、离开应用不通知 | E4/E10；系统进程实际送达待平台验收 |
| §7 表：完成、待处理、失败的前台/其他会话反馈 | E4/E10；恢复失败内容由 M8j/E3 覆盖 |
| §7 表：应用不在前台且启用时通知一次 | E10 模拟 native；**系统通知真实送达和点击待集成** |
| §7-1 去重跨刷新/历史/重复事件 | E4/E10 |
| §7-2 合并提示、不遮挡输入 | ActivityView 多项计数及独立活动条；多尺寸和输入中展示待视觉验收 |
| §7-3 通知只含标题状态 | E10 字段覆盖 |
| §7-4 待处理持续至解决、无额外审批 | E4/E8，既有审批仅在显式配置启用时使用 |

## §§8–9 生命周期、并发与隔离

| 要求 | 当前证据及判断 |
| --- | --- |
| 8.1-1 停止明确会话和任务 | E7/E8；E13 验证真实 UI 停止后立即跨模式，E3 覆盖迟到发送回执 |
| 8.1-2 立即反馈停止中、确认前不显示已停止 | 执行侧 E8；客户端请求窗口由 M8i/E3 覆盖 |
| 8.1-3 慢停止说明等待操作 | E4/E9/E11 覆盖资源/退出反馈；E22 实际页面操作未退出时的说明、刷新和释放后停止通过 |
| 8.1-4 不撤销已完成外部操作、保留成果 | 实现不主动回滚；E2 保留已完成消息。E21 真实文件在停止及刷新后保留已通过 |
| 8.1-5 停止后新输入带上下文继续 | E8；不承诺指令级续跑 |
| 8.1-6 重试/排队/等待可取消且不暗中再启动 | E8/E9；E15 已通过 SDK 自动重试及停止后不再请求 |
| 8.2-1、2 确认规则及停止后删除 | E7/E11，页面停止删除操作位于 chat.js；E20 生产删除交互通过（确认选择受控） |
| 8.2-3 删除失败/未停保留记录 | E7/E11；M8k/E1 已验证删除后替代启动失败能恢复原 B 实例；运行中删除另见 G10 |
| 8.3-1 最小化/隐藏进程活着继续 | E1 隐藏；M8n1 实际 Windows 最小化/恢复通过 |
| 8.3-2 关闭窗口的三项决策及重新打开 | E1 原生窗口/托盘对象、程序决策/回调；物理点击与其他 OS 待集成 |
| 8.3-3 退出确认、等待与持续反馈 | E1/E4/E11；M8n1 实际 Windows 关闭/取消/停止退出通过 |
| 8.3-4 异常退出后中断、历史与入口 | E2 强制结束重启覆盖；非磁盘故障保证 |
| 8.3-5 不自动重放、核对后继续 | E2 证明只有显式输入触发新模型请求；不等同外部动作事务去重 |
| 8.3-6 renderer 重建不重新调用模型 | E1 |
| §9-1 每会话独立并发与上下文 | E1/E7/E8/E14；实际 SDK 的不同模型/目录组合通过 |
| §9-2 B 模型/目录不影响 A、换目录新建 | [host tests](../test/agent-host-tools.test.mjs)、E7/E14；生产目录 IPC 创建新会话，A/B 目录独立 |
| §9-3 默认仅新会话、任务内改模型延后且说明 | E14 复现并修复已有空会话被覆盖，验证新会话默认及下一任务应用延后模型；页面 pendingModel 可见 |
| §9-4、5 共享资源冲突与保守串行 | E9；实际 Foundry 世界操作待集成，不防外部程序写入 |
| §9-6 资源等待可见、公平、取消撤队 | E4/E9 |
| §9-7 额度满排队、不随视图变化 | E9/E12，默认 2、环境配置最多 16 |
| §9-8 只回收安全空闲实例、重开恢复 | E5/E7；未保存/活跃数据不为满足缓存上限而丢弃 |

## §10 行为不变量

| 编号 | 证据与未完成范围 |
| --- | --- |
| 1 执行归会话任务 | E1/E7/E8 |
| 2 命令事件归属、迟到不污染 | E6/E7/E8；全局活动/共享世界事件采用独立作用域 |
| 3 执行状态唯一、即时与确认区别 | E8；前端停止请求 G2 |
| 4 后台可恢复状态与摘要 | E1/E6/E10 |
| 5 恢复包含当前现场 | E1/E3/E6；运行进程仍在的快照，不承诺未持久流片抗断电 |
| 6 顺序去重、不丢重/倒退 | E6；E16 生产页面验证迟到导航回复及任务完成后的旧 running 快照 |
| 7 导航不停止/释放/重提交 | E1/E7 |
| 8 工具不虚假成功、停止不虚假完成 | E3/E8/E9；实际工具联合场景待补 |
| 9 已读与通知去重可恢复 | E4/E10 |
| 10 会话/任务/事件诊断、不额外敏感正文 | E12 及 [runtime scope tests](../test/direct-foundry-runtime.test.mjs)；界面同步失联可诊断性 G4 |

## §11 验收场景与性能门槛

| 11.1 行号 | 场景 | 判断 |
| --- | --- | --- |
| 1 | 流式 A→同模式 B→A | E1 自动化通过 |
| 2 | 长工具跨模式返回 | E13 生产主进程/真实 SDK/PowerShell 通过，含运行中及完成后刷新计时 |
| 3 | 后台完成后打开 | E1 自动化通过 |
| 4 | 后台失败/需要处理与定位 | E4 分层通过；错误恢复由 M8j/E3 覆盖 |
| 5 | 快速 A→B→A 乱序 | E6/E7 分层及 E16 生产页面/IPC/SDK 通过，修复旧列表阻止立即返回的问题 |
| 6 | 快照边界恰逢任务结束 | E6 分层及 E16 生产集成通过，旧快照晚于完成事件返回后仍保留终态及唯一终稿 |
| 7 | A 发送/停止后立即切 B | E3/E7 分层通过，G2 已关闭；E13 真实 UI 停止 A 后立刻跨模式，B 工具不受影响 |
| 8 | 各自草稿附件阅读位置 | E3/E5 自动化通过 |
| 9 | 翻历史收到新输出 | E5 自动化通过 |
| 10 | 补充恰逢任务结束 | E8 真实 SDK 受控 provider 通过 |
| 11 | 页面刷新不增加模型调用 | E1 自动化通过 |
| 12 | 进程异常结束重启 | E2 自动化通过，工具副作用范围见 8.3-5 |
| 13 | 同资源竞争、一方取消 | E9 分层通过；E18 生产工具/真实世界资源等待及取消通过 |
| 14 | 超额度取消排队 | E9 自动化通过 |
| 15 | 删除执行中会话 | E7/E11 分层通过；E20 生产页面/IPC/SDK 停止并删除通过；G5 另覆盖替代启动失败恢复 |
| 16 | 已通知重开/重复投递 | E4/E10 自动化通过；native 送达待补 |

| 11.2 门槛 | 当前证据 |
| --- | --- |
| 选中 P95 ≤100 ms、缓存内容 ≤300 ms | [M8n3 复核](performance-with-metadata.md)：37.6 ms，120 次有缓存切换；包含元数据读取和连续完整消息 |
| 校准 ≤1 s、超时有提示 | M8n3：68.2 ms；G4 已验收慢同步提示、超时和重试 |
| 状态延迟 P95 ≤500 ms | M8n3：133 ms，41 状态样本；模型等待不计入 |
| 长历史与配置最大并发 | E12：16 并发，每会话 10,000 历史及 5,000 回执；是受控任务基准 |
| 正确性不能用最终刷新替代 | E6/E7/E8 为独立断言；G1–G5 已修复；G7 未完成前整体仍不通过 |

## §12 范围与交付物

- 规格和架构文件已存在；[milestones](milestones.md) 对应当前分支逐阶段提交。整体目标保持 active。
- 默认并发 2、上限 16；后台驻留采用原生托盘/窗口生命周期；文件和页面资源边界及性能基准已有实现/记录，仍需完成上述集成范围。
- 跨设备、退出后云执行、事务回滚及精确百分比仍在原规格排除范围，不将其新增为完成门槛。
- architecture §11 的“每模式一个 AgentHost”等文字属于实施前调查。本轮已增加历史标签和当前实施记录链接，避免将已修复缺陷继续当成当前架构事实。

## 后续修复与验收顺序

| 缺口 | 必要变化 | 验收要求 |
| --- | --- | --- |
| G1 输入语义（M8i 已关闭） | 空闲/活动任务的可见发送语义、可访问名称一致 | E3 验证切换与快照恢复后正确，最终归属仍取执行侧回执 |
| G2 停止窗口（M8i 已关闭） | 停止请求期间保留草稿附件、阻止提交；失败或完成后恢复操作 | E3 验证延迟停止回执、停止失败、A→B、Enter/按钮/重试、刷新、终态及下一任务均不丢草稿或串任务 |
| G3 终态原因（M8j 已关闭） | 从快照重建失败/停止原因与下一步，避免实时事件独占详情 | E3 验证后台失败打开/刷新、重复事件与同步、文本安全呈现、无原因说明、下一任务清理；E4 验证取消任务说明 |
| G4 同步诊断（M8l 已关闭） | 最后确认时间、缓存待校准标识、十秒超时可重试、静默时只读检查，不伪造终态 | E3 验证延迟/失败/完全静默/跨导航迟到失败与请求清理；E1/E4/E5 回归通过 |
| G5 空注册表恢复（M8k 已关闭） | controller 检查当前 activeHost；恢复优先选中存活 resident，避免从磁盘重新实例化运行中的 B | E7 验证失败重试/并发合并/身份；E1 验证生产 IPC 删除替代失败后恢复原 B，随后正常停止退出 |
| G6 生产联合场景（M8m5 已关闭） | E13–E16 及 E18 完成长工具、刷新计时、跨会话停止、模型/目录隔离、自动重试、乱序导航/终态边界及实际 Foundry 资源竞争/取消 | 真实 SDK、生产 IPC；实际副作用限于隔离测试资源，不推及所有第三方系统和模块 |
| G7 平台交互（部分完成） | Windows 关闭/取消、最小化/恢复、停止退出已由 M8n1 原生输入验证；M8n4/E19 已验收多尺寸渲染布局；系统通知与托盘实际点击仍待完成 | [原生验收记录](windows-native-acceptance.md)；逐平台声明结果，不能用 mock 替代 |
| G8 文档一致性 | 本轮已更新架构历史标签并建立本索引；最终仍需逐项关闭缺口 | 文件链接可用，规格不缩水，全部缺口有最终证据才结束目标 |
| G9 首轮会话列表（M8n2 已关闭） | 原生日志提供驻留元数据；前端合并更新既有列表行 | E17 验证首轮运行时标题/数量、后台及前台完成、抽屉打开时行身份与顺序不变 |

| G10 剩余行为集成（M8o4 已关闭） | 保留原条款 §5 补充-1、§8.1-3/4、§8.2-2 与 §11.1-15 的证据缺口 | 实际工具失败后任务继续；慢停止期间显示正在等待的操作；停止后已有真实产物保留；生产主进程等待停止后才删除运行会话（M8o2/E20 已通过，其他三项保留） |
