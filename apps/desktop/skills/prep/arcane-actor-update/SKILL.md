---
name: arcane-actor-update
description: 在 Foundry 世界里新建或修改人物（Actor、角色、NPC）。给人物添加法术、职业能力或专长（优先从 arcane-dnd5e-2014-automation 模块的 "Arcane 5e 2014" 合集包拿）、创建人物、给人物配图、发现 token 拖上地图没有头像、补 token 图或批量修正人物图像时使用。
---

# 人物（Actor）更新

## Actor 类型与派生计算

先根据用户意图选择 Actor 类型：

- “玩家角色”“角色卡”“我的 5 级法师”或仅提供职业+种族+等级而没有 NPC 语义时，使用 `type: "character"`。导入职业、种族、背景和子职的原生 Item，让 dnd5e 准备等级、HP、AC、技能、法术位和资源；然后 read-back 实际结果。
- “NPC”“敌人”“守卫”“首领”“怪物”时，使用 `type: "npc"`。优先导入完整 stat block；空白 NPC 不会自动获得玩家角色式等级 HP。
- 添加职业能力不会改变 Actor 类型；类型由用户意图决定。

Character 路径中，模型只负责选择来源、等级和明确选项。不要自己计算 HP、AC、技能映射、法术位或资源；让 dnd5e 计算并通过一次 read-back 验证。

## 车卡 / 升级施法职业：工具流与法术数量契约

车卡或升级施法职业时优先工具流，不凭记忆推规则数量：

1. 计划：`foundry_content_list`（`type:"classFeature"`，传 `actorUuid`、`classUuid`、目标 `characterLevel`，有子职/种族传 `subclassUuid`/`raceUuid`）。`automaticSteps` 由 `foundry_actor_advance` 自动完成，不手工重复添加；`choiceRequirements` 每条带 `fill`（填到 advance 入参的键）、`valueFormat`、`count`/`cap`，只填这些要求。
2. 数量预算：`spellBudget` 是该等级的施法数量契约——`cantrips` 戏法数、`known` 已知法术数（2014 诗/术/契/游）、`book` 法术书容量（法师）。选满这个数，不多不少。
3. 候选：`foundry_content_list`（`type:"spell"`，传同一 `classUuid`）分页列候选并带 `eligibility`；戏法传 `maxLevel:0`。环位上限不背表：advance 后角色身上 `system.spells.spellN.max > 0` 的环即合法环位，按此选法术书/已知。
4. 子职业：`subclass-uuid` 要求自带 `candidates`（uuid）和 `candidateNames`（名称映射）。用户指定学派时按名称从池里选；未指定时按任务默认或从池里挑，池为空才用 `foundry_content_search` 定位。定下 `subclassUuid` 后必须带它重调一次 list：子职业自身的授予/选择步骤（`subclass:` 前缀）才进输出，`actorAdvanceArgs` 也会带上它传给 advance。
5. 落地与对账：法术随 `additionalItems` 交给 `foundry_actor_advance`，或事后走下面的授予路径；完成后回读 `actor.items` 数一遍——戏法数 == `cantrips`、书/已知 == `book`/`known` 才算完成。

授予文档的来源优先级不变（下节合集包优先）：工具流确定的法术按 identifier 在模块合集包取文档，模块缺失再直接用工具返回的 dnd5e UUID。

## 给人物添加法术 / 职业能力

零散"给某人加指定法术/特性"（非整体车卡升级）走本节合集包路径直接授予。

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

1. 添加的法术/能力回读 `actor.items` 确认在角色卡上，来源为 arcane-dnd5e-2014-automation 的包或已报告的回退来源。
2. 角色卡 / Actor 目录显示头像。
3. 新拖一个 token 到场景，显示正确图像。
4. 场景中该人物已有的 token 图像已同步。
