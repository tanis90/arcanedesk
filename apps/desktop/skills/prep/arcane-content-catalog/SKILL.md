---
name: arcane-content-catalog
description: 在 Foundry 中需要查找职业、子职、种族、法术、特性、装备或来源 UUID 时使用内容发现工具。
---

# Foundry 内容发现

本 skill 只负责发现来源与数量预算，不负责写入 Actor。发现完成后，把来源 UUID 交给
`arcane-actor-update` 执行写入。

## 分工（写死，不要互换）

- `foundry_compendium_browse`：回答"满足条件的候选有哪些"。发现阶段的主工具。
- `foundry_advancement_plan`：回答"这个 actor 拿这个职业到 N 级，native 自动给什么、
  我必须填什么"。是 `foundry_actor_advance` 的唯一计划来源。
- `foundry_content_search`：身份解析兜底——"我知道它叫什么，给我确切 UUID"。仅三个
  合法用途：找世界内预制 actor、找 compendium 怪物（复制源）、browse 查无此物时的兜底。
  禁止用它做条件枚举（那是 browse），禁止用它发现职业/种族/子职业（那是 browse 目录类型）。

## 车卡发现流程：三次拿全

1. `foundry_compendium_browse`（`type:"class"`）：全部职业目录，按 `rules+identifier`
   去重、arcane 模块包优先；2014/2024 双版本各自成行，按用户指定的规则版本选行拿
   `classUuid`。
2. `foundry_compendium_browse`（`type:"race"`）：同理选种族行拿 `raceUuid`。
3. `foundry_advancement_plan`（传 `actorUuid`、`classUuid`、`raceUuid`、目标
   `characterLevel`）：完整升级计划 + 子职业候选池 + `spellBudget`；`raceUuid` 必须
   传——种族侧的选择（语言、技能、工具熟练等）才进 `choiceRequirements`。

`rules` 参数一律不传：目录自然呈现双版本供选行，plan 的规则版本由 `classUuid` 锚定
自动推导。

## advancement_plan 契约

- `automaticSteps` 由 `foundry_actor_advance` 自动完成，不手工重复添加。
- `choiceRequirements` 是唯一的填写清单：每条带 `fill`（填到 advance 入参的哪个键）、
  `valueFormat`、`count`/`cap` 和候选池；只填这些要求，从池里选，不凭记忆。
  `valueFormat:"trait-key"` 的池（技能/工具/语言，含种族侧）已展开为具体 key
  （如 `languages:standard:elvish`）并附本地化 `candidateNames`；`fill` 对应
  `choices.skills`/`choices.tools`/`choices.languages`，照抄池中的 key 即可。
  专精槽（带 `mode:"expertise"` 与 `note`）独立吃 `choices.expertise`：每个值必须是
  卡面已有、或本次调用 choices.skills/choices.tools 里已选的熟练项——先填熟练槽再填
  专精槽，非法值会在写入前整体拒绝并点名。
  多个普通槽位共用一个 choices 键时，`fillAllocation` 给出该键总值与槽位消耗顺序，
  一次填够总数。
- `automaticSteps` 的 `summary` 带具体值：种族 ASI 逐属性列明（如 `str+1, dex+1…`）、
  体型、职业 scale 骰（如 `scale: 2d6`）、HP 公式；种族移动速度在顶层 `race.movement`
  （种族条目直接携带，不走 advancement 步骤）。这些都不需要翻种族/职业原文核对。
- `spellBudget` 是施法数量契约：`cantrips` 戏法数、`known` 已知法术数（2014 诗/术/契/
  游）、`book` 法术书容量（法师），选满这个数。准备施法者（2014 牧师/德鲁伊/圣武士/
  奇械）改发 `fullList`：他们能会的全部法术候选（带 uuid/名称/环位，上限为最高法术位
  环）——这类职业"会"整个职业法术列表，准备是 DM 与玩家游戏时决定的页签标记，工具
  不管理；建卡时给 advance 传 `fullSpellList:true` 一次授满。
- 子职业两次调用约定：先不带 `subclassUuid` 拿计划（`subclass-uuid` 步骤自带
  `candidates`/`candidateNames` 池，按职业与规则版本过滤）；定下后带它重调一次，子职业
  自身的授予/选择步骤（`subclass:` 前缀）才进输出。
- HP 不进 `choiceRequirements`：1 级满骰、后续级固定均值，由 advance 原生完成，
  `automaticSteps` 带信息摘要。HP 不需要选择、不需要验算，advance 回执的
  `hp`/`hpFill` 即终态。NPC（怪物加职业等级）同样走 plan/advance：新增等级用
  怪物体型骰的固定均值（无首级满骰），摘要照常下发。
- `actorAdvanceArgs` 原样传给 `foundry_actor_advance`。

## browse 过滤与 uuids 模式

- 法术/物品发现的首选形态是 `names` 批量解析：把记得的名单一次传给
  `foundry_compendium_browse`（`type:"spell"/"item"`，≤50 个），每个名字独立按单一
  语言名称或 identifier 子串匹配——一条名字只用一种语言，中英不要组合进同一个字符串；
  identifier 匹配忽略标点（`Explorer's Pack` 能命中 identifier `explorers-pack`）。
  `names` 模式不要加 `itemType`：它把候选收窄到单一原生类别，equipment 不含武器，
  会漏掉长剑这类条目。
  逐名返回 `status`：`unique` 直接取 uuid；`ambiguous` 多为 2014/2024 双版本重名，
  加 `rules` 收窄即可；`miss` 才换拼写重试，或转 `query` 分页浏览（`page`/`pageSize`，
  `maxLevel` 限环位、戏法传 0，`itemType` 过滤物品类别）。法术传同一 `classUuid` 时
  候选带 `eligibility`：`legal` 在该职业法术列表上；`auto-grant` 由职业/子职自动授予，
  不要再手工授予；`name-match` 仅名称命中，授予前自行核实。
- uuids 模式（传 `uuids`，≤20 个）：返回完整文档（summary + document）。仅两个用途：
  语义选择（用户要"控场法术"这类理解题）与异常对账（授予不符预期时排查）。发现流程
  不得使用。

查询失败时修正参数或报告未解析来源，禁止凭名称或记忆猜测 UUID。
