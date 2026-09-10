# Foundry 内容查询工具 Spec

状态：设计稿，尚未实现。

本文定义一组面向模型的 Foundry 内容读取入口。目标不是把 Foundry API 抽象成另一套写入语言，而是让模型用最少的查询步骤获得**可判断、可导入、可验收**的来源内容。

## 1. 设计边界

内容查询有三种不同意图：

1. **Search**：我知道一个模糊名称，想找到精确文档和 UUID。
2. **List**：我想知道一个规则集合里有哪些候选项。
3. **Detail**：我已经选定一个 UUID，需要它的完整定义。

这三种意图使用三个入口。入口数量增加是为了减少每个入口的语义负担；不提供万能参数、cursor 或隐式规则猜测。

所有入口都必须要求 `scope`：

- `world`：当前 World 中的实例，可能已经被 DM 修改。
- `compendium`：可复用的来源模板或规则内容。

返回结果始终带实际来源。工具不能把 World 实例伪装成规则来源，也不能把搜索命中伪装成职业合法性证明。

分页统一使用 `page` 和 `pageSize`，均从 1 开始；默认 `page=1`、`pageSize=20`，最大 `pageSize=100`。详情查询不分页。

## 2. `foundry_content_search`

### 用途

根据名称、关键词或 identifier 找到精确文档。它回答“这个东西在哪里”，不回答“它对当前角色是否合法”。

### 输入

```ts
{
  scope: "world" | "compendium",
  type: "actor" | "scene" | "item",
  query: string,
  packIds?: string[],
  actorType?: "character" | "npc",
  itemType?: string,
  page?: number,
  pageSize?: number
}
```

`query` 匹配名称和稳定 identifier。`packIds` 只在 `scope=compendium` 时使用。

### 输出

```ts
{
  page: number,
  pageSize: number,
  total: number,
  hasNextPage: boolean,
  items: Array<{
    uuid: string,
    name: string,
    type: "actor" | "scene" | "item",
    packId?: string,
    entryId?: string,
    identifier?: string
  }>
}
```

不返回完整正文，不返回职业资格判断。

## 3. `foundry_content_list`

### 用途

查询规则或结构上定义好的候选集合。它回答“有哪些东西可以选、会被授予或属于这个来源”。

### 输入

```ts
{
  scope: "world" | "compendium",
  type: "spell" | "classFeature" | "feat" | "monsterAction" | "weapon" | "armor" | "item",
  rules?: "2014" | "2024",
  class?: string,
  subclass?: string,
  characterLevel?: number,
  levels?: number[],
  maxLevel?: number,
  actorUuid?: string,
  query?: string,
  page?: number,
  pageSize?: number
}
```

只对相关类型解释筛选项；无关筛选项返回输入错误，不静默忽略。

法术列表必须额外返回：

```ts
{
  uuid: string,
  name: string,
  level: number,
  school?: string,
  classEligible: boolean,
  subclassGranted: boolean,
  optionalExpansion: boolean,
  levelEligible: boolean,
  eligibilityReason: string
}
```

职业资格必须由版本明确的来源计算。工具不能只因为 Item 存在就报告 `classEligible=true`。

怪物动作列表以 `actorUuid` 为边界，只列出该 Actor 的实际 embedded Item；装备列表返回装备类别、武器／护甲基础属性和来源摘要。

### 输出原则

列表只返回选择所需的摘要，不返回全文。没有筛选条件时允许完整分页，但仍遵守 `pageSize` 上限。列表的候选集合不等于“模型必须全部导入”。

## 4. `foundry_content_detail`

### 用途

读取一个已经选定的具体文档。它回答“这个 UUID 的完整定义是什么”。

### 输入

```ts
{
  scope: "world" | "compendium",
  uuid: string
}
```

### 输出

```ts
{
  uuid: string,
  type: "Actor" | "Scene" | "Item",
  name: string,
  source: {
    scope: "world" | "compendium",
    packId?: string,
    entryId?: string,
    packageName?: string
  },
  summary: object,
  document: object,
  activities?: object,
  effects?: object
}
```

`document` 保留实际原生数据；`summary` 提供模型快速使用的规范化字段。详情读取不重新判断职业资格，资格以 `list` 的结果为准；如果模型改变了职业、等级或规则版本，应重新查询 `list`。

## 5. Benchmark 组合演练

下面只计算**获取信息**所需的查询步骤，不把 Actor 创建、原生写入和最终读回算进来。每一步可以在一次工具调用中完成；列表分页按返回是否有下一页决定。

### A1：五级塑能法师从零创建

需求：人类、法师5级、塑能学派、智力18、火球术、长棍。

推荐路径：

