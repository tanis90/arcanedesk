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

**QA-A 实测补充**：固定环境 Arcane 0.3.18 中的 Summon Beast 是原生 summon Activity，
但没有当前发现合同认可的 nativeSummon marker，因此不会进入模型能力目录。未修改该 Item。
另以其精确原生身份测试 SDK 新入口，有/无进行中战斗均在扣费、Token 放置、聊天和效果写入前
返回 CAPABILITY_UNAVAILABLE。这个防护测试不代表新召唤协议已集成；包侧重构须一起确认
发现 marker 与 placement capability 的版本匹配，不能只改执行入口。

## AUTO-002 短休/长休联动

状态：产品能力整体延期，包侧同样不实施。

背景、需求和改造思路集中记录在 [短休/长休 TODO](./foundry-rest-todo.md#auto-包的联动工作也一起延期)，
包括现有 restActor/restGroup、UI 语义一致性、恢复与次数 hooks、人工选择和完成回执。
后续恢复需求时先更新该记录，再由包侧统筹。当前不接入模型工具，也不通过属性 patch 模拟休息。

## AUTO-003 叙事施法的独立视觉入口（可选）

**状态**：待包侧评估；当前不修改包，不阻塞无动画的叙事记账。

**背景**：QA-A 的现有组合未确认可独立调用、且不产生游戏效果的法术视觉入口。
易容术／敲击术等 narrative 路径已完成一次扣费；再调用 Item use 或整条自动化脚本播放动画，
可能重复扣费、创建效果或触发战斗前提。不能用这种方式补动画。

**需求**：若包侧需要支持，提供明确 capability 和仅视觉的调用合同，接受精确来源 Token 与
Item/Activity 身份；不扣资源、不创建规则效果、不要求 Combatant，不自动放置或绑定召唤物。

**改造思路**：由包侧重构统筹，把可复用视觉步骤从带规则副作用的执行链拆出，明确支持范围、
完成／跳过／失败回执与版本；未找到可用资产时允许跳过。接口名称等待包侧确认。

**App/SDK 边界**：沿用[唯一技术方案](./foundry-prep-play-technical-plan.md)第 7 节的可选视觉语义。
没有匹配入口时跳过；记账已完成后，视觉失败只加 warning，不补扣、不重施、不换旧执行通道。
本轮不为此增加模型工具，不修改包代码、编译器、生成物或世界 Item。

**验收**：有 Token 且入口支持时仅播放一次；资产缺失／超时／异常后资源仍只扣一次，
无额外效果、战斗或召唤物；旧包无入口正常完成记账。确认实际包集成后再关闭。


## 追加职业后的CR重评未实现

- 决策：本轮不实现、不自动估算CR。来源CR保留，DM明确指定时才修改；交付时说明没有重新评估。
- 背景：相同职业等级对不同基础怪物的威胁增量不同，例如狼人追加战士与龙追加施法职业，不能用每级固定增加CR的方式处理。
- 后续若重启：独立设计整体威胁评估与验证案例，再讨论实现；不视为当前必做项。不以修改CR绕过熟练派生问题。
- 依据与当前边界：[唯一技术方案§26.1](foundry-prep-play-technical-plan.md#261-cr边界已确认)。本条不涉及auto pack变更。

## 车卡试跑发现：奥术回想的职业定位与资源字段（仅记录）

背景：六题benchmark v2的Qwen A1工具组导入了`Compendium.arcane-dnd5e-2014-automation.classfeatures.Item.j1igHekQF2wcXNwW`。只读检查内嵌宏发现它按`i.type === "class" && i.name === "法师wizard"`定位等级，并使用旧式`system.uses.value`写入。当前未执行此宏，不宣称已经复现运行故障。

需求：能识别合法导入的法师职业条目，兼容本地dnd5e资源消耗字段；不能要求agent仅为宏而使用某个精确本地化名称。

改造思路：由auto pack维护者后续评估使用稳定identifier/关联字段定位职业，并按支持的系统版本适配资源消费API，加入不同显示名与资源耗尽场景验证。本轮不修改auto pack，不把这项自动化可用性算作模型配置失败。背景见[benchmark手册](prep-character-benchmark-manual.md)。


### auto pack 职业能力标识规范化（只记录，不修改包）

背景：六题职业成长benchmark中，施法、奥术传承等条目的system.identifier为空，奥术回想/法术塑形带前导连字符。条目来源UUID真实，旧验收器却无法关联能力和资源。当前以审核后的UUID别名表兼容，未修改auto pack。

需求：在auto pack本轮大改稳定后，为职业能力提供稳定、无歧义的机器标识；显示名和翻译变化不应影响能力识别。

改造思路：包维护侧统一生成与校验identifier，处理同名跨职业能力、既有UUID和旧卡迁移；客户端继续兼容旧来源UUID，回归验证资源与活动关联。不在当前benchmark迭代中直接改包。参见[技术方案](foundry-prep-play-technical-plan.md#27-六题benchmark实现试跑与验收修订完成)与[修订证据](prep-character-benchmark-audit.md)。


### 成长候选的附加先决条件结构化（auto pack 后续协同）

背景：查询v4发现祈唤已具备prerequisites.level，但苦痛魔爆、饥渴魔刃等的魔能爆/刃之魔契要求仅在requirements文本里，prerequisites.items为空。需求：工具能够可靠区分等级可选与前置选择已满足。改造思路：由auto pack维护方审查可表达的Item标识关联，按dnd5e原生前置条件语义补入，复杂“或”条件不能强行简化；同时保留规则文字。当前不修改auto pack，只在查询中保留条件待确认。关联[唯一技术方案§30](foundry-prep-play-technical-plan.md#30-查询-v4候选资格与子职法术表2026-09-09)。


### 全职业初查中的 auto pack 待核对项

关联唯一技术方案§31。禁止本轮修改包，以下由包维护方确认并实施：
- 逸闻学院：五级前只有额外3技能Trait，未见恶言相加的ItemGrant，描述中也没有该能力。需求是保留三技能同时补准确能力关联；改造时核对同版本来源与现有自动化Item，不凭名字批量替换。
- 奇械师：ItemChoice声明artificerInfusion类别但pool空，现有注法文档的类型子类未提供对应分类。描述列表已有准确UUID。建议补规范类别或显式pool，再核对等级门槛和复制魔法物品的二级选择。
- 德鲁伊：2014职业的4级可选链接xzAp6LCqoEml2umc标记了不同规则版本，查询已阻止静默导入。由包维护方核实条目版本与实际规则内容，修元数据或替换该关联。
- 游侠：原版宿敌/自然探索者同时出现在授予和替代选择中，需确认选择后是否有删除/替换机制，避免两套能力同时获得。工具后续审查应保留选择hint和规则要求，不能自动改包。
