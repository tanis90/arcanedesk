# 枭熊 / 弗人 → ArcaneDesk 迁移调研方案

状态：调研方案 v0.1  
日期：2026-11-02  
实现方案：[`xiongxiong-fullpeople-migration-tech-plan.md`](xiongxiong-fullpeople-migration-tech-plan.md)  
范围：只解决「枭熊（Owlbear Rodeo 2）+ 弗人（FullPeople）→ D&D 公用数据」；「公用数据 → ArcaneDesk 世界包」沿用现有能力，不在本文重新设计。

---

## 0. 一句话结论

**第一版不要做枭熊插件，先做「本地转换器 + ArcaneDesk 迁移向导 + Agent Skill」。**

输入是用户在枭熊里主动导出的 **弗人世界包 `.fobr`**（每个场景一个，导出时勾选「包含房间元数据」）以及用户自己房间的 **弗人角色卡 JSON**；输出是 **Foundry dnd5e 5.3.3 的 Actor / Item / Scene 文档 JSON + 素材包**，交给现有世界包管线落成 ArcaneDesk 世界。

P0 覆盖 PC、NPC、物品（含作为物品的职业）、装备、怪物；P1 覆盖地图。目标体验是：DM 在枭熊导出带房间元数据的 `.fobr`（每个场景一个），拖进 ArcaneDesk，预览后一键导入；索引齐全时，角色卡正文和图片由转换器自动抓取、打包，不再逐张手工导出。

---

## 1. 背景与边界

### 1.1 名词

- **枭熊**：Owlbear Rodeo 2.0（`owlbear.rodeo`）的国内叫法，轻量地图/Token VTT。
- **弗人**：GitHub 用户 **FullPeople** 的作品，产品名是 **Full Suite**（全集）或 **Character Cards**（单角色卡模块）。国内玩家通常通过自定义扩展地址安装。
- **D&D 公用数据**：本文定义为 **Foundry VTT dnd5e 5.3.3 的文档 JSON**（Actor / Item / Scene），加一份素材清单。理由见 2.4：只有这套 schema 同时覆盖 PC、NPC、物品、职业和场景；下游世界包管线也吃 Foundry 世界。
- **世界包**：ArcaneDesk / MythicTable 云端可直接打开的战役物料。后半段已有 `arcane-world-import` 等能力，本文不展开。

**谁存了什么（最容易混的一张表）：**

| 数据 | 存在哪 | 谁维护 | 迁移怎么拿 |
|---|---|---|---|
| 房间、场景、Token、地图图片 | 枭熊云端 | Owlbear | 用户导出 `.fobr` / `.ob2` |
| 卡片索引、Token 绑定 | 枭熊 room/scene metadata | 枭熊（弗人插件写入） | `.fobr` 的 scene/room metadata |
| 角色卡正文 `data.json` | FullPeople 服务器 `obr.dnd.center` | FullPeople | 按索引抓取；回退逐卡导出 |
| 怪物 stat block | 枭熊 scene metadata | 弗人插件写入 | `.fobr` 的 `com.bestiary/monsters` |
| `.fobr`、单卡 JSON | DM 电脑 | 用户 / 插件客户端 | 拖入 / 下载 |
| 我们 VTT 的战役、文档、素材 | ArcaneDesk 云端 | 我们 | `mtcompat_*` |

> **再强调一次：枭熊的 `items[]` 是画布物件（地图、Token、墙、灯、迷雾、文字），不是 D&D 的 Actor/Item。** D&D 的 Actor/Item 来自角色卡 `data.json` 和图鉴 stat block。

### 1.2 不在本期

- 不做实时双向同步；迁移是一次性导入。
- 不做战斗自动化补全（攻击、豁免、伤害、效果持续时间）；P0 只保证数据完整和卡面可读。
- 不打包、不分发非 SRD 的规则文本/图片；迁移结果只进用户自己的战役。
- 不做聊天记录、日志、手抄笔记的迁移；P2 再评估。

---

## 2. 调研发现

### 2.1 弗人插件是什么、数据在哪

弗人不是枭熊官方功能，而是一个运行在 Owlbear 房间 iframe 里的扩展套件。公开仓库包括：

- `FullPeople/obr-suite`：Full Suite 主体，GPL-3.0；
- `FullPeople/character-cards`：角色卡模块，PolyForm Noncommercial 1.0.0；
- `FullPeople/bestiary`：怪物图鉴，PolyForm Noncommercial 1.0.0；
- `FullPeople/DND-card-web`：独立车卡网站，自定义非商用许可。

关键事实：

| 数据 | 存在哪 | 格式 | 能否导出 |
|---|---|---|---|
| 角色卡正文 | 作者服务器 `obr.dnd.center/characters/<roomId>/<cardId>/data.json` | JSON，`schema_version: "0.3"` | 卡片界面有「导出 JSON」「仅复制」；服务端 `data.json` **当前源码标明无鉴权**，但未验证长期策略 |
| 角色卡索引 | 枭熊 scene metadata `com.character-cards/list`；跨场景镜像在 room metadata `com.character-cards/list-room` | 数组，元素含 `id/name/url/uploader/uploaded_at` | 随 `.fobr` 的 scene/room metadata 带走；多个文件取并集，单文件不保证全量 |
| Token 与卡片绑定 | token metadata `com.character-cards/boundCardId` | 字符串 | 随 `.fobr` 场景 items 带走 |
| 怪物图鉴 | 场景 metadata `com.bestiary/monsters`，按 slug 存 5etools 风格 stat block；token 上另有 `com.bestiary/slug` | 5etools monster JSON | 随 `.fobr` 场景 metadata 带走 |
| 地图/场景 | 枭熊场景 items | OBR Item JSON | `.fobr` 可打包当前场景；官方 `.ob2` 也可按场景导出 |
| 图片 | OBR 资产库 URL，或 `5e.kiwee.top` 图床 | URL | `.fobr` 默认只存 URL；**是否需登录、是否会过期未验证，按可能需鉴权设计回退** |

> **术语提醒：`.fobr` 的 `items[]` 不是 D&D 的 Actor/Item。** 它是枭熊画布物件（地图、Token、墙、灯、迷雾、文字）；D&D 的 Actor/Item 来自角色卡 `data.json` 和图鉴 stat block，转换器负责把两者映射成 Foundry 文档。

> **证据等级**：`data.json` 无鉴权来自 FullPeople 源码注释（`panel-page.ts`）和一次 404/CORS 探针，**不等于长期授权**；OBR 图片 URL 的公开性来自 `.fobr` 导出器注释，**尚未用真实 URL 验证**。产品必须按「可能需鉴权 / 可能过期」设计回退，不能把无鉴权当成稳定契约。

**卡片怎么寻址：**

