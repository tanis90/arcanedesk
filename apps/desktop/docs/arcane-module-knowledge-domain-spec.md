# 知识领域「知识祝福」技能熟练授予槽补全 Spec（arcane-dnd5e-2014-automation）

> 日期：2026-09-17
> 状态：待实施（arcanedesk 侧已拍板走"改模块数据"方案）
> 目标仓库：`arcanedesk-fvtt-mods-private`（模块 `arcane-dnd5e-2014-automation`）
> 提出方：arcanedesk 备团工具 e2e 矩阵（`arcanedesk-prep-play`，全职业子职业 sweep 二扫）
> 参照格式：同目录 `arcane-module-bonus-proficiency-spec.md`

---

## 1. TL;DR

PHB 2014 知识领域牧师 1 级特性「知识祝福 Blessings of Knowledge」是**三段式**：自选 2 门语言 + **获得**四选二（Arcana/History/Nature/Religion）技能熟练 + 这些技能的熟练加值双倍。arcane 包的子职业数据只建了语言槽（default 模式）和双倍槽（expertise 模式），**缺了中间的"授予熟练"槽**。dnd5e 原生的 expertise apply 对未熟练技能静默跳过、绝不代授——所以只要牧师职业技能没选 History/Religion，无论走原生 UI 还是我们的工具链，这个角色都**永远比规则少 2 项技能熟练**，且无任何报错。

修法：给知识领域 L1 补一个 default 模式的 Trait advancement（四选二授予熟练），现有双倍槽与语言槽不动。排序天然正确（default 排在 expertise 前，先授予后双倍），arcanedesk 工具链**零改动**即可完整支持。另附同包剑圣宗一处过度授予（远程剑圣武器 7 选 1 被建成 7 件全授），一并修。

只改模块数据，不改运行时、不改 automation.js。本 spec 不涉及任何规则书文本新增（不动 feat 条目、不动描述），无授权文本红线问题。

## 2. 背景：怎么发现的

arcanedesk 备团工具 e2e 矩阵（`arcanedesk-prep-play` worktree，`scripts/e2e-advance-matrix.mjs`）2026-09-17 做了全职业子职业 sweep：12 职业 119 案，115 绿 4 红。其中 `cleric/知识领域` 案（案 id `A3s-knowledge-domain`）红，报错为 harness 填值器异常：

```
专精槽 subclass:1:TraitAdvancement:1.pool0 合法候选不足：需 2，前面槽位只落了 1 个
```

表面看是 harness 选技能没有前瞻（牧师职业技能池 {his, ins, med, per, rel} 选 2，与领域池交集只有 his/rel，填值器只落了 1 个）。但顺着挖下去发现**真根因在包数据**：就算 harness 有完美前瞻、把职业技能两个坑都给了 his/rel，落出来的卡依然比 PHB 少 2 项熟练——因为包里根本没有"授予"这一层，expertise 槽只能双倍已有的、永远给不了新的。harness 前瞻治标不治本，故拍板修包。

## 3. 问题本质：三段规则建了两段

PHB 2014 原文（Knowledge Domain, Blessings of Knowledge）：

> "At 1st level, you learn two languages of your choice. You also become proficient in your choice of two of the following skills: Arcana, History, Nature, or Religion. Your proficiency bonus is doubled for any ability check you make that uses either of those skills."

arcane 包（`arcane-dnd5e-2014-automation.subclasses`，identifier `knowledge-domain`，名称「知识领域 Knowledge Domain」）L1 实测（COS 世界，Foundry 13.351 / dnd5e 5.3.3，2026-09-17 经 fvtt-cli debug-eval 取数）：

| advancement id | 标题 | 模式 | 配置 | 对应规则段 |
|---|---|---|---|---|
| `U054nyZPLUmE6cBU` | 知识祝福 | `default` | choices: [{count 2, pool: `languages:standard:*` + `languages:exotic` + `languages:exotic:*`}] | ① 语言 ✓ |
| `RfNcL3EpBJbmd0kG` | 知识祝福 | `expertise` | choices: [{count 2, pool: `skills:arc/his/nat/rel`}] | ③ 双倍 ✓ |
| — | — | — | **缺失** | ② 授予熟练 ✗ |

