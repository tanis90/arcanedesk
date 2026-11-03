# 枭熊 / 弗人 → ArcaneDesk 迁移技术方案

状态：实现方案 v0.1  
日期：2026-11-02  
上游调研：[`xiongxiong-fullpeople-migration-research.md`](xiongxiong-fullpeople-migration-research.md)  
目标：把枭熊（Owlbear Rodeo 2）+ 弗人（FullPeople）的战役数据，迁移成 ArcaneDesk 自己的 VTT 战役。

---

## 1. 目标与非目标

### 1.1 目标

- 用户在 ArcaneDesk 里完成一次「从枭熊迁移」会话：采集 → 预览 → 一次确认 → 新战役可玩。
- P0：PC、NPC、物品、职业（作为 Item）、装备、怪物。
- P1：地图（背景、网格、Token 位置/旋转/缩放；墙/灯/迷雾放 P2）。
- 目标 VTT 是**我们自己的 VTT**（MythicTable / MT Compat 云端战役），不是 Foundry。
- FVTT 最多作为后台的 world zip 编译器，**不出现在用户动线里**。

### 1.2 非目标

- 实时双向同步；迁移是一次性导入。
- 战斗自动化补全（攻击、豁免、伤害、效果持续时间）；P0 只保证数据完整、卡面可读。
- 聊天记录、日志、手抄笔记迁移。
- 非 SRD 内容的公开分发；迁移结果只进用户自己的战役。
- 枚举/猜测别人的卡片或素材；只处理用户自己房间、自己导出的数据。

### 1.3 术语与数据归属

- **枭熊的 `items[]` 不是 D&D 的 Item。** 前者是画布物件（MAP/CHARACTER/WALL/LIGHT/FOG/DRAWING/NOTE）；后者是武器/护甲/法术/职业/专长。转换器负责把两者映射成 Foundry 文档。
- **`.fobr` 是单场景世界包**，不是整个战役，也不含角色卡正文；它含当前场景 items、sceneMetadata、可选 roomMetadata、图片 URL。
- **角色卡正文在 FullPeople 服务器** `obr.dnd.center`，不在枭熊云端，也不在 DM 电脑上；`cardId` 由服务端返回，客户端不按名字生成。
- **卡片索引在枭熊 metadata**：`com.character-cards/list`（scene）/ `list-room`（room）。只从用户自己房间的索引读 ID，不猜/不撞。

| 数据 | 存在哪 | 迁移怎么拿 |
|---|---|---|
| 房间、场景、Token、地图图片 | 枭熊云端 | 用户导出 `.fobr` / `.ob2` |
| 卡片索引、Token 绑定 | 枭熊 room/scene metadata | `.fobr` 的 metadata |
| 角色卡正文 `data.json` | FullPeople 服务器 | 按索引抓取；回退逐卡导出 |
| 怪物 stat block | 枭熊 scene metadata | `.fobr` 的 `com.bestiary/monsters` |
| `.fobr` / 单卡 JSON | DM 电脑 | 拖入 / 下载 |
| 我们 VTT 的战役/文档/素材 | ArcaneDesk 云端 | `mtcompat_*` |

---

## 2. 冻结的架构决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 目标是我们自己的 VTT；FVTT 不进用户动线 | 用户不需要 FVTT 账号；FVTT 只可能在后台当编译器 |
| D2 | 输入首选 `.fobr` + 弗人卡片 `data.json`；回退逐卡 JSON / `.ob2` | `.fobr` 提供场景 + 卡片索引 + 怪物 stat block；正文在卡片服务器 |
| D3 | 输出 Foundry dnd5e 5.3.3 文档 JSON；不手写 LevelDB | LevelDB 是构建产物；Foundry 才是权威校验器 |
| D4 | 需要时用本地 Foundry 空白世界做 builder：逐条 create / read-back / validate，最后打包 | 单文档可验证、可回滚；避免整包返工 |
| D5 | 登录态不抽取、不落盘、不进模型 | 用户登录枭熊导出文件；我们 VTT 的会话留在面板 transport |
| D6 | v1 不嵌枭熊；v1.5 再上右屏 surface | 先跑通转换器，避免被 iframe/Cloudflare/下载拦截拖住 |
| D7 | 迁移包内部生成，用户默认看不到 zip | 用户体验是「迁移会话」，不是文件管理 |

---

## 3. 总体架构

