---
name: arcane-actor-update
description: 在 Foundry 世界里新建或修改人物（Actor、角色、NPC）。给人物添加法术、职业能力或专长（优先从 arcane-dnd5e-2014-automation 模块的 "Arcane 5e 2014" 合集包拿）、创建人物、给人物配图、发现 token 拖上地图没有头像、补 token 图或批量修正人物图像时使用。
---

# 人物（Actor）更新

## Actor 类型与派生计算

先根据用户意图选择 Actor 类型：

- “玩家角色”“角色卡”“我的 5 级法师”或仅提供职业+种族+等级而没有 NPC 语义时，使用 `type: "character"`。导入职业、种族、背景和子职的原生 Item，让 dnd5e 准备等级、HP、AC、技能、法术位和资源；然后 read-back 实际结果。
- “NPC”“敌人”“守卫”“首领”“怪物”时，使用 `type: "npc"`。优先导入完整 stat block。
  怪物加职业等级同样走 plan/advance 工具链：新增等级用怪物体型骰的固定均值
  （medium 是 d8→5），没有玩家角色的首级满骰，也不会在收尾自动满血——HP 终值
  以 advance 回执为准。
- 添加职业能力不会改变 Actor 类型；类型由用户意图决定。

Character 路径中，模型只负责选择来源、等级和明确选项。不要自己计算 HP、AC、技能映射、法术位或资源；让 dnd5e 计算并通过一次 read-back 验证。

## 车卡 / 升级：写入工具链

车卡与升级全程走结构化写工具，不裸写世界：

1. 建档：`foundry_actor_create` 建空白 `character`（`source.kind:"blank"`），基础属性
   （标准数组/购点分配，整数 1..20）随 `dnd5e.abilities` 同批下发——种族/ASI 加成是
   advance 时对基础值做加法，属性必须先于 advance 落地，create 天然满足这个顺序。
   怪物复制用 `source.kind:"compendium"` + packId/entryId。同名冲突按回执处理，不重复创建。
2. readRef：一切写操作前用 `foundry_actor_get` 读 actor 拿 `readRef`；授予前
   `include:["items"]`，改 prototype Token 前 `include:["prototypeToken"]`。
3. 事后改属性：`foundry_actor_update` 的 `dnd5e.abilities` 是 SET 语义修正路径——
   advance 之后写入的必须是含种族/ASI 加成的最终基础值；名称/HP/AC/token 同此出口。
   种族侧的技能/工具/语言选择已进 plan 的 `choiceRequirements`（填 `choices.skills`/
   `choices.tools`/`choices.languages`，候选是具体 trait key）；其他种族侧选择
   （专长、戏法、自选属性）以 plan 实际下发为准——出现在 `choiceRequirements` 就照填，
   没出现就 advance 后按回执核对，用本工具 SET 补终值，并在报告里注明哪些是手工补的。
4. 升级写入：`foundry_actor_advance` 一次完成——`actorAdvanceArgs` 来自
   `foundry_advancement_plan`，choices 只填 `choiceRequirements` 要求的键；多个槽位共用
   一个 choices 键时，plan 的 `fillAllocation` 给出该键的总值与各槽消耗顺序，一次填够
   总数即可，不足会在写入前整体拒绝并带分配提示。专精槽（plan 里带 `mode:"expertise"`
   与说明）独立吃 `choices.expertise`：每个值必须是卡面已有熟练、或本次调用
   `choices.skills`/`choices.tools` 里已选的项——先填熟练槽再填专精槽；把未熟练的 key
   填进专精槽会在写入前整体拒绝并点名（dnd5e 原生对未熟练目标静默丢弃，工具把这件事
   提前成显式拒绝；万一仍被丢弃，回执 warnings 报 `EXPERTISE_NOT_LANDED`）。装备、法术书
   法术等额外条目随 `additionalItems`（≤50）同一批写入：用户点名的装备精确解析来源，
   未点名的起始装备按职业常识一次 `names` 批量解析带过，不逐件考证；`fullList` 职业
   改传 `fullSpellList:true`。`expectedName`/`expectedType` 是全等漂移校验：照抄 browse
   返回的 `name` 原串或整个省略，凭记忆拼写（含自创中英组合）会让整批在写入前拒绝。HP 由 dnd5e 原生计算（1 级满骰、后续级固定均值），plan
   不会询问 HP，也不需要自行验算。0 级建档的 advance 收尾自动满血、自动把法术位
   `value` 填到 `max`（回执 `hpFill`/`slotFill` 可见），既有角色升级不动当前 HP 与
   法术位余量——都不需要额外补写操作。
