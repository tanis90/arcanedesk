---
name: arcane-content-catalog
description: 在 Foundry 中需要查找职业、子职、法术、特性、装备或来源 UUID 时使用内容 catalog 工具。
---

# Foundry 内容目录

本 skill 只负责发现来源与数量预算，不负责写入 Actor。发现完成后，把来源 UUID 交给
`arcane-actor-update` 执行写入。

- 模糊名称用 `foundry_content_search`：传 `scope`、`documentType`（`Actor`/`Item`/`Scene`）和
  `query`；已知来源包时传 `packIds` 收窄。搜索只定位文档，不证明任何职业合法性。
- 职业成长用 `foundry_content_list`（`type:"classFeature"`）：传 `actorUuid`（已建角色）、
  `classUuid`、目标 `characterLevel`，有子职/种族时再传 `subclassUuid`/`raceUuid`。返回原生
  升级计划：`automaticSteps` 由 advance 自动完成，不要手工重复添加；`choiceRequirements` 每条
  带 `fill`（该值填到 actor_advance 入参的哪个键）、`valueFormat`（取值格式）和 `count`/`cap`；
  `spellBudget` 给出施法职业在该等级的戏法/已知/法术书数量预算；`actorAdvanceArgs` 原样传给
  `foundry_actor_advance`。子职业 Item 自身的授予/选择步骤只有传了 `subclassUuid` 才会枚举
  （slot 带 `subclass:` 前缀）：先不带它拿到计划，定下子职业后带它重调一次。
- 法术/物品候选用 `foundry_content_list` 的 `type:"spell"/"item"/"weapon"`：按名称或
  identifier 匹配，`page`/`pageSize` 分页；`rules` 过滤 2014/2024 包，`maxLevel` 限制法术
  环位（戏法传 0）。传 `classUuid` 时候选带 `eligibility`：`legal` 在该职业法术列表上；
  `auto-grant` 由职业/子职自动授予，不要再手工授予；`name-match` 仅名称命中，授予前自行核实。
- `subclass-uuid` 要求自带 `candidates`（uuid）和 `candidateNames`（名称映射）候选池，已按
  职业与规则版本过滤，直接从池里选；池为空或其它无池要求才用 `foundry_content_search`
  按学派/子职名称定位 UUID，不凭记忆猜。
- 需要完整文档（activities、effects、规则全文）时，用 `fromUuid` 读取该 UUID 的文档；
  保持 UUID 与来源，不用同名条目替换。
- 查询失败时修正参数或报告未解析来源，禁止凭名称或记忆猜测 UUID。