- URL 形状：`/characters/<roomId>/<cardId>/data.json`。`roomId` 是枭熊房间 ID，`cardId` 是服务端生成的卡片 ID。
- 客户端不按角色名生成 `cardId`：上传 / `create-from-json` / 刷新后，服务端返回 `CardEntry { id, name, url, ... }`，客户端只使用 `entry.id` / `entry.url`；`name` 只是展示字段。
- `url` 是权威定位；如果只有 `id`，用 roomId + id 拼 `data.json`。
- `cardId` 的格式（UUID / 短随机 / 名字 slug）由服务端决定，客户端代码看不出来；`character-cards-server` 仓库 404/私有，需要真实样本才能确认。
- **不要猜/撞 `cardId`。** 只从用户自己房间的 `com.character-cards/list` / `list-room` 读精确 ID；`.fobr` 勾选房间元数据就会带出来。
- 本地存储：OBR 插件的 `localStorage` 只存面板状态/预览，不存卡片正文；每次打开卡都去服务器拉。独立车卡网站 `DND-card-web` 用 IndexedDB，是另一个产品形态，不等于 OBR 插件本地有副本。
- 探测记录：`/characters/test/test/data.json` 返回 404 + `access-control-allow-origin: *`；`/characters/test/` 返回 403；`/api/character/test/test/data` 返回 405（只允许 PUT/OPTIONS）。这些只能说明不存在的路径没有被 401 挡住，不能证明真实卡无鉴权。

