# Owlbear Rodeo 2 调研与 Arcane 设计方向

状态：方向决策。调研日期：2026-09-03。

本文记录 Arcane Desk 将现有 Foundry VTT（下称 FVTT）能力扩展到 Owlbear Rodeo 2
（下称 Owlbear）时的事实基础、能力断层和阶段性设计决策。它不是已经交付的功能说明，文中
action 名和数据结构在进入实现前仍需单独评审。

## 1. 结论

本轮调研形成两项产品决策：

1. **人物抽象和战斗自动化由 Arcane 自研。** Owlbear 官方没有等价于 FVTT `Actor`、
   `Item`、`ActiveEffect`、`Combat` 的 RPG 领域模型，社区扩展之间也没有被普遍采用的
   Actor 数据标准。Arcane 必须拥有稳定的 Actor、Encounter 和规则执行边界，不能把任意
   第三方扩展的私有 metadata 当作产品内核。
2. **P0 只做备团辅助。** 第一阶段先完成角色/NPC/怪物资料的创建、导入、修改、校验，以及
   token 素材和当前 Scene 的布置。实时战斗规则执行、回合推进、效果持续时间和第三方角色卡
   双向同步均不进入 P0。

Owlbear 在本设计中的定位是轻量战场和多人画布；Arcane 补充其缺失的 RPG 数据层和自动化层。

## 2. 为什么 Arcane 在 FVTT 中看起来是“无缝”的

Arcane 当前不是仅靠屏幕坐标操作 FVTT。Desktop 将固定、版本化的 runtime 注入自己控制的
FVTT `/game` 页面，再直接使用页面内已经存在的对象模型。调用链见
[Direct Foundry Runtime](direct-foundry-runtime-mvp.md)。

当前 SDK 的完整 runtime 已包含以下能力：

- 检索、读取、导入、导出和更新世界级 Actor；
- 从 Compendium 创建 Actor、向 Actor 添加 Item、设置人物与 prototype token 图片；
- 从 Actor 的 prototype token 创建 Scene Token，并保留 `actorId`、`actorLink` 等关系；
- 读取 Actor 上的动作、资源、HP、状态和效果；
- 创建 Combat/Combatant、掷先攻、开始战斗和推进回合；
- 读取标准化的 `battleContext` / `turnContext`，执行动作并返回可审计回执；
- 在写操作派发后发生超时、导航或 renderer 中断时返回 `indeterminate`，禁止盲目重试。

完整 action 清单和读写分类见
[Foundry SDK contracts](../../../packages/foundry-sdk/src/contracts.ts)。现阶段对战斗 agent 默认开放的
安全 action 仍只有 `worldInfo`、`battleContext`、`turnContext` 和 `executeTurn`；范围更广的
Actor、Token、Combat 操作用于受控的备团和维护流程。

这种体验成立，是因为 FVTT 提供了连续的领域对象链：

```text
World Actor
  ├── system-defined data
  ├── embedded Items / actions
  ├── ActiveEffects / statuses
  └── prototypeToken
         └── Scene TokenDocument
                └── Combatant
                       └── Combat round / turn
```

FVTT Core 提供 Document 的身份、数据库 CRUD、权限、集合、嵌入文档、Hooks 和迁移机制；
`dnd5e` system 再定义角色、职业、属性、法术、物品和 Activities 的具体 schema；MidiQOL、DAE、
Times Up、socketlib 和 Arcane 自有自动化模块继续补齐命中、伤害、范围、效果过期、跨客户端调用
和特殊能力。当前距离/范围适配已经明确优先调用 MidiQOL，失败时才回退到 FVTT grid，见
[runtime helpers](../../../packages/foundry-sdk/src/runtime-helpers.ts)。

因此，FVTT 中的“无缝”实际是建立在一套受控技术栈之上：

```text
FVTT 13 + dnd5e data model + automation modules + Arcane runtime contract
```

它并不意味着浏览器里任意 VTT 或任意第三方角色卡天然共享这些能力。

## 3. Owlbear 官方 SDK 实际提供什么

Owlbear 官方 SDK 是**扩展 SDK**，主要提供：

- Room、Party、Player、Scene、Viewport 和 Theme 状态；
- Scene Item 的查询、创建、更新、删除和变更监听；
- 图片/Scene 素材的上传和用户选择；
- Action、Context Menu、Tool、Popover、Modal 等扩展 UI；
- extension 之间或不同客户端之间的 Broadcast 消息。

