---
name: arcane-actor-update
description: 在 Foundry 世界里新建或修改人物（Actor、角色、NPC）。给人物添加法术、职业能力或专长（优先从 arcane-dnd5e-2014-automation 模块的 "Arcane 5e 2014" 合集包拿）、创建人物、给人物配图、发现 token 拖上地图没有头像、补 token 图或批量修正人物图像时使用。
---

# 人物（Actor）更新

## 给人物添加法术 / 职业能力

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