```text
┌──────────────────────────────┐
│ 枭熊 / 弗人（用户已登录）      │
│  .fobr（场景 + 元数据）        │
│  卡片 data.json（作者服务器）  │
│  图片 URL（OBR CDN / 图床）    │
└──────────────┬───────────────┘
               │ 用户导出 / 下载拦截 / 拖入
               ▼
┌──────────────────────────────┐
│ Collector（Node，本地）       │
│  - 解包 .fobr                 │
│  - 合并 scene/room 卡片索引   │
│  - 抓卡片 JSON（带鉴权回退）  │
│  - 下载/去重图片              │
│  - 产出 migration manifest    │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Normalizer（Node，本地）      │
│  - 弗人 schema 0.3 → dnd5e    │
│  - OBR items → Foundry Scene  │
│  - 规则映射 + 例外标记         │
│  - 产出 Actor/Item/Scene JSON │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Builder / Validator（可选）   │
│  - 本地 Foundry 空白世界       │
│  - 逐条 create/read-back      │
│  - Document.validate()        │
│  - 关闭 Foundry 后打包 world  │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ Import（现有能力）            │
│  - mtcompat_import_prepare    │
│  - mtcompat_import_apply      │
│  - 报告战役链接/计数/缺失      │
└──────────────────────────────┘
```

**关键边界**：Collector/Normalizer 不直接写我们 VTT 的后端；Import 只走已登录的 MT Compat 面板 / 现有 `mtcompat_*` 工具。

---

## 4. 输入契约

### 4.1 `.fobr`（首选）

格式：`FOBR1`（5 字节 magic）+ uint32 LE 压缩长度 + gzip JSON。

```text
{
  version: 1,
  meta: { exportedAt, exporter, sceneName, sceneId, stats },
  sceneMetadata: { ... },      // 含 com.bestiary/monsters、套件状态
  roomMetadata?: { ... },      // 勾选「包含房间元数据」才有；含卡片索引
  items: [ ... ],              // OBR 画布物件：MAP/CHARACTER/WALL/LIGHT/FOG/...
  images: { [hash]: { mime, sourceUrl, data?, width, height } }
}
```

采集规则：

- 多个 `.fobr` 按 `sceneId` 去重；卡片索引取 `sceneMetadata["com.character-cards/list"]` 与 `roomMetadata["com.character-cards/list-room"]` 的并集，再按 `cardId` 去重。
- 单文件不保证覆盖所有卡；最稳是每个场景导出一次，或补逐卡 JSON。
- `.fobr` 默认不嵌入图片，`image.url` 是外部 URL；Collector 负责下载/去重/失败报告。

### 4.2 弗人卡片 `data.json`

- `schema_version: "0.3"`；顶层字段：`identity/classes/abilities/core_stats/defenses/skills/combat/spellcasting/features/special_resources/background/inventory/auto_resources/exports`。
- 卡片索引元素：`{ id, name, uploader, uploaded_at, url, visibility?, owner_ids?, locked?, group? }`；`url` 是权威定位，`data.json` 可从 `url` 推导。
- URL 形状：`/characters/<roomId>/<cardId>/data.json`；`roomId` 是枭熊房间 ID，`cardId` 是服务端生成的卡片 ID。
- **卡片正文由服务端返回；客户端不按名字生成 `id`。** 上传/建卡后服务端返回 `entry.id` / `entry.url`，客户端只使用返回值；`name` 只是展示字段。
- `cardId` 的具体格式（UUID / 短随机 / 名字 slug）客户端看不出来，服务端仓库私有；M0 用真实样本确认。
- **不从名字猜 ID，不枚举/撞卡。** 只从用户自己房间的 `com.character-cards/list` / `list-room` 读精确 ID。
- OBR 插件 `localStorage` 只存 UI 状态/预览，不存卡片正文；独立车卡网站 `DND-card-web` 用 IndexedDB，是另一个产品形态。
- 当前 `data.json` 源码标明无鉴权，但按「可能加鉴权/限流」设计回退。

### 4.3 回退输入

| 输入 | 场景 | 说明 |
|---|---|---|
| 逐卡 JSON | 卡片端点加鉴权 / 用户只想导几张 | 用户在卡片界面「导出 JSON」 |
| `.ob2` | 没有 Full Suite / `.fobr` 不可用 | 官方 Manage Storage 按场景导出；解析 ZIP 内的 scene JSON + 图片 |
| 手动图片 | 图片 URL 需要鉴权/过期 | 浏览器另存；Collector 按文件名/尺寸匹配 |