1. `list(compendium, classFeature, class=wizard, subclass=school-of-evocation, characterLevel=5)`：取得五级职业／子职成长、自动授予和待选择项。
2. `list(compendium, spell, class=wizard, subclass=school-of-evocation, characterLevel=5)`：取得四个戏法、最高三环、可选法师法术和领域／子职额外法术的资格信息。
3. `list(compendium, spell, class=wizard, characterLevel=5, query=火球术)`：确认火球术属于法师列表并取得 UUID。
4. `list(compendium, weapon, query=长棍)`：取得合法长棍候选和 UUID。
5. 对最终导入的职业、子职、特性、火球术和长棍逐个 `detail`；如果列表已经返回完整的来源 UUID 和写入所需摘要，可以只对需要 activities/effects 的 Item 查详情。

信息查询：**4 次 list + 按需 detail**。不需要搜索 `Daylight`，也不需要让模型从全部世界 Item 中自行判断法师资格。

### A3：三级生命牧师从零创建

需求：丘陵矮人、生命领域、感知16、轻锤。

1. `list(compendium, classFeature, class=cleric, subclass=life-domain, characterLevel=3)`：取得牧师和生命领域成长。
2. `list(compendium, spell, class=cleric, subclass=life-domain, characterLevel=3)`：取得领域法术和等级合法的牧师法术。
3. `list(compendium, weapon, query=轻锤)`：取得轻锤来源。
4. 对实际导入的职业、子职、领域法术和轻锤按需 `detail`。

信息查询：**3 次 list + 按需 detail**。

### B1：狼人追加五级冠军勇士

需求：复制指定狼人，追加战士5级、冠军勇士，保留原内容。

1. `detail(compendium, sourceActorUuid)`：读取狼人完整 Actor、原有 embedded Items、traits、HP、Token 图片和动作。
2. `list(compendium, classFeature, class=fighter, subclass=champion, characterLevel=5)`：取得战士累计成长、额外攻击和冠军特性。
3. `detail` 读取列表中将要导入的职业、子职和特性；武器不需要重新查询，因为需求没有增加装备。

信息查询：**1 次 detail + 1 次 list + 按需 detail**。不会重新搜索狼人名称，也不会把原有 Multiattack 当成新增 Extra Attack 的替代品。

### B2：地精追加三级盗贼

1. `detail(compendium, sourceActorUuid)`：读取地精原始 HP、体型、技能、动作和装备。
2. `list(compendium, classFeature, class=rogue, subclass=thief, characterLevel=3)`：取得盗贼成长、专精、偷袭和盗贼子职能力。
3. 对需要实际 activities/effects 的特性 `detail`。

信息查询：**1 次 detail + 1 次 list + 按需 detail**。HP 预期由来源 detail、体型生命骰和任务规则独立计算，不能从写入后的 HP 反推。

### B3：兽人追加五级法师

1. `detail(compendium, sourceActorUuid)`：读取兽人所有原始内容。
2. `list(compendium, classFeature, class=wizard, subclass=school-of-evocation, characterLevel=5)`：取得法师成长和塑能能力。
3. `list(compendium, spell, class=wizard, characterLevel=5, query=火球术)`：取得火球术合法性和 UUID。
4. 按需对职业、子职、火球术和新增法术 `detail`。

信息查询：**2 次 detail + 2 次 list + 按需 detail**。不会为理解 NPC schema 搜索本地 dnd5e 源码；原生 API 写法来自 skill，来源内容来自 catalog。

## 6. 步骤数量如何解释

步骤少是一个有用信号，但不是单独的优化目标。

- A1 如果一次 `list` 已返回职业成长、法术资格和实际 UUID，就不应再为每个候选重复 `search`。
- B1/B2 的来源 Actor 已知，直接 `detail` 比先按名称 `search` 更少一步。
- `detail` 次数不能盲目压到零。法术 activities、效果、武器攻击活动等确实需要全文；少查详情但导入错误，不算进步。
- 查询步骤少但写后验收缺失，会把返工推迟到模型最后一句话；所以 benchmark 必须同时记录查询调用、写入调用、读回和最终正确率。

本 spec 的成功标准是：在相同任务和模型下，新的查询入口让模型获得正确来源信息所需的往返减少，同时不降低独立验收正确率。单纯把完整数据塞进一次超大响应，不算成功。

## 7. 与当前 benchmark 的关系

本 spec 不修改 Reviewed v7 的历史输入和结果。它提出下一轮待验证的查询合同：A1/A3 检查从零配置，B2 检查生命骰取整，B3 检查施法者增量，B1 作为已有收益的回归保护。下一轮比较旧查询流程与本 spec 流程时，必须保留独立预期和写后有效字段读回；不能把工具返回值直接当成验收结果。

相关记录：[Reviewed v7 整批报告](prep-character-reviewed-v7-results.md)、[唯一技术方案](foundry-prep-play-technical-plan.md)。
