# 备团／跑团实施与验收记录

依据：[唯一技术方案](./foundry-prep-play-technical-plan.md)、[auto pack TODO](./todo.md)、[休息 TODO](./foundry-rest-todo.md)。
本文只记录实施证据和未完成工作，不另定产品合同。

分支：`codex/foundry-prep-play`，独立 worktree 基线 `9107c09`。未修改原主线工作目录或 auto pack。

## 当前状态

整体未完成。首批 SDK 能力和操作日志已实现，尚未接入 App 工具，不是可交付版本。

| 方案项 | 实施状态与剩余工作 |
| --- | --- |
| M0 基线／工具矩阵 | 已从最新主线建独立 worktree；尚需集中 allowlist、真实 Pi active set 检查和性能基线 |
| M1 共享上下文 | SDK staticContext/playContext 已有统一 Scene／有效战斗范围、全量 Token、结构引用；尚需宿主快照失效映射、view/operation 分支和工具接入 |
| M1 状态 | SDK conditionsSet 已有源保护、原生结束专注、目标解析和四态；尚需模型 schema、中英文别名、宿主快照与工具接入，以及真实系统验证 |
| M1 操作记录 | 本地 JSONL、首次派发前落盘、同调用去重、重启不重放已实现并测试；尚需服务／会话删除接入 |
| M1 环境绑定 | Runtime 状态写已有 world 检查；尚需消息提交时捕获 world/Scene/selection 和工具调用归属 |
| M2 跑团执行 | 未实现新 executeAction、叙事能力发现／扣费、无战斗攻击、回合约束及稳定引用解析 |
| M3 备团 Actor | 未实现七项核心工具中的搜索和 Actor 服务、图片管线、readRef |
| M4 备团 Scene | 未实现 Scene 服务、图片／批量 Token、局部回读 |
| M5 召唤 | auto pack 只记录 AUTO-001；尚需 App/SDK 写前能力拒绝，不接入旧同先攻协议冒充新功能 |
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

先完成 M1 宿主接入：固定读取消息提交时的轻量身份，持久化至输入元数据；在模型消费该输入时
绑定选择来源，不能让排队后的选择或其它聊天改变写目标。服务持有现有资源租约并通过
callForSession 使用同一个 Runtime；日志在实际写派发前记录。再集中注册 schema/allowlist。

随后实现 M2 的完整发现→执行链路，不能只改工具名称。静态动作目录还需补充 narrative-only
普通法术、验证实际能力定义完整性及结构失效覆盖；动态结果不携带重定义。
最后推进 M3/M4 和全套验收。真实世界验收仅使用测试世界；若缺用户授权的连接或测试材料，
先完成其它独立工作，再说明具体所需操作。