5. 补充授予：advance 之外的零散授予走 `foundry_actor_grant_items`（1~50 条/批，按来源
   去重不叠加）。能走 `additionalItems` 的优先随 advance 一次写入。
6. 回执即对账：advance 回执的 verification 就是 actor 终态报告——abilities（每属性
   before/after + race/asi 分解）、subclass、race（含 size）、movement、languages、
   traits（豁免/技能/护甲/武器/工具熟练 + expertise 专精级技能/工具清单）、proficiency.bonus、spellcasting（ability/
   slots/戏法与法术计数 + byLevel 按环计数）、ac、init、scale（职业 scale 值，如
   sneak-attack 骰）、resources、grantedItems（advancement 实际授予的条目名/类型清单，
   含职业特性与种族条目，带 `activities` 活动计数）、createdItems（additionalItems 授予，同带 activities）、preservedItems（既有条目保留计数）、hpFill/slotFill/spellFill
   全在其中，收到 `completed` 即对账完成，不需要任何回读补查；你要核对的字段不在回执里时，
   视为工具缺口，在报告里注明。`partial`/`indeterminate` 按回执指引处理，不重放整批。

## 车卡 / 升级施法职业：法术数量契约

车卡或升级施法职业时优先工具流，不凭记忆推规则数量。发现流程（browse 目录 → plan）
见 `arcane-content-catalog`；写入侧契约：

1. 计划即填写清单：`automaticSteps` 由 `foundry_actor_advance` 自动完成，不手工重复
   添加；`choiceRequirements` 每条带 `fill`（填到 advance 入参的键）、`valueFormat`、
   `count`/`cap`，只填这些要求。
2. 数量预算：`spellBudget` 是该等级的施法数量契约——`cantrips` 戏法数、`known` 已知
   法术数（2014 诗/术/契/游）、`book` 法术书容量（法师）。选满这个数，不多不少。准备
   施法者（2014 牧师/德鲁伊/圣武士/奇械）没有数量，改发 `fullList`：他们"会"整个职业
   法术列表，建卡时给 advance 传 `fullSpellList:true` 一次授满（领域法术等已有条目按
   来源 UUID 自动去重，高级别自动分批）；`system.prepared` 页签标记留给 DM 和玩家在
   游戏中自行决定，一律不设置。
3. 候选：法术候选用 `foundry_compendium_browse`（`type:"spell"`，传同一 `classUuid`）
   分页列取并带 `eligibility`；戏法传 `maxLevel:0`。环位上限按目标等级的规则知识传
   `maxLevel`；总数不背表，以 `spellBudget` 为准。`fullList` 职业的候选已在
   `spellBudget.fullList.candidates` 里给全，不必再分页搜。
4. 子职业：先不带 `subclassUuid` 调计划拿候选池（`candidates`/`candidateNames`）；用户
   指定学派时按名称从池里选，未指定时按任务默认或从池里挑。定下 `subclassUuid` 后必须
   带它重调一次计划：子职业自身的授予/选择步骤（`subclass:` 前缀）才进输出，
   `actorAdvanceArgs` 也会带上它传给 advance。
