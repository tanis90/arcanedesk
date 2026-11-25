---
name: arcane-actor-update
description: 在 Foundry 或奥法地图（mtcompat play）中新建、复制或修改 NPC/PC，进行车卡升级、授予法术/能力/专长，以及换头像或 Token 图时使用。新建或复制人物且未指定头像时，主动从 arcane-assets 选图；普通修改保持既有图片，除非用户明确要求新增、替换或修复图片。
---

# 人物（Actor）更新

## 页面与工具准入

- 先用 `world_status` 确认当前是 ready 游戏页：Foundry 的 `/game` 且当前用户是 GM，或 mtcompat 的 `play.html` 且 world/user/runtime 已就绪。`profile` 与 `activatedTools` 只表示产品档位和工具面，不能代替这个判断；`lobby.html` 与 `/auth/**` 不做任何 Actor 读写。
- 全程优先本 skill 的结构化工具。确需裸 JS 的自定义步骤，Foundry 用 `browser_evaluate`；mtcompat 的 ready `play.html` 先用 `map_api_search({ prefix: "game.actors" })` 读取声明面，再用 `map_page_eval` 并读取 `touched/missing` 注记，不把 `map_page_eval` 用于大厅或登录页。
- `foundry_screenshot` 只在页面已经 detected 后做视觉核对，不在大厅或登录页调用。

## 先判定操作范围

| 用户意图 | 默认动作 |
|---|---|
| 新建或复制 NPC/PC | 完成建档；未提供图片且未明确要求保留来源图时，从 `arcane-assets` 选择头像 |
| 改名、加法术、升级、改属性等普通修改 | 只改请求涉及的字段，保持 `img`、原型和存量 Token 图像不变 |
| 新增、替换或修复人物图像 | 使用用户提供的图片；未提供时从 `arcane-assets` 选择 |
| 没区分头像和 Token 图 | 使用同一张图，同步头像、原型和存量 Token |
| 明确只改某一个图像字段 | 只改该字段，不用默认同步覆盖其它图像 |

## Actor 类型与派生计算

先根据用户意图选择 Actor 类型：

- “玩家角色”“角色卡”“我的 5 级法师”或仅提供职业+种族+等级而没有 NPC 语义时，使用 `type: "character"`。导入职业、种族、背景和子职的原生 Item，让 dnd5e 准备等级、HP、AC、技能、法术位和资源；然后 read-back 实际结果。
- “NPC”“敌人”“守卫”“首领”“怪物”时，使用 `type: "npc"`。优先导入完整 stat block。
  怪物加职业等级同样走 plan/advance 工具链：新增等级用怪物体型骰的固定均值
  （medium 是 d8→5），没有玩家角色的首级满骰，也不会在收尾自动满血——HP 终值
  以 advance 回执为准。
- 添加职业能力不会改变 Actor 类型；类型由用户意图决定。

Character 路径中，模型只负责选择来源、等级和明确选项。不要自己计算 HP、AC、技能映射、法术位或资源；让 dnd5e 计算并通过一次 read-back 验证。

## 最小建档示例

空白 NPC：

```js
foundry_actor_create({
  source: { kind: "blank", actorType: "npc" },
  name: "教堂守卫",
})
```

从合集复制完整 NPC（packId/entryId 必须来自实际 browse 结果）：

```js
foundry_actor_create({
  source: { kind: "compendium", packId: "<合集包id>", entryId: "<条目id>" },
  name: "腐朽牧师",
})
```

空白 PC 与基础属性（标准数组；后续种族/ASI 由 advance 加法处理）：

```js
foundry_actor_create({
  source: { kind: "blank", actorType: "character" },
  name: "艾拉",
  dnd5e: { abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 } },
})
```

这些只是建档，不是完整车卡。PC 继续 `arcane-content-catalog` 的 class/race 发现 → `foundry_advancement_plan` → `foundry_actor_advance`；NPC 优先使用完整 stat block，怪物加职业等级也走 plan/advance。图片统一交给下面的 `foundry_image`，不在 create 里传本机路径或 Base64。

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
   种族侧选择（技能/工具/语言/自选属性点/变体专长）同样进 plan 的
   `choiceRequirements`，与职业侧同法填写；没出现在清单里的才在 advance 后按回执核对，
   用本工具 SET 补终值，并在报告里注明哪些是手工补的。