关键机制事实：dnd5e 原生 `TraitAdvancement.apply` 里，`mode === "expertise"` 且目标当前值为 0（未熟练）时**静默跳过、不写任何值**。expertise 模式只双倍、不代授。所以"授予"必须由一个独立的 default 模式槽完成，包里没有就是没有。

后果量化：牧师职业技能池 ∩ 领域池 = {his, rel}。职业技能没选这两条的知识领域牧师（完全合法的建法，如职业技能选 Insight + Medicine），知识祝福的技能部分**整段落空**——无报错、无提示，比 PHB 少 2 项技能熟练。

SRD 官方包（`dnd5e.subclasses`）无知识领域（不在免费 SRD 5.1 范围），没有官方模板可对照；但同包"授予熟练"的通行建模就是 default 模式 Trait advancement（如生命领域 `armor:hvy` 的 grants），照此办理即可。

## 4. 修法：改动内容

### 4.1 知识领域 L1 补授予槽

给 `knowledge-domain` 子职业 L1 新增一个 Trait advancement：

- **title**：沿用「知识祝福」（与现有两槽同名，符合包内惯例；如需区分可用「知识祝福（技能熟练）」）。
- **type**：`Trait`。
- **configuration**：
  - `mode: "default"`
  - `allowReplacements: false`
  - `grants: []`（走 choices，不走固定 grants——规则是四选二）
  - `choices: [{ count: 2, pool: ["skills:arc", "skills:his", "skills:nat", "skills:rel"] }]`
- **id**：新生成稳定 16 字符 id。

现有的 expertise 双倍槽（`RfNcL3EpBJbmd0kG`）与 default 语言槽（`U054nyZPLUmE6cBU`）**保持不动**。

### 4.2 排序无需干预（但请在验证中断言）

dnd5e `TraitAdvancement.sortingValueForLevel` 的 modeOrder 把 `default` 排在 `expertise` 前，新增授予槽天然先于双倍槽 apply——先授予、后双倍，正是规则语义。该排序已被 arcanedesk 侧 bard/逸闻学院案实证（授予槽先落、专精槽从已落项里挑）。实施时无需手工排序，但建议验证器加一条"同 L1 三个 Trait 槽的排序值：default 技能槽 < expertise 技能槽"的断言防回归。

### 4.3 与 arcanedesk 工具链的相容性（已确认，零工具改动）

- 授予槽落下后，专精槽的合法候选 = 授予槽落下的 2 项（外加职业技能可能覆盖的 his/rel），"先授予后双倍"链路完整。
- arcanedesk runtime 2026-09-16 刚上的"default 模式槽拒绝重复选取已熟练 trait"纪律与本修法不冲突：授予槽先落、专精槽模式为 expertise 不走该分支。
- harness（`e2e-advance-matrix.mjs` fillChoices）的专精槽模型就是"只能从前面槽位已落的 trait 里挑"，授予槽补上后候选自然充足，**harness 不需要前瞻改造**。

### 4.4 实现约束

同 bonus-proficiency spec：

- **生成器是唯一真源**：改动落在内容源/生成器输入，重建 pack；禁止手改 `packs/*.ldb` 或线上 Foundry 文件。
- 本 spec 不锁定具体文件与行号，以仓库当前管线与《职业自动化开发规范》为准；职业类改动前先读该规范（私有 repo AGENTS 强制）。
- **不回填已建角色**：子职业条目建卡时已拷贝进角色，存量知识领域角色身上的 advancement 快照不变。如有存量角色，由 DM 手工处理或重建，模块侧不做迁移。
- 本 spec 不新增 feat 条目、不引入任何规则书描述文本，无授权红线。

### 4.5 验证器断言

按现行管线为知识领域加断言：

- L1 存在 3 个 Trait advancement：default 技能池（四选二）、default 语言池（选 2）、expertise 技能池（四选二），池键与第 3 节表格逐项一致；
- 排序断言（见 4.2）。

## 5. 验收标准