它的画布基础对象是通用 `Item`。地图上的人物 token 只是 `CHARACTER` layer 上的一个
`Image` Item。`Player` 表示进入 Room 的用户，不是人物角色。官方 `Asset` API 管理图片和
Scene 素材，也不提供 RPG Actor。

每个 Scene Item 和 Player 都可以携带自由结构的 `metadata`。官方只要求扩展用反向域名给
metadata key 加命名空间，避免不同扩展撞名；官方不规定 HP、AC、职业、等级、法术、物品或
动作的字段。这是一种扩展存储机制，不是 Actor schema。

Owlbear 扩展的页面运行在 iframe 内，通过 SDK 与宿主通信。SDK 文档暴露的是嵌入扩展使用的
客户端接口；本轮调研没有发现可从外部进程直接控制 Room 的官方 headless/remote API。因此
Arcane 不应假设在 Owlbear 顶层页面注入一段代码就能获得所有第三方 iframe 的内部对象。

## 4. FVTT 有、Owlbear 没有的关键能力

| 能力 | FVTT | Owlbear 官方 | 对 Arcane 的影响 |
| --- | --- | --- | --- |
| 独立于 Scene 的人物实体 | 世界级 `Actor` collection，有稳定 ID 和数据库生命周期 | 无 Actor；只有素材和 Scene Item | 必须自建 Actor repository，不能把 token 当人物真源 |
| Actor 与 Token 关系 | `prototypeToken`、`actorId`、linked/synthetic Actor、ActorDelta | Character token 只是 Image Item | 必须定义 `actorRef`、投影和一 Actor 多 token 语义 |
| 游戏系统 schema | System 为 Actor/Item 定义类型、字段、校验和派生数据 | metadata 完全由扩展自行约定 | 必须自建版本化 schema、校验和迁移 |
| 能力、法术和物品 | Actor 内嵌 `Item`；dnd5e Activities 提供可执行入口 | 无标准 Item/Action/Activity | 必须自建 Actor Item 和 Action 定义 |
| 状态与持续效果 | `ActiveEffect`、statuses、round/turn duration | 无标准效果模型 | 必须自建 condition/effect 生命周期 |
| 战斗实体和回合 | `Combat`、`Combatant`、先攻、round/turn、Hooks | 无官方 Combat/Combatant | 必须自建 Encounter/Combat state 和并发写入规则 |
| 规则执行 | system + module 共同完成掷骰、命中、伤害、豁免、范围和模板 | 官方只提供画布与通用扩展接口 | 必须自建规则引擎和动作执行回执 |
| 内容库 | Compendium 有稳定 document 类型、UUID 和导入语义 | 只有通用图片/Scene Asset；规则内容由扩展或外部服务提供 | 必须自建/导入合法内容目录和来源追踪 |
| 权限和所有权 | Document 级 ownership 和 GM 数据库操作 | Room/Scene/Item 权限，不理解 Actor 字段 | 必须在 Arcane 领域层再次做授权 |
| 扩展互操作 | 模块通常围绕同一 Actor/Item/Combat 对象和 Hooks 工作 | 扩展共享画布和 metadata，但各自定义私有 schema | 不能宣称自动兼容任意 Owlbear 角色卡 |

最重要的断层不是少几个 API，而是 Owlbear 官方刻意没有 RPG domain model。单独补一个
`createToken` 只能解决“地图上出现一张图片”；它不能回答这个 token 对应哪个人物、有哪些法术、
剩余多少资源、能执行什么动作，也不能保证删除 token 后人物仍然存在。

## 5. 社区扩展调研

### 5.1 Forge!

Forge 是目前最接近 Actor/System 抽象的社区产品：

- `Unit` 近似 Actor；
- `System` 组织一组自定义属性；
- Unit Card 和 Unit List 分别承担角色卡和先攻列表；
- Resource、formula 和 dice notation 可表达 HP、法术位和派生值；
- 支持 Unit JSON 导入/导出；
- AI Template 能输出当前 System 的属性字典、metadata key 和示例值，让 AI 生成可导入 JSON。

但 Forge 仍不能作为 Arcane 内核：

- 没有发现公开、版本化的第三方编程接口；现有导入/导出是 UI 工作流；
- 属性由短 BID 标识，导入 System 时 BID 可能重映射，不能硬编码 `HP`、`STR` 等 key；
- 自定义 System、Share ID 和云端 collection 与 Battle-System 账户/服务及等级有关；
- 它是一个功能丰富的扩展，不是 Owlbear 官方或社区共同维护的数据标准。

Forge 适合作为未来可选 adapter。前提是上游提供稳定的 schema discovery、Unit CRUD/change
event 契约，最好通过 Owlbear Broadcast 暴露，而不是让 Arcane 逆向其 metadata。