### 4.4 抓取阶梯（卡片与图片）

```text
1. Node fetch
     200 → 用
     401/403/过期 → 下一步
2. 页面上下文 fetch
     右屏枭熊 WebContentsView / 扩展 iframe，用当前用户 session
     成功 → 经 IPC 交回 App；不导出 cookie/token
     失败 → 下一步
3. 用户官方导出
     卡片：逐卡「导出 JSON」
     图片：浏览器另存 / 插件导出
4. 保留原 URL，报告缺失，不阻断导入
```

**硬边界**：

- 不跨房间枚举/爬取；只处理用户自己房间的 `.fobr` 引用。
- 不把 session cookie/token 写日志、写文件、传模型。
- 两套 session 用不同 Electron partition（`persist:owlbear` / `persist:mtcompat`）。

---

## 5. 输出契约

### 5.1 目录

```text
out/
├── manifest.json
├── foundry/
│   ├── actors/*.json
│   ├── items/*.json
│   ├── scenes/*.json
│   └── folders/*.json
├── assets/
│   ├── portraits/
│   ├── tokens/
│   ├── maps/
│   └── items/
└── report.json
```

### 5.2 `manifest.json`

```json
{
  "schemaVersion": "arcanedesk.migration/1",
  "source": {
    "kind": "xiongxiong-fullpeople",
    "fobrVersion": 1,
    "cardSchema": "0.3",
    "exportedAt": "2026-11-02T00:00:00Z",
    "roomId": null,
    "scenes": [],
    "cardIds": []
  },
  "target": {
    "system": "dnd5e",
    "systemVersion": "5.3.3",
    "coreVersion": "13.351",
    "ruleset": "2014"
  },
  "counts": { "actors": 0, "items": 0, "scenes": 0, "assets": 0 },
  "warnings": [],
  "needsReview": []
}
```

### 5.3 Foundry 文档约束

- `_id`：16 位 `[0-9a-zA-Z]`；建议由 sourceId 哈希生成，保证幂等。
- `flags.xiongxiong`：`sourceId`、`sourceType`、`sourceName`、`raw`、`confidence`、`needsReview`。
- `_stats`：`coreVersion: "13.351"`、`systemId: "dnd5e"`、`systemVersion: "5.3.3"`。
- Actor 内嵌 items/effects；`details.race/background/originalClass` 指向内嵌 Item `_id`。
- 职业是 Item；P0 `advancement: []`，特性以 `feat` Item 内嵌。
- 法术/武器/特性 P0 只保文本与数值；`activities` 可空，P1 再补。

### 5.4 `report.json`

```json
{
  "sourceCounts": { "cards": 0, "monsters": 0, "scenes": 0 },
  "mapped": { "actors": 0, "items": 0, "scenes": 0 },
  "skipped": [],
  "missingAssets": [],
  "unmappedFields": [],
  "needsReview": [],
  "fieldCoverage": { "pc": 0.0, "npc": 0.0, "items": 0.0 }
}
```

---

## 6. 映射规则

### 6.1 PC / NPC 角色卡

| 源 | 目标 | 规则 |
|---|---|---|
| `identity.character_name/display_name` | `Actor.name` | 两个都进 flags |
| `identity.race` | 内嵌 `race` Item | `details.race` = `_id` |
| `background.background_name` | 内嵌 `background` Item | `details.background` = `_id` |
| `classes[]` | 每个职业一个 `class` Item | `system.levels`；总等级自动求和 |
| `classes[].subclass` | 内嵌 `subclass` Item | `classIdentifier` 指向职业 |
| `abilities.*.total` | `system.abilities.*.value` | 豁免熟练写 `proficient` |
| `skills[]` | `system.skills.*.value` | 中文名→key；未知进 flags |
| `core_stats` | `attributes.ac/hp/init/movement` | AC 用 `flat` 保真 |
| `defenses` | `traits.dr/di/dv` | 中文伤害类型→key |
| `combat.armor/shield` | `equipment` Item | `armor.value` / `dex` / `equipped` |
| `combat.weapons[]` | `weapon` Item | 伤害/词条/精通；攻击加值进 flags |
| `spellcasting` | `spell` Item + `attributes.spellcasting` | 环位/学派/射程/成分/持续时间 |
| `features.*` | `feat` Item | 按来源分 class/race/feat |
| `inventory` | `weapon/equipment/consumable/loot/container` | 未知→loot；P0 容器拍平 |
| `exports.dice_bot` | 不导入 | 保留 flags |

