# 自建怪 → SRD 模板怪对照思路

**核心策略：模组的"自建怪"大多有 SRD 近亲。克隆近亲 + 打补丁，比从零建快一个数量级，且动作/抗性/免疫全部白嫖。**

## 找模板的方法

1. 读模组数据卡，提取结构特征：多重攻击几次？近战/远程组合？集群？构装？有没有类似光环/再生的被动？
2. `foundry_content_search(documentType='Actor', scope='compendium', query=<英文模板名>)` 检索。
3. 同名有 2014（dnd5e.monsters）/2024（dnd5e.actors24）双版本，按模组规则风味选。
4. `foundry_actor_create`（source: compendium）克隆进世界并直接改名为模组名。
5. `browser_evaluate` 打补丁（数值/类型/动作名/特性），patch 后逐项回读核验。

## 实战案例（某实测模组，示例）

| 模组怪 | SRD 模板 | 吻合度 | 补丁量 |
|---|---|---|---|
| 模组自建的蜘蛛群 | Swarm of Insects（昆虫集群） | 属性/HP/AC/抗性/盲视全同 | 仅改啃咬伤害+毒豁免，加蛛行特性 |
| 侍女雕像（4人版） | Animated Armor（活化盔甲） | **模组原文明说"使用活化盔甲数据"**，完全一致 | 仅中文化动作名 |
| 侍女雕像（5-6人版） | Animated Armor | 同型放大 | AC/HP/属性/动作换成模组版，加冲锋 |
| 融合怪物 | Manticore（蝎尾狮） | 多重攻击结构(啃咬+爪击×2)、远程刺、HP 公式、速度全同 | 类型改不死、加再生、尾刺加毒豁免 |

## 打补丁清单（按序检查）

- `system.attributes.ac.flat` / `hp`（value/max/formula）
- `system.abilities.<ab>.value`
- `system.details.cr` + `system.details.xp.value`（CR 与 XP 一起改）
- `system.details.type.value`（beast/construct/undead…）与 `type.swarm`
- `system.attributes.movement`（walk/fly/climb/hover）
- 动作 Item：改名中文化、改 damage（注意 base 注入坑，见 dnd5e-pitfalls.md）、加 save
- 模组特有特性（战术、解除方式、好感度等）：建成 `type: 'feat'` 的描述条目，DM 打牌面就能看见
- 与模组无关的模板自带特性（如蝎尾狮的尾刺再生）：删掉

## 合集没有模板时

才从零 `Actor.create`。NPC 的 attacks 用 `type: 'weapon'` + attack activity；被动特性用 feat。建完在 NPC sheet 截图核验。

## 合集根本没收的内容

非 SRD 怪物（如还魂尸 Revenant）任何官方包都没有。不要凭记忆复刻完整数据卡（版权与准确性双重风险）：按模组原文处理——模组不设数据的就不设，备注指引 DM 查阅对应书；模组给了数据的照模组建。