### 5.2 Game Master's Grimoire（GMG）

GMG 面向 D&D 5e/PF2e，提供 HP、AC、先攻、statblock、法术、有限次数能力、队伍、物品和商店。
仓库采用 MIT 许可证，而且截至调研日仍有提交，因此不能简单归类为废弃项目。

但是它的 token metadata 主要是战斗索引：HP、max HP、AC、initiative、statblock `sheet` 引用、
装备 ID、limited uses、ruleset 和若干显示开关。完整 statblock、物品和跨 Scene 队伍数据有相当
部分依赖 Tabletop Almanac 及其 API Key。仓库也没有正式 GitHub Releases，未提供供其他扩展
消费的稳定入站 API。

因此 GMG 是有用的 GM 工具箱和潜在数据导入源，不是通用 Actor 基础设施。未来若用户需求明确，
Arcane 可以只同步 HP/AC/initiative 等窄字段，或导入用户有权访问的 Tabletop Almanac 内容；
不应直接绑定其内部 metadata 作为人物真源。

### 5.3 Persistent Tokens 和其他角色卡扩展

Persistent Tokens 能跨 Scene 保存 token text、metadata 和 attachments，并能制作 token template。
它能帮助 Arcane metadata 随 token 复制，但不定义人物、动作或规则。其他角色卡扩展则常见以下
形态：

- 把外部角色卡 URL 关联到 token；
- 将角色卡数据保存在浏览器 LocalData 或自己的云服务；
- 为某一个规则系统定义私有 metadata；
- 只处理 HP、先攻、背包或某一个局部功能。

这些扩展可以在用户层面组合使用，但没有共同 Actor contract。兼容其中一个不会自动兼容其他
扩展，两个扩展同时维护 HP/先攻时还可能产生双真源和覆盖冲突。

### 5.4 社区结论

截至 2026-09-03：

- 没有发现 Owlbear 官方 Actor 抽象；
- 没有发现社区事实标准级的 Actor schema；
- Forge 是最值得观察和洽谈协议的通用角色平台；
- GMG 是 D&D/PF2e 场景下的可选窄适配对象；
- Persistent Tokens 可自然保存 Arcane metadata，但不需要成为架构依赖。

## 6. 目标架构

```text
Arcane AgentHost
  -> typed Owlbear actions
  -> Arcane domain services
       ├── ActorRepository        <- 人物真源
       ├── PrepService            <- P0
       ├── EncounterRepository    <- 战斗数据基础，P0 只准备不执行
       └── CombatEngine           <- P1+，不进入 P0
  -> Arcane-owned Owlbear extension/runtime
  -> official @owlbear-rodeo/sdk
  -> Owlbear Room / Scene Items

Optional adapters
  ├── Forge adapter
  └── GMG narrow adapter
```

### 6.1 真源和投影

完整人物必须独立于 Owlbear Scene 存在。P0 默认由 Arcane 的本地 workspace/repository 保存，
提供显式导入导出；token 只是该人物在某个 Scene 中的一次投影。

建议 token metadata 只保存稳定引用、版本和足够的战场摘要，例如：

```json
{
  "com.arcanedesk.actor-ref": {
    "actorId": "actor_01...",
    "revision": 12,
    "systemId": "dnd5e-2014"
  },
  "com.arcanedesk.combat-snapshot": {
    "hp": 27,
    "maxHp": 32,
    "tempHp": 0,
    "ac": 15
  }
}
```

完整 Actor 不默认塞入 token metadata，原因包括：

- token 删除不应删除人物；
- 同一个人物可能出现在多个 Scene，或有多个 token 实例；
- token 复制不能无意复制出第二个人物真源；
- 第三方扩展共享 metadata，需要避免大对象、多方写入和冲突；
- Actor schema 需要独立版本、校验、迁移和内容来源信息。

`combat-snapshot` 是可重建投影，不是第二真源。进入实时战斗设计前，需要再确定 HP 等高频状态
由 Actor、Encounter 还是 token authoritative，并定义多客户端冲突规则。

### 6.2 Arcane Actor 的最低领域边界

P0 不需要一次实现完整规则引擎，但 Actor schema 至少应为后续扩展保留以下边界：

- identity：稳定 ID、名称、类型、system ID、schema version；
- presentation：头像、token 图片、默认尺寸、可见性和标签；
- statistics：属性、HP、AC、速度、感知和其他 system-defined fields；
- resources：法术位、次数、充能等 current/max/reset；
- items：职业能力、法术、武器、装备和来源；
- actions：动作 ID、消耗、目标、范围、掷骰/效果的声明式定义；
- provenance：来源、许可证/用户导入信息和外部引用；
- projection：prototype token 默认值和各 VTT external refs。