4. 升级写入：`foundry_actor_advance` 一次完成——`actorAdvanceArgs` 来自
   `foundry_advancement_plan`，choices 按槽位寻址：把 `choiceRequirements` 每条的 `key`
   原样抄进 `choices.bySlot` 填值（plan 的 `choicesTemplate` 已给每个 key 备好填空骨架）。
   trait/候选池槽填数组（trait key 或池内 UUID，长度等于该条的 `count`）；ASI 槽填
   `{ abilityScore: { dex: 1, con: 1 } }` 浮动加点——种族固定加成（如半精灵魅力+2）
   自动并入，不要重复加；`asi-or-feat` 槽二选一 `{ abilityScore: … }` 或
   `{ feat: "<uuid>" }`；`subclass-uuid` 那条不进 bySlot，仍填顶层 `subclassUuid`
   入参。plan 没列出的 key 会在写入前以 `CHOICE_SLOT_UNKNOWN` 整体拒绝并列出合法槽位。
   专精槽（plan 里带 `mode:"expertise"` 与说明）同此键法：每个值必须是卡面已有熟练、
   或本次调用前面槽位已选的项；把未熟练的 key 填进专精槽会在写入前整体拒绝并点名
   （dnd5e 原生对未熟练目标静默丢弃，工具把这件事提前成显式拒绝；万一仍被丢弃，
   回执 warnings 报 `EXPERTISE_NOT_LANDED`）。镜像规则：普通熟练槽（default 模式）
   不得重复选卡面已熟练或本次调用前面槽位已选的 skills:/tool: 项——dnd5e 对 default
   模式无条件写熟练值 1，重选会把已落的专精（2）踩回 1，工具同样在写入前整体拒绝
   并点名。装备、法术书
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
   含职业特性与种族条目，带 identifier 与 `activities` 活动计数）、createdItems（additionalItems 授予，同带 activities）、preservedItems（既有条目保留计数）、preservation
   （仅 NPC：怪物固有特性族——伤害抗免/状态免疫/感官/体型/语言/生物类型/移动——的
   before/after diff，`changed` 为空即原卡分毫未动，不需要再翻 traits 原文核对）、
   hpFill/slotFill/spellFill
   全在其中，收到 `completed` 即对账完成，不需要任何回读补查；你要核对的字段不在回执里时，
   视为工具缺口，在报告里注明。回执 warnings 的 `TRAIT_GRANT_NOT_LANDED` 是 dnd5e 原生
   静默丢弃的显性化：该 actor 类型在当前系统版本没有对应字段（典型：NPC 卡没有护甲/武器
   熟练字段，怪物挂职业等级后这两族熟练天然落空）——收到即在报告里披露，不要回读数据
   模型求证，也不要手工修补。`partial`/`indeterminate` 按回执指引处理，不重放整批。

## 车卡 / 升级施法职业：法术数量契约

车卡或升级施法职业时优先工具流，不凭记忆推规则数量。发现流程（browse 目录 → plan）
见 `arcane-content-catalog`；写入侧契约：

1. 计划即填写清单：`automaticSteps` 由 `foundry_actor_advance` 自动完成，不手工重复
   添加；`choiceRequirements` 每条带 `key`（抄进 advance `choices.bySlot` 的槽位键）、
   `valueFormat`、`count`/`cap`，只填这些要求。
2. 数量预算：`spellBudget` 是该等级的施法数量契约——`cantrips` 戏法数、`known` 已知
   法术数（2014 诗/术/契/游）、`book` 法术书容量（法师）。选满这个数，不多不少。准备
   施法者（2014 牧师/德鲁伊/圣武士/奇械）没有数量，改发 `fullList`：他们"会"整个职业
   法术列表，建卡时给 advance 传 `fullSpellList:true` 一次授满（领域法术等已有条目按
   来源 UUID 自动去重，高级别自动分批）；`system.prepared` 页签标记留给 DM 和玩家在
   游戏中自行决定，一律不设置。子职业引入的施法（2014 奥法骑士/诡术师）发
   `source:"subclass"` + `known`：环级法术按数选满；戏法不在预算里，走子职业自带的
   选择槽（`subclass:` 前缀槽位）。
