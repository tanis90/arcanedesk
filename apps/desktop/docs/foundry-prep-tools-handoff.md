# arcanedesk 备团工具链 v1 + A1-A3 缺口修复 交接

> 分支：`codex/foundry-prep-play`  
> 最新提交：`c44dfb2` feat: prep toolchain v1 + A1-A3 self-run gap fixes  
> 日期：2026-09-15

## 1. 我们在做什么

为 `arcane-desk` 的**备团模式**（prep mode）建一套结构化 Foundry 工具，让 LLM 在创建/升级 2014 版角色时尽量少用裸 JS。核心思路：把"发现"和"写入"都变成有 schema、有回执的工具调用，模型只负责做选择，计算交给 dnd5e。

完整 spec 见 `apps/desktop/docs/foundry-prep-tools-spec.md`。

## 2. v1 工具链全貌

### 2.1 发现工具（只读）

| 工具 | 定位 | 关键输出 |
|------|------|---------|
| `foundry_advancement_plan` | 升级计划唯一来源 | `automaticSteps`、`choiceRequirements`（带 `candidates`/`candidateNames`/`fill`/`valueFormat`）、`spellBudget`、`actorAdvanceArgs` |
| `foundry_compendium_browse` | 条件枚举 + uuids 读全文 | type: `class`/`subclass`/`race`/`spell`/`item`，按 `rules`/`identifier`/eligibility 过滤 |
| `foundry_content_search` | 身份解析兜底 | 按 name/identifier 找精确 UUID |

- 目录按 `rules+identifier` 去重，arcane 模块包优先，2014/2024 双版本各自成行。
- `rules` 不传，由 `classUuid` 锚定推导。

### 2.2 写入工具（写后带 receipt）

| 工具 | 用途 |
|------|------|
| `foundry_actor_create` | 建空白/compendium Actor；**主路径**带 `dnd5e.abilities` 标准数组 |
| `foundry_actor_update` | 改名字/HP/AC/属性/token；`dnd5e.abilities` 是修正路径 |
| `foundry_actor_grant_items` | 零散授予，按来源去重 |
| `foundry_actor_advance` | 一次完成升级，装备/法术走 `additionalItems`，`fullSpellList` 授满准备施法者 |

- 所有写工具走 `readRef`（`foundry_actor_get` 先读），回执即对账。
- fvtt-cli 已同步：`actor-create`、`actor-edit`、`actor-grant-items`、`actor-advance` 等命令。

### 2.3 教义与 skill

- `arcane-content-catalog`：三次拿全教义——`browse class` → `advancement_plan`（拿子职业池）→ `browse race`。
- `arcane-actor-update`：写工具链 + 回执即对账；0 级建档 advance 自动满血。
- 共享契约：`apps/desktop/docs/skill-design-contract.md` §6 记录了所有关键决策。

## 3. 本轮已修复的 A1-A3 缺口

| 缺口 | 修法 | 状态 |
|------|------|------|
| browse 法术 `eligibility` 恒为 name-match | identifier 层判定：模块 `spellClasses` 标注权威，dnd5e 注册表 identifiers 回退 | 已修，真实世界复验 wizard 33/50 legal |
| 子职业候选池不去重 | 按 `system.identifier ?? uuid` 去重，arcane 优先 | 已修，法师池 14→13 |
| pool-uuid/trait-key `candidateNames` 为空 | runtime `hydrateCandidateNames`：uuid 走合集 index，trait key 走 `Trait.keyLabel` | 已修，战士/牧师 plan 候选全部有名 |
| `actorEdit` 不支持 abilities | `create.dnd5e.abilities`（主路径，先于 advance）+ `edit.dnd5e.abilities`（修正路径） | 已修，create/edit 真实世界复验 |
| advance 后 `hp.value < hp.max` | 0 级建档 advance 收尾自动拉满（`hpFill` 回执），既有角色不动 | 已修，SDK 测试覆盖；真实世界复验待 benchmark 重跑 |

