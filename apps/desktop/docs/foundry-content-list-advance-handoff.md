# `foundry_content_list` → `foundry_actor_advance` Handoff

状态：设计已确认，联动实现尚未合入生产代码。

最后核对：2026-09-14。本文件只记录设计和实现交接，不改变运行时行为。

## 1. 目标

让模型完成 Character 创建或升级时，只判断用户真正需要的选择；Foundry dnd5e 原生系统负责 advancement、ItemGrant、资源连接和派生字段。

`foundry_content_list` 负责提供紧凑、可判断的规则视图；`foundry_actor_advance` 负责一次性执行并回读验证。两者之间不传完整 advancement JSON，也不让模型手写 HP、法术位、资源或派生字段。

## 2. 已验证内容

- `actorAdvance` 已接入 SDK、Desktop service、tool policy 和 runtime；fvtt-cli 有 `actor-read`/`actor-advance` typed 命令可直接驱动。
- 只接受 `character` Actor，并要求当前 Actor `readRef`。
- 通过来源 UUID 读取 class、subclass、race 的 compendium Item。
- 使用 dnd5e `AdvancementManager.forNewItem` 和原生 `advancement.apply()`；class/race 共享单个 working clone，一次 commit。
- 已在本地 COS（Foundry 13.351、dnd5e 5.3.3）端到端验证 A1：法师 5 级 + 塑能学派 + 人类，一次 `actorAdvance` 调用后回读确认——等级 5、HP 22/22（6+4×4）、属性 11/11/11/13/11/11（人类 +1 全属性 + 4 级 ASI int+2）、技能奥术/调查、法术位 4/3/2、职业特性 3 件、子职业特性 2 件（塑能学者、法术塑形）、火球术 + 长棍入包，receipt 18 步 0 warnings。
- 缺必填 choices 时聚合报 `ADVANCEMENT_NEEDS_CHOICE`（列出全部缺口 slot）且零写入，已实测负探针。
- SDK 测试 112/112 通过（含 actorAdvance 行为级测试 11 个）。
- `foundry_content_list` 目前仍主要存在于 benchmark fixture，生产工具尚未接入。

### 2.1 COS 实机回归核实的 dnd5e 5.3.3 机制事实（2026-09-14）

- 原生"新增 item 的 advancement 链"**不靠创建 hook**（dnd5e 没有任何 createItem advancement hook；`isAdvancement: true` 只是跳过 HP 警告等副作用的选项标记）。子职业特性链 = `AdvancementManager` 会话内私有 `#synthesizeSteps()`：`SubclassAdvancement.apply` 把子职业 item 插进 working clone 后，manager 侦测到"新增的带 advancement 的 item"，把它的 flows 按等级动态插入步进列表。runtime 已复刻：Subclass apply 后对新 item 做第二遍 `flowsForLevel` 枚举并自动应用（SRD 子职业低级 advancement 全是 ItemGrant 固定授予；若遇需要选择的子职业步骤会进 receipt `warnings` 的 `SUBCLASS_STEP_NEEDS_CHOICE`）。
- 种族 advancement 在 **level 0**（`SizeAdvancement.levels = [0]`，人类 ASI/体型/语言都在 level 0）；`forNewItem` 对非 class item 枚举 `0..currentLevel`。归一化必须保留 level 0，不能按 1..targetLevel 过滤。
- 多个 advancement 的 apply 在 `options.initial` 下走另一条路：ASI 只有 `initial` 才把 `configuration.fixed` 注入 assignments；Trait 在 `initial` 下**丢弃传入 chosen**改用自动值；Subclass 在 `initial` 下直接 return。runtime 因此不传 initial，改为在 points:0 的种族 ASI 上自行把 fixed 展开进 `assignments`。
- `SubclassValueData.document` 是解析后的 Item **文档实例**而不是字符串 id，回读要用 `?.id`。
- `AdvancementManager` 流程末端有一个无 advancement 的合成步骤，只负责把 class item 顶到目标等级；静态枚举会漏它，必须显式 `classItem.updateSource({"system.levels": targetLevel})`。
- SRD 法师/牧师低等级**没有法术 ItemChoice advancement**（戏法只有 ScaleValue 计数器，法术书在系统层面无表达；唯一法术 ItemChoice 是法师 20 级 Signature Spells）。A1 的法术获取走 `additionalItems` 授予路径。SRD 5.1 内容在 `dnd5e.classes/spells/items/races/subclasses` 包；`dnd5e.equipment` 不存在，武器在 `dnd5e.items`；2024 版内容在 `*24` 系列包。
- ItemGrant/ItemChoice 的 apply data 形状是 `{selected:[uuid...]}`；ItemChoice 的 `configuration.choices` 是**按等级键的映射**（`{"1":{count:2}}`），Trait 的 `configuration.choices` 是数组——两者形状不同，归一化不能混用。
- class item commit 后不携带 `_stats.compendiumSource`；runtime 在 advance 前给 class/race item data 写入 `flags.dnd5e.sourceId`，让 receipt 的 `verification.classUuid` 可追溯来源。