5. 落地与对账：法术书法术、装备随 `additionalItems` 交给 advance 一次写入；用户明确只
   点名少数几个法术而不要全列表时，才省略 `fullSpellList` 改用 `additionalItems` 按名
   授予。advance 回执带 verification（含 `fullSpellList` 时的 `spellFill` 授予计数）——
   收到回执即对账完成，不需要回读数数。

授予文档的来源优先级不变（下节合集包优先）：browse 去重已按模块包优先呈现，直接用
返回的 UUID 即可。

## 给人物添加法术 / 职业能力

零散"给某人加指定法术/特性"（非整体车卡升级）优先工具路径：用
`foundry_compendium_browse`/`foundry_content_search` 定位来源 UUID，再用
`foundry_actor_grant_items` 授予（回执即对账）。下面的合集包裸 JS 路径仅在需要
自定义字段或工具不可用时使用。

法术、职业特性、专长等条目的默认来源是 **arcane-dnd5e-2014-automation 模块的合集包**（Foundry 合集栏里的 "Arcane 5e 2014 …" 系列）：先从这里拿，拿不到才回退 system 自带包。禁止凭记忆手写条目数据——一律从 compendium 文档拷贝，避免字段版本漂移。

1. 定位包：`game.packs` 中按 `pack.metadata.packageName === "arcane-dnd5e-2014-automation"` 过滤（collection 即以 `arcane-dnd5e-2014-automation.` 开头）。按需求选包：
   - 法术：`arcane-dnd5e-2014-automation.spells`
   - 职业/子职特性：`arcane-dnd5e-2014-automation.classfeatures`
   - 专长：`arcane-dnd5e-2014-automation.feats`
   - 种族 / 种族特性：`arcane-dnd5e-2014-automation.races` / `.racialtraits`
   - 背景 / 背景特性：`arcane-dnd5e-2014-automation.backgrounds` / `.backgroundfeatures`
   - 职业 / 子职：`arcane-dnd5e-2014-automation.classes` / `.subclasses`
   - `arcane-dnd5e-2014-automation.summons` 是 Actor 包（召唤生物），不适用本条授予路径。
   以上 Item 包一个都不存在时，说明模块未安装或未启用：明确告诉用户，再回退 `dnd5e.*` 自带包（如 `dnd5e.spells`），并在报告里写明实际来源。
2. 检索：`await pack.getIndex()`。条目名是中英双语（如 `法师护甲 Mage Armor`，也有纯中文条目），必须用大小写不敏感的包含匹配兼容中文或英文片段，禁止拿用户给的单一语言名称做全串精确匹配。index 条目带 `type`（法术是 `spell`；职业特性和专长都是 `feat`，只能靠选包区分）和 `_id`；命中后 `await pack.getDocument(entry._id)` 取完整文档。多个候选时取名称最接近的一个并在报告里说明，不中断流程反问。
3. 授予：`await actor.createEmbeddedDocuments("Item", [doc.toObject()])`；一次给多个条目就把多个 `toObject()` 放进同一个数组一次调用。
4. 回读 `actor.items` 确认条目已在该人物身上，报告条目名和来源包 id。
5. 法术的 `system.prepared` 只是法术书页签标记，不影响施放：授予保持合集默认值即可，不要额外设置准备状态，除非用户明确要求。

### 由系统默认处理的字段

创建或更新 Actor 时，默认不要写入 `system.skills.<key>.ability`。dnd5e 会根据
`CONFIG.DND5E.skills` 初始化技能的默认属性；模型不得根据角色的主属性或名称猜测映射。
只有用户明确要求替代属性，或来源文档明确带有合法覆盖时，才写入 `ability`。写入后回读
每个被选择技能的最终 `ability`；空值或不符合来源/明确覆盖的值必须修复后才能完成任务。