角色卡 JSON 的顶层字段（来自官方示例 [`cc-example-card.json`](https://github.com/FullPeople/obr-suite/blob/main/public/cc-example-card.json)）：

```text
schema_version, meta, identity, classes[], total_level, abilities,
core_stats, defenses, skills[], combat, spellcasting, features,
special_resources[], background, inventory, auto_resources[], exports
```

几个对迁移很有利的点：

- `classes[]` 直接给出职业名、子职名、等级，支持主职 + 兼职；
- `features` 里的职业特性、种族特性、专长都带完整中文描述和等级；
- `spellcasting` 里的法术带环位、学派、施法时间、射程、成分、持续时间、英文名和来源；
- `abilities` 同时有总值、初始值、背景/成长/杂项加值、豁免熟练；
- `skills[]` 带技能名、关联属性、熟练度、总加值；
- `combat.weapons[]` 带攻击加值、伤害、伤害类型、精通、词条；
- `inventory` 有钱币、负重、容器和物品；
- `meta.english` / `ENG_name` / `source` 给英文名和来源，可用于匹配 Arcane 的英文合集条目。

限制：

- 卡片是**扁平数据**，不是 Foundry 的 `advancement` / `activities` 结构；职业特性、法术、武器都只有文本和数值，没有可执行的动作定义。
- 角色卡没有独立的「NPC 类型」；NPC 要么是用户拿角色卡当 NPC 用，要么是图鉴怪物绑定到 token。
- 作者服务器 `character-cards-server` 未公开；`data.json` 端点当前无鉴权是代码事实，不是授权承诺。
- 许可证是 NonCommercial / GPL-3.0；商业产品不能直接复制或改其代码，只能做 clean-room 的格式互操作，并建议先与作者沟通。

### 2.2 枭熊平台能导出什么

- **没有房间级 / 战役级一键导出**。官方只有按场景/图片的 **Manage Storage → Export**，得到 `.ob2`；以及扩展 SDK 的当前场景读取能力。
- **弗人世界包 `.fobr`** 是更实用的场景包：文件头 `FOBR1` + uint32 长度 + gzip JSON，内容包含：
  - `items[]`：当前场景全部 OBR Item（地图、Token、墙、灯光、迷雾、绘制、文字……），位置/缩放/旋转/metadata 原样保留；
  - `sceneMetadata`：套件状态、传送门、`com.bestiary/monsters` 等；
  - `roomMetadata`：可选，勾选后包含 `com.character-cards/list-room` 等跨场景数据；
  - `images{}`：默认不嵌入，item 里保留原始 OBR 图床 URL。
- **SDK 能力**：`OBR.room.getMetadata()`、`OBR.scene.items.getItems()`、`OBR.assets.downloadScenes()`；但没有「枚举全部场景/资产库」的 API，所以即使写扩展，也不能真正静默地一键导出整个战役。
- **图片**：`.fobr` 里的 URL 通常指向 OBR 图床；转换器需要下载并打包，不能假设 URL 永久有效。
- **嵌入限制**：`www.owlbear.rodeo` 返回 `X-Frame-Options: SAMEORIGIN`，普通 iframe 嵌不进去；桌面端要用 Electron `WebContentsView` 这类顶层视图。页面还在 Cloudflare 后面，登录挑战要在目标机器实测；失败就退回系统浏览器 + 拖入文件。

### 2.3 有没有现成迁移工具

截至调研日，**没有公开的「枭熊/弗人 → Foundry VTT」迁移工具**。最接近的可复用资产：

- `ddb-importer`（MIT）：D&D Beyond → Foundry dnd5e，按实体 Parser 生成 Actor/Item，可参考其字段映射和 compendium 匹配；
- `R20Converter` / `R20Exporter`：Roll20 导出 + 整世界转换，可参考「浏览器导出 → 本地转换」的产品形态；
- `scene-importer`（Owlbear 扩展）：反向的 Foundry/UVTT → Owlbear，可参考场景坐标/墙/灯转换；
- 内部已有 `apps/desktop/docs/owlbear-rodeo-research-and-design.md`（分支 `codex/owlbear-research-design`），结论是枭熊没有 Actor 抽象、不能把第三方 metadata 当产品内核；本方案与之一致：**只消费用户主动导出的文件，不抓 iframe DOM、不模拟点击、不读未公开 metadata。**

### 2.4 目标格式为什么选 Foundry dnd5e

| 格式 | PC | NPC/怪物 | 物品/法术/职业 | 地图/场景 | 结论 |
|---|---|---|---|---|---|
| Foundry dnd5e JSON | ✅ | ✅ | ✅ | ✅ | 下游是 Foundry 时唯一 1:1 |
| 5etools JSON | ⚠️ 无完整角色卡 | ✅ | ✅ | ❌ | 适合做怪物/物品内容源 |
| Open5e API | ❌ | ✅ SRD | ✅ SRD | ❌ | 适合 SRD 批量内容 |
| D&D Beyond JSON | ✅ | ⚠️ 靠 importer | ⚠️ 靠 importer | ❌ | 只覆盖 PC |

Foundry dnd5e 5.3.3 的关键结构（决定转换器怎么写）：

- 角色总等级由所有 `class` Item 的 `system.levels` 求和，**没有 `details.class`**；
- `details.race`、`details.background`、`details.originalClass` 必须是 Actor 内嵌 Item 的 `_id`，不是 UUID；
- 职业是 Item；职业特性通过 `advancement` 的 `ItemGrant` UUID 授予。迁移时如果不想依赖合集，最稳的是**把职业、种族、背景、特性、法术、武器全部内嵌**，`advancement` 留空；
- 怪物特性/动作放在内嵌 `feat` / `weapon` Items，不放 `system` 数组；
- `activities` 为空时卡面可读，但攻击/伤害不会自动掷；P0 不补，P1 再用英文名匹配合集补；
- `_stats` 写 `coreVersion: "13.351"`、`systemId: "dnd5e"`、`systemVersion: "5.3.3"`，避免被当成旧版迁移。

---

## 3. 产品形态：脚本是内核，Skill 是入口，插件是以后

| 方案 | 用户体验 | 开发成本 | 依赖/风险 | 建议 |
|---|---|---|---|---|
| A. 本地转换器 + 迁移向导 + Agent Skill | 导出 `.fobr` → 拖入 → 预览 → 导入 | 中 | 依赖弗人文件格式；无浏览器权限问题 | **第一版做这个** |
| B. 枭熊扩展（Arcane Bridge） | 房间内点「导出到 Arcane」 | 高 | OBR 扩展分发/审核/权限；仍不能枚举全部场景；要维护 SDK 兼容 | P2 可选加速器 |
| C. 与 FullPeople 合作 | 作者加「导出整个房间/导出为 Foundry」或稳定 API | 低（若作者愿意） | 依赖作者排期 | **并行推进** |
| D. 纯 Agent Skill（不让用户装任何东西） | 对话式指导 + 手工导出 | 低 | 无法解析二进制/批量抓取，体验一般 | 作为 A 的入口，不单独做 |

**为什么第一版不做插件：**

1. `.fobr` 已经是弗人用户现成的「世界包」导出，覆盖场景 items + 可选房间元数据，正好是迁移需要的输入；
2. 枭熊没有全场景枚举 API，插件也只能让用户逐个场景导出，省不了最关键的那一步；
3. 插件要处理 OBR 扩展分发、iframe 权限、SDK 版本漂移，投入产出比低；
4. 内部设计原则明确不把第三方 iframe/metadata 当正式接口；消费用户主动导出的文件更稳。

**建议的最终形态：**

```text
ArcaneDesk「从枭熊迁移」向导
  └── Agent Skill：arcane-xiongxiong-import
        └── Node 转换器：xiongxiong-import.mjs
              ├── 解析 .fobr（gzip JSON）
              ├── 读取房间元数据里的卡片索引
              ├── 抓取用户自己房间的 data.json
              ├── 下载图片、去重、打包
              ├── 映射为 Foundry dnd5e 5.3.3 JSON
              └── 输出迁移报告（覆盖率/缺失/警告）
        └── 交给现有世界包管线落成战役
```

---

## 4. 推荐方案

### 4.1 用户体验（目标路径）

**第一步：在枭熊导出**

1. 确认房间已安装/启用 Full Suite（弗人）。
2. 打开「设置 → 世界包（.fobr）」。
3. 打开「包含房间元数据（人物卡 / 套件设置等）」。
4. 点「导出 .fobr」，每个场景导出一次；第一个文件带房间元数据即可。
5. 如果用户用的只是 Character Cards 单模块，没有 `.fobr`：退化为「每张卡导出 JSON」+「官方 Manage Storage 导出 `.ob2`」。

**第二步：拖进 ArcaneDesk**

- 支持多选 `.fobr`、卡片 JSON、`.ob2`，也支持一个文件夹。
- 自动识别：PC 卡、NPC 卡、怪物、物品、场景、素材。
- 预览页显示：将导入多少 Actor / Item / Scene、哪些字段缺失、哪些图片下载失败、规则版本是 2014 还是 2024。

**第三步：一键导入**

- 默认新建战役；用户明确点名才并入既有战役。
- 导入完成后给一份报告：成功数、跳过数、缺失字段、需要人工复核的条目。

### 4.2 输入契约

转换器只认三类输入，按优先级：

1. **`.fobr`（首选）**：一个场景一个文件。卡片索引可能在 `sceneMetadata["com.character-cards/list"]`，也可能在 `roomMetadata["com.character-cards/list-room"]`；转换器对多个 `.fobr` 取并集。单文件不保证覆盖所有卡，最稳的是把每个场景都导出，或补逐卡 JSON。
2. **弗人卡片 JSON（回退）**：用户在卡片界面「导出 JSON」得到的 `data.json`；可多选。
3. **`.ob2`（官方回退）**：没有 Full Suite 时，用枭熊官方场景导出；解析 ZIP 里的 `manifest.json` + `assets/docs/scenes/<id>.json` + 图片。

转换器不直接访问枭熊页面、不读 iframe、不调用未公开 API；只读用户给的文件和用户自己房间的 `data.json`。`.fobr` 提供的是「场景布局 + 卡片索引 + 怪物 stat block」，不是角色卡正文；正文要按索引去取 `data.json`。

### 4.3 输出契约

建议输出一个「迁移包」目录，而不是直接生成 LevelDB：

```text
out/
├── manifest.json          # 来源、版本、规则档、房间/场景、计数、哈希
├── foundry/
│   ├── actors/*.json      # Foundry dnd5e Actor（内嵌 items/effects）
│   ├── items/*.json       # 需要独立存在的职业/法术/装备（可选）
│   ├── scenes/*.json      # Foundry Scene（P1）
│   └── folders/*.json     # 可选
├── assets/
│   ├── portraits/ tokens/ maps/ items/
└── report.json            # 字段覆盖率、未映射字段、缺失素材、警告
```

`manifest.json` 至少包含：

```json
{
  "schemaVersion": "arcanedesk.migration/1",
  "source": {
    "kind": "xiongxiong-fullpeople",
    "fobrVersion": 1,
    "cardSchema": "0.3",
    "exportedAt": "2026-11-02T00:00:00Z",
    "roomId": "...",
    "scenes": ["..."]
  },
  "ruleset": "2014",
  "counts": { "actors": 0, "items": 0, "scenes": 0, "assets": 0 },
  "warnings": []
}
```

**与下游的接口**：现有 `arcane-world-import` 吃的是 Foundry 世界目录/zip（LevelDB），不是裸 JSON。所以这里有一个必须确认的决策点：

- 如果下游已经有「JSON → 世界包」的打包器：直接把上面的目录交给它；
- 如果下游只吃 world zip：在转换器后面加一个 `--pack-world` 步骤，用本地 Foundry 实例或 `classic-level` 写入器把 JSON 落成世界，再走现有导入；
- **不要**在 P0 手写 LevelDB；这是最容易埋坑的地方。

### 4.4 角色映射（PC / NPC）

| 弗人字段 | Foundry dnd5e 目标 | 说明 |
|---|---|---|
| `identity.character_name` / `display_name` | `Actor.name` | 两个名字都保留到 `flags.xiongxiong.identity` |
| `identity.race.name` / `subrace` | 内嵌 `race` Item；`system.details.race` = Item `_id` | 种族特性放 `features.race_features` |
| `background.background_name` | 内嵌 `background` Item；`system.details.background` = `_id` | 背景故事写 `system.details.biography.value` |
| `identity.alignment` | `system.details.alignment` | 保留原文 |
| `identity.languages` | `system.traits.languages.value` + `custom` | 中文→语言 key；未知进 `custom` |
| `classes[]` | 每个职业一个内嵌 `class` Item | `system.levels` 是该职业等级；总等级自动求和 |
| `classes[].subclass` | 内嵌 `subclass` Item | `classIdentifier` 指向职业；无 advancement |
| `abilities.*.total` | `system.abilities.<key>.value` | `save.proficient` → `proficient: 1` |
| `abilities.*.save.bonus/misc` | `system.abilities.<key>.bonuses.save` | 保留自定义加值 |
| `skills[]` | `system.skills.<key>.value` + `bonuses.check` | 中文技能名→key；未知进 `flags` |
| `core_stats.ac` | `system.attributes.ac.flat` + `calc` | 保真优先，不重算 |
| `core_stats.hp` | `system.attributes.hp.value/max/temp` | 直接写 |
| `core_stats.initiative` | `system.attributes.init.bonus` | 字符串 |
| `core_stats.speed` | `system.attributes.movement.walk` | 尺 |
| `core_stats.size` | `system.traits.size` | 中型→`med` 等 |
| `defenses.*` | `system.traits.dr/di/dv` + `flags` | 中文伤害类型→key |
| `combat.armor` / `shield` | `equipment` Item | `system.armor.value` / `dex` / `equipped` |
| `combat.weapons[]` | `weapon` Item | 伤害、词条、精通、攻击加值；攻击加值可进 `flags` |
| `combat.other_equipment[]` | `equipment` / `loot` | 有甲值走 equipment，否则 loot |
| `spellcasting.spellcasting_ability` | `system.attributes.spellcasting` | 中文→`cha` 等 |
| `spellcasting.spell_slots` | `system.spells.spellN.value/max` | 1–9 环 |
| `spellcasting.cantrips_known/prepared/always_known` | 内嵌 `spell` Item | 环位、学派、施法时间、射程、成分、持续时间、描述 |
| `features.class_features/race_features/feats/...` | 内嵌 `feat` Item | `system.type.value` 按来源分 `class`/`race`/`feat` |
| `special_resources[]` | `system.resources` 或 `flags.xiongxiong.resources` | 优先保留原文 |
| `inventory.currency.wallet` | `system.currency` | `pp/gp/ep/sp/cp` |
| `inventory.items/wondrous_items/consumables/containers[].items` | 内嵌 Item | 武器/护甲/消耗品/容器/杂物；P0 先拍平容器 |
| `exports.dice_bot` | 不导入 | 保留到 `flags` 供追溯 |

**PC / NPC 判定**：默认 `identity.player` 非空 → PC；为空 → NPC。预览页允许用户改。NPC 如果是图鉴怪物，走 4.5。

### 4.5 怪物映射（NPC Actor）

怪物数据来自 `.fobr` 的 `sceneMetadata["com.bestiary/monsters"]`（slug → 5etools monster JSON），token 上的 `com.bestiary/slug` 负责关联。

| 5etools 字段 | Foundry NPC 目标 |
|---|---|
| `name` / `ENG_name` | `Actor.name`；英文名进 `flags` |
| `size[]` | `system.traits.size` |
| `type` / `type.tags` | `system.details.type.value/subtype` |
| `ac[]` | `system.attributes.ac.flat`（取第一个数值；其余进 `flags`） |
| `hp.average` / `hp.formula` | `system.attributes.hp.max/value` / `formula` |
| `speed` | `system.attributes.movement` |
| `str/dex/con/int/wis/cha` | `system.abilities.*.value` |
| `save` | `system.abilities.*.proficient` + `bonuses.save` |
| `skill` | `system.skills.*.value` |
| `senses` / `passive` | `system.attributes.senses.ranges` + `special` |
| `languages` | `system.traits.languages` |
| `cr` | `system.details.cr`（小数） |
| `damageResist/Immune/Vulnerable` | `system.traits.dr/di/dv` |
| `conditionImmune` | `system.traits.ci` |
| `trait[]` | 内嵌 `feat` Item，`system.type.value = "monster"`，`properties: ["trait"]` |
| `action[]` / `reaction[]` / `legendary[]` / `mythic[]` / `lair[]` | 内嵌 `feat` / `weapon` Item；P0 保留文本，P1 补 activities |
| `spellcasting[]` | `feat` Item + `system.attributes.spellcasting`；法术能内嵌就内嵌 |
| `tokenUrl` | `prototypeToken.texture.src`；下载图片 |
| 其他未知字段 | `flags.xiongxiong.raw` |

**降级策略**：如果 token 只有 HP/AC/名称，没有 `com.bestiary/monsters`，就创建一个最小 NPC，把 HP/AC/名称写进去，其余字段标 `needsReview`；不要因为缺 stat block 就丢弃怪物。

### 4.6 物品映射

| 弗人来源 | Foundry Item 类型 | 说明 |
|---|---|---|
| `combat.weapons[]` | `weapon` | 伤害、伤害类型、精通、词条、重量、熟练 |
| `combat.armor` / `shield` | `equipment` | `armor.value`、`armor.dex`、`equipped` |
| `inventory.items[]` | `weapon` / `equipment` / `consumable` / `loot` / `tool` | 按名称/字段猜测；猜不出走 `loot` |
| `inventory.wondrous_items[]` | `equipment` / `loot` | 有甲值/词条走 equipment，否则 loot |
| `inventory.consumables[]` | `consumable` | 数量、使用次数 |
| `inventory.containers[].items[]` | `container` + 子 Item | P0 拍平，容器名进 `flags`；P1 做嵌套 |
| `spellcasting.*` | `spell` | 见 4.4 |
| `features.*` | `feat` | 见 4.4 |
| `classes[]` | `class` | 职业就是 Item |
| 只有名字、没有描述的条目 | `loot` | 保留名称/数量，标 `needsReview`，不丢 |

**原则：宁可生成一个信息不全但可编辑的 Item，也不要静默丢弃。** 所有未识别字段进 `flags.xiongxiong.raw`，报告里列出。

### 4.7 职业 / 特性 / 法术的策略

弗人给的是**扁平文本**，不是 Foundry 的 advancement/activities。P0 分两步：

1. **先保住数据**：职业 Item + 所有职业特性作为 `feat` Item 内嵌；法术作为 `spell` Item 内嵌；`advancement: []`、`activities: {}`。
2. **再补自动化（P1）**：用 `meta.english` / `ENG_name` / `source` 去匹配 Arcane 的英文合集条目（2014/2024 对应包），命中就拷贝 `activities` / `advancement` / `effects`；没命中就保留文本，报告里标「可自动化但未匹配」。

这样 P0 不会因为 UUID 断链导致职业特性丢失，也不会承诺做不到的全自动。

### 4.8 地图 / 场景映射（P1）

`.fobr` 的 `items[]` 就是当前场景的全部 OBR Item。转换器按 layer/type 分类：

- `MAP` + `IMAGE`：场景背景图；
- `CHARACTER` + `IMAGE`：Token；
- `WALL` / `LIGHT` / `FOG` / `DRAWING` / `NOTE`：墙、灯、迷雾、绘制、文字。

初始坐标公式（需用真实场景校准）：

```text
设 OBR 地图图块左上 L、图内网格偏移 o、图块缩放 s、网格 DPI D；
平移 T = -(L + o * s)

Foundry:
  grid.size = D
  grid.distance = 5
  grid.units = "ft"
  background.offsetX = -o.x * s.x
  background.offsetY = -o.y * s.y
  token.x = (token.center.x + T.x) - token.widthPx / 2
  token.y = (token.center.y + T.y) - token.heightPx / 2
  token.width = token.image.width * token.scale.x / D
  token.height = token.image.height * token.scale.y / D
```

P1 先做「背景图 + 网格 + Token 位置/旋转/缩放/可见性」；墙/灯/迷雾放 P2，因为语义不是一一对应，硬转会制造「看起来像但跑起来不对」的假保真。

### 4.9 保真度矩阵

| 数据 | P0/P1 保真度 | 说明 |
|---|---|---|
| PC 六维/豁免/技能/HP/AC/速度 | 高 | 数值直接映射 |
| PC 职业/子职/等级 | 高 | 职业 Item + 总等级 |
| PC 职业特性/种族特性/专长 | 高（文本） | 描述完整；无 advancement |
| PC 法术 | 高（文本） | 环位/学派/射程/成分/持续时间保留；无 activities |
| PC 装备/武器/护甲/钱币 | 高（数据） | 伤害/AC/词条保留；攻击加值进 flags |
| NPC/怪物 stat block | 高（文本） | 5etools 字段齐全时接近 1:1 |
| 怪物动作自动化 | 低 | P1 再补 activities |
| 地图背景/网格/Token | 高 | 需要坐标校准 |
| 墙/灯/迷雾 | 中/低 | P2；语义差异大 |
| 日志/笔记 | 低 | 不在本期 |

### 4.10 用户动线（推荐）

不要把动线拆成「先导出一个 zip」和「再把 zip 解压进 FVTT」两个独立任务。对用户来说，这是一次**迁移会话**；zip 只是内部临时产物。

```text
[聊天] 用户：把枭熊里的《XX》团迁过来
  ↓
[右屏：枭熊] 用户登录 → 打开房间
  ↓ Agent 引导：弗人设置 → 世界包 → 勾选「包含房间元数据」→ 导出 .fobr（每个场景一次）
[App] 监听下载 → 收到 .fobr → 显示「已采集 3/8 场景」
  ↓
[App] 解包 + 抓卡 + 下图片 → 预览「4 个 PC / 2 个 NPC / 12 个怪物 / 3 张地图」
  ↓ 用户确认
[目标选择] 新建 ArcaneDesk 战役 / 并入当前 FVTT 世界
  ↓
[执行] 世界包管线 / Foundry API 或 Adventure 导入
  ↓
[报告] 成功数、跳过数、缺失字段、需人工复核项
```

几个关键点：

- **用户不需要看见 zip**。转换器内部生成迁移包；只有用户主动点「导出迁移包」时才给文件，用于备份、换机或排障。
- **不是两次命令，而是一个有检查点的会话**。Agent 维护 `migrationSession`：已采集哪些场景、解析出多少 Actor、目标是谁、哪些字段缺失。用户中途去开会，回来说「继续」也能接上。
- **右屏枭熊是可选加速器，不是前置条件**。v1 可以先让用户在系统浏览器里导出 `.fobr`，再拖进 ArcaneDesk；v1.5 再把枭熊嵌进右屏并拦截下载。两条路的后续流程完全一样。
- **嵌入用 `WebContentsView`，不要用 iframe**。枭熊返回 `X-Frame-Options: SAMEORIGIN`，iframe 嵌不进去；Electron 的 `WebContentsView` 是顶层视图，不受这个头限制，但 Cloudflare 登录挑战需要在目标机器上实测。若嵌不进去，自动退回系统浏览器 + 拖入。
- **下载拦截**：Electron `session.on("will-download")` 监听 `.fobr` / `.json`，落到临时目录并通知 Agent；不要用 DOM 点击去触发导出。

### 4.11 目标世界的两种落法

| 目标 | 做法 | 是否需要 FVTT 登录 | 主要风险 |
|---|---|---|---|
| 新建 ArcaneDesk 战役 | 转换器 → 世界包 → 现有世界包管线 | 否 | 最低；推荐默认 |
| 并入现有 FVTT 世界 | 转换器 → Adventure / module 包 → Foundry 原生导入或页面 API | 是（GM） | 纯追加不去重、ID 冲突、权限 |
| 新建本地 FVTT 世界 | 转换器 → world pack → 打开 | 是 | 需要生成 LevelDB/world，成本最高 |

**不要直接往 `Data/worlds/<id>/data/*.db` 里写 JSON 文件。** Foundry 运行时持有 LevelDB，外部写入会被覆盖或损坏；正确做法是：

1. **新世界**：走现有世界包管线，或离线生成 world 后再打开；
2. **既有世界**：先生成 Foundry **Adventure**（或带 Adventure pack 的 module），用 Foundry 原生「导入 Adventure」；或通过受控页面 runtime 调 `Actor.createDocuments` / `Item.createDocuments` / `Scene.createDocuments`，带幂等键和回执；
3. **合并**：默认「新建」最安全；用户明确要并入时，计划里必须写明「纯追加、不去重、重复导入会产生重复文档」。

**分阶段建议**：

- **v1**：系统浏览器导出 `.fobr` + 拖入 ArcaneDesk；默认目标「新建 ArcaneDesk 战役」；不嵌枭熊、不碰 FVTT 登录。
- **v1.5**：右屏增加「枭熊」surface（`WebContentsView` + 独立 session + 下载拦截）；仍默认新建战役。
- **v2**：支持并入既有 FVTT 世界（Adventure/module + 页面 API），并补地图场景。

### 4.12 世界落地：不要让模型直接写 LevelDB

这是本方案最重要的架构决策。

**LevelDB 编码本身是可规则表达的**：键语法、嵌入文档、ID、版本号都能写成确定性代码。但「可规则表达」不等于「应该自己写」：

- 仓库已有 LevelDB **读**层（`import-core.mjs`）和世界**打包**器（`pack-world.mjs`），但没有写层；新增写层是 2–4 周的一次性成本 + 每次 Foundry/dnd5e 升级的持续维护成本。
- 写层要正确处理 `!actors!<id>`、`!actors.items!<actorId>.<itemId>`、`!scenes.tokens!<sceneId>.<tokenId>`、effects 三层嵌入、父文档只存子 ID、`world.json` 版本、folder/ownership/sort 等；任何一处错了，Foundry 可能在启动时才报错或静默迁移。
- 最致命的是**验证延迟**：LevelDB 是二进制，模型很难在写入过程中逐条读回并确认；等整包做完再打开 Foundry，错误定位和回滚成本都很高。

**推荐：把 Foundry 当编译器/校验器，而不是把 LevelDB 当源格式。**

| 路径 | 做法 | 验证粒度 | 成本/风险 | 建议 |
|---|---|---|---|---|
| A. Foundry 编译器 | 起一个空白 dnd5e 世界 → 通过 Document API 逐条创建 Actor/Item/Scene → 每条读回 `toObject()` 对比 + `validate()` → 最后关闭 Foundry、打包世界 zip | 单文档 | 低；1–2 周 | **P0 首选** |
| B. Adventure/module 导入 | 转换成 Adventure pack → Foundry 原生「导入 Adventure」→ 按 `flags.xiongxiong.sourceId` 逐条核对 | 批量 | 中；3–5 天 | **并入既有世界首选** |
| C. 直接写 LevelDB | 自己用 `classic-level` 写键值 | 整包 | 高；2–4 周 + 持续维护 | 只在没有 Foundry 运行时的离线场景用 |

**规则化边界：**

- **完全规则化**：字段映射、枚举转换（技能/学派/词条/体型）、ID 生成、嵌入 Item 结构、素材路径、`_stats` 版本、幂等键。
- **规则 + 模型兜底**：中文→英文名匹配、职业特性 vs 专长、物品类型猜测、容器拍平、AC/HP 派生、法术/攻击的 activities 补全。
- **必须人工复核**：homebrew 职业/法术、无法匹配的英文名、只有名字没有描述的物品、地图网格异常。

**逐条验证循环：**

```text
对每个 Actor/Item/Scene：
  1. 用 sourceId 查重（flags.xiongxiong.sourceId）
  2. 不存在 → create；已存在 → 跳过或按计划更新
  3. 读回 toObject()，归一化后与源数据对比
  4. 调 Document.validate() / dnd5e DataModel 校验
  5. 通过 → 记 receipt；失败 → 只删这一条，修正后重试
  6. 全部完成 → 抽样打开卡面/场景，再打包
```

这样模型在每一步都能看到「创建前/创建后/差异」，错了只回滚一条文档，不需要重建整个世界。**P0 的输出契约因此定为 Foundry 文档 JSON；`--build-world` 是可选的后置步骤，由 Foundry 生成 LevelDB，不由转换器手写。**

### 4.13 目标是 ArcaneDesk 自己的 VTT 时的动线

如果最终目标是自己的 VTT 战役，**FVTT 不应该出现在用户动线里**；它最多是后台的「world zip 编译器」，用户不需要打开或登录 FVTT。

推荐动线：

```text
右屏：ArcaneDesk VTT / MT Compat 面板
  用户登录（或已有会话）
  ↓
左屏 Chat：用户说「把枭熊这个团迁过来，新建一个战役」
  或「我已经登进去了，帮我创建吧」
  ↓
Agent：mtcompat_session_status 检查登录与面板
  未登录 → 请用户在右屏登录，登录后重新检查；不要问账号密码
  ↓
Agent：读取迁移包（没有就引导导出/拖入 .fobr）
  → 预览 PC/NPC/物品/怪物/场景、素材、缺失字段
  ↓
Agent：一份计划（战役名、规则档、数量、素材、缺失、新建还是并入）
  ↓ 用户一句「可以/继续」
Agent：mtcompat_import_prepare → 展示计划 → mtcompat_import_apply
  如果管线只吃 world zip：后台用本地 Foundry 空白世界建文档、逐条校验、打包
  用户看不到 FVTT，也不需要 FVTT 账号
  ↓
报告：战役链接、文档数、素材数、跳过/缺失、需复核项
```

**新建还是并入：**

- **推荐新建**：`mtcompat_import_prepare` 传 `newName`，由工具决定「本人 + 同规则系统同名战役复用，否则新建」；跨规则系统会被拒绝。
- **用户先建了空战役**：传 `campaignId` + `readRef`；计划里必须写明「纯追加、不去重、重复导入会产生重复文档」。
- 不需要用户先手动建战役；用户说「帮我创建」时，Agent 直接走新建路径即可。

**交互预算：一次审批。** 计划讲清楚「迁什么、去哪儿、新建还是并入、多少内容、哪些缺失」；用户放行后直接执行，不再逐步确认。登录属于账户边界，不是提问：让用户在右屏自己登录，Agent 只检查 `mtcompat_session_status`。

### 4.14 登录态与请求边界

确实需要两边的登录态，但它们是**两种不同的东西**，不能混：

| 登录态 | 谁需要 | 用来做什么 | Agent 是否需要拿到 |
|---|---|---|---|
| 枭熊 / 弗人 | 用户 | 打开房间、点「导出 .fobr」、必要时逐卡导出 JSON | 不需要。`.fobr` 是用户导出的文件，转换器只读文件 |
| 弗人卡片服务 | 当前源码标明无鉴权，但不能假设长期如此 | 抓 `data.json` | 先试 Node；401/403 则页面内 `fetch` 或逐卡导出，不把 cookie 交给 Node/模型 |
| 我们自己的 VTT | 用户 + Agent | 新建/复用战役、写文档、传素材 | Agent 通过已登录的 MT Compat 面板 transport 操作，不自己拿 token |
| 本地 Foundry（可选） | 后台 builder | 把文档 JSON 编译成 world zip | 由 App 管理，不需要用户登录 FVTT |

**请求边界：**

- **`.fobr` 解析、JSON 映射**：Node 本地做，无网络鉴权问题。
- **图片下载**：`.fobr` 里是 OBR 资产 URL，**可能是公开 CDN、能力 URL（不可猜但无登录）或签名 URL，目前未验证**。Node 先试 `fetch`；遇到 401/403/过期，就在用户已登录的页面内 `fetch` 后经 IPC 交回 App，或让用户手动另存，**不要把 session cookie 抽出来传给 Node 或模型**。失败不阻断导入，保留原 URL 并报告。
- **弗人卡片 `data.json`**：当前源码标明无鉴权，Node 可以先试；但这不是授权承诺，必须按 401/403 回退到页面内 `fetch` 或逐卡导出。**不要把 session cookie 抽出来传给 Node 或模型。**
- **我们自己的 VTT**：所有管理/上传/写入都走已登录的 MT Compat 面板 / 现有 `mtcompat_*` 工具，主进程不直连后端、不复制 token。这是现有 skill 的硬边界。
- **两套 session 隔离**：Electron 用不同的 session partition（例如 `persist:owlbear` / `persist:mtcompat`），不共享 cookie；Agent 只检查「是否已登录/是否就绪」，不读取密码或 token。
- **授权边界**：只处理用户自己房间、从该房间导出的 `.fobr` 所引用的卡片和素材；不跨房间枚举、不爬取、不批量抓别人的卡。即使端点当前无鉴权，也不等于可以越界读取。

**右屏切换：**

- Agent 可以请求切换 surface，但应该是显式的：「我现在把右屏切到枭熊，你登录后导出；导出完告诉我，我再切回 VTT。」
- 不要在用户正在操作 VTT 时静默切走；surface 切换要有可见提示。
- v1 可以完全不嵌枭熊：用户在自己浏览器里导出 `.fobr`，拖进 ArcaneDesk；这样只需要我们 VTT 的登录态，少一套 session 编排。
- v1.5 再增加右屏枭熊 surface 和下载拦截；即使那时，Agent 也不「拿登录态」，只是用当前已登录的页面。

一句话：**枭熊登录态是用户导出文件的必要条件，但不是转换器的输入；转换器的输入是 `.fobr`。我们 VTT 的登录态由面板 transport 持有，Agent 只发受控请求，不碰 token。**

---

## 5. P0 / P1 范围与验收

### P0（必须）

- [ ] 解析 `.fobr`（至少 1 个场景 + 房间元数据）。
- [ ] 读取 `com.character-cards/list-room` / `com.character-cards/list`，抓取用户自己房间的 `data.json`。
- [ ] PC：六维、豁免、技能、HP/AC/速度、职业/子职/等级、种族/背景、特性、法术、装备、钱币。
- [ ] NPC：角色卡型 NPC + 图鉴怪物型 NPC + 只有 HP/AC 的最小 NPC。
- [ ] 物品：武器/护甲/盾/消耗品/容器/杂物；职业作为 Item；装备进 Actor。
- [ ] 怪物：5etools stat block → NPC Actor + 内嵌 feat/weapon。
- [ ] 输出 Foundry dnd5e 5.3.3 JSON + 素材 + `manifest.json` + `report.json`。
- [ ] 至少 10 个样本（3 PC、3 NPC、4 怪物）通过「导入 Foundry 后打开卡面核对」。
- [ ] 至少 1 个真实战役端到端跑通现有世界包管线。

### P1（应该）

- [ ] `.fobr` 场景 → Foundry Scene：背景、网格、Token 位置/旋转/缩放/可见性。
- [ ] Token 与 Actor 绑定：`boundCardId` → Actor；`bestiary/slug` → NPC。
- [ ] 多 `.fobr` 合并：按 `sceneId` 去重，按 `cardId` 去重。
- [ ] 图片下载/去重/压缩；失败保留 URL 并报告。
- [ ] 地图对齐验收：网格误差 < 1 格，Token 误差 < 0.5 格（抽样 2 张地图）。

### P2（以后）

- [ ] 墙/灯/迷雾转换。
- [ ] 用英文名匹配合集，补 activities/advancement/effects。
- [ ] 枭熊扩展「Arcane Bridge」，批量导出/一键导入。
- [ ] 日志/笔记/Handout。
- [ ] 与 FullPeople 的官方导出接口/合作。

### 估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| 0 | 样本收集 + 格式普查 + 作者沟通 | 3–5 天 |
| 1 | `.fobr`/卡片解析 + 转换器骨架 | 1 周 |
| 2 | PC/NPC/物品/怪物映射 + Foundry 导入验证 | 1–2 周 |
| 3 | 地图场景映射 + 对齐验收 | 1 周 |
| 4 | Skill/向导封装 + 端到端 + 用户试用 | 1 周 |

P0 约 3–4 周，P1 再加 1–2 周；不含作者合作等待时间。

---

## 6. 调研 / 实验计划

### 6.1 用户调研

- 访谈 3–5 位正在用弗人的 DM：最怕迁移丢什么、能接受几步导出、是否愿意装新扩展、对「自动掷骰」的期待有多高。
- 观察 1 次真实迁移：记录从打开枭熊到导入完成的点击次数、耗时、卡点。
- 验收口径：4 个 PC + 1 个场景 < 10 分钟；全程不需要命令行；报告能解释每一个缺失字段。

### 6.2 技术实验

| 编号 | 问题 | 方法 | 产出 | 决策 |
|---|---|---|---|---|
| E0 | 真实数据到底长什么样 | 找 2–3 个使用弗人的 DM，收 3 个 `.fobr` + 10 张卡 | 样本库（脱敏） | 继续/调整范围 |
| E1 | 卡片 schema 覆盖率 | 写 census 脚本，统计字段、空值、未知 key | 字段清单 + 缺口 | P0 字段冻结 |
| E2 | `.fobr` 能否稳定解析 | 用 3 个文件验证 magic/gzip/items/metadata | 解析器 spike | 主路径/回退 |
| E3 | 卡片与图片抓取是否可行 | 从 room metadata 取 `url`，逐卡 GET `data.json`；用真实 `.fobr` 里的图片 URL 分别测无 cookie / 带页面 session 的 200/401/403、CORS、限流、是否过期 | 抓取报告 | 自动抓/页面内抓/逐卡导出 |
| E4 | Foundry 映射是否正确 | 生成 Actor/Item，导入 Foundry 13.351 + dnd5e 5.3.3，打开卡面核对 | 10 个黄金样本 | 映射定版 |
| E5 | 地图能否对齐 | 2 张地图（方格/六角），截图比对网格与 Token | 坐标公式/校准工具 | P1 范围 |
| E6 | 端到端 | 迁移包 → 现有世界包 → 云端战役 | 验收记录 | 发布门槛 |
| E7 | 合规/授权 | 读许可证、ToS；联系 FullPeople | 授权结论/邮件 | 能否商用/合作 |

**E0 样本清单**：至少包含 2014 战士、2024 术士、兼职角色、无描述物品、容器、传奇动作怪物、法术施法怪物、方格地图、六角地图。没有这些，P0 验收不算完成。

---

## 7. 风险与合规

| 风险 | 影响 | 缓解 |
|---|---|---|
| 弗人 `data.json` 端点变更/加鉴权 | 自动抓卡失败 | 支持逐卡 JSON 导出回退；pin `schema_version`；与作者沟通 |
| `.fobr` 格式变更 | 场景解析失败 | 版本探测；支持官方 `.ob2` 回退；格式契约测试 |
| 许可证（NC/GPL） | 商业产品不能复制代码 | clean-room 实现；不复制/不改其代码；先问作者；法务复核 |
| 非 SRD 内容 | 版权/分发风险 | 只迁用户自己的战役；不公开分发；世界包内容闸口 |
| 图片 URL 失效/CORS | 图片缺失 | 本地下载；失败保留 URL 并报告；不阻断导入 |
| Foundry dnd5e schema 漂移 | 导入后字段错位 | 固定 `foundry13-dnd5e5.3`；适配层 + 黄金样本回归 |
| 职业/法术无 activities | 用户觉得「不自动」 | P0 明说只保数据；P1 用英文名匹配合集补 |
| 中文名匹配不到英文合集 | 自动化补不全 | 双语索引 + 人工复核队列；匹配不到不阻断 |
| 大文件/多场景 | 内存/超时 | 流式解压、并发限制、分场景处理 |
| 用户隐私 | 卡片含个人信息 | 本地处理；不上传第三方；日志脱敏 |

**合规红线：**

- 只处理用户自己房间、自己导出的数据；不做跨房间爬取。
- 不把弗人的 GPL/NC 代码复制进 ArcaneDesk；只按公开文件格式做互操作。
- 不把非 SRD 的怪物/法术文本打包进公开世界包；用户私有战役可以保留，但公开分享要走内容闸口。
- 对外发布前，先联系 FullPeople 说明迁移用途，争取书面同意/合作；这既降法律风险，也能拿到格式稳定性承诺。

---

## 8. 待确认问题

1. **下游契约**：现有「D&D 公用数据 → 世界包」的 skill 到底吃 `Foundry world zip` 还是 `Actor/Item/Scene JSON`？这决定转换器要不要做 `--pack-world`。
2. **商业/许可**：ArcaneDesk 是否商业产品？能否接受「clean-room 互操作 + 作者授权」的路径？
3. **样本**：有没有愿意提供脱敏 `.fobr` + 卡片 JSON 的真实团？
4. **规则版本**：P0 先做 2014 还是 2024，还是双版本？弗人示例偏 2024（武器精通/起源专长），但很多团还在 2014。
5. **作者关系**：谁去联系 FullPeople？是否愿意做「官方推荐迁移工具」？
6. **地图范围**：P1 只做背景/网格/Token，还是必须带墙/灯/迷雾？
7. **NPC 定义**：产品上 NPC 是「角色卡」还是「怪物 stat block」？建议两者都支持，预览页让用户选。

---

## 9. 下一步（两周）

1. **确认 D1 下游契约**（1 天）：找世界包 skill 的 owner 对齐输入格式。
2. **收样本**（2–3 天）：3 个 `.fobr` + 10 张卡 + 2 张地图；脱敏。
3. **写 census 脚本**（1 天）：只统计不转换，输出字段覆盖率/未知 key/图片可下载率。
4. **联系 FullPeople**（并行）：说明用途，问 `data.json` 稳定性、`.fobr` 版本策略、是否愿意合作。
5. **写转换器 spike**（3–5 天）：`.fobr` → PC/NPC/物品/怪物 → Foundry JSON；先不碰地图。
6. **Foundry 导入验证**（2 天）：10 个黄金样本，记录字段差异。
7. **定 Skill 契约**（1 天）：`arcane-xiongxiong-import` 的触发词、交互预算、错误文案。
8. **P1 地图 spike**（3 天）：1 张方格 + 1 张六角，验证坐标公式。

---

## 附录 A：关键来源

- FullPeople 组织：https://github.com/FullPeople
- Full Suite 仓库：https://github.com/FullPeople/obr-suite
- 角色卡模块：https://github.com/FullPeople/character-cards
- 角色卡示例 JSON：https://github.com/FullPeople/obr-suite/blob/main/public/cc-example-card.json
- 卡片索引实现：https://github.com/FullPeople/obr-suite/blob/main/src/modules/characterCards/directory.ts
- `.fobr` 格式：https://github.com/FullPeople/obr-suite/blob/main/src/modules/worldPack/format.ts
- `.fobr` 导出器：https://github.com/FullPeople/obr-suite/blob/main/src/modules/worldPack/exporter.ts
- 卡片列表/无鉴权说明：https://github.com/FullPeople/obr-suite/blob/main/src/modules/characterCards/panel-page.ts
- 怪物图鉴数据：https://github.com/FullPeople/obr-suite/blob/main/src/modules/bestiary/data.ts
- Owlbear 扩展 SDK：https://docs.owlbear.rodeo/extensions/
- Owlbear Room API：https://docs.owlbear.rodeo/extensions/apis/room/
- Owlbear Scene Items API：https://docs.owlbear.rodeo/extensions/apis/scene/items/
- Owlbear Assets API：https://docs.owlbear.rodeo/extensions/apis/assets/
- Owlbear ToS：https://www.owlbear.rodeo/terms
- Foundry dnd5e 5.3.3：https://github.com/foundryvtt/dnd5e/tree/release-5.3.3
- ddb-importer：https://github.com/MrPrimate/ddb-importer
- R20Converter：https://github.com/kakaroto/R20Converter
- scene-importer：https://github.com/Eppinguin/scene-importer

## 附录 B：字段速查

**属性 key**：`str/dex/con/int/wis/cha`  
**技能 key**：`acr/ani/arc/ath/dec/his/ins/itm/inv/med/nat/prc/prf/per/rel/slt/ste/sur`  
**体型**：`tiny/sm/med/lg/huge/grg`  
**法术学派**：`abj/con/div/enc/evo/ill/nec/trs`  
**武器词条**：`ver/fin/lgt/thr/two/amm/hvy/rch/spc/mgc`  
**2024 精通**：`cleave/graze/nick/push/sap/slow/topple/vex`  
**稀有度**：`""/common/uncommon/rare/veryRare/legendary/artifact`  
**同调**：`""/required/optional`

## 附录 C：最小输出示例

```json
{
  "_id": "pcRandal00000001",
  "name": "本杰明·弗拉明戈",
  "type": "character",
  "system": {
    "abilities": {
      "str": { "value": 12 },
      "dex": { "value": 14 },
      "con": { "value": 8, "proficient": 1 },
      "int": { "value": 14 },
      "wis": { "value": 8 },
      "cha": { "value": 18, "proficient": 1 }
    },
    "attributes": {
      "ac": { "flat": 15, "calc": "flat" },
      "hp": { "value": 20, "max": 20, "temp": 0 },
      "movement": { "walk": 30, "units": "ft" },
      "spellcasting": "cha"
    },
    "details": {
      "alignment": "",
      "race": "raceHuman0000001",
      "background": "bgAdventurer00001",
      "originalClass": "classSorcerer0001",
      "biography": { "value": "<p>……</p>", "public": "" }
    },
    "traits": { "size": "med", "languages": { "value": ["common", "draconic"], "custom": "" } },
    "currency": { "pp": 0, "gp": 30, "ep": 0, "sp": 0, "cp": 0 },
    "skills": { "ath": { "value": 1 }, "ste": { "value": 1 } },
    "spells": { "spell1": { "value": 4, "max": 4 }, "spell2": { "value": 3, "max": 3 }, "spell3": { "value": 3, "max": 3 } }
  },
  "items": [
    { "_id": "classSorcerer0001", "name": "术士", "type": "class", "system": { "levels": 6, "advancement": [] } },
    { "_id": "spellFireball00001", "name": "火球术", "type": "spell", "system": { "level": 3, "school": "evo", "activities": {} } }
  ],
  "effects": [],
  "flags": {},
  "_stats": { "coreVersion": "13.351", "systemId": "dnd5e", "systemVersion": "5.3.3" }
}
```

> 注：示例只展示字段形状，ID 需为 16 位 `[0-9a-zA-Z]`；实际转换器会补齐 `prototypeToken`、`ownership`、`img`、`_stats` 等字段，并通过 dnd5e DataModel 校验。

## 附录 D：已确认 / 未确认清单

### 已确认（源码 / 探针 / 官方文档）

- [x] 枭熊 2.0 没有房间级一键导出；官方只有按场景/图片的 `.ob2`。
- [x] 弗人 `.fobr` 是 `FOBR1` + gzip JSON，含当前场景 items、sceneMetadata、可选 roomMetadata、图片 URL。
- [x] 弗人卡片正文在 FullPeople 服务器 `obr.dnd.center`，不在枭熊云端，也不在 DM 电脑上。
- [x] 卡片索引在枭熊 room/scene metadata；`.fobr` 勾选房间元数据可带走索引，但不带正文。
- [x] 卡片 `cardId` 由服务端返回，客户端不按角色名生成；`name` 只是展示字段。
- [x] OBR 插件 `localStorage` 只存 UI 状态/预览，不存卡片正文；独立车卡网站 `DND-card-web` 才用 IndexedDB。
- [x] `data.json` 当前源码标明无鉴权；不存在的路径探针返回 404/CORS `*`，不是 401。
- [x] 枭熊 `www.owlbear.rodeo` 返回 `X-Frame-Options: SAMEORIGIN`，普通 iframe 不能嵌入。
- [x] Foundry v11+ 世界数据是 LevelDB；仓库已有读层/打包器，没有写层。
- [x] 目标 Foundry dnd5e 5.3.3：职业是 Item，`details.race/background/originalClass` 指向内嵌 Item `_id`。

### 未确认（需要账号 / 真实样本）

- [ ] 真实 `cardId` 的格式（UUID / 短随机 / 名字 slug）。
- [ ] 真实 `data.json` 在无 cookie / 带页面 session 下的 200/401/403、限流、CORS。
- [ ] OBR 图片 URL 是否需登录、是否签名、是否过期。
- [ ] `.fobr` 的 `com.bestiary/monsters` 是否包含完整 stat block（动作/施法/传奇动作）。
- [ ] `sceneMetadata` 与 `roomMetadata` 的卡片索引覆盖差异。
- [ ] 地图 grid/offset/scale 的真实数值和坐标公式误差。
- [ ] 现有 `mtcompat_import_*` 吃 world zip 还是能直接吃 Foundry 文档 JSON。
- [ ] FullPeople 对迁移工具的授权/合作意愿。

### 不做

- 不猜、不枚举、不撞别人的 `cardId`；只从用户自己房间的索引读取。
- 不把 session cookie/token 抽出来交给 Node/模型。
- 不手写 LevelDB；LevelDB 只由 Foundry 生成。
- 不把非 SRD 内容打包进公开世界包。
