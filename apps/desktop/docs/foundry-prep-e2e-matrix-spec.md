# 备团写路径 e2e 矩阵 spec

状态：待审查。约束对象：`scripts/e2e-advance-matrix.mjs`（待写）及其验收口径。
读者：本工具链的维护者。本文不定模型行为，只定**工具自身的写路径回归**——
模型 benchmark（deepseek）以本矩阵全绿为前置，二者不混跑。

## 1. 背景与目的

2026-09-16 的槽位寻址改造（`foundry-prep-tools-spec.md` §13）是破坏性变更：
`choices.bySlot` 取代共享桶、混合 ASI fixed 并入、trait 审计改叶存储口径。
单测（166 个 vm fixture）证明逻辑正确，但 fixture 的 advancement 类是模拟的，
证明不了真实 dnd5e 5.3.3 + arcane 模块数据下"所有职业/种族都能写"。

本矩阵就是那个证明：**对 2014 规则的全部职业 × 一个选择面复杂的种族、
最简单职业 × 全部种族、外加一案 NPC 回归，各跑一次 create → plan → advance 正路，
用统一 oracle 验收回执**。harness 是确定性脚本，无大模型参与。

## 2. 矩阵

### 2.1 轴 A：高等精灵 × 全职业（13 案）

种族固定为高等精灵 High Elf（`arcane-dnd5e-2014-automation.races`，
identifier `high-elf`）：种族侧带戏法选择（法师池）、固定 ASI（dex+2/int+1）、
额外语言——种族侧 choice 覆盖面最复杂的精灵亚种。

| # | 职业 | 子职业（按 plan 池名称子串匹配） | 考点 |
|---|---|---|---|
| A1 | 野蛮人 Barbarian | 狂战士 Berserker | 无施法基线 |
| A2 | 吟游诗人 Bard | 勇气学院 Valor | known 施法 |
| A3 | 牧师 Cleric | 生命领域 Life | fullSpellList + 领域授予 |
| A4 | 德鲁伊 Druid | 大地结社 Land | fullSpellList |
| A5 | 战士 Fighter | 战斗大师 Battle Master | 子职业侧选择槽（战技池） |
| A6 | 武僧 Monk | 散打宗 Open Hand | 无施法 + 资源 |
| A7 | 圣武士 Paladin | 奉献之誓 Devotion | fullSpellList（半施法者） |
| A8 | 游侠 Ranger | 猎人 Hunter | known 半施法者（2014） |
| A9 | 游荡者 Rogue | 窃贼 Thief | 专精槽（mode:"expertise"） |
| A10 | 术士 Sorcerer | 龙族血脉 Draconic | known + 已验证案回归 |
| A11 | 魔契师 Warlock | 邪魔 Fiend | pact 法术位 + known |
| A12 | 法师 Wizard | 塑能学派 Evocation | 法术书 book 路径 |
| A13 | 奇械师 Artificer | 炼金术士 Alchemist | fullSpellList + 工具熟练 |

子职业名称为预期映射，harness 以 plan `subclass-uuid` 候选池实际下发为准按名称
子串解析；解析不到即判失败并列出池内容，不静默换子职业。

### 2.1b 扩展层：高等精灵 × 全职业 × 全子职业（约 120 案）

轴 A 的 13 个挑选子职业只是核心层。子职业侧自己的选择槽（战斗大师战技池、
图腾武士图腾选择等 `subclass:` 前缀步骤）是槽位寻址改造后最该被回归的路径，
挑选制盖不住——故扩展层对 plan 候选池下发的**每一个** 2014 子职业各跑一案，
种族仍固定高等精灵，oracle 与填值器不变（全通用，零特判）。

两层门禁口径不同：

- **核心 32 案**（轴 A 13 + 轴 B 18 + NPC 1）：每次改工具必跑，必须全绿，
  不允许豁免。
- **扩展约 120 案**：benchmark 前/定期全量跑。失败分两级归类——**工具缺陷**
  （填值器按规则填了还被拒/落地错，修法与核心案相同，回归进单测）与
  **内容数据**（TCE/龙枪等扩展子职业 advancement 结构本身异常，记入报告
  已知清单，修模块数据另开工作项，不阻塞工具合入）。