通用 envelope 与具体规则系统 schema 分离。Arcane 拥有 envelope、版本和生命周期；
`dnd5e-2014` 等 ruleset adapter 定义具体字段与派生规则。这样“战斗自动化全自研”不等于把所有
系统塞进一个无类型 JSON，也不要求 P0 同时支持所有规则系统。

### 6.3 Owlbear 接入方式

Arcane 应发布自己控制的 Owlbear extension，并在该 iframe/runtime 内调用官方 SDK。Desktop 与
Arcane extension 之间只传递固定、版本化、JSON-safe 的 action；模型不能提交任意脚本。

这延续现有 Foundry SDK 的安全原则：

- 固定 allowlist；
- 读写 action 分级；
- 参数按数据序列化；
- GM/Scene/权限 preflight；
- 写操作使用 request ID、revision/idempotency key；
- 派发后中断返回 `indeterminate`，重新读取状态后才能继续；
- 创建/更新后回读验证。

不把跨域抓取第三方 iframe DOM、模拟点击第三方扩展 UI 或逆向未公开 metadata 作为正式方案。

## 7. P0：备团辅助

### 7.1 目标用户任务

P0 应在只安装 Arcane extension、不安装 Forge/GMG 等第三方扩展时独立完成：

1. 查看当前 Room、Scene、grid 和已有 Character token。
2. 从自然语言或合法数据源创建 NPC/怪物/PC 草稿，例如“创建一个 5 级法师 NPC”。
3. 校验并修改人物属性、资源、能力、法术、物品和 token 默认值。
4. 上传或选择用户提供的 token 图片。
5. 将 Actor 创建为当前 Scene 的 Character token，设置位置、尺寸、名称、可见性和归属。
6. 批量放置、复制、编号和隐藏怪物 token，准备 encounter roster。
7. 保存 Actor 与 Scene 投影关系；切换/删除 token 后 Actor 仍可检索和再次放置。
8. 导入、导出和回读人物数据，报告内容来源和未能结构化的字段。

备团模式沿用现有安全边界：只处理用户有权使用的资料，不代取付费内容，不凭记忆伪造受版权
限制的数据；已有原则见 [Prep Mode](prep-mode-spec.md) 和
[Skill 设计契约](skill-design-contract.md)。

### 7.2 建议 action 面

以下是设计候选，不是已经冻结的公共 API：

```text
Read
  owlbearWorldInfo
  owlbearSceneSnapshot
  actorSearch
  actorGet
  actorValidate
  encounterDraftGet

Write
  actorCreate
  actorImport
  actorUpdate
  actorSetImage
  tokenCreateFromActor
  tokenUpdate
  tokenDuplicate
  tokenDelete
  encounterPrepare
```

`encounterPrepare` 只创建 roster 和 Scene 布置，不开始战斗、不掷先攻、不执行攻击。批量 action
应返回逐项 receipt，并保证失败时能区分未派发、部分完成和状态不确定。

### 7.3 P0 非目标

- 自动攻击、伤害、豁免、治疗和法术结算；
- Combat/round/turn 实时推进；
- concentration、持续时间和 ActiveEffect 等价实现；
- 覆盖、视线、范围模板和复杂移动规则；
- 玩家实时角色卡协作编辑；
- 与任意第三方 Owlbear 角色卡/战斗 tracker 双向同步；
- Forge/GMG 私有 metadata 写入；
- 一开始同时覆盖任意 TTRPG ruleset。

## 8. P0 验收场景

P0 至少用以下端到端场景验收：

1. 一个干净 Owlbear Room，只安装 Arcane extension，没有 Forge、GMG 或 Persistent Tokens。
2. DM 打开一个 Scene，要求 Agent 创建一个指定等级、规则来源明确的 NPC。
3. Agent 生成并校验 Arcane Actor，保存稳定 ID 和 schema version。
4. Agent 上传/选择 token 图，在当前 Scene 指定位置创建 Character Image Item，并写入
   Arcane namespaced metadata。
5. Agent 回读 Scene Item 和 Actor，验证名称、位置、图片、引用和 revision。
6. 删除 Scene token 后，Actor 仍存在且可以在另一个 Scene 重新放置。
7. 同一个创建请求在派发后发生连接中断时不会自动产生重复 Actor/token；系统先回读再处理。
8. 导出后重新导入，Actor 的结构化字段、来源和 external refs 可验证。