## 4. 验证结果

- **单元测试**：SDK 138/138 绿，desktop 496/496 + verify:source 绿，`verify:repo` 绿。
- **真人自测 A1-A3**：三张卡关键指标正确（A1 INT18/HP32/书14；A2 STR18/HP44/防御；A3 WIS16/AC18/法术37=fullList34+戏法3）。
- **真实世界复验**：8.1.2/8.1.3 已用 fvtt-cli 在 COS 世界跑通；8.1.4 因 QA 会话掉线未实测，将随 benchmark 重跑一并验证。

## 5. benchmark 现状（需要重跑）

### 5.1 校验什么

当前校验器：`apps/desktop/test/character-benchmark/verifier.cjs` 选 `v4`，其内部调用 `verify-v3.cjs` 做独立断言（不调用 builder）。主要检查（core 项不过 = 任务失败）：

- `actor.exists` / `actor.unique` / `actor.name`
- `class.level`、`class.subclass`
- `feature.*`：必有的职业/子职特性（如 `fighting-style`、`bonus-proficiency`、`arcane-tradition` 等）
- `features.level-ceiling`：没有超过当前等级的特性
- `abilities.legal`：标准数组 + 种族 + 合法 ASI
- `abilities.requested`：A1 INT=18、A3 WIS=16
- `hp.full`：value == max（这也是 8.1.4 的验收点）
- `movement.walk`、`proficiency.effective`、`saves.granted`
- `skills.selected` / `skills.abilities` / `skills.expertise`
- 施法：`spells.caster`、`spells.slots`、`spells.cantrips`、`spells.book`、`spells.known-membership`
- `fireball.ready`（A1/A3/B3）
- `resource.*`（second-wind、action-surge、channel-divinity）
- `gear.*`、`weapon.activity.*`、`armor.effective`
- B cases：源 Actor 类型/CR/效果/物品/图像保留

`verify-v3.cjs:14-92` 是全部检查实现；`source-aliases-v3.json` 做 SRD↔arcane 包别名映射。

### 5.2 模型拿到哪些工具、怎么拿到的

启动文件：`apps/desktop/test/character-benchmark/run-suite.mjs`

- 两个 arm：
  - `*_js`：裸 JS 基线（模型只能用 evaluate/browser_evaluate）
  - `*_tool`：工具臂，加载 `apps/desktop/src/main/foundry-tools.js` 里注册的工具
- `comparison` 模式有 `build-query` 和 `catalog`，当前推荐 `catalog`。
- 每个 trial 调用 `run-prep-benchmark.mjs`，模型通过 `model-adapter.cjs` 拿到与桌面端一致的 system prompt + skill + 工具面。

工具臂可用工具（即 desktop foundry 工具面）：

- `foundry_actor_get`、`foundry_actor_create`、`foundry_actor_update`、`foundry_actor_grant_items`、`foundry_actor_advance`
- `foundry_advancement_plan`、`foundry_compendium_browse`、`foundry_content_search`
- `foundry_image`（头像/token 图）

`run-suite.mjs:15` 生成 trial 列表，每个模型 two arms，顺序交替。

### 5.3 benchmark skill 教了模型什么

文件：`apps/desktop/test/character-benchmark/skill/SKILL.md`

- 六案都是 2014 规则；A 案建 `character`，B 案保留怪物 Actor 类型做扩展。
- 新卡：标准数组 15/14/13/12/10/8 + 种族 + 普通 ASI，无专长；人类非变体；矮人为丘陵矮人；未指定法师子职为塑能。
- HP：首 HD 取满，后续 PC 固定 HP + CON；丘陵矮人每级 +1 HP；满血/资源。
- 法师：法术书数量正确、戏法数量正确、必须有 Fireball；不限制高环法术分布。
- 准备施法者（牧师/德鲁伊/圣武士/奇械）：授予职业法术列表全部法术（到最高可用环），不管理 preparation 标记。
- B 案扩展：保留源怪物所有 items/effects/images/traits；新 HD 按体型；HP 公式见 skill；不手动改 CR 或 proficiency；Extra Attack 不加入 Multiattack。