运行量级：扩展层每案 30-60s，全量约 1-2 小时；`--filter` 随时切子集。

**扩展层首扫结果（战士，2026-09-17）**：10 案跑通，但抓到奥法骑士假绿——落卡
3 环位 0 环法照绿（子职业施法不走 advancement：环位由系统按
`spellcasting.progression="third"` 自动派生，环级法术原生就是手工拖卡，plan 无槽、
表无行、oracle 无查）。修复：oracle 补"环位非空但无 budget 且环级法术为 0"兜底断言
（假绿正确转红）+ runtime 三环表 budget 下发（见 foundry-prep-tools-spec §3.2
spellBudget 子职业施法条）。诡术师（游荡者）同形态，`--subclasses-of rogue` 已回归
9/9 绿（法术 4 个 1 环按法师列表落卡）。

首扫登记的已知问题（均不阻塞工具合入）：

- **内容数据**：arcane 包诡术师缺"自选 2 个法师戏法"的 ItemChoice advancement
  （奥法骑士有对应槽，诡术师只有 Mage Hand 固定 ItemGrant）——规则上 3 级诡术师是
  Mage Hand + 2 自选戏法，落卡少 2 个自选。修模块数据另开工作项。
- **回执口径**：`cantripsBySource`/`spellsBySource` 把 activity 缓存法术
  （`flags.dnd5e.cachedFor`，原生"经活动施法"的副本）计为 granted 桶——诡术师案的
  法师之手因此呈 subclass 1 + granted 1（缓存副本）。不是重复 bug，但对账口径应排除
  cachedFor 条目，候选修正暂记。

### 2.2 轴 B：冠军勇士 × 全 2014 种族（18 案）

职业固定为战士 + 冠军勇士（无施法、最少 choice，把变量压到种族侧；它也是
轴 A 换成战斗大师之后保留的"最简单职业"基准）。
种族清单以 browse `type:"race"` 目录实际下发为准（2026-09-16 实测 18 条）：

| identifier | 名称 | 预期考点（以 plan 实际下发为准） |
|---|---|---|
| human | 人类 | 固定 +1 全属性 |
| variant-human | 人类(变体) | 专长 pool-uuid + 技能 |
| half-elf | 半精灵 | 混合 ASI（cha+2 固定 + 2 浮动）+ 变体 ItemChoice |
| high-elf | 高等精灵 | 戏法池 + 固定 ASI |
| wood-elf | 木精灵 | 固定 ASI |
| drow | 黑暗精灵 | 固定 ASI + 种族法术授予 |
| dragonborn | 龙裔 | 吐息武器自动授予 |
| hill-dwarf | 丘陵矮人 | 固定 ASI + HP 上限加成 |
| mountain-dwarf | 山地矮人 | 固定 ASI |
| stout-halfling | 敦实半身人 | 固定 ASI |
| lightfoot-halfling | 轻足半身人 | 固定 ASI |
| forest-gnome | 森林侏儒 | 固定 ASI + 戏法授予 |
| rock-gnome | 岩侏儒 | 固定 ASI |
| half-orc | 半兽人 | 固定 ASI |
| tiefling | 提夫林 | 种族法术授予 |
| tiefling-levistus | 提夫林(莱维斯图斯) | 遗产法术授予 |
| aasimar-mpmm | 阿斯莫 | MPMM 式 ASI（自选点） |
| kender-dsotdq | 坎德人 | 龙枪设定种族 |

### 2.3 NPC 回归（1 案）

狼人 Werewolf + 战士 5 级（冠军勇士）：怪物复制建档（`actor-create`
`source.kind:"compendium"`，来源由 browse/search 解析，优先 arcane 怪物包，
回退 dnd5e SRD 怪物包并记录），再走 plan/advance。

考点：怪物体型骰 HP（无首级满骰、无 hpFill）、`preservation.changed` 为空
（原怪物的天生护甲/变身/免疫分毫未动）、护甲与武器熟练的
`TRAIT_GRANT_NOT_LANDED` 警告**预期出现**（NPCData 无这两个字段，原生静默丢弃的
显性化，见设计契约 2026-09-16 记录）——本案 warnings oracle 方向与 character 轴相反。

## 3. harness 设计

### 3.1 形态与入口