不要把所有未指定字段都当成安全默认值。最小 NPC 的技能映射和基础 AC 会由 dnd5e 初始化，
但 HP 和移动速度可能默认为 0。用户或来源没有给出时可以省略并报告实际值；用户或 spec 有要求时，
必须显式写入并回读 `system.attributes.hp` 和 `system.attributes.movement.walk`。

### 不要自行推导 Foundry 默认字段

下面这些是 Foundry/dnd5e 数据模型的系统职责，创建 NPC 时没有用户或 spec 的明确值就不要传：

| 字段/问题 | 默认动作 | 只有何时才写 |
|---|---|---|
| `system.skills.<key>.ability` | 省略；`CONFIG.DND5E.skills` 会初始化技能对应属性 | 用户要求替代属性，或来源文档明确给出合法覆盖 |
| `system.tools` 的 key、`art:*` / `vehicle:*` 等 MappingField 结构 | 省略；不要研究或重建 `MappingField` 的初始 key | 用户明确要求某项工具熟练/专精，并且写入后回读确认 |
| `system.attributes.ac` 的派生/默认值 | 省略；让 dnd5e 计算 | spec 明确要求固定 AC 或 flat AC |
| `system.resources`、法术位和 Item 派生 uses | 省略；由系统和导入的原生 Item 初始化 | spec 明确要求具体资源数值；只写要求的槽位/资源并回读 |
| NPC 与 Character 的 HP 派生差异 | 不阅读系统源码猜公式；按 Actor 类型创建，读取实际结果 | spec 明确 HP 时写 `system.attributes.hp.value/max`，然后 read-back |
| `system.attributes.movement.walk` | 未指定时可省略（系统可能得到 0） | spec 或来源明确要求速度时显式写入并回读 |

不要为了确认这些默认值调用 `browser_evaluate` 去翻 dnd5e 源码。正确流程是：最小必要输入 → 一次写入 → 一次 read-back；若结果与明确 spec 不符，再针对该字段修复。默认字段不需要出现在模型生成的 patch 中。

## 人物头像与 Token 图像同步

Foundry 里「角色卡上的头像」和「拖进地图的 token 图像」是互不联动的字段：只设头像，token 会显示默认的神秘人剪影。凡是创建人物或修改人物图像，两个位置必须一起设置、一起回读验证，不允许只改其一。

### 字段位置（V13）

- `actor.img` — 角色卡和 Actor 目录里显示的头像。
- `actor.prototypeToken.texture.src` — 之后新拖入场景的 token 默认图像。
- 动态 token 环：`prototypeToken.ring.enabled` 为 true 时，token 画面主体取自 `prototypeToken.ring.subject.texture`，必须与上面两个字段一起设置（通常同一张图）。

### 创建人物时的默认动作

1. 用户没有分别提供头像图和 token 图时，三个字段用同一张图；用户分别提供时分别设置，并向用户确认哪张图用在哪。
2. 图片文件先落进世界 Data 目录内（如 `worlds/<世界id>/assets/`)，字段写世界内相对路径；禁止引用本机绝对路径或临时目录——迁移世界、换机器后图会全丢。
3. 写入后逐个回读 `img`、`prototypeToken.texture.src`（环启用时含 `ring.subject.texture`），并确认路径指向的文件真实存在。

### 已在场景里的存量 token

改 `prototypeToken` 只影响之后放置的 token，不会改已放置在场景里的。修正存量：遍历相关 Scene 的 token 文档，把属于该人物的 token 的 `texture.src`（环启用时含 `ring.subject.texture`）一并更新，或让用户删除后重拖。所有写调用 await 并回读验证。

## 验收

1. 工具授予以回执 verification 为准（created/skipped 计数）；裸 JS 授予回读 `actor.items` 确认在角色卡上，来源为 arcane-dnd5e-2014-automation 的包或已报告的回退来源。
2. 角色卡 / Actor 目录显示头像。
3. 新拖一个 token 到场景，显示正确图像。
4. 场景中该人物已有的 token 图像已同步。