3. 候选：法术候选用 `foundry_compendium_browse`（`type:"spell"`，传同一 `classUuid`；
   budget 带 `spellListClassUuid` 时改传它——子职业施法者的列表挂在法师职业上）
   分页列取并带 `eligibility`；戏法传 `maxLevel:0`。环位上限：budget 带 `maxSpellLevel`
   时照传，否则按目标等级的规则知识传 `maxLevel`；总数不背表，以 `spellBudget` 为准。
   budget 的 `note` 是规则提示（如学派限制、固定戏法），遵循但不需验算。`fullList`
   职业的候选已在 `spellBudget.fullList.candidates` 里给全，不必再分页搜。计划带
   `autoGrantedSpells` 时（子职业固定赠法术、种族法术），自选避开清单内的 uuid——
   撞上会被写入去重，白烧一个自选名额。
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

人物图像分布在 `actor.img`、`actor.prototypeToken.texture.src` 和场景中各 Token 的 `texture.src`。启用动态 Token 环时，画面主体还可能来自 `prototypeToken.ring.subject.texture`。默认同图同步，但用户明确只改一个字段时，以用户范围为准。

### 从 arcane-assets 选图

只有新建、复制或用户明确要求图像时才进入本流程。按角色的种族、职业、性别、时代、装备和风格选图，不只按职业名猜一个通用立绘。

1. 读取画库 `index.json`，用 `type/style/attrs/tags/name/name_zh/desc/desc_zh` 过滤少量候选，再按语义选择。只选 `file` 真实存在且以 `.png/.jpg/.jpeg/.webp` 结尾的条目；索引里的原始 `.svg` 不传给 `foundry_image`。
2. 当前世界能读取 `modules/arcane-assets/index.json` 和对应图片时，使用 `dataPath: "modules/arcane-assets/<条目的 file>"`，不重复上传。
3. 否则复用本次任务已解压的画库；没有时调用 `foundry_module_prepare({ query: "arcane-assets" })`。`preparing` 按其 `poll_url` 等待，`ready` 后把 ZIP 下载到本次备团目录的专用子目录，核对返回的 `size` 和 `sha256`，再解压并读取索引。`foundry_module_prepare` 本身不下载或安装；这里不安装、不启用模块，也不修改 Foundry Data。把选中文件的 cwd 相对路径作为 `sourcePath`。
4. 报告实际选择的资源和匹配依据。画库不可用或没有合适图片时，保留已建 Actor 并明确报告“头像未完成”，不退回 dnd5e 默认图，也不重复创建 Actor。

### 应用图片

用户未区分头像和 Token 图时，用 `foundry_image` 一次完成上传和应用：

```js
foundry_image({
  sourcePath: "assets/church-guard.webp",
  targetUuid: "Actor.<id>",
  syncPlacedTokens: true,
})
```

Actor 应用会同时更新 `actor.img` 与原型 Token，启用 ring 时同步 subject texture；`syncPlacedTokens:true` 同步当前世界各场景的 linked/unlinked 存量 Token，保留名称、位置和尺寸。已有模块图片改用 `dataPath` 入参，其余相同。

用户明确只改角色卡头像或只改某一个 Token 图像字段时，先以不带 `targetUuid` 的 `foundry_image` 取得持久 `dataPath`，再用当前运行时的原生 Document API 只更新指定字段。不要把会同步原型 Token 的默认 Actor 应用用于“只换头像”。

返回的持久路径以回执为准，不猜 OSS 地址，不把签名 query 写回文档。核对回执中的 `img`、原型和各 Token 步骤；未覆盖的字段才用 `foundry_actor_get` 补读。上传成功而应用失败时保留 `dataPath` 对账，`partial/indeterminate` 不自动重放。

## 验收

1. 创建、升级和授予以 typed 工具的 verification 回执为准；只有裸 JS 路径才回读对应文档。
2. 图像任务核对实际资源、`actor.img`、原型 Token 和请求范围内的存量 Token；不为验收额外创建场景 Token。
3. 普通修改不调用 `foundry_image`，也不把图像字段塞进更新补丁；明确只改一个图像字段时，回读确认其它图像字段未变。
4. 未完成的头像或其它步骤明确列出，不把部分完成说成全部完成。
