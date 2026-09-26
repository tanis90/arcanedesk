---
name: arcane-module-to-fvtt
description: 把已建立 Obsidian 资料库的 D&D 5e 模组系统性维护进 Foundry VTT 世界。当用户要求"把模组做进/维护进 Foundry/FVTT"、"建世界"、"同步模组内容到 FVTT"，或提供模组资料库要求建场景/怪物/预设卡/速查卡时使用。前置条件：模组资料库已由 arcane-module-reader 建成。单个角色的修补用 arcane-actor-update；服务器安装运维用 arcane-fvtt-setup/ops；本 skill 只管内容建设工程。
---

# 模组 → FVTT 世界维护

把模组资料库变成可直接开团的 FVTT 世界。这是一个**验收表驱动**的工程流程：先和 DM 拍板、立验收契约，再逐行建设，最后全局走查。

## 用户交互预算

**恒定 2 次**：阶段 0 的决策确认门（决策清单一页合并确认，每项有推荐默认值，DM 无意见即采用）+ 完工后偏差清单随报告交付的一次评审。其余全部是默认值自治，中途不再提问。

## 第一原则：原文保真

**任何写进世界的模组文本，必须先用 read/grep 打开资料库原文核对后再写，严禁凭记忆生成。** 实际教训：剧本、谜语、祷文三类文本凭记忆重建全部出错，靠对照原文重写才修正。

- 速查卡、handout、规则卡：先读对应章节文件，再落笔。
- 与原文的**刻意偏差**（原卡笔误、合集缺内容、语义不通处）不擅自"修复"，按原文保留并在验收文档的「偏差清单」中逐条记录。
- 商业模组全文不进 FVTT（作者通常只授权简版速查）；全文保留在本地资料库。

## 前置检查

1. 模组资料库已存在（`模组资料库/<模组名>/章节/*.md` + `_原始解析/images/`）。没有则先走 arcane-module-reader。
2. FVTT 服务器在跑、GM 页面就绪（`world_status` 验证 `game.ready && game.user.isGM`）。没就绪走 arcane-fvtt-ops，**本 skill 不负责装服务器、不直接操作服务器进程与锁文件**。
3. 确认系统与合集包版本：dnd5e 系统版本，以及 arcane 模块合集包（`browser_evaluate` 读 `game.packs`，按 `metadata.packageName` 认，如 `arcane-dnd5e-2014-automation`），记下来——后面引用合集要用。

## 阶段 0：决策拍板 + 验收契约（不拍板不动工）

用 `templates/决策清单.template.md` 逐项和 DM 确认（典型决策点：旧内容清不清、缺图场景怎么办、模组全文进不进、预设卡建几级、Token 规范）。确认后把 `templates/验收标准.template.md` 复制到工作目录，按模组内容填成 9 行左右的验收表，**后续所有建设逐行对照打勾**。

## 阶段 1：世界基线

- 复制模板世界或新建；id 用 ASCII（避免 URL/路径问题），title 用中文名。
- 按决策清空旧内容（Scene/Actor/Item/Journal/RollTable/Combat/ChatMessage/内容文件夹），保留 Compendium 文件夹和有用的宏。
- 建 5 个内容文件夹（Scene/Actor/Item/JournalEntry/RollTable 各一），全部以模组名命名，记下 folder id。
- 本 skill 的脚本一律用 `ARCANE_FVTT_NODE` 运行（Node 环境约定见 arcane-fvtt-ops）。

## 阶段 2：地图与场景

- **为什么需要渲染脚本**：模组作者给的地图常是 PDF（印刷用的矢量图），Foundry 场景背景只接受 JPG/PNG/WebP，必须先栅格化成图片。`scripts/render-pdf-map.mjs` 干的就是这件事：输入 PDF 输出高清 JPG，两端都用系统自带组件零安装（Windows 走 WinRT PdfDocument，macOS 走 sips）。**只渲染 PDF 首页**——多页地图先按页拆成单页 PDF，再逐张渲染。
- 图片拷进世界 Data 目录用 ASCII 文件名（`worlds/<id>/assets/xxx.jpg`）。Data 目录的实际位置随平台不同（Windows 在 `AppData\Local\FoundryVTT\`，macOS 在 `~/Library/Application Support/FoundryVTT/`），以 arcane-fvtt-ops 查到的为准。
- `foundry_scene_apply` 建场景，background 用 Data 相对路径。
- **网格校准用视觉迭代，别信离线测量**：临时把网格设为亮色高透明（如 `#ff0040` alpha 0.8），`canvas.pan` 到走廊等直线密集区，`foundry_screenshot` 截图比对，调 `background.offsetX/offsetY` 直到贴合，最后恢复低调网格样式。印刷格与场景 px 的换算比例每张图不同，靠截图实测。
- 首版不做墙/灯光/音效。token 落点先看地图图片估坐标，宁可在房间里放偏一点也不要放墙里；放完截图抽查。

## 阶段 3：资产清单化

把模组拆成五类资产逐行列入验收表：Scene / Actor（自建 vs 引合集）/ Item / RollTable / Journal（DM 速查卡 + 玩家 handout + 规则卡）。自建还是引合集的判定：

- 合集已有 → 引用，**不重复自建**。
- 引用来源优先级：Item 条目（法术/特性/专长/职业等）默认从 arcane-dnd5e-2014-automation 模块的 "Arcane 5e 2014 …" 合集包拿，模块包缺条目或未安装才回退 `dnd5e.*` 系统包，并在报告写明实际来源；条目一律从 compendium 文档拷贝，不凭记忆手写。按类别选包清单与检索方法见 arcane-actor-update「给人物添加法术 / 职业能力」；工具流 browse/plan 去重已按模块包优先，手工 content_search/eval 路径遵守同一优先级。怪物 Actor 模块包不收，引系统包（见 reference/dnd5e-pitfalls.md §5）。
- NPC 用合集底版 + 改名 + 模组描述（`system.details.biography.value`）。
- 合集缺的内容（如非 SRD 怪物）→ 按模组原文处理，记偏差清单。