1. `npm run build:internal` 成功，`npm run validate:internal` 全绿（含 4.5 新断言）。
2. `build-summary.json` diff 仅出现知识领域 L1 一个新 advancement；无 uuid 泄漏；图标 WARNING 为空（本改动不涉及图标）。
3. 本地部署 COS 后 API probe：`knowledge-domain` L1 advancement 含新 default 技能槽，池为 `skills:arc/his/nat/rel`、count 2。
4. **e2e 对账（核心验收）**：在 arcanedesk-prep-play worktree 跑 `node scripts/e2e-advance-matrix.mjs --port 9230 --subclasses-of cleric`，`A3s-knowledge-domain` 案在 harness 零改动的前提下转绿（当前红，报错见第 2 节）。
5. UI 冒烟：新建 1 级牧师，职业技能故意不选 his/rel（如选 Insight + Medicine），进阶知识领域：知识祝福应弹出**两个**选择槽——先授予 2 项技能熟练（traits 写 1），再双倍 2 项技能（traits 写 2），外加 2 门语言。最终卡面比修法前多 2 项技能熟练。

## 6. arcanedesk 侧联动（提出方负责，不在本 spec 实施范围）

- 矩阵 spec（`foundry-prep-e2e-matrix-spec.md` §2.1b）的 cleric 条目已改写为指向本 spec；**修包前该案保持红 = 设计意图，不做豁免、不做 harness 前瞻**。
- 修包落地后由提出方重跑 `--subclasses-of cleric` 确认转绿，并顺手回归核心 32 案。
- 工具、skill、runtime 均无需任何改动。

## 7. 附录 A：剑圣宗远程武器过度授予（同一包主，顺带修）

同包另有一处内容数据问题，已在 sweep 二扫中登记，一并交给修包人：

`way-of-the-kensei`（剑圣宗 Way of the Kensei）L3「剑圣武器（远程）」（advancement id `rxzZASzhM1wpndsL`）建成：

- `mode: "default"`，`choices: []`，`grants: ["weapon:sim:dart", "weapon:sim:lightcrossbow", "weapon:sim:shortbow", "weapon:sim:sling", "weapon:mar:blowgun", "weapon:mar:handcrossbow", "weapon:mar:longbow"]` —— **7 件远程武器熟练全部固定授予**。

XGE 原文（Kensei Weapons）："Choose two types of weapons to be your kensei weapons: one melee weapon and one ranged weapon."——远程同样是 **7 选 1**，不是全授。落卡比规则多 6 件熟练。

对照：同条目 L3「剑圣武器（近战）」（`udGLth7QYlXXvjzg`）建模正确（choices: [{count 1, pool: 21 显式键}]，grants 空）。

修法：把远程槽的 7 个键从 `grants` 挪进 `choices: [{ count: 1, pool: [...7 键] }]`，`grants` 置空。

已知联动（不阻塞修包）：arcanedesk 工具侧当前 `isSupportedPool` 白名单不含 `weapon:` 族，该选择槽会落 uncoveredRequiredSteps（工具缺口另案跟踪）；**包侧先把数据修对**，原生 UI 流程永远可用，工具支持随后跟上。

## 8. 附录 B：关键证据索引

实测环境：COS 世界（30002 端口），Foundry 13.351，dnd5e 5.3.3，2026-09-17，经 fvtt-cli debug-eval 直接读包文档。

- 知识领域包数据：`arcane-dnd5e-2014-automation.subclasses`，identifier `knowledge-domain`。L1  advancement 清单：2× ItemGrant（领域法术 / 职业特性）+ 2× Trait（见第 3 节表格），**无第三个 Trait 槽**。
- expertise 静默跳过语义：`dnd5e.mjs` `TraitAdvancement.apply`，`mode === "expertise"` 且 `existingValue === 0` 分支无任何写入。
- 排序证据：bard/逸闻学院案（arcanedesk 侧，2026-09-16/17）——授予槽先落、专精槽从已落项挑，sweep 8/8 绿。
- harness 报错原文与填值器模型：`scripts/e2e-advance-matrix.mjs` fillChoices（约 139-164 行），专精槽合法候选 = candidates ∩ 前序槽位已落 trait。
- 剑圣宗包数据：同包 `way-of-the-kensei` L3 三个 Trait advancement 全量 dump（书画之道工具二选一 ✓、近战 21 选 1 ✓、远程 7 全授 ✗）。
- sweep 总账与四红分类：`apps/desktop/docs/foundry-prep-e2e-matrix-spec.md` §2.1b「扩展层二扫结果」。
