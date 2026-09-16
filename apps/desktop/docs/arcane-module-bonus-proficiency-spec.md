# 子职业熟练文本条目补全 Spec（arcane-dnd5e-2014-automation）

> 日期：2026-09-15
> 状态：待实施（arcanedesk 侧已拍板走"改模块数据"方案）
> 目标仓库：`arcanedesk-fvtt-mods-private`（模块 `arcane-dnd5e-2014-automation`）
> 提出方：arcanedesk 备团工具 benchmark（r3 A3 试次）

---

## 1. TL;DR

dnd5e 数据把"子职业授予熟练"建成**两层**：Trait advancement 负责机械落卡（写进角色 `system.traits`），一个 feat 类型的**文本条目**负责出现在角色卡特性列表里。我们的 arcane 2014 包只有第一层、缺第二层：**15 个子职业**的熟练在机械上已正确授予，但卡面上永远少一条「附赠熟练项」特性条目。本 spec 要求把这些文本条目（以及顺带发现的 2 处真机械缺口）补进生成器数据源。

只改模块数据，不改运行时、不改 automation.js。**不需要回填已建角色**（AGENTS 规则：模块升级不更新已拷贝的 Actor Items）。

## 2. 背景：怎么发现的

arcanedesk 备团工具 benchmark（`arcanedesk-prep-play`，r3 批次，suite `character-v10-production-catalog`）的 A3 场景是"建 3 级生命领域矮人牧师"。验收器 `verify-v3.cjs` 有一项 `feature.bonus-proficiency`[core] 检查：角色身上应存在 feat 条目 `Compendium.dnd5e.classfeatures.Item.68bYIOvx6rIqnlOW`（SRD 的「附赠熟练项」）。该期望锚自一张用 SRD 包手工建的参照卡。

r3 三个 A3 试次（工具臂×1、裸 JS 臂×2）全部此项失败，observed 均为 `[]`。实测排查（COS 世界，dnd5e 5.3.3）：

- 角色 `system.traits.armorProf.value` = `["lgt","med","shl","hvy"]` —— **重甲熟练机械上已落卡**，AC、装备合法性、midi 判定全部正常；
- 缺失的只有特性列表里的**文本条目**；
- 失败不是模型没做对，而是 **arcane 包数据里根本没有这个条目可授**——生命领域子职业的 L1 ItemGrant 只授「生命门徒」，整个 `classfeatures` 包里搜不到任何"附赠熟练项"条目（全包带"熟练"的 feat 仅「熟练探险家」一条）。

benchmark 三选一决策中拍板：由模块数据补齐（而非放宽验收器、而非让 skill 教模型手工补授），使卡面与 SRD 一致。

## 3. 问题本质：双层建模

以生命领域为例，SRD 官方包（`dnd5e.subclasses`）L1 是这样建模的：

| 层 | 载体 | 内容 |
|---|---|---|
| 机械 | `Trait` advancement「护甲熟练」 | `grants = Set["armor:hvy"]` → 写进角色 traits |
| 文本 | `ItemGrant` advancement「Features」 | 授予 feat 条目「附赠熟练项」（`68bYIOvx6rIqnlOW`，描述："在第1级选择该领域时，你获得重甲的熟练项。"）+「生命门徒」 |

arcane 包（`arcane-dnd5e-2014-automation.subclasses`）生命领域 L1：Trait 一模一样在，ItemGrant 只有「生命门徒」——文本层整条缺失。

**根因（已定位）**：donor classpack 原始数据就是这样。`subclass.jsonl` 的生命领域 L1 ItemGrant 原本就只引用 `JKRSuJBfZnXIx8Zu`（生命门徒）；donor 特性 dump（`class-abilityphb.jsonl` / `extra-ability.jsonl`）里也**没有**任何"附赠熟练项"feat 文档，只有 9 个 `type:"base"`、无描述、名为"获得XX熟练"的占位条目（不可用）。**不是我们的 advancement filter 丢的**，无需回查 filter 行为。

