# auto pack 联动 TODO

实施纪律与整体目标见 [唯一技术方案](./foundry-prep-play-technical-plan.md)。
auto pack 正在重构，本文件用于交接需求，不授权当前工作修改该包，也不构成排期承诺。
发现新依赖时按“背景、需求、改造思路、App/SDK 边界、验收、状态”追加；原事项有变化则更新原条目。
API 名称和源码位置均为讨论依据，须在包侧重构后重新确认。

## AUTO-001 召唤解除同先攻与战斗依赖

状态：待包侧重构统筹；当前不修改 auto pack。目标详见唯一技术方案第 8 节。

**背景**：当前召唤链路把施法者 Combatant、有效先攻、召唤物参战和同先攻收尾绑定在一起。
跑团模式需要在非战斗中施法；这些战斗前提会阻止召唤完成，也增加游标恢复和失败处理负担。

**需求**：召唤可在有/无战斗时原生放置，保留实际 Token、归属、来源、消耗和已有生命周期语义。
取消强制参战、复制施法者先攻及同先攻游标处理。DM 自行将召唤物加入战斗、独立投先攻。
不新增生命周期自动化，不自动删除或重掷存量召唤物的 Combatant。

**改造思路**：在重构后的召唤准备/完成链路中拆除 Combatant/initiative 的必需条件，
以实际放置 Token 和原生完成信号收尾。旧实现的 prepareNativeSummonUse、
finalizeNativeSummonCore、nativeSummonEnsureCombatants 是定位参考。
明确版本化 capability、marker 和 placement 回执；唯一技术方案中的
nativeSummonPlacementV2 / finalizeNativeSummonPlacement / combatBinding:manual 是建议名称，
等待包侧确认。同步评估编译器/emitter 与旧 Actor Item 兼容，不能假定已复制 Item 自动升级。

**App/SDK 边界**：可先做能力检查、合同隔离与测试；包侧未提供匹配协议时，
新入口在首次写入/扣费前返回 CAPABILITY_UNAVAILABLE。不能调用旧同先攻流程后补救，
不能在 App 复制包规则或注入补丁。保留旧调用方兼容，不声称新召唤已经可用。

**验收**：有/无战斗放置；不自动参战或继承先攻；取消/全部跳过/部分放置；
扣费后后处理失败或超时不重扣、不重施；新旧包与新旧 Item 组合；旧调用方回归。
fixture 测试通过不等于真实包集成通过。包侧就绪并完成集成验收后才关闭本条目。

## AUTO-002 短休/长休联动

状态：产品能力整体延期，包侧同样不实施。

背景、需求和改造思路集中记录在 [短休/长休 TODO](./foundry-rest-todo.md#auto-包的联动工作也一起延期)，
包括现有 restActor/restGroup、UI 语义一致性、恢复与次数 hooks、人工选择和完成回执。
后续恢复需求时先更新该记录，再由包侧统筹。当前不接入模型工具，也不通过属性 patch 模拟休息。