**PC/NPC 判定**：`identity.player` 非空 → PC；为空 → NPC；预览页可改。

### 6.2 怪物（NPC Actor）

来源：`.fobr` 的 `sceneMetadata["com.bestiary/monsters"]`（slug → 5etools monster JSON）。

- `ac/hp/speed/abilities/saves/skills/senses/languages/cr` → NPC `system` 对应字段。
- `trait/action/reaction/legendary/mythic/lair` → 内嵌 `feat`/`weapon` Items；P0 保文本，P1 补 activities。
- `tokenUrl` → `prototypeToken.texture.src`。
- 没有 stat block 时创建最小 NPC（名称/HP/AC），其余标 `needsReview`。

### 6.3 物品

- 武器 → `weapon`；护甲/盾 → `equipment`；消耗品 → `consumable`；容器 → `container`；杂物 → `loot`。
- 只有名字没有描述的条目 → `loot` + `needsReview`，不丢。
- 所有原始字段进 `flags.xiongxiong.raw`。

### 6.4 地图（P1）

- `.fobr` `items[]`：`MAP` → Scene 背景；`CHARACTER` → Token；`WALL/LIGHT/FOG/DRAWING/NOTE` 按 layer 分类。
- 初始坐标公式：

```text
T = -(map.left + map.grid.offset * map.scale)
grid.size = map.grid.dpi
grid.distance = 5
grid.units = "ft"
background.offsetX = -map.grid.offset.x * map.scale.x
background.offsetY = -map.grid.offset.y * map.scale.y
token.x = token.center.x + T.x - token.widthPx / 2
token.y = token.center.y + T.y - token.heightPx / 2
token.width = token.image.width * token.scale.x / grid.size
token.height = token.image.height * token.scale.y / grid.size
```

- 墙/灯/迷雾 P2；P1 只做背景、网格、Token。
- 每个 `.fobr` 一个场景；多个文件按 `sceneId` 合并。

### 6.5 规则化边界

| 层次 | 方式 |
|---|---|
| 字段映射、枚举、ID、嵌入结构、素材路径 | 确定性代码，100% 可测 |
| 中文→英文名、职业特性 vs 专长、物品类型、AC/HP 派生、activities | 规则优先，模型兜底，标 `confidence` |
| homebrew、匹配不到的名字、只有名字的物品、地图异常 | `needsReview`，不阻断 |

**模型不直接生成整份 Actor JSON。** 模型只处理规则无法判定的例外，并输出结构化 patch；Normalizer 负责校验和落盘。

---

## 7. 世界落地：Foundry 当编译器

### 7.1 为什么不手写 LevelDB

- LevelDB 是 Foundry 的运行时数据库，键语法/嵌入文档/版本耦合；写入错误可能在启动时才暴露。
- 仓库已有读层（`import-core.mjs`）和打包器（`pack-world.mjs`），没有写层；新增写层是 2–4 周 + 持续维护。
- 模型无法在写入过程中逐条读回验证，错误回滚成本高。

### 7.2 推荐流程

```text
Foundry 空白世界（dnd5e 5.3.3）
  → 逐条 create Actor/Item/Scene
  → toObject() 读回 + 归一化 diff + validate()
  → 失败只删这一条，修正后重试
  → 全部通过 → 关闭 Foundry → 打包 world zip
  → 交给 mtcompat_import_prepare/apply
```

- 幂等键：`flags.xiongxiong.sourceId`；已存在则跳过/更新，不重复创建。
- 回执：每条文档记录 `sourceId/targetId/status/diff`。
- 如果现有管线能直接吃 Foundry 文档 JSON，跳过 builder；如果只吃 world zip，用 builder 生成。

### 7.3 不做什么

- 不直接写 `Data/worlds/<id>/data/*.db`。
- 不在 Foundry 运行时外部改数据库。
- 不把 LevelDB 当源格式或调试格式。

---

## 8. 用户动线

### 8.1 v1（先做）

```text
用户在系统浏览器登录枭熊
  → 弗人设置 → 世界包 → 勾选「包含房间元数据」→ 导出 .fobr（每个场景一次）
  → 把 .fobr / 卡片 JSON 拖进 ArcaneDesk
  ↓
Agent 解析 + 抓卡 + 下图片 + 预览
  ↓
用户：迁到我的 VTT，新建战役
  ↓
Agent 检查 mtcompat_session_status
  → 计划：战役名、规则档、数量、素材、缺失
  ↓ 用户「可以」
Agent：mtcompat_import_prepare → apply
  ↓
报告：战役链接、文档数、素材数、跳过/缺失
```