## 3. 已拍板的设计边界

### 3.1 不使用 progressionRef 或服务端缓存

每次 list 都即时读取当前 World 的 compendium 和原生 advancement 配置。list 不创建快照、不写入 Foundry、不保存候选集合。

`actorAdvance` 收到参数后重新通过 `fromUuid` 解析来源，并重新扫描 advancement。list 和 advance 之间如果规则内容发生变化，advance 以当前原生数据重新校验，不能依赖旧快照。

### 3.2 UUID 是唯一的可执行身份

list 返回的每个可选条目都必须带真实 UUID，并且同时保留 `packId`、`entryId` 作为审计信息。模型把选中的 UUID 传给 advance 或 grant；工具再次验证 UUID 能解析到预期的 compendium Document、类型和来源。

### 3.3 list 与 advance 使用同一套步骤归一化

必须实现一个共享的 `normalizeAdvancementSteps`（名称可调整），由它生成：

- 原生步骤总数；
- 自动步骤摘要；
- 模型必须填写的 `choiceRequirements`；
- 每个选择的 `slot`、类型、等级、数量、候选或候选来源；
- `coverage.uncoveredRequiredSteps`。

`actorAdvance` 不能使用另一套基于关键词的判断逻辑。它必须重新生成同样的步骤计划，再把 choices 映射到对应的原生 advancement。

## 4. `foundry_content_list` 接口草案

这是只读查询接口，参数描述“要查看哪个规则集合”：

```ts
{
  scope: "compendium",
  type: "classFeature" | "spell" | "item" | "weapon",
  rules?: "2014" | "2024",
  classUuid?: string,
  subclassUuid?: string,
  raceUuid?: string,
  characterLevel?: number,
  maxLevel?: number,
  query?: string,
  page?: number,
  pageSize?: number
}
```

`classFeature` 结果的核心结构：

```ts
{
  actorAdvanceArgs: {
    classUuid: string,
    subclassUuid?: string,
    raceUuid?: string,
    targetLevel: number
  },
  automaticSteps: StepSummary[],
  choiceRequirements: ChoiceRequirement[],
  coverage: {
    nativeStepCount: number,
    automaticStepCount: number,
    choiceStepCount: number,
    uncoveredRequiredSteps: string[]
  }
}
```

`spell`、`item`、`weapon` 结果返回紧凑候选；每个候选至少包含 `uuid`、`name`、类型、等级（适用时）、`packId` 和 `entryId`。候选的资格字段必须说明是合法候选、自动授予还是仅名称命中，不能混用。

## 5. `foundry_actor_advance` 接口草案

这是写入接口，参数描述“给哪个 Actor 应用哪些已经确认的选择”：

