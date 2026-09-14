# Character Advancement agent 接入调研

日期：2026-09-14。当前代码已在 `41b0279` 提交；本次只提交调研，不修改运行工具。

## 当前版本的原生事实

本机 COS 运行的是 Foundry 13.351、dnd5e 5.3.3。真实系统代码位于 `D:\FVTT_DATA\Data\systems\dnd5e\dnd5e.mjs`。

`AdvancementManager.forNewItem(actor, itemData, options)` 在 dnd5e 代码约 7161 行定义。它会：

1. clone Actor；
2. 把 class/race/subclass Item 放到 clone；
3. 按 class level 生成 advancement steps；
4. 通过 ItemGrant、Trait、HitPoints、ScaleValue 等 advancement 修改 clone；
5. 最终由 manager 的 complete 流程把 clone 的变化提交回 Actor。

manager 默认 `automaticApplication: false`。`render()` 只有在 step 有 `automatic` 标记或 `automaticApplication` 能提供数据时才自动前进；需要选择的 step 会进入 UI flow。dnd5e 的内部 `#forward` / `#complete` 是 private 方法，生产代码不应直接调用。

公开的 advancement 实例提供 `apply(level, data, options)`、`restore`、`reverse` 和 `automaticApplicationValue(level)`。HitPoints、ItemGrant、ScaleValue 的实现都在同一份 dnd5e.mjs 中。Tidy5e 的 actor sheet 也用 `AdvancementManager.forNewItem`，例如其 drop handler 约在 57588、86952、93943 行。这是“原生升级入口”的直接实现参考。

## 推荐架构：ArcaneDesk 的受限 native adapter

不要让 agent 执行任意 `browser_evaluate`，也不要复制一套 D&D5e 规则。建议在现有 Foundry action/runtime 层增加一个明确的 `actorAdvance` action，并暴露成一个 agent tool：

```js
foundry_actor_advance({
  actorUuid,
  classUuid,
  subclassUuid,
  raceUuid,
  targetLevel,
  choices: {
    skills: ["med", "rel"],
    tools: ["art:smith"],
    cantrips: [/* source UUIDs */],
    preparedSpells: [/* source UUIDs */],
    abilityScore: { wis: 1, con: 1 }
  }
})
```

这些输入是“来源 UUID + 等级 + 用户选择”，不是自定义 Actor schema。工具内部：

```text
校验当前 world / GM / Actor
  → fromUuid 解析来源
  → 构造 AdvancementManager 或等价 native flows
  → 自动应用无选择 advancement
  → 把 choices 映射给 ItemGrant/Trait/ItemChoice flow
  → 让 Foundry 写入 clone
  → commit 到原 Actor
  → read-back 派生字段
  → 关键字段不满足时返回 failed，不返回 success
```

实现要分两层：

- `foundry_actor_advance`：公共 contract、权限、事务边界、receipt、错误码、read-back。
- `dnd5e-native-advancement-adapter`：只处理 dnd5e 5.3.3 的 manager/flow 版本。以后系统版本变化时替换这一层，而不是改 agent skill 或 Actor schema。

第一版只支持“创建 Character + 一个 class + 一个 subclass + 一个 race + 到目标等级”，不要一开始做 multiclass、重选、降级和跨规则版本。

## 关键技术难点

### 1. 无 UI 的选择提交

`AdvancementManager` 的公开工厂可生成 steps，但 manager 的自动循环是 private。要先在 COS 的临时 Actor 上探针，确认每种 flow 的公开调用方式：

```js
const manager = dnd5e.applications.advancement.AdvancementManager
  .forNewItem(actor, classData, { automaticApplication: true });

return manager.steps.map(step => ({
  type: step.type,
  automatic: step.automatic,
  flow: step.flow?.constructor?.name,
  advancement: step.flow?.advancement?.constructor?.name,
  methods: Object.getOwnPropertyNames(
    Object.getPrototypeOf(step.flow?.advancement ?? {})
  )
}));
```