### 5.4 如何重跑

参考配置：`C:/qa/kimi/suite-a123-r4.json`（或复制一份改 `outputDir`）。关键字段：

```json
{
  "models": [{ "model": "deepseek-flash", "provider": "deepseek", "profile": "C:/..." }],
  "fixtureReport": "C:/Users/.../prep-benchmark-fixture-*.json",
  "outputDir": "C:/qa/kimi/suite-a123-rNEXT",
  "cases": ["A1","A2","A3"],
  "comparison": "catalog",
  "taskTimeoutMs": 300000
}
```

命令：

```bash
cd apps/desktop/test/character-benchmark
node run-suite.mjs --config=C:/qa/kimi/suite-a123-rNEXT.json
```

重跑前确保：Chrome 调试端口 9230 可用、Foundry 页签在 `http://127.0.0.1:30000/game`、GM 已登录、fixture 场景激活。

### 5.5 当前基线

- A1：js 39 次 / tool 36 次
- A2：js 21 次 / tool 19 次
- A3：js 49 次（超时）/ tool 40 次

验收目标（spec §5，需按当前工具面重新评估）：A1 11~13 / A2 9~11 / A3 9~11；裸 JS=0；search=0；plan 每案 2 次。

## 6. 仍未关闭的项

| 项 | 说明 |
|----|------|
| `auto-grant` 枚举 | §8.1.1 尾巴：从职业/子职 ItemGrant advancement 枚举法术 identifier，自动标记 browse 候选 |
| spellBudget 兑现出口 | §8.2.5：法师戏法无原生 choice 步骤，需明确 `cantrips` 走 `additionalItems` |
| 装备发现教义 | §8.2.7：中文名不中改英文/identifier 片段；缺失如实报告 |
| 装备穿戴教义 | §8.2.8：`additionalItems` 防具/武器必须 `equipped:true` |
| spec §5 步数表自身修正 | §8.3：漏计 `actor_get` readRef、A1 法术页数预期不现实 |
| 8.1.4 真实世界复验 | 随 benchmark 重跑验证 A1/A2/A3 成卡后 `hp.full` 直接通过 |

## 7. 关键文件速查

- Spec：`apps/desktop/docs/foundry-prep-tools-spec.md`
- Skill 契约：`apps/desktop/docs/skill-design-contract.md`
- 运行时：`packages/foundry-sdk/src/runtime-source.ts`（由根目录 `tmp-runtime-work.js` 序列化生成）
- 工具定义：`apps/desktop/src/main/foundry-tools.js`
- SDK 契约：`packages/foundry-sdk/src/contracts.ts`
- benchmark 用例：`apps/desktop/test/character-benchmark/cases.cjs`
- benchmark 启动器：`apps/desktop/test/character-benchmark/run-suite.mjs`
- benchmark skill：`apps/desktop/test/character-benchmark/skill/SKILL.md`
- benchmark 校验：`apps/desktop/test/character-benchmark/verify-v3.cjs`
- source 别名：`apps/desktop/test/character-benchmark/source-aliases-v3.json`

## 8. 注意事项

- `tmp-runtime-work.js` 是 runtime 主源，当前未纳入 git（分支既有惯例），只提交序列化产物 `runtime-source.ts`。若需可追溯编辑，建议把 `tmp-runtime-work.js` 也加入版本控制。
- Foundry 13.351 + COS 世界是共享实例，**不要起自己的实例、不要动它**；写操作只通过 fvtt-cli / desktop 工具面。
- 当前分支与 main 的差异是探索性的，可破坏性变更。