v1 不嵌枭熊、不碰 FVTT、不需要枭熊登录态被 Agent 读取。

### 8.2 v1.5（右屏枭熊）

- 右屏增加「枭熊」surface：Electron `WebContentsView` + 独立 session partition。
- **不要用 iframe**：`www.owlbear.rodeo` 返回 `X-Frame-Options: SAMEORIGIN`；`WebContentsView` 是顶层视图，不受该头限制。页面在 Cloudflare 后面，登录挑战必须在目标机器实测。
- 用户登录、打开房间；Agent 引导导出 `.fobr`。
- `session.on("will-download")` 拦截 `.fobr` / JSON，落临时目录并通知 Agent。
- surface 切换显式提示；不静默切走。
- 仍然：用户登录，Agent 不拿登录态。
- 如果 Cloudflare/登录嵌不进去，自动退回 v1（系统浏览器 + 拖入），不影响后续流程。

### 8.3 v2

- 并入既有 FVTT 世界（Adventure/module + 页面 API）；P1 地图场景。
- 仍不手写 LevelDB。

---

## 9. Agent Skill 契约

### 9.1 名称与触发

- Skill：`arcane-xiongxiong-import`
- 触发词：枭熊迁移、弗人迁移、`.fobr`、FullPeople、把枭熊的团迁过来。

### 9.2 交互预算

- 恒定 1 次：迁移计划审批。
- 按需 +1：缺少 `.fobr` / 未登录我们 VTT / 卡片端点需要逐卡导出。
- 不向用户要密码；不读取/复述 token。

### 9.3 工具面

```text
xiongxiong_inspect   // 只读：解析 .fobr/卡片，返回预览与报告
xiongxiong_prepare   // 只读：生成迁移计划（目标/数量/缺失）
xiongxiong_build     // 写：生成 Foundry 文档/迁移包（本地）
mtcompat_session_status
mtcompat_campaign_list / mtcompat_campaign_get
mtcompat_import_prepare / mtcompat_import_apply
mtcompat_operation_get
```

### 9.4 用户可见文案

- 不展示内部错误码；用「缺什么/下一步怎么办」解释。
- 计划必须写清：迁什么、去哪、新建/并入、多少内容、哪些缺失、哪些需复核。
- 导入后报告：战役链接、成功数、跳过数、缺失素材、`needsReview`。

### 9.5 失败处置

| 情况 | 处理 |
|---|---|
| `.fobr` 缺 room metadata | 提示重新导出并勾选；或逐卡导出 |
| 卡片 401/403 | 页面内 fetch / 逐卡导出；不抽 cookie |
| 图片 401/403/过期 | 页面内 fetch / 手动另存；保留 URL 报告 |
| 我们 VTT 未登录 | 请用户在右屏登录，重新检查；不代填 |
| 导入 partial | 不自动重跑；读回执/对账，由用户决定 |
| Foundry 校验失败 | 只回滚该条文档，修正后重试 |

---

## 10. 代码落点与 CLI

建议新建 skill 目录，复用现有 `arcane-world-import` 的 node/资产/报告约定：

```text
apps/desktop/skills/prep/arcane-xiongxiong-import/
├── SKILL.md
└── scripts/
    ├── xiongxiong-import.mjs   # CLI 入口
    ├── fobr.mjs                # .fobr 解包/元数据
    ├── cards.mjs               # 卡片索引/抓取/回退
    ├── map-dnd5e.mjs           # 弗人/OBR → dnd5e JSON
    ├── scenes.mjs              # P1 场景映射
    ├── build-world.mjs         # Foundry builder/validator
    └── report.mjs              # manifest/report
```

CLI：

```bash
"$ARCANE_FVTT_NODE" scripts/xiongxiong-import.mjs \
  --fobr <file...> \
  [--cards <dir>] \
  --out <dir> \
  --ruleset 2014|2024 \
  [--fetch-cards] \
  [--download-assets] \
  [--build-world] \
  [--dry-run] \
  [--report <path>]
```

- stdout：最终 JSON（计数/路径/警告）；进度日志走 stderr。
- `--dry-run` 不写文件、不建世界，只输出报告。
- `--build-world` 需要本机 Foundry/dnd5e 5.3.3；没有就明确报错，不降级手写 LevelDB。