- 单文件脚本 `scripts/e2e-advance-matrix.mjs`，root package.json 加
  `"test:e2e:advance": "node scripts/e2e-advance-matrix.mjs"`——"集中启动"就这一个
  命令，不接 CI runner、不进 GitHub Actions（GitHub 托管 runner 跑不了授权软件
  Foundry + 世界数据；单元层回归仍由既有 `npm test` 承担）。
- 参数：`--port <cdpPort>`（默认 9222）、`--host`、`--world <origin,id>`、
  `--filter <正则>`（只跑匹配案，调试单案用）、`--subclasses-of <cls>`（扩展层：
  逐职业全子职业扫描——建一次性 probe 卡跑 plan 拿权威子职业池，每子职业一案，
  案 id `A5s-<identifier>`；browse 仅用于反查 identifier；sweep 案 `spells:"auto"`，
  按 plan.spellBudget 形状自适应 known/book/fullList）、`--keep`（不清理测试 actor）。
  池来源是 plan 的 subclass-uuid 槽而非 browse：plan 池是 advance 实际接受的集合，
  且自动按职业 rules 排除跨规则条目（browse 目录不传 rules 时不排除，2026-09-17 实测
  2014 战士池混入 2024 Champion——browse 侧已知不对称，调用方显式传 rules 对齐）。
- 依赖：一个活着的、GM 已登录的 Foundry 标签页（COS 世界、dnd5e 5.3.3、
  arcane 模块启用），经 fvtt-cli 直连（directCdp）。harness 以子进程调
  `packages/fvtt-cli/dist/cli.js`，不走网络服务。

### 3.2 每案流程（确定性）

1. `actor-create`：空白 character（NPC 案为 compendium 复制），名称
   `e2e·<案号>`，基础属性按职业主属性表固定分配标准数组（15/14/13/12/10/8）。
2. `advancement-plan`（不带 subclassUuid）→ 按轴表名称解析子职业。
3. `advancement-plan`（带 subclassUuid + raceUuid）→ 最终 choiceRequirements。
4. 法术（仅 known/book 职业）：`compendium-browse` `type:"spell"` 传同一
   classUuid，按 `eligibility:"legal"` 过滤分页取数——戏法取满
   `spellBudget.cantrips`（maxLevel:0），已知/法术书取满 `known`/`book`
   （环位 ≤ 目标级最高法术位）。同名双版本取 2014/arcane 行。全程不背名单。
   fullList 职业不选法术，advance 传 `fullSpellList:true`。
5. `actor-read` 取 readState。
6. `actor-advance` 一次调用：`actorAdvanceArgs` 原样 + `choices.bySlot` 按
   `choicesTemplate` 骨架填值 + 法术随 `additionalItems`。
7. oracle 断言（§3.4），收报告。
8. 清理：通过案默认删除测试 actor（gated debug-eval，仅删 harness 自建 id）；
   失败案保留供排查；`--keep` 全保留。

### 3.3 填值器规则（确定性，无随机）

- `trait-key` 池：取 `candidates` 前 `count` 个。
- `pool-uuid` 池：取 `candidates` 前 `count` 个（专长/变体/超魔法同法），但先排除
  已被 `additionalItems` 占用的 uuid——种族戏法与职业自选撞重会被 grant dedup 吞掉
  一个，职业侧就少一张（2026-09-17 复跑 A10/A12 实测）。
- `asi-assignment` / `asi-or-feat`：固定走 `abilityScore` 分支，按职业主属性表
  顺序分配浮动点（cap 内，total 精确等于 points）。`asi-or-feat` 的 `feat` 分支
  由单测覆盖，矩阵不考（2014 变体人类专长走的是 pool-uuid，已有覆盖）。
- `subclass-uuid`：顶层入参，不进 bySlot。

### 3.4 oracle（每案断言，全过才算绿）

通用（character 轴）：

1. `status === "completed"`，`warnings` 为空数组。
2. 属性守恒：每属性 `after === before + race + asi`；轴 A 高等精灵断言
   dex race+2、int race+1；半精灵案断言 cha race+2（混合 ASI fixed 并入）。