如果所有必选步骤都能通过 `automaticApplicationValue` 或 `advancement.apply` 无 UI 完成，就在 adapter 中顺序处理 clone，再调用公开 Actor update。若某类选择只能由 UI flow 提交，工具应明确返回 `needs_choice`，由 agent 补充 choices，不能偷偷猜第一项。

### 2. 事务和重复执行

先在 clone 上完成，检查所有必需 steps 和 read-back，再一次性提交。Actor 必须带一个 operation id；重复 operation id 直接返回原 receipt，禁止再次创建或重复授予 Item。

### 3. 来源身份

`toObject()` 后的 `_stats.compendiumSource` 可能为空，不能把它当作可靠 provenance。adapter 应在导入副本上显式保留 `flags.dnd5e.sourceId` 或等价来源记录，并在 receipt 中记录 source UUID。验收器要把“Item 存在”和“来源可追溯”分开检查。

### 4. 资源检查

完成后必须检查：

```text
class levels
subclass classIdentifier
HP value/max
spell slots value/max
class scales
selected skill ability
resource uses max/value/recovery
```

A3 中 `channel-divinity` scale 已经是 1，但 generic Channel Divinity Item 的 uses.max 为空；adapter 必须识别这种“scale 存在但资源没有连接”的状态并失败或继续完成原生连接，不能把空资源报告为成功。

## 可以参考的现有模块

- **Character Builder**：目前最接近我们的目标。它明确使用官方 D&D5e documents 和 native Advancement system，先准备选择、验证，再提交到 live Actor；同时处理 subclass review、HP advancement、feature/spell grants 和最终 commit。[Character Builder package page](https://foundryvtt.com/packages/dnd5e-character-builder)
- **官方 dnd5e Advancement wiki**：说明 advancement type 注册、ItemGrant/Trait 等模型和系统 API。[Advancement wiki](https://github.com/foundryvtt/dnd5e/wiki/Advancement)
- **官方 Advancement User Guide**：描述玩家通过 Character Sheet 的 level-up automation 使用原生 advancement。[Advancement User Guide](https://github.com/foundryvtt/dnd5e/wiki/Advancement-User-Guide)
- **Hero Mancer**：另一种 D&D5e 角色创建器，适合作为“向导先收集选择，再写 Actor”的产品交互参考，但不能作为 dnd5e 5.3.3 原生 API 的证据。[Hero Mancer package page](https://foundryvtt.com/packages/hero-mancer)
- **Tidy5e Sheet**：本机源码直接调用 `AdvancementManager.forNewItem`，适合确认当前安装版本的真实入口。

## 与现有 ArcaneDesk 的落点

需要改动的层次：

```text
packages/foundry-sdk/src/contracts.ts       增加 actorAdvance contract
apps/desktop/src/main/foundry-tools.js      增加 foundry_actor_advance schema
apps/desktop/src/main/foundry-services.js   prep-only action allowlist
apps/desktop/src/main/foundry-tool-policy.js allow actorAdvance
packages/foundry-sdk/src/runtime-source.ts  native adapter + read-back
apps/desktop/skills/...                      skill 只写调用规则，不写 D&D公式
```

现有 `foundry_actor_grant_items` 继续保留，用于单个额外 Item；`foundry_actor_advance` 专门负责 Character progression。两者都必须使用 UUID，并返回 compact serializable receipt。

## 第一条验收链

只实现 A3 所需的最小纵向切片：

```text
cleric level 3
+ hill dwarf
+ Life Domain
+ 2 skill choices
+ 3 cantrips
+ ordinary prepared spells
+ HP advancement
+ Channel Divinity scale/resource
```

验收标准是 A3 v5 的核心检查全部通过；任何 `max=""`、未解析的 ItemGrant、超等级特性或重复 Actor 都必须失败。通过后再扩展 A1/A2 和 multiclass。

Character Builder 的经验也支持这个边界：模块负责准备 Items、spells、features、effects、ownership、advancements、flags 和 resources；正常活动、伤害、目标、消耗、恢复和 spell preparation 继续由 Foundry/dnd5e 处理，而不是由 agent 自己重算。[Character Builder package page](https://foundryvtt.com/packages/dnd5e-character-builder)
'''