```ts
{
  actorUuid: string,
  readRef: string,
  classUuid: string,
  subclassUuid?: string,
  raceUuid?: string,
  targetLevel: number,
  choices?: {
    skills?: string[],
    tools?: string[],
    cantrips?: string[],
    preparedSpells?: string[],
    hp?: "max" | "avg",
    abilityScore?: Record<string, number>
  },
  additionalItems?: Array<{
    uuid: string,
    quantity?: number,
    equipped?: boolean
  }>
}
```

它不接受 advancement 原始 JSON、完整 Item 文档、HP 公式、法术位、资源数值或任意 system patch。没有明确的用户选择时，工具使用 dnd5e 原生默认行为；原生必填选择无法默认时，写入前返回 `ADVANCEMENT_NEEDS_CHOICE`，不产生世界写入。

## 6. A1 预期调用流程

1. 创建空白 `character` Actor。
2. `foundry_actor_get(include: ["items", ...])` 获取 `readRef`。
3. list `classFeature`：法师、子职、种族、5 级、2014。
4. list `spell`：法师可用范围；必要时用 `query` 找火球术。每个候选都带 UUID。
5. list `weapon` 或 `item`：查询长棍并取得 UUID。
6. 模型只补充 `choiceRequirements` 对应的 choices。
7. 调用一次 `foundry_actor_advance`，将来源 UUID、choices 和长棍 UUID 传入。
8. 回读 Actor，检查等级、特性、HP、资源、法术和装备。

list 可以按领域调用多次；不应在同一 advancement 计划上反复 list/detail/浏览器评估。advance 正常只调用一次，缺少必填选择时才返回未写入的拒绝结果。

## 7. 当前实现阻塞

1. **生产 list 尚未实现**：需要把 benchmark fixture 的紧凑视图移植到 SDK runtime 和 Desktop tool，但不能直接复制 fixture 的缓存或关键词分类逻辑。
2. **非 advancement 输入仍需边界确认**：A1 的初始能力值、法术书内容、准备状态和装备组合不完全属于 advancement。它们应由明确的 Character 创建/装备入口承载，不能偷偷塞进 progression choice。
3. **list 输出必须控制上下文大小**：自动步骤只返回摘要；法术和装备候选返回紧凑引用，详细 effects/activities 只在最终确实要导入时再 detail。

已解除（2026-09-14）：原生步骤归一化已抽出为 runtime `normalizeAdvancementSteps`（产出 steps/automaticSteps/choiceRequirements/uncovered/unmet），`actorAdvance` 已改为"先整体校验、零写入拒绝、单次 commit"，并经 COS 实机回归（见 2.1）。

## 8. 实现顺序

1. 在 SDK runtime 中实现共享 `normalizeAdvancementSteps`，先用 COS 的 class/subclass/race 实例回归。
2. 实现只读 `contentList` action、typed contract、Desktop service、tool schema 和 allowlist。
3. 让 classFeature list 返回 `actorAdvanceArgs`、自动步骤、choice requirements 和 coverage。
4. 让 spell/item list 返回完整 UUID 候选，并验证分页和规则版本。
5. 改造 `actorAdvance` 使用共享归一化结果做零写入前校验。
6. 用 A1 跑工具臂 benchmark，再和裸 eval 对比耗时、完成度、工具调用数和失败原因。
7. 只有当 A1 暴露出实际缺口时，才增加能力值、法术书/准备、装备等受限输入。

## 9. 验收标准

- list 返回的每个可执行候选都有可解析且类型正确的 UUID。
- `coverage.uncoveredRequiredSteps` 为空时，advance 不会因为 list 遗漏原生必填步骤而失败。
- choices 不完整、来源 UUID 错误或 readRef 过期时，advance 在任何 Actor 写入前拒绝。
- 自动职业/子职业特性、资源和派生字段由原生 advancement 产生，不由模型复制或计算。
- A1 工具臂完成后，回读结果与 benchmark 验收字段一致；失败时能从 trace 区分模型选择错误、工具校验错误和 Foundry 原生错误。