3. 施法契约（职业侧口径）：施法职业 `cantripsBySource.class + cantripsBySource.granted ===
   spellBudget.cantrips`，known/book 同理对 `spellsBySource`；fullList 职业
   `spellFill.count === fullList.count`。种族/子职业白送的戏法与环法（高等精灵戏法、
   大地附赠戏法、提夫林地狱斥喝）经 `advancementOrigin` 落进 race/subclass 桶，
   不与职业配额对账。（2026-09-17 首轮全案差 1 的教训：卡面总数 ≠ 职业配额。）
4. creation 收尾：`hp.value === hp.max`；施法者 `slotFill` 存在。
   （`hpFill` 只在发生拉满时才出现在回执里——种族不加 con 时无漂移、自然满血，
   不当必填。）**施法兜底**：卡面环位非空但 plan 无 spellBudget 且环级法术为 0 →
   判失败（未对账的施法能力；2026-09-17 奥法骑士假绿抓出此盲区）。
5. `grantedItems` 同时含职业、种族、子职业来源条目。
6. `uncoveredRequiredSteps` 为空（plan 阶段断言）。

NPC 案（方向相反的几条）：`warnings` 只允许 `TRAIT_GRANT_NOT_LANDED`；
无 `hpFill`；`preservation.changed` 为空；HP 每级体型骰均值。

### 3.5 输出与报告

- 控制台逐案一行：`A3 牧师×高等精灵 ✅ 1.2s` / 失败打断言明细。
- JSON 报告落盘 `tmp-e2e/advance-matrix-<时间戳>.json`（gitignore）：每案的
  plan 键集、bySlot 键集、回执 verification 摘要、断言结果、耗时。
- 退出码：全绿 0，任何一案失败 1。

## 4. 执行顺序（已定）

1. 本 spec 审查定稿。
2. 实现 harness，先跑 4 案小样（A5 战斗大师战士、A12 法师、A3 牧师、B 半精灵
   战士）验证 harness 自身，再跑核心 32 案。
3. 记录问题 → 修复 → 回归测试（单测层能固化的进单测）→ 核心 32 案复跑全绿。
4. 核心全绿后跑扩展层（全子职业约 120 案）：工具缺陷照修，内容数据问题登记
   已知清单。
5. commit & push。此后才启动 deepseek benchmark（前置检查：benchmark harness
   若内嵌旧 choices schema 需先同步）。

## 5. 非目标

- 不考 2024 规则版本（工具能力对齐见 foundry-prep-tools-spec.md 已知限制）。
- 不考装备下发（D6 从简教义已覆盖；additionalItems 由法术路径顺带考）。
- 不考兼职（multiclass）：当前工具链未支持，不在本矩阵。
- e2e harness 本身不含模型；模型参与的质量评测由 §6 的 matrix suite 承接。

## 6. 模型 benchmark 对接（matrix suite）

e2e 矩阵回答的是"工具能不能写对"；本节回答"模型用工具写，相比裸 JS 有没有
更省力、更成功"。两者共用同一套案例定义（A/B/C 三轴同义配置），但判定哲学
不同：e2e 是确定性填值器的逐槽断言，matrix suite 是模型自由发挥后的终态快照
判定。

### 6.1 案例与双臂

- MVP 三案（先跑通，再扩到 32 案全量）：**A5**（高等精灵×战斗大师战士，
  非施法+子职业选择槽）、**A12**（高等精灵×塑能法师，法术书+种族戏法最难
  路径）、**C1**（狼人+战士 5 级，NPC 复制建档）。案例配置与
  `scripts/e2e-advance-matrix.mjs` 同义，定义在
  `test/character-benchmark/matrix-model-adapter.cjs` 的 `MATRIX_CASES`。
- 双臂（复用 benchmark 既有配对语义，同一 case 同模型连续跑）：
  - `matrix_tool`：完整生产 prep 工具集 + 生产 Prep prompt + 注入
    arcane-actor-update / arcane-content-catalog / character-benchmark 三份
    skill（hash 冻结断言，批次内不许漂移）。
  - `matrix_js`：过滤掉 newTools 全集（即既有 `"js"` 臂语义），只给
    character-benchmark 共享 skill + 中性 browser_evaluate 路由。**裸 JS 臂
    跑通一轮后结果永久钉死存档，此后迭代工具只重跑工具臂。**

### 6.2 prompt 哲学：自由发挥 + 不做限制