## 4. 影响面审计（全包子职业扫描，2026-09-15 实测）

扫描 `arcane-dnd5e-2014-automation.subclasses` 全部含 Trait advancement 的子职业，逐个人工核对同级 ItemGrant 条目名，结论分三类。

### A 类：机械已落卡，缺文本条目（本 spec 主体，15 个子职业）

| 子职业 | identifier | 级别 | Trait grants（实测） | 书本特性名 | 同级现有条目 |
|---|---|---|---|---|---|
| 生命领域 | `life-domain` | 1 | `armor:hvy` | Bonus Proficiency | 2 领域法术 + 生命门徒 |
| 自然领域 | `nature-domain` | 1 | `armor:hvy`（另有技能 choice Trait） | Bonus Proficiency | 2 法术 + 自然侍僧 |
| 风暴领域 | `tempest-domain` | 1 | `armor:hvy`, `weapon:mar` | Bonus Proficiencies | 2 法术 + 风暴狂怒 |
| 战争领域 | `war-domain` | 1 | `armor:hvy`, `weapon:mar` | Bonus Proficiencies | 2 法术 + 战争祭司 |
| 死亡领域 | `death-domain` | 1 | `weapon:mar` | Bonus Proficiency | 2 法术 + 收割者 |
| 锻造领域 | `forge-domain` | 1 | `armor:hvy`, `tool:art:smith` | Bonus Proficiencies | 2 法术 + 锻造祝福 |
| 秩序领域 | `order-domain` | 1 | `armor:hvy` | Bonus Proficiencies | 2 法术 + 权威之音 |
| 暮光领域 | `twilight-domain` | 1 | `armor:hvy`, `weapon:mar` | Bonus Proficiencies | 2 法术 + 黑夜明目 + 警觉赐福 |
| 勇气学院 | `college-of-valor` | 3 | `armor:med`, `armor:shl`, `weapon:mar` | Bonus Proficiencies | 战斗激励 |
| 剑舞学院 | `college-of-swords` | 3 | `weapon:mar:scimitar`, `armor:med` | Bonus Proficiency | 战斗风格（剑舞）+ 剑舞 |
| 逸闻学院 | `college-of-lore` | 3 | 3 技能自选（choice Trait） | Bonus Proficiencies | **无，见 B 类** |
| 醉拳宗 | `way-of-the-drunken-master` | 3 | `skills:prf`, `tool:art:brewer` | Bonus Proficiencies | 醉拳法门 |
| 命流宗 | `way-of-the-mercy` | 3 | `tool:herb`, `skills:ins`, `skills:med` | Implements of Mercy（慈悲妙手） | 予命之手×2 + 夺命之手 |
| 符文骑士 | `rune-knight` | 3 | `languages:standard:giant`, `tool:art:smith` | Bonus Proficiencies | 符文雕刻者 + 巨人之力 |
| 骑兵 | `cavalier` | 3 | 技能自选（choice Trait） | Bonus Proficiency | 生而为骑 + 坚定之印×2 |

### B 类：顺带发现的真机械缺口（一并修）

1. **逸闻学院 `college-of-lore` L3 整条 ItemGrant 缺失**：除了附赠熟练项，「语出惊人 Cutting Words」也从未授予——角色 3 级拿不到这个核心特性。现成素材：donor `class-abilityphb.jsonl` 有 feat 文档「语出惊人 Cutting Words」（`_id: XVwbRWKX20xZZWQB`）；SRD 参照为 `dnd5e.classfeatures.5zPmHPQUne7RDfaU`。
2. **龙族血脉 `draconic-bloodline` L1 缺 Trait advancement**：文本条目「巨龙先祖」「龙族体魄」都在，但龙语熟练没有机械落卡。SRD 有现成参照：`Trait`，`grants = ["languages:exotic:draconic"]`。这是唯一一个"文本在、机械缺"的反向缺口。