---

## 11. 测试与验收

### 11.1 黄金样本

- PC：2014 战士、2024 术士、兼职角色。
- NPC：角色卡型、图鉴型、只有 HP/AC 的最小 NPC。
- 怪物：哥布林（简单）、施法怪、传奇动作怪、CR 小数怪。
- 物品：魔法武器、护甲、容器、只有名字的杂物。
- 地图：方格、六角/偏移各 1 张。

### 11.2 验收口径

- 字段覆盖：PC/NPC/物品 ≥ 95% 字段被映射或显式标记；0 个静默丢弃。
- 引用：0 个断链的 `details.race/background/class`；0 个重复 `sourceId`。
- 怪物：AC/HP/六维/动作文本齐全；动作自动化可缺，但必须报告。
- 地图：网格误差 < 1 格；Token 误差 < 0.5 格（抽样）。
- 体验：4 PC + 1 场景 < 10 分钟；全程无需命令行；报告能解释每个缺失。
- 安全：日志/报告无 token；无跨房间请求；401/403 有回退。

### 11.3 端到端

1. 用户导出 `.fobr` → 拖入 → 预览。
2. 新建 ArcaneDesk 战役 → 导入 → 打开战役 → 抽查 PC 卡/怪物/物品。
3. 重复导入同一战役 → 计划提示「纯追加不去重」；不自动重跑。
4. 模拟卡片 401 → 回退逐卡 JSON → 导入成功。
5. 模拟图片 403 → 保留 URL → 报告缺失，不阻断。

---

## 12. 拿到枭熊账号后的实测清单

账号到手后按这个顺序跑，先验证事实，再写代码：

- [ ] 安装 Full Suite，建一个测试房间。
- [ ] 建 4 张卡：2014 战士、2024 术士、兼职、无描述物品。
- [ ] 建 3 个怪物 token：哥布林、施法怪、传奇动作怪。
- [ ] 建 2 个场景：方格地图、六角/偏移地图。
- [ ] 导出 `.fobr`（勾选房间元数据）；解包记录 `sceneMetadata` / `roomMetadata` 的 key。
- [ ] 记录卡片索引的 `id` 形状（UUID/短随机/名字 slug）和 `url` 形状。
- [ ] 用真实 `data.json` URL 测：无 cookie / 带页面 session 的 200/401/403、CORS、限流。
- [ ] 用真实图片 URL 测：无 cookie / 带页面 session 的 200/401/403、`Expires`/签名参数、是否能下载。
- [ ] 检查 `.fobr` 是否包含 `com.bestiary/monsters` 完整 stat block。
- [ ] 记录 OBR 图片在 `files.owlbear.app` 的 URL 形态和有效期。
- [ ] 用两张地图校准坐标公式，截图比对网格/Token。
- [ ] 确认卡片索引在 `sceneMetadata` 与 `roomMetadata` 的覆盖差异。
- [ ] 确认 Full Suite 版本、manifest URL、许可证/作者联系方式。

---

## 13. 待确认

1. 现有 `mtcompat_import_*` 吃 world zip 还是可以直接吃 Foundry 文档 JSON？决定 builder 是否必需。
2. ArcaneDesk 是否商业产品？许可证/作者合作策略。
3. P0 先做 2014 还是 2024，还是双版本。
4. 地图 P1 是否必须带墙/灯/迷雾。
5. NPC 的产品定义：角色卡型、图鉴型，还是两者都算。
6. 谁负责联系 FullPeople；是否争取官方批量导出/合作。

---

## 14. 里程碑

| 阶段 | 内容 | 产出 | 估算 |
|---|---|---|---|
| M0 | 账号实测 + 样本库 + 格式冻结 | 实测报告/样本 | 3–5 天 |
| M1 | `.fobr`/卡片解析 + Collector | 迁移 manifest + 报告 | 1 周 |
| M2 | PC/NPC/物品/怪物 → dnd5e JSON | 黄金样本通过 | 1–2 周 |
| M3 | Foundry builder/validator + 迁移包 | 可校验 world zip / JSON | 1 周 |
| M4 | Skill + 迁移向导 + 端到端 | 用户可用 | 1 周 |
| M5 | 地图 P1 | Scene/Token 对齐 | 1 周 |
| M6 | 右屏枭熊 surface（可选） | 下载拦截/会话切换 | 1 周 |

P0（M0–M4）约 4–6 周；P1 再加 1–2 周；不含作者合作等待。