prompt 只钉四个硬约束 + 命名：职业 / 子职业 / 种族（或怪物）/ 等级。属性、
技能、法术、装备全部由模型自选。两臂同文，公平性由同文保证。不写"禁止翻
源码"之类的禁令——模型绕开工具走裸 JS 是工具不好用的强信号，正是我们要
收集的数据。

### 6.3 判定器：probe 期望 + 终态快照（双臂同标准）

不用回执判定（裸 JS 臂没有回执），统一用终态快照 + 纯函数判定
（`judgeState`，单测 `matrix-model-adapter.test.mjs`）：

1. **setup（probe）**：建一张探针卡（NPC 案先复制怪物源）→ 用 runtime 的
   `advancementPlan` 跑一遍同配置计划 → 提取期望（子职业 UUID、技能池与
   选择数、ASI 点数、种族固定加成与种族戏法数、生命骰、法术预算、怪物源
   快照 sourceBefore）→ 删探针。期望与工具同源——模型应当拿到的计划就是
   判定依据，judge 与 tool 同一个真理来源。probe plan 若报
   `uncoveredRequiredSteps` 非空则该案不适合自由发挥判定，setup 直接抛错。
2. **verify**：页内采集终态快照（abilities/hp/skills/items 含 sourceId），
   调 `judgeState`。全部检查选择无关：
   - 属性总和守恒（标准数组 72 + 种族加成 + ASI 点数），单项 3..20；
     NPC 方向相反：原属性保留，只允许 ASI 增量（单项 ≤2）。
   - HP：character 首级满骰 + 后续均值（职业骰）；NPC 每级体型骰均值（原生口径，
     hitDie 由 probe 卡 traits.size 映射：tiny d4 / sm d6 / med d8 / lg d10 /
     huge d12 / grg d20）、无首级满骰；conMod 从终态推导；`hp.value === hp.max`。
   - 法术：戏法总数 = 职业预算 + 种族白送；book/known/fullList 按预算精确
     计数；环级不超预算上限。
   - 技能：熟练数 = 职业选择数 + 固定熟练（character：职业/种族 Trait
     advancement 的固定 grants，如高等精灵 keen senses 的 skills:prc；
     NPC：来源自带）；职业自选部分须落在 plan 枚举池内。注意去重语义：
     自选与固定熟练重叠会被 dnd5e 去重、熟练数变少——判 fail，因为
     "浪费一个选择"正是要抓的质量瑕疵。
   - NPC 案另查来源条目逐条保留（按 类型+名称）。
3. 矩阵案全部视为 npcCases：验收后 `retainedForReview`，不自动删卡，人工
   审查后手动清理。

### 6.4 运行

前置：30002 COS 世界在线（模块就绪），先生成 fixture 报告：

```
ARCANE_FVTT_ORIGIN=http://127.0.0.1:30002 ARCANE_FVTT_CDP_PORT=9230 \
  node apps/desktop/test/setup-prep-benchmark.mjs --target=local-cos
```

套件配置（`C:/qa/suite-v9-matrix.json` 样式）：

```json
{
  "fixtureReport": "<上一步生成的 fixture 路径>",
  "outputDir": "C:/qa/batch-v9-matrix-<ts>",
  "comparison": "matrix",
  "taskTimeoutMs": 300000,
  "cases": ["A5", "A12", "C1"],
  "models": [{ "profile": "C:/qa/kimi-a3", "provider": "deepseek-for-benchmark", "model": "deepseek-flash" }]
}
```

```
node apps/desktop/test/character-benchmark/run-suite.mjs --config=C:/qa/suite-v9-matrix.json   # 先 --dry-run
```

run-suite 对 matrix 不传 `--character-suite`；指纹集含
matrix-model-adapter.cjs，批次中途改适配器会触发 inputs-changed 中止。

### 6.5 从 MVP 到 32 案

1. MVP 3 案×双臂（6 trial）跑通，读报告：工具臂 vs 裸 JS 臂的迭代数 / 耗时 /
   成功率；裸 JS 臂结果钉死。
2. 把 `MATRIX_CASES` 补全到与 e2e 核心矩阵同构的 32 案，重跑工具臂。
3. 扩展层（全子职业约 120 案）按需，先解决内容数据已知清单。