### C 类：已核对无需改（文本条目已覆盖熟练描述）

奥秘领域（奥术传承）、和平领域（和平执行）、知识领域（知识祝福）、战斗大师（战争学徒）、紫龙骑士（皇家特使）、武士（雅臣）、魔射手（魔箭学识）、剑圣宗（剑圣之途）、牧人之环（林地之语）、巨人道途（巨人之灾等 4 条）、神龙宗（L3 共 5 条）。

> 扫描范围说明：本表覆盖 arcane 包内全部带 Trait advancement 的子职业。无 Trait advancement 的子职业不涉及此问题。

## 5. Spec：改动内容

### 5.1 新增 feat 文本条目（进 `classfeatures` 包数据源）

每个 A 类子职业新增一条独立 feat 文档（与 SRD 惯例一致：每子职业一条，描述各自的具体熟练，不要做成共享单条）：

- **命名**：遵循包内双语惯例 `中文 English`，如 `附赠熟练项 Bonus Proficiency` / `附赠熟练项 Bonus Proficiencies`；命流宗用 `慈悲妙手 Implements of Mercy`。
- **结构模板**：`type: "feat"`，`system.type.value: "class"`，参照官方 5.3.3 样本 `local-samples/foundry-compendia/dnd5e.classfeatures.json` 的 `68bYIOvx6rIqnlOW`（Bonus Proficiency，Life）与 `e9ytGikyLFgwZ5wi`（Bonus Proficiencies，Lore）。SRD 覆盖的生命/逸闻两条可直接以官方文档为底本改双语名。
- **描述文本**：取自 `private-content` 已授权的文档输入（见私有 repo AGENTS.md 的 `source-manifest.json`，15 个文档/翻译输入）。**红线：不得新引入未授权规则书文本或新翻译**（私有/公共 repo AGENTS 均明确）。描述写该子职业具体获得什么熟练（如风暴领域："你获得重甲和军用武器的熟练项。"）。
- **id**：新生成稳定 16 字符 id（SRD 两条可保留官方 id 以利识别）。**不要**复用 donor 里 9 个 `type:"base"` 的"获得XX熟练"占位文档。
- **图标**：从已 vendor 的 `assets/Nicons/` 中选（重甲类可用胸甲图标），构建日志 `[copyReferencedIcons] WARNING` 必须保持为空。
- **纯文本条目**：不带 Activity、不带 Active Effect——熟练已由 Trait advancement 落卡，条目重复挂效果会double。这一条请写进生成器注释。

### 5.2 子职业 advancement 注入

对 A 类 15 个子职业，把新条目 uuid 追加进**对应级别已有的 ItemGrant**（如生命领域并入 L1「职业特性」grant，与生命门徒并列），不要新增并列的第二条 ItemGrant——保持与 SRD 结构同形。逸闻学院除外（见 5.3）。

### 5.3 逸闻学院 L3 整条补授（B 类）

新建 L3 ItemGrant「职业特性」，条目 = [「语出惊人 Cutting Words」（donor id `XVwbRWKX20xZZWQB`，注意按构建的 id 重映射规则处理），新「附赠熟练项 Bonus Proficiencies」]。L3 的 3 技能自选 Trait advancement 已存在，保持不变。

### 5.4 龙族血脉 L1 补 Trait（B 类）

新增 L1 `Trait` advancement「语言」，`grants = ["languages:exotic:draconic"]`，`mode: "default"`，与 SRD 同形。

### 5.5 验证器断言

按现行管线（`npm run build:internal` / `npm run validate:internal` 及其验证器）为每个改动子职业加断言：

- `hasItemGrant(<subclass>, <level>, [<新条目id>, ...])`；
- Trait advancement 的 grants 回归断言（防注入时误改机械层）；
- 逸闻学院：L3 同时含语出惊人与附赠熟练项；
- 龙族血脉：存在 grants 含 `languages:exotic:draconic` 的 L1 Trait。

