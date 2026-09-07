# 备团／跑团实施与验收记录

依据：[唯一技术方案](./foundry-prep-play-technical-plan.md)、[auto pack TODO](./todo.md)、[休息 TODO](./foundry-rest-todo.md)。
本文只记录实施证据和未完成工作，不另定产品合同。

分支：`codex/foundry-prep-play`，独立 worktree 基线 `9107c09`。未修改原主线工作目录或 auto pack。

## 当前状态

整体未完成。首批 SDK 能力和操作日志已实现，尚未接入 App 工具，不是可交付版本。

| 方案项 | 实施状态与剩余工作 |
| --- | --- |
| M0 基线／工具矩阵 | 已从最新主线建独立 worktree；尚需集中 allowlist、真实 Pi active set 检查和性能基线 |
| M1 共享上下文 | SDK 统一 Scene／有效战斗范围、全量 Token、结构引用；服务已实现快照失效标记和 operation 查询；尚需工具激活、动态动作引用映射 |
| M1 状态 | SDK 源保护、原生结束专注、目标解析和四态；已补严格模型 schema、中英文别名、绑定来源的服务；尚需工具激活和真实系统验证 |
| M1 操作记录 | JSONL、派发前落盘、去重、重启不重放、服务调用和会话删除清理已实现并测试 |
| M1 环境绑定 | 已接入消息入队时固定读取 world/Scene/selection、输入日志元数据、当前已消费输入绑定；模型工具工厂在审批前固定绑定，尚需真实 Pi 工具激活测试 |
| M2 跑团执行 | 已实现 executeAction、普通 narrative-only 法术发现／扣费、复用旧执行核的非战斗动作、回合约束、服务引用解析；待统一工具激活、完整参数覆盖和真实世界验收 |
| M3 备团 Actor | 未实现七项核心工具中的搜索和 Actor 服务、图片管线、readRef |
| M4 备团 Scene | 未实现 Scene 服务、图片／批量 Token、局部回读 |
| M5 召唤 | auto pack 只记录 AUTO-001；新 executeAction 已在扣费前拒绝召唤放置，不调用旧同先攻协议；真实组合仍待验收 |
| Prompt／UI／遥测 | 尚未改名称、提示词、结果显示、工具分类 |
| 完整验收 | 尚未执行 CLI 全套回归、全仓 verify、真实测试世界及性能对比 |

## 已有证据

- SDK 新测试：125 个隐藏／未渲染 Scene Token 全量、Actorless Token、静态／动态名单一致，
  当前 Scene 有效战斗与其它 Scene 隔离、歧义战斗拒绝；资源／状态不使结构引用失效，Token/Item 变化会失效。
- 状态测试：显式 set 幂等、重复 Actor 去重、来源效果零写拒绝、系统专注结束与手动标记区分、
  world/关注范围校验、派发后失败不冒充 rejected。
- 操作记录 4 项测试通过：重复投递一次执行、已完成结果重启恢复、派发中重启不重放、
  落盘失败零派发、下游失败不重试、调用身份冲突拒绝。
- Desktop 全套 412 项测试通过；Desktop typecheck 和 source boundary 通过。
  这些是基础回归证据，不能证明尚未接入的产品功能可用。
- SDK 旧四默认 actions 与原 battleContext/turnContext/executeTurn 行为保留；
  目标解析调整后 43 项 SDK 测试全部通过，包括提交时选择 UUID 与跑团禁止独立 Actor 旁路。

## 下一步

M1 宿主服务与输入绑定已接入。新工具定义集中在 foundry-tools.js，但尚未加入 active set；
既有模型仍使用旧工具。下一步实现 M2 executeAction 后统一切换工具名、schema/allowlist 和 prompt，
避免把新 actionRef 目录和旧 executeTurn 模型参数混用。DirectFoundryRuntime 已支持显式 allowedActions，
尚需主入口传具体新增 action 并集，默认四项仍保持。

随后实现 M2 的完整发现→执行链路，不能只改工具名称。静态动作目录还需补充 narrative-only
普通法术、验证实际能力定义完整性及结构失效覆盖；动态结果不携带重定义。
最后推进 M3/M4 和全套验收。真实世界验收仅使用测试世界；若缺用户授权的连接或测试材料，
先完成其它独立工作，再说明具体所需操作。

## 跑团执行增量

- 新 SDK executeAction 只接受宿主从静态快照解析的动作身份；检查 world、contextRef、
  当前回合、source Token/Actor、Item/Activity，再决定 narrative 或原生路径。
- 旧 executeTurn 核心增加内部显式来源参数，旧 SDK 入口行为不变；新非战斗入口复用同一执行核。
- 普通 spell/pact/atwill 且消耗明确的叙事 Spell 可记账；额外 uses/消耗目标、未知方法和反应时序
  不静默处理。独立视觉 adapter 尚未接入，当前回执明确无动画，不冒充完整自动结算。
- 服务将动态可用 ID 映射到缓存中的 actionRef，不向动态结果重复塞入能力定义；
  narrative-only 能力按资源是否足够显示。一次战斗执行后旧 turn 证据失效。
- 新测试覆盖无 Activity 法术扣位、上下文／Token／回合失效、资源不足、非战斗推进拒绝、
  派发后失败不补扣、召唤零写拒绝、叙事成功而推进失败返回 partial。
- 非战斗攻击的新测试在原生执行函数边界注入 fixture，证明路由与来源；它不替代真实攻击验收。
  旧 CLI 232 项执行回归通过，最新 SDK 52 项测试通过；动态资源映射和工具服务的 7 项定向测试通过。
- 新工具仍未激活。下一步统一切换 AgentHost 工具注册／显式 SDK action 并集／prompt，
  然后推进备团搜索与 Actor、Scene 工具，不把当前执行基础视作方案完成。

## 宿主绑定增量

- 入队启动固定身份读取；日志持久化后才向首轮模型投递。元数据写失败阻止模型启动。
- 工具绑定最近已消费的输入，尚未消费的 steering 不改变当前目标；审批前固定绑定。
- 停止发生在身份读取期间时，读取结束也不会再启动模型；取消输入的元数据落盘结束后才允许删除会话。
- 状态服务只持有一层已有页面资源租约，通过 callForSession 保持遥测归属；操作查询不读页面。
- 相关定向测试通过，覆盖快照、歧义边界、状态别名、原始输入绑定、取消、删除和 schema。
- 首次全量回归发现旧停止测试把新增身份读取当作慢写；已区分 fixture 的固定读取与实际写入，
  并补充停止期间身份读取的回归测试。修复后 Desktop 全套 424 项通过；typecheck、source boundary、
  Markdown 链接和 diff 空白检查通过。仍未完成模型工具激活与真实世界验收。