## 9. P1 以后：战斗自动化

战斗自动化建立在自有 Actor 之上，至少还需要：

- Encounter/Combatant/round/turn 状态机；
- initiative、资源消耗、condition/effect duration；
- 目标选择、距离、范围、视线和模板适配；
- attack/save/damage/heal 等规则执行 primitive；
- ruleset adapter 和声明式 Action contract；
- 多客户端写入仲裁、GM authority 和断线恢复；
- 类似当前 `battleContext`、`turnContext`、`executeTurn` 的稳定读取和执行回执。

可以复用现有 Foundry SDK 在 action allowlist、上下文裁剪、执行回执和 `indeterminate` 写语义上的
经验，但不能复用 FVTT/dnd5e/MidiQOL 的对象本身。Owlbear 版需要重新实现这些对象背后的领域
行为。

## 10. 第三方兼容策略

第三方兼容遵循“导入/投影，不让渡真源”：

- Arcane 永远保留 canonical Actor；
- 默认只读写 `com.arcanedesk.*` metadata；
- 有稳定、公开、版本化 API 的扩展才进入正式 adapter；
- adapter 必须声明支持的上游版本、映射损失和冲突策略；
- 只有 UI 导入导出的扩展，P0 最多提供文件/剪贴板格式转换，不做隐藏 UI 自动化；
- 同步 HP 等共享状态前必须选定唯一 authoritative owner，避免循环更新。

Forge 若将来提供 System schema discovery、Unit CRUD 和 change events，可成为第一优先 adapter。
GMG 只考虑 HP/AC/initiative 或合法 statblock 导入等窄适配。Persistent Tokens 应能自然保留 Arcane
metadata，但 Arcane 的正确性不依赖它安装。

## 11. 实现前必须回答的问题

1. P0 Actor repository 采用 workspace 文件、App 数据库还是二者组合；备份、迁移和导出语义是什么。
2. Owlbear extension 与 Desktop 的发现、认证、会话绑定和协议升级如何完成。
3. Owlbear metadata、Room/Scene storage 和 Broadcast 的实际配额、rate limit 与离线行为。
4. Actor 高频状态在 P1 中的 authoritative owner，以及多标签页/多客户端冲突解决方式。
5. P0 首个 ruleset 的精确范围；若为 D&D 5e 2014，哪些内容来自 SRD、Arcane 自有数据或用户导入。
6. 一个 Actor 多 token、token duplicate、Scene duplicate 和跨 Room 复制时如何生成/保留 external ref。
7. Owlbear verified extension 对外部本地 Desktop bridge、网络权限和发布形态的限制。

这些问题不改变本文两项方向决策，但会影响 P0 数据格式和交付路径，应在实现 proposal 中冻结。

## 12. 参考资料

### FVTT

- [Foundry VTT v13 API：Document 类型总览](https://foundryvtt.com/api/v13/modules/foundry.documents.html)
- [Foundry VTT v13 API：Actor](https://foundryvtt.com/api/v13/classes/foundry.documents.Actor.html)
- [Foundry VTT v13 API：TokenDocument](https://foundryvtt.com/api/v13/classes/foundry.documents.TokenDocument.html)
- [Foundry VTT v13 API：Combat](https://foundryvtt.com/api/v13/classes/foundry.documents.Combat.html)
- [Foundry VTT v13 API：ActiveEffect](https://foundryvtt.com/api/v13/classes/foundry.documents.ActiveEffect.html)

### Owlbear 官方

- [Owlbear extension API 总览](https://docs.owlbear.rodeo/extensions/apis/)
- [Owlbear Scene Items API](https://docs.owlbear.rodeo/extensions/apis/scene/items/)
- [Owlbear Item 类型](https://docs.owlbear.rodeo/extensions/reference/items/)
- [Owlbear Metadata](https://docs.owlbear.rodeo/extensions/reference/metadata/)
- [Owlbear Assets API](https://docs.owlbear.rodeo/extensions/apis/assets/)
- [Owlbear extension 架构](https://docs.owlbear.rodeo/extensions/getting-started/)

### 社区扩展

- [Forge!](https://extensions.owlbear.rodeo/forge)
- [Game Master's Grimoire 源码](https://github.com/kamejosh/owlbear-hp-tracker)
- [Game Master's Grimoire 使用说明](https://github.com/kamejosh/owlbear-hp-tracker/blob/master/USAGE.md)
- [Persistent Tokens](https://extensions.owlbear.rodeo/persistent-tokens)