### 5.6 实现约束

- **生成器是唯一真源**：所有改动落在内容源/生成器输入，重建 pack；禁止手改 `packs/*.ldb` 或线上 Foundry 文件（两边 AGENTS 红线）。
- 本 spec 有意**不锁定具体文件与行号**：私有 repo 构建管线在 2026-09 迁移过（`npm run build:internal`，foundry-pack-builder writeModule，17 包），`notes/how-to-add-a-class.md` 里描述的单文件生成器、`ensureItemGrant` helper、`classFeatureIds` 种子等是**参考模式**，以仓库当前管线与《职业自动化开发规范》为准。
- 职业类改动需先读 `internal/auto2014/docs/foundry-automation/notes/职业自动化开发规范.md`（私有 repo AGENTS 强制）。
- 世界 Actor 与线上 pack 不是真源；**不回填任何已建角色**。

## 6. 验收标准

1. `npm run build:internal` 成功，`npm run validate:internal` 全绿（含 5.5 新断言）。
2. `build-summary.json` diff 仅出现预期新增条目与 advancement 变更；无 `dnd5e_classpack` uuid 泄漏；图标 WARNING 为空。
3. 本地部署 COS 后 API probe（参照 how-to-add-a-class §3.4）：
   - 生命领域 advancement L1 ItemGrant 含新「附赠熟练项」且 Trait `armor:hvy` 不变；
   - 逸闻学院 L3 含语出惊人 + 附赠熟练项；
   - 龙族血脉 L1 Trait 含龙语。
4. 在 COS 世界用 advancement 流程新建 3 级生命领域牧师：特性列表出现「附赠熟练项」条目，且 `system.traits.armorProf.value` 含 `hvy`。
5. A 类其余 14 个子职业抽查同级 ItemGrant 均含新条目。

## 7. arcanedesk 侧联动（提出方负责，不在本 spec 实施范围）

- `verify-v3.cjs` 的 `feature.bonus-proficiency` 期望当前锚定 SRD id `68bYIOvx6rIqnlOW`；新条目落地后改为接受 arcane 包新 id（或按条目名匹配），随后重跑 A3 场景确认通过。
- benchmark skill 与工具**不需要任何改动**——这正是选 ③ 而非 ② 的理由。
- r3 已建试次角色（如 `Actor.qYRcIkWKVE8o3RQr`）维持现状，不回填。

## 8. 附录：关键证据与素材索引

实测环境：COS 世界，Foundry 13.351，dnd5e 5.3.3，2026-09-15。

- 角色 traits：`Actor.qYRcIkWKVE8o3RQr`（工具臂）/ `Actor.jEwr4kJPZwU59n67`（JS 臂）`armorProf.value = ["lgt","med","shl","hvy"]`。
- 两包生命领域 advancement 对比：SRD L1 ItemGrant = `[68bYIOvx6rIqnlOW, jF8AFfEMICIJnAkR]`；arcane L1 ItemGrant = `[2 领域法术, JKRSuJBfZnXIx8Zu]`。两包 Trait grants 均为 `["armor:hvy"]`。
- donor 根因：`private-content/auto2014/docs/foundry-automation/notes/classpack-analysis/subclass.jsonl` 生命领域 L1 ItemGrant 本就只引 `JKRSuJBfZnXIx8Zu`；特性 dump 中无附赠熟练项 feat 文档。
- 素材：语出惊人 donor id `XVwbRWKX20xZZWQB`（`class-abilityphb.jsonl`，type feat）；官方模板 `dnd5e.classfeatures` 的 `68bYIOvx6rIqnlOW` / `e9ytGikyLFgwZ5wi`；donor 占位文档（勿用）：`zucCzkJArfZFbnhb` 等 9 个 `type:"base"`。
- benchmark 报告：`C:/qa/kimi/suite-a123-r3/` 各 trial `manifest.report`。