## 阶段 4：Actor 建设（自建怪先找模板怪）

**核心策略：SRD 近亲克隆 + 打补丁，远快于从零建。** 见 `reference/monster-templates.md` 的对照思路和实测案例（蜘蛛群=Swarm of Insects、活化盔甲、蝎尾狮）。流程：

1. `foundry_content_search`（documentType=Actor，scope=compendium）找模板；同名常有 2014/2024 双版本，按模组风味选。
2. `foundry_actor_create`（source compendium）克隆进世界并直接改名。
3. `browser_evaluate` 打补丁：改数值、改类型、改动作名与描述、加模组特有特性（做成 feat 条目）。
4. 动作的伤害/豁免改动注意 **damage parts 的 base 注入坑**——见 `reference/dnd5e-pitfalls.md`。

## 阶段 5：角色卡（预设卡 / 模组给的 NPC 卡）

**这段的底层问题不是“预设卡”，而是：模组给的角色数据和原生规则流程算出来的不一致时怎么办。** 预设卡只是最常见的实例（特殊专长、非标准 HP/AC、作者改的骰子），怪物数据卡也可能遇到。处理原则：

1. **优先走原生 advance 建标准版**：用 `foundry_advancement_plan` 出计划 + `foundry_actor_advance` 建卡。HP、熟练加值、职业特性、法术位全部由 dnd5e 原生计算，这版在系统层面一定是自洽的。
2. **逐项 diff 模组卡 vs advance 结果**：属性/HP/AC/技能/豁免/法术/装备/特性，列成对照表。
3. **不一致项不擅自改**：写进验收文档「偏差清单」，每条标注三方信息——模组卡写的值 / advance 算的值 / 你的判断（疑似原卡笔误？作者定制规则？版本风味差异？），**交 DM 评审**。DM 确认要改，再用 eval 打补丁。实测案例：某模组预设卡的牧师先攻 +5（按警戒专长应为 +4）、野蛮人 AC 15（无甲防御应为 16）、巨斧 2d6（标准为 1d12）——都是 diff 出来的，保留原值+备注。
4. **例外**：DM 在决策阶段已拍板“以原卡为准”（如 Q4 类决策），可以手工建；但走查时仍要 diff 标准 build 并在偏差清单说明，不能跳过记录。

**如果确实要直接 eval 改卡**，坑都验证过并写在 `reference/dnd5e-pitfalls.md`，核心几条：

- **角色必须挂职业条目**（dnd5e.classes24/classes 包，`system.levels=1`）——不挂则 level=0、熟练加值被算成 1，所有技能豁免默默少 1 点。挂完立即抽查技能 total 验证。
- **武器伤害改 parts 有 base 注入坑**：显示层永远先插武器自带 base 段，update 数组按索引合并。改基础骰改 `system.damage.base`，附加段才放 parts；核验看 `toObject()` 的 stored 原值。
- 法术位用 `system.spells.spell1.override`；AC 与装备计算不符时用 `ac.calc='flat'` 并备注；专精 = `skills.<key>.value: 2`。
- 「原卡动作备注」feat 收录武器精通类骑手效果；「升至 2 级（届时更新）」feat 写原文升级内容。

## 阶段 6：文本资产（Journal/RollTable）

- **逐页/逐条创建**——单批次 `createEmbeddedDocuments` 建多个 JournalEntryPage 会静默失败，必须循环单页创建。
- DM 速查卡：单本 Journal，每章一页（朗读要点/检定 DC/遭遇配置/奖励/升级时机），全部对照原文提炼。
- 玩家 handout 设 `ownership: { default: 2 }`（Observer）。
- RollTable 的 d6 表用 `range: [n,n]` + weight 1。

## 阶段 7：图像资产（Token 规范）

- 有立绘的角色：方形裁切对焦面部。`scripts/crop-token.mjs`（Node，跨平台）支持 top（头像/半身像）/center（全身怪物）/rect 自定义矩形（抽查发现裁歪后修正）。
- **裁完必须 read 图片抽查**——全身竖版立绘用 center 会把头切掉（实测踩过）。
- 应用用 `foundry_image`（sourcePath + targetUuid），已放置的 token 加 `syncPlacedTokens: true` 同步。
- 无立绘的沿用合集图。

## 阶段 8：全局走查

一次 `browser_evaluate` 查：重名文档、无自定义图的 Actor、越界 token、残留战斗/聊天、handout 权限。然后更新验收文档打勾 + 填偏差清单，给 DM 交付报告。

## 工具通道注意事项

- 结构化写入工具偶发 `INPUT_WORLD_UNAVAILABLE`，先 `foundry_open` 重连、请用户在主聊天框发一条消息再重试；恢复后优先用结构化工具，结构化工具不覆盖的（Journal/RollTable/复杂补丁）用 `browser_evaluate` 走公开 Document API。
- 写入超时/导航/结果不确定时不盲目重试，先查询世界现状。

## 文件清单

```
templates/决策清单.template.md    # 动工前与 DM 逐项拍板
templates/验收标准.template.md     # 验收契约骨架（按模组填充）
scripts/render-pdf-map.mjs     # PDF 地图 → JPG（跨平台：WinRT/sips，零安装）
scripts/crop-token.mjs         # 立绘方形裁切 top/center/rect（跨平台）
reference/dnd5e-pitfalls.md       # dnd5e 5.3 数据层坑与正确写法
reference/monster-templates.md    # 自建怪 → SRD 模板怪对照思路
```
