# ArcaneDesk 备团工具 Spec：角色创建路径

版本：2026-09-15 草案（待实施）
状态：取代 [foundry-content-catalog-spec.md](foundry-content-catalog-spec.md) 的工具面部分（其三工具
list/search/detail 设计中 detail 从未实现；本 spec 以 browse 的 uuids 模式吸收 detail 语义，
并根据 r4 批次实证重估其定位）。契约细节以 packages/foundry-sdk/src/contracts.ts 为准。

## 1. 背景与设计原则

目标：给备团模式的 LLM 一条低心智负担的角色创建通路——发现靠枚举不靠搜索，写入靠引用导入
不靠手工装配，对账靠回执不靠复查。

实证基线（2026-09-15 r4 批次，deepseek-flash，COS 世界，A 组三案两臂）：

| 用例 | 裸 JS 臂 | 现工具臂 |
|---|---|---|
| A1 人类法师5级 | 39 次调用（30 次裸 eval）196s 通过 | 36 次（14 次裸 eval）115s 通过 |
| A2 人类战士5级 | 21 次（17 次裸 eval）148s 通过 | 19 次（10 次裸 eval）105s 通过 |
| A3 矮人牧师3级 | 49 次（22 eval + 23 powershell）300s 超时失败 | 40 次（20 次裸 eval）137s，仅 1 项验收失败 |

现工具臂只比裸 JS 省 2~3 次调用，原因（轨迹实证）：发现阶段依赖 search（中文名命中率差）、
list 信息不全被迫裸 eval 读原文、create/update/grant 工具在工具集内激活但 skill 零教学、
模型不信任回执反复自检。本 spec 针对这四点。

设计原则：

1. **写入 = 引用导入**。advance/grant 从 compendium 原文档直接导入，法术 activities、
   装备攻击活动的保真与模型是否读过全文无关。detail 不再是写入正确性的前提（对 spec
   旧结论的修正：旧结论假设模型手工装配写入数据）。
2. **回执即对账**。写工具返回 verification；模型收到回执后不得再裸 eval 自检。
3. **rules 从锚推导或标注，模型默认不传**。有锚调用（plan、带 classUuid 的 browse）从
   职业文档推导（显式 `system.source.rules` > 包名含 `24` > 默认 2014）；无锚目录
   （class/race）双版本都返回、条目自带 `rules` 标注，模型按 DM 指令选行；`rules`
   参数仅作可选收窄。
4. **职责写死**。search 答"这个 UUID 是什么"（身份解析），browse 答"候选有哪些 +
   这几个的全文是什么"（条件枚举 + detail），plan 答"这次升级要填什么"。
5. **发现三次拿全**。browse(class) → plan（含子职业池与 spellBudget）→ browse(race)，
   三次调用获得全部决策信息；search 仅兜底。

## 2. 工具总表（角色创建路径）

| 工具 | 读/写 | 定位 |
|---|---|---|
| foundry_compendium_browse | 读 | 条件枚举 compendium 候选；uuids 模式读全文 |
| foundry_content_search | 读 | 身份解析：按名称找确切 UUID（仅兜底） |
| foundry_advancement_plan | 读 | 算"某 actor 拿某职业到 N 级"的完整升级计划 |
| foundry_actor_get | 读 | 读 actor 摘要与编辑投影，签发 readRef |
| foundry_actor_create | 写 | 建空白/compendium actor |
| foundry_actor_update | 写 | 有界字段修改（名称/HP/AC/token；基础属性建档） |
| foundry_actor_grant_items | 写 | 按 compendium 来源精确授予（去重不叠加） |
| foundry_actor_advance | 写 | 原生 advancement 一次写入 + additionalItems + fullSpellList |

角色路径外的工具（world_status、play/static_context、conditions_set、scene_*、image、
execute_action）不在本 spec 范围。

## 3. 逐工具 spec

### 3.1 foundry_compendium_browse（新；吸收 content_list 的 spell/item/weapon 与 detail）

定位：回答"满足条件的 compendium 候选有哪些"；uuids 模式回答"这几个 UUID 的完整定义是什么"。
不做资格最终裁决（eligibility 是提示，裁决以 plan 为准），不做世界范围查找（那是 search）。

```ts
input: {
  scope: "compendium";
  type: "spell" | "item" | "class" | "subclass" | "race";
  world?: { origin: string; id: string };
  // 通用过滤
  rules?: "2014" | "2024";       // 可选收窄；不传时双版本都返回（目录类）或按既有规则过滤（spell/item）
  query?: string;                // 名称/identifier 子串匹配（spell/item）
  names?: string[];              // ≤ 50 批量名解析（spell/item，与 query 互斥，不分页）
  page?: number; pageSize?: number;  // 仅 spell/item 分页，pageSize ≤ 50
  // type=spell
  maxLevel?: number;             // 0 = 戏法
  classUuid?: string;            // 候选带 eligibility：legal / auto-grant / name-match
  // type=item
  itemType?: "weapon" | "equipment" | "consumable" | "tool" | "loot" | "container" | "ammo";
  // type=subclass
  classUuid?: string;            // 解析为 classIdentifier 后过滤
  // uuids 模式（detail 形态，与 type 过滤互斥）
  uuids?: string[];              // ≤ 20，返回完整文档
}

output: {
  status: "completed" | "rejected"; code?: string; message?: string;
  // 枚举模式（type=class/subclass/race 不分页）
  candidates?: Array<{ uuid: string; name: string; identifier: string | null;
    packId: string; rules: "2014" | "2024" | null; classIdentifier?: string }>
  // 分页模式（type=spell/item）
    | Array<{ uuid: string; name: string; identifier?: string | null; type: string | null;
    level: number | null; packId: string; entryId: string;
    eligibility?: "legal" | "auto-grant" | "name-match" }>;
  // names 模式（type=spell/item）
  resolutions?: Array<{ query: string; status: "unique" | "ambiguous" | "miss";
    total: number; candidates: 分页模式行 /* ≤ 10 条/名，精确命中排前 */ }>;
  total?: number; page?: number; nextPage?: number | null;
  // uuids 模式
  documents?: Array<{ uuid: string; name: string; type: string; packId: string | null;
    summary: object; document: object }>;
  warnings?: object[];
}
```

语义备注：

- **names 批量解析**（D4）：法术/装备发现的首选形态——模型按记忆名单一次给 ≤50 个
  名字，每个名字**独立**做单一语言子串/identifier 匹配（禁止"火球 Fireball"式中英
  组合串），精确命中排前。unique 直接取 uuid；ambiguous 常见于跨规则版本重名（传
  rules 收窄，候选带 rules 标签）；miss 才翻页浏览或 search 兜底。
- **包范围**：全 Item 包扫描（含 arcane 模块包）；旧实现只扫 dnd5e 硬编码三包，是模型
  裸 eval 枚举模块包的真因。
- **去重**：key = `rules + identifier`（identifier 缺失退回 uuid）。同 key 合并、arcane 包
  优先（模块副本带自动化数据且经 tool 臂验证）；跨规则版本的同 identifier 条目各自成行。
  显式传 rules 时先过滤再去重。
- **weapon 折叠**：原 type:"weapon" 取消，由 type:"item" + itemType:"weapon" 吸收
  （实证零调用；语义上是 item 的子集过滤）。
- **uuids 模式**：吸收旧 spec 的 foundry_content_detail。返回 summary（规范化字段）+
  document（原生全文）。仅限两个用途：语义选择（DM 要"控场法术"这类理解题）与
  异常对账（授予不符预期时排查）。发现流程不得使用。

### 3.2 foundry_content_search（收窄，schema 不变）

定位：身份解析——"我知道它叫什么，给我确切 UUID"。仅三个合法用途：找世界内预制
actor、找 compendium 怪物（B 组复制源）、目录/browse 查无此物时的兜底。禁止用于条件
枚举（那是 browse）、禁止用于职业/种族/子职业发现（那是 browse 目录类型）。

```ts
input: { scope: "world" | "compendium"; documentType: "Actor" | "Item" | "Scene";
  query: string; packIds?: string[]; actorType?: string; itemType?: string;
  limit?: number; cursor?: string }
output: { entries: Array<{ uuid: string; id: string; name: string; type: string;
  documentType: string; entryId?: string; packId?: string; package?: string }> }
```

### 3.3 foundry_advancement_plan（原 content_list type:"classFeature"）

定位：回答"这个 actor 拿这个职业到 N 级，native 自动给什么、我必须填什么"。是
foundry_actor_advance 的唯一计划来源。

```ts
input: { actorUuid: string; classUuid: string; characterLevel: number;
  subclassUuid?: string; raceUuid?: string; world?: { origin: string; id: string } }
output: {
  status: "completed" | "rejected"; code?: string; message?: string;
  actorAdvanceArgs: { classUuid: string; subclassUuid?: string; raceUuid?: string;
    targetLevel: number };              // 原样传给 foundry_actor_advance
  automaticSteps: Array<{ slot: string; level: number; kind: string; label: string;
    summary?: string }>;                // advance 自动完成，禁止手工重复添加
  choiceRequirements: Array<{ slot: string; level: number; kind: string; label: string;
    count: number; valueFormat: string; key: string; candidates?: string[];
    candidateNames?: Record<string, string>; cap?: number; required: boolean;
    note?: string }>;
  choicesTemplate: Record<string, unknown>;  // 每个 bySlot 槽位的填空骨架，照抄改值即可
  spellBudget: { ability: string | null; progression: string; cantrips?: number;
    known?: number; book?: number;
    source?: "subclass";            // 子职业引入施法（三环）时标 "subclass"
    maxSpellLevel?: number;         // 子职业施法者：目标等级最高环位（browse maxLevel 回传）
    spellListClassUuid?: string;    // 子职业施法者：法术列表所在职业（2014 三环 = 法师）
    note?: string;                  // 规则提示（学派限制/固定戏法），不校验
    fullList?: { maxLevel: number; count: number;
      candidates: Array<{ uuid: string; name: string; level: number }> } } | null;
  coverage: { nativeStepCount: number; automaticStepCount: number;
    choiceStepCount: number; uncoveredRequiredSteps: string[] };
  warnings: object[];
}
```

**choiceRequirements.key（2026-09-16 槽位寻址定稿，取代 fill/fillAllocation）**：key 指明
这个选择填到 advance 入参的哪个位置——key 形如 `class:3:ItemChoiceAdvancement:0`
（即 slot 本身）的填到 `choices.bySlot[key]`；key 为 `subclassUuid` 的填顶层入参
`subclassUuid`。choicesTemplate 按 valueFormat 给骨架：`trait-key`/`pool-uuid` →
`[]`（数组，长度须等于 count）；`asi-assignment` → `{ "abilityScore": {} }`；
`asi-or-feat` → `{ "abilityScore": {} }` 且 note 注明可用 `{ "feat": "<uuid>" }` 替代。
同一升级里多个 ASI 节点（如职业 4 级 + 种族浮动）各占独立 slot、各填各的，
不再共享一个 abilityScore 键。

语义备注：

- **raceUuid 必带**（2026-09-15 定稿）：种族侧的技能/工具/语言 Trait 选择依赖
  raceUuid 才进 choiceRequirements（slot 带 race: 前缀）。发现顺序因此定为
  browse class → browse race → plan。
- **trait-key 候选一律具体化**：Trait 池里的通配符（如人类额外语言的
  `languages:*`）在 plan 出口用系统自带 `Trait.mixedChoices` 展开为具体 key
  （`languages:standard:elvish` 等 24 个）并附 candidateNames；模型照抄池中 key
  即可。注册表不可用时回退原始池，advance 侧匹配仍按通配符前缀语义接受具体 key。
- **trait 池可寻址族**（2026-09-17 扩）：模型可填的 Trait 选择池为
  skills/tool/languages 加防御族 `dr:`/`di:`/`ci:`/`dv:`（龙裔伤害抗性为准案，
  e2e B14）；其余族（weapon/armor/saves/senses 等）仍走原生默认值并在
  uncoveredRequiredSteps 显性报告，待矩阵案例驱动再扩。
- **NPC 支持**：actor 类型门为 character|npc。NPC（怪物加职业等级）的 HP 摘要
  按怪物体型骰（actor hd.denomination）下发"fixed N (dX average)"，无首级满骰。
- **子职业两次调用约定**：不带 subclassUuid 先拿计划（choiceRequirements 里
  valueFormat="subclass-uuid" 的步骤自带 candidates/candidateNames 池）；定下子职业后
  带 subclassUuid 重调一次，子职业自身的授予/选择步骤才会枚举（slot 带 subclass: 前缀）。
  **advance 接受 subclass: 槽位**（2026-09-17 定稿）：子职业步骤与 class/race 走同一条
  enumerate+normalize 管线——枚举用不落入世界的临时条目（避免与 SubclassAdvancement
  apply 插入的真卡重复），apply 时按 advancement id 映射到真卡上执行，授出条目的
  advancementOrigin 因此指向存活卡。plan 与 advance 的槽宇宙严格同源。
- **空池 ItemChoice 按 restriction 枚举**（2026-09-17 定稿）：pool 为空是 dnd5e 表达
  "按限制自选"的标准编码（高等精灵戏法 pool:[] + restriction.level:"0"，系统包与模块
  一致；原生 UI 在选择器里按 restriction 过滤）。plan 对这种槽按 restriction 枚举候选：
  spell+整数环 → 该环全部法术；feat → 全部专长；统一 identifier 去重、arcane 包优先、
  按 classUuid 锚定的 rules 版本过滤。不可枚举形状（level:"available" 的魔法奥秘、
  无 type 的条目）保持 candidates 缺省，视为已知边界。校验侧本就按 restriction 验收，
  枚举集是它的子集，天然自洽。
- **HP 永不进 choiceRequirements**（D1）：1 级满骰、后续级固定均值，dnd5e 原生计算；
  automaticSteps 给信息性摘要（"hp: max hit die (6) + con mod" / "hp: fixed 4 (d6
  average) + con mod"）。choices.hp 保留为 advance 隐藏覆盖项（DM 掷骰 HP 才传），
  plan 不下发、不询问。不做 HP 数值 preview（D2）——对错由验收夹具判断，skill 引导
  模型信任工具而非自行验算。
- **choiceRequirements 是唯一的填写清单**：key 指明填到 advance 入参的哪个位置
  （`choices.bySlot[key]`，或顶层 `subclassUuid`），candidates 是该步骤的合法候选池，
  从池中选，不凭记忆。
- **混合 ASI 的 fixed 部分进 automaticSteps**：fixed 非零且 points>0 的节点（半精灵
  +2 魅力 + 两点浮动）除浮动 choiceRequirement 外，另发一条
  "fixed ability bonuses: cha+2" 自动步——固定加成不需要模型填，但必须事前可见。
- **spellBudget.fullList**：准备施法者（2014 牧师/德鲁伊/圣武士/奇械）能会的全部法术
  （按环位上限枚举自模块标注包）。这类职业"会"整个职业法术列表，准备是 DM 与玩家
  游戏时决定的页签标记，工具不管理。配套 advance 的 fullSpellList 开关使用。
- **spellBudget 子职业施法（2026-09-17 定稿，取代"v1 放弃"）**：职业不施法而子职业
  `system.spellcasting.progression` 非空时（2014 仅奥法骑士/诡术师，全世界包扫描 +
  PHB 三环表逐行核实），按三环表下发 `known` + `source:"subclass"` + `maxSpellLevel` +
  `spellListClassUuid`（法师列表）。环级法术走 additionalItems（known 语义，browse 回传
  spellListClassUuid 拿 eligibility）；戏法不下发——走子职业自带 ItemChoice 槽，避免
  双口径。学派限制/固定 Mage Hand 进 `note` 提示，不校验。2024 子职业施法形态未调研，
  不下发。
- rules 由 classUuid 锚定推导，模型不传。

### 3.4 foundry_actor_get（现状不变）

读 actor 紧凑摘要 + 按需投影（items/resources/prototypeToken/sceneTokens），返回写操作
必需的 readRef。授予前必须 include:["items"]。返回不含完整 Item 文档（要全文走
browse uuids 模式）。

### 3.5 foundry_actor_create（现状不变，skill 新增教学）

```ts
input: { source: { kind: "blank"; actorType: "character" | "npc" }
       | { kind: "compendium"; packId: string; entryId: string };
  name: string; folderId?: string; initialItems?: CompendiumGrant[];
  prototypeToken?: { name: string } }
```

同名返回冲突；部分创建不自动重试。B 组怪物复制走 source.kind="compendium"。

### 3.6 foundry_actor_update（现状不变，skill 新增教学）

有界字段修改：name、folderId、prototypeToken、HP、flat AC，以及建档期基础属性
（标准数组分配等非 advancement 字段）。需要当前 readRef；画像/token 图片走 foundry_image。

### 3.7 foundry_actor_grant_items（现状不变，skill 新增教学）

```ts
input: { actorUuid: string; readRef: string; items: CompendiumGrant[] }  // 1..50
CompendiumGrant: { uuid?: string; packId?: string; entryId?: string;
  expectedName?: string; expectedType?: string; quantity?: number; equipped?: boolean }
```

按来源去重（已存在跳过，不叠加不替换），回执报 created/skipped。advance 之外的补充
授予出口；能走 advance.additionalItems 的优先走 advance（单次写入、统一回执）。

### 3.8 foundry_actor_advance（2026-09-16 槽位寻址定稿）

```ts
input: { actorUuid: string; readRef: string; classUuid: string; subclassUuid?: string;
  raceUuid?: string; targetLevel: number;
  choices?: {
    bySlot?: Record<string, SlotValue>;  // key 原样抄自 plan 的 choiceRequirements[].key
    hp?: "max" | "avg"                   // 隐藏覆盖（DM 掷骰 HP 才传），plan 不下发
  };
  additionalItems?: CompendiumGrant[];   // ≤ 50；法术书、装备同一出口
  fullSpellList?: boolean }              // 仅 fullList 职业合法，否则写入前拒绝

SlotValue =                              // 形状由该槽的 valueFormat 决定：
  | string[]                             //   trait-key / pool-uuid：长度须等于 count
  | { abilityScore: Record<string, 1|2> } //  asi-assignment / asi-or-feat
  | { feat: string }                     //   仅 asi-or-feat：一个专长/特性 UUID
```

**槽位寻址语义**：每个 choiceRequirement 的值放到它自己的 key 下，节点之间不共享、
不排序、不互相消费——同一个 bySlot 里可以有任意多个 ASI 节点各自加点。校验全部
写入前完成：

- 未知 slot key → 拒绝 `CHOICE_SLOT_UNKNOWN` 并列出合法 key（取代旧
  UNCONSUMED_CHOICE 警告——值不再可能"剩下"）。
- 必填 slot 缺失或数组长度 ≠ count → 拒绝 `ADVANCEMENT_NEEDS_CHOICE` 点名 slot。
- pool-uuid 值不在 candidates → 同码拒绝，点名 slot 与违规值。
- asi-assignment：属性合法且未 locked、每项 ≤ cap、合计 ≤ points（只约束浮动部分）。
- asi-or-feat：`{ abilityScore }` 与 `{ feat }` 二选一，都传或都不传都拒绝；
  `{ feat }` 的 UUID 须可解析为 Item。
- 混合 ASI（fixed 非零 + points>0）：fixed 自动并入 assignments（native 语义
  value.assignments = fixed + floating，浮动部分可叠在 fixed 属性上），
  fixed 不受 cap/points 限制。

actor 类型门为 character|npc（2026-09-15 放开）。NPC 加职业等级：HP 步用怪物
体型骰固定均值（无首级满骰、无 hpFill），法术位照常派生。

HP、职业特性、资源、衍生值由 dnd5e 原生计算；缺/错选择在任何写入前拒绝。回执
verification 覆盖 actor 终态全字段（D3）：abilities（每属性 before/after + race/asi
分解，回答"人类 +1 是否落地"类问题）、subclass（uuid/name）、race（uuid/name/size）、
movement（walk 及非零其他）、languages（applied + 种族默认池 note）、traits（豁免/
技能/护甲/武器/工具熟练）、proficiency.bonus、spellcasting（ability/slots/戏法与法术
计数 + **cantripsBySource/spellsBySource 来源拆分**——2026-09-17 定稿：按
advancementRoot/Origin 解析授予条目类型分 class/subclass/race/granted 四桶，
budget 只对 class+granted 两桶，种族白送的戏法/环法不再造成假差 1）、ac、
resources（带 uses 条目）、hpFill/slotFill/spellFill。hpFill 与 slotFill
同属 0 级建档收尾（hpFill 仅 character 且仅发生拉满时出现——种族不加 con 无漂移时
自然满血、无 hpFill；slotFill 把 spellN/pact 的 value 填到 max）。
收到回执即对账完成，禁止再裸 eval 自检；回执未覆盖的字段先视为工具缺口上报，再考虑
补读。

## 4. 主流程（发现 → 建档 → 写入）

```
1. foundry_actor_create            建空 character（B 组：source=compendium 复制怪物）
2. browse type:"class"             拿 classUuid（按 DM 指令的 rules 选行）
3. browse type:"race"              拿 raceUuid（A 组）
4. advancement_plan                classUuid + raceUuid：完整计划 + 子职业池 +
                                   spellBudget + 种族侧选择（语言等）
5. advancement_plan +subclassUuid  最终计划（actorAdvanceArgs）
6. browse names[记忆名单]          仅已知施法者（法师书/戏法）与装备需要；一次批量解析，
                                   miss 才翻页；准备施法者法术 = 0 次浏览（fullSpellList 一个布尔值）
7. foundry_actor_update            基础属性建档（标准数组等非 advancement 字段）
8. foundry_actor_advance           actorAdvanceArgs + choices + additionalItems + fullSpellList?
9. 回执 verification 对账           0 次调用
```

search 在第 1 步后只剩兜底（B 组怪物源若已知 UUID 连兜底都不用）。

## 5. Benchmark 预期路径与步数

步数口径：只计模型对世界/工具的信息与写入调用；skill 阅读（3~4 次 read + 1 次
world_status）为两臂共同固定开销，不计入对比。"裸 JS"指 browser_evaluate/powershell。

### A1：人类法师 5 级（塑能学派，智力 18，火球术，长棍）

| # | 调用 | 要点 |
|---|---|---|
| 1 | actor_create | blank character |
| 2 | browse type:"class" | 选 2014 法师行 |
| 3 | advancement_plan L5 | 子职业池 + spellBudget（戏法 4 / 书 14） |
| 4 | browse type:"race" | 选 2014 人类行 |
| 5 | advancement_plan +塑能 | 最终 actorAdvanceArgs |
| 6 | browse names[4 个戏法名] maxLevel:0 +classUuid | 批量解析，eligibility=legal 确认 |
| 7 | browse names[14 个法术书名] +classUuid | 批量解析（含火球术）；miss 才翻页补 |
| 8 | browse type:"item" names[长棍/材料包/法术书/学者套组] | 装备批量解析（未点名装备从简，D6） |
| 9 | actor_update | 基础属性标准数组（智力向 18 分配） |
| 10 | actor_advance | choices{skills:[arc,inv], abilityScore, cantrips:[4]} + additionalItems[14 书 + 4 装备] |

预期 **10~12 次，裸 JS 0，search 0**。
对比：裸 JS 臂实测 39 次（30 次裸 eval）→ **降 ~67%**；现工具臂 36 次 → 降 ~64%。

### A2：人类冠军战士 5 级（长剑盾牌链甲手斧）

| # | 调用 | 要点 |
|---|---|---|
| 1 | actor_create | blank character |
| 2 | browse type:"class" | 2014 战士 |
| 3 | advancement_plan L5 | 子职业池 + 战斗风格选择步骤 |
| 4 | browse type:"race" | 2014 人类 |
| 5 | advancement_plan +冠军 | 最终 actorAdvanceArgs |
| 6 | browse type:"item" names[长剑/盾/链甲/手斧] | 装备批量解析（quantity 在 grant 里给） |
| 7 | actor_update | 基础属性（力量向 18） |
| 8 | actor_advance | choices{skills, feats:[战斗风格], abilityScore} + additionalItems[4 装备] |

预期 **8~10 次，裸 JS 0**。
对比：裸 JS 臂实测 21 次（17 次裸 eval）→ **降 ~52%**；现工具臂 19 次 → 降 ~47%。

### A3：丘陵矮人生命牧师 3 级（感知 16，轻锤）

| # | 调用 | 要点 |
|---|---|---|
| 1 | actor_create | blank character |
| 2 | browse type:"class" | 2014 牧师 |
| 3 | advancement_plan L3 | 子职业池 + spellBudget.fullList（34 个候选） |
| 4 | browse type:"race" | 2014 丘陵矮人 |
| 5 | advancement_plan +生命领域 | 最终 actorAdvanceArgs |
| 6 | browse names[3 个戏法名] maxLevel:0 +classUuid | 批量解析 |
| 7 | browse type:"item" names[轻锤/链甲/盾/圣徽/探险家套组] | 装备批量解析（从简，D6） |
| 8 | actor_update | 基础属性（感知向 16） |
| 9 | actor_advance | fullSpellList:true + choices{cantrips:[3], skills} + additionalItems[5 装备]；34 法术一次写入，回执 spellFill.count=34 |

预期 **8~10 次，裸 JS 0**。法术环节 0 次浏览——fullList 语义把"34 个法术的发现与填写"
压缩为一个布尔值，这是准备施法者的最大减负点。
对比：裸 JS 臂实测 49 次（300s 超时失败）→ **降 ~78%**；现工具臂 40 次 → 降 ~72%。

### 验收标准（改造后重跑 A1-A3 时执行）

- 工具臂总调用落在上述区间（A1 10~12 / A2 8~10 / A3 8~10），裸 JS（browser_evaluate
  +powershell）= 0，search ≤ 0（A 组无兜底场景）
- advancement_plan 调用 = 2/案（子职业两次约定）；多于 2 次视为路径异常
- 全部验收项通过（含修复后的 bonus-proficiency 别名期望）

## 6. 明确非目标（本轮不做）

- 三次发现调用合并为一次（跑一轮看模型是否还乱搜再说）
- search 匹配算法改进（目录类型落地后 search 不再承担职业/种族发现，问题降级）
- HP 数值 preview / 公式下发——已否决（D2）：对错由验收夹具判断，skill 引导信任工具
- plan 扩面（startingEquipment 候选池下发）——下批候选，独立评估
- 法术分页体验（pageSize 上限/按环位精确过滤/给 wizard 也下发候选池）——观察项

## 7. 相对现状的变更清单

1. SDK：content_list 拆为 advancement_plan + compendium_browse（硬切换无别名）；
   browse 新增 class/subclass/race 目录类型、uuids 模式、全 Item 包扫描、
   rules+identifier 去重（arcane 优先）、itemType 过滤（weapon 折叠）
2. SDK：advance 的 fullSpellList 开关（已完成，121/121 测试绿）
3. desktop：工具注册/policy/taxonomy/测试同步改名与 schema 更新
4. fvtt-cli：content-list 拆 advancement-plan / compendium-browse 两命令
5. skill：arcane-content-catalog 重写（三次拿全 + search/browse/uuids 分工）；
   arcane-actor-update 补 create/update/grant 教学（工具早已激活，实证零教学）；
   prep.md 与 benchmark 共享 skill 同步
6. benchmark 验收：source-aliases-v3.json 补 bonus-proficiency arcane 别名（已完成）
7. 重跑 A1-A3 按 §5 验收标准核对；B 组视结果跟进

## 8. 自测缺口清单（2026-09-15，按 spec 链路真人扮演模型跑完 A1-A3）

方法：fvtt-cli 驱动真实 COS 世界，严格按 §4/§5 路径建三张卡
（SelfRun-A1-Wizard / A2-Fighter / A3-Cleric，均成卡且关键指标正确：
A1 L5 INT18 HP32 书14 戏法4；A2 L5 STR18 HP44 防御风格 手斧×2；
A3 L3 WIS16 AC18 法术37=fullList34+戏法3，spellFill.count=34）。
结论：**主链路成立**（三次拿全、子职业两次 plan、fullSpellList 一次授满、
回执即对账、装备 quantity/equipped、bonus-proficiency 模块数据均已验证），
但实测调用数全面超 §5 预期：A1 ~27 次（预期 11~13）、A2 ~12 次（预期 9~11）、
A3 ~20 次（预期 9~11）。超支全部可归因到下列缺口。

**修复进度（2026-09-15）**：①（eligibility 挪 identifier 层）、②（候选池水合）、
③（abilities 工具出口）、④（0 级建档自动满血）与 ⑥（子职业池去重）已修；
①②③⑥均实测验证，④真实世界复验待 benchmark 重跑（QA 会话当时掉线）。
arcane 包优先语义同时收口为单一 helper（runtime `isArcanePack`/`preferExistingRow`，
规则：`startsWith("arcane-")`、已有行是 arcane 或挑战者不是 arcane 时保留已有行），
browse 去重与 catalog 目录去重统一走它，全链路口径一致。其余条目仍挂账。

### 8.1 功能缺陷（按修复优先级）

1. **browse 法术 `eligibility` 恒为 `name-match`**（runtime `compendiumBrowseData`）
   **[已修 2026-09-15，eligibility 部分]**：原判定走
   `game.dnd5e.registry.spellLists.forType("class:"+identifier)`，注册表条目是
   dnd5e 系统包 UUID，而候选已按 arcane 优先去重为模块包 UUID——两个 UUID
   空间永不命中（实测 wizard ≤3 环 50 行全 name-match）。这是 A1 超支主因
   （法术发现实测 9~10 次调用 vs 预期 2）。
   已落地修法：合法性判定挪到 identifier 层——候选包有模块标注
   （任一 flags 命名空间含 `spellClasses` 数组，fullList 同款鸭子类型）时标注权威
   （`spellClasses.includes(classIdentifier)`）；未标注包回退 dnd5e 注册表
   `forType("class:"+id).identifiers` 集合匹配；无 classUuid 时不输出
   eligibility 字段（contracts 已改可选）。
   实测复验：wizard ≤3 环 2014 第 1 页从 0/50 legal → **33 legal / 17 name-match**
   （翠炎剑等 TCE 非法术表 SRD 条目也正确标 legal）；SDK 补四象限测试。
   **仍挂账：`auto-grant` 枚举值从未产生**（需从职业/子职 ItemGrant advancement
   枚举法术 identifier，本轮未动）。
2. **`pool-uuid`/`trait-key` 步骤的 `candidateNames` 全空** **[已修 2026-09-15]**：
   原问题为 A2 战斗风格 6 候选、A3 牧师戏法 9 候选只有 uuid 没有名，模型被迫
   uuids-browse 水合（每案 +1 次）；子职业池有名、物品选择池无名，水合不一致。
   已落地修法：plan 组装时统一水合（runtime `hydrateCandidateNames`）——trait key
   走 dnd5e `Trait.keyLabel` 本地化，Compendium uuid 按包分组从合集 index 取名
   （世界 uuid 回退 fromUuid），全不命中时不输出该字段。
   实测复验：新卡牧师 plan——技能 5/5 有名（历史/洞悉/医药/游说/宗教）、
   牧师戏法 9/9 有名（神导术 Guidance…）、战士战斗风格 6/6 有名；SDK 补
   水合/空池两测试。
3. **`actorEdit` 不支持基础属性** **[已修 2026-09-15，create 主 + update 备]**：
   原问题为 `ActorChanges` 无 abilities 字段，§3.6 承诺的"标准数组分配"无法实现，
   三案各被迫 1 次裸 eval（`system.abilities.*.value`）。
   已落地修法：`dnd5e.abilities: Record<abl, number>`（六属性、整数 1..20）——
   主路径进 `actorCreate`（实测种族/ASI 是 advance 时对基础值做加法、非 ActiveEffect，
   SET 必须先于 advance，create 结构性保证顺序）；修正路径进 `actorEdit`（SET 语义，
   advance 后写入须含加成最终值）；读侧 `prepActorFields` 默认下发六个
   `system.abilities.*.value` 使 readRef 覆盖。skill/契约 §6/工具描述同步分工教义。
   实测复验：create 带标准数组成卡且回执 echo、read 字段齐、edit wis/con 逐步回执
   completed、int=25 在任何写入前 INPUT_INVALID 拒绝；SDK 补 6 测试（create 合法/
   合并 compendium 源/越界拒绝，edit 合法/越界/readRef 未覆盖拒绝）。
4. **advance 落地后 `hp.value < hp.max`** **[已修 2026-09-15，0 级自动满血]**：
   原问题为车卡满血语义（verify-v3 `hp.full` 要求 value==max）迫使模型再花
   read+edit 两步补血（+2 次，A3：max 30 / value 24）。
   根因（dnd5e 5.3.3 源码实证）：HP 步用各步**当时**体质调整值把 value 累加定格
   （空白卡 value 初值 null），max 是 prepare 用**最终**体质重算的派生值；车卡
   中途种族 ASI 必然让两条通道对不上，prepare 只有 min(value,max) 钳制、少了不补。
   已落地修法：advance 收尾时若执行前 `details.level === 0`（建档签名——0 级角色
   无战斗史）且 value<max，自动拉平（只拉不压、temp 不动、仅 completed 才做），
   回执 `hpFill:{before,after}` 可见、verification.hp 即终值。无新入参；既有角色
   升级（≥1 级）不动当前 HP。skill/契约 §6/工具描述同步。
   SDK 补 3 测试（0 级拉平且回执 before/after、≥1 级不拉、只拉不压）；
   真实世界复验待 benchmark 重跑一并进行（QA 会话当时已掉线）。

### 8.2 语义/教义缺口

5. **spellBudget 兑现出口不明**：法师职业 Item 无戏法 choice 步骤，`choices.cantrips`
   变 `UNCONSUMED_CHOICE` 警告、戏法不上卡，靠警告再 grant 补救（+2 次）；牧师有原生
   戏法步骤（fill choices.cantrips）则正常。同一字段两类出口，模型无法预知。
   修法：plan 给 spellBudget 各项标出口（如 `cantrips:{count:4, via:"additionalItems"}`），
   skill 同步"有 fill 走 choices，无 fill 走 additionalItems"。
6. **子职业候选池不去重** **[已修 2026-09-15]**：原问题为塑能/勇士/生命领域
   均两行（纯中文条目 + 模块双语条目），模型需自行判断选模块条目。
   已落地修法：池按 `system.identifier ?? uuid` 去重、arcane 优先
   （`subclassCandidatesForClass` 重写为 byKey Map，getIndex fields 补
   `system.identifier`）。实测：法师子职业池 14→**13**，塑能只剩
   `塑能学派 School of Evocation`（arcane 双语条目胜出）；SDK 补去重测试。
7. **装备发现的名称变体成本**：探险家包实为"探索者套组"（identifier "explorer" 才
   命中）、普通圣徽全 2014 包缺失（世界内容现实）。教义补：中文名不中改英文/identifier
   片段重试；缺失如实报告不硬凑。另：全武器页 281 行（含全部魔法变体）不可浏览，
   装备发现一律带 query，教义写死。
8. **装备穿戴**：`additionalItems` 的防具/武器必须带 `equipped:true`——A2 漏带
   AC 13（应为 18），A3 带了 AC 18 ✓。skill 补一句。

### 8.3 spec 自身修正

9. §5 步数表漏计 `foundry_actor_get`（readRef 签发）：写操作前置 1~2 次
   （update 前 + advance 前），各案预期 +1~2。
10. §5 A1"法术 1~2 页"不现实：即使 8.1.1 修好，法师 ≤3 环合法池 ~150 行（3+ 页）。
    选项：browse 加 eligibility 过滤参数 / legal 优先排序 / pageSize 上限提高 /
    给 wizard 也下发候选池（§6 观察项）。待 8.1.1 修复后重测再定。

### 8.4 CLI 面（非 spec 对象，顺手记录）

11. fvtt-cli 已补 `actor-create`/`actor-edit`/`actor-grant-items` 三命令（对齐
    desktop 写工具面）；CLI 写调用需显式传 `world`+`requestId`（desktop 自动注入），
    后续可给 CLI 加默认注入。

### 8.5 已验证成立（无需改动）

- 三次拿全：class/race 目录双版本各自成行、`rules+identifier` 去重正确
  （2014 法师取 arcane 行、2024 法师取 classes24 行，互不合并）。
- 子职业两次 plan 约定：plan1 给池，plan2 才出种族步骤（丘陵矮人工具熟练
  只在带 raceUuid 的计划里出现）；`ADVANCEMENT_NEEDS_CHOICE` 拒绝报文精确到
  slot + need/have，可行动。
- fullSpellList：34 个法术一次写入、领域法术按来源去重、回执 `spellFill.count=34`
  即对账——准备施法者法术环节 0 次浏览，完全达成设计意图。
- uuids 模式吸收 detail：战斗风格/戏法池水合靠它，一次 6~9 个返回全文。
- `additionalItems` 的 `quantity`（手斧×2）与 `equipped`（链甲+盾牌 AC 18）。
- 模块数据 bonus-proficiency 已在生命牧师卡面（附赠熟练项 Bonus Proficiency）。

## 9. 第二轮优化：A 系列 trace 解剖决策（D1-D6，2026-09-15 落地）

v1 基线（r5/r5b）后逐秒解剖 A1 工具臂 trace：50 次调用里 ~33 次浪费精确落在
plan/receipt 未覆盖的字段上——powershell 翻 dnd5e 源码验 HP 语义 ×8（24-57s）、
不敢翻 489 池分页而逐名点查法术 ×18（66-83s）、裸 eval 回读 abilities/语言/种族
advancement 原文核对 ×7（99-152s，含一次 34KB 全量 dump）。六条决策全部落地：

| 决策 | 内容 | 落点 |
|---|---|---|
| D1 | HP 槽撤出 choiceRequirements，永不询问模型；choices.hp 留作 advance 隐藏覆盖（DM 掷骰 HP 才传） | runtime normalizeAdvancementSteps；automaticSteps 摘要带 hitDie 推导（§3.3） |
| D2 | 不做 HP 数值 preview / 公式教学；对错由 benchmark 夹具判断，skill 引导模型信任工具 | §6 非目标 + 三份 skill |
| D3 | receipt verification 扩展 actor 终态全字段（§3.8）；亚种 = 独立 race 条目（沿用，不改） | runtime actorAdvanceData |
| D4 | browse 新增 names[] 批量解析（§3.1）；**不改匹配算法**，工具描述与 skill 写明单一语言名单教义 | runtime + desktop schema/描述 |
| D5 | skill 只教理想路径、不写禁令；模型绕开工具走裸 JS 视为"工具不如裸 JS 好用"的强信号，harness jsFallback 遥测天然记录 | 三份 skill 改写 |
| D6 | 未点名装备从简（benchmark 与生产 skill 一致）：DM 点名的装备精确解析，未点名的按常识名单一次 names[] 带过，不逐件考证 | skill |

### 工具迭代积压（backlog）

1. ~~选择型种族进工具~~ → 2026-09-15 部分落地（§10）：种族侧技能/工具/语言 trait
   池已进 plan/advance；剩余缺口是种族侧 ASI 自选（半精灵 +1/+1 与职业 ASI 共用一个
   choices.abilityScore 键会冲突）与其他 trait 类型池、optional grant——下轮迭代处理。
2. **itemType 零命中回退**（观察项）：browse 带 itemType 过滤零命中时不回退
   （实例："材料包"实际 type=container，按 equipment 查得 0）。若 trace 再出现
   误过滤导致的回退搜索，再考虑零命中时去掉过滤重试并在结果标注。
3. ~~B 组 NPC 职业等级支持~~ → 2026-09-15 落地（§10）：plan/advance 放开 npc，
   体型骰 HP 语义与原生逐点对上。

## 10. 第三轮修复：A 组缺口 G1/G2 + NPC 入口（2026-09-15 落地）

A 组 v2 基线归因出的两个缺口与 B 组前置需求，一轮修完并活冒烟验证：

| 缺口 | 修复 | 活冒烟证据 |
|---|---|---|
| G1 种族 Trait 选择不进 plan/advance（人类额外语言池原生是通配符 `languages:*`，既不可执行也无法匹配） | race 流程 Trait 池（技能/工具/语言）下发 choiceRequirements；通配符用系统 `Trait.mixedChoices` 展开为具体 key + candidateNames；advance 匹配按通配符前缀语义；choices 白名单与 ctx.provided 加 languages | 人类法师 plan：race:0 语言槽下发 24 个具体语言 key；advance choices.languages:[elvish] 落地，回执 languages.applied=[common, elvish] |
| G2 法术位只派生 max、value 留 0（"满资源"终态不符） | 0 级建档收尾 slotFill：spellN/pact value 填到 max，回执 slotFill:{before,after} | 法师 5 级 slotFill spell1 0→4 / spell2 0→3 / spell3 0→2 |
| NPC 入口 ACTOR_TYPE_UNSUPPORTED | plan/advance 类型门改 character\|npc；NPC HP 用怪物体型骰均值、无首级满骰、无 hpFill | 兽人（15=2d8+6, con+3）+ 法师 5 级 → hp 55/55、hd 7d8、slotFill 4/3/2、0 警告，与原生公式逐点一致 |

SDK 150 断言全绿（新增通配符展开/拒绝/注册表回退 3 用例）；桌面 496 绿。
配套教义：三份 skill 同步（发现顺序 class→race→plan、trait-key 具体 key 池、
slotFill/hpFill 收尾语义、NPC 工具链）；js 臂 fixture skill 明确
`await (async () => {...})()` 包裹形态（A3 裸 JS 臂曾因函数声明未调用/顶层 await
连续摔跤 6 次）。

## 11. 第四轮：v3/v4 批次归因修复（2026-09-15 落地）

### 11.1 v3 批次（12 trials）归因与修复（commit e57425d）

| 现象 | 归因 | 修复 |
|---|---|---|
| B1/B2/B3 工具臂全挂 preserve.item | AdvancementManager clone roundtrip 物化空 `flags.dnd5e:{}`，commit() 用 diff:false 全量重写既有条目，字节级保留被破坏 | commit 对既有条目做 canonical 比较（剪空对象后 JSON 比对），内容不变就跳过重写；活验证：兽人复制件 + 法师 5 级后 4 个源条目字节不变 |
| A1 工具臂 advance partial（SOURCE_MISMATCH） | 模型自创中英组合 expectedName 而非照抄 browse 的 name | 错误信息带 entry uuid + expected/actual；additionalItems 的 prepPrepareGrants 提前到 commit 前，坏条目在零写入时整体拒绝 |

v3 数据基线：A1 26c/83s✅、A2 20c/54s✅、A3 27c/110s✅、B 组工具臂全 ❌（修复前）；
js 臂 A 组 22-38c ✅、B2 超时。

### 11.2 v4 批次（12 trials）结果

修复生效：B 组三案工具臂 core 26/26 全绿（preserve 清零）；A1 工具臂 19c/50s（无 partial）；
A3 21c/73s。js 臂 A1/A3 双双 300s 超时（控制臂自身波动，不修）。

### 11.3 v4 工具臂 trace 逐秒归因 → 本轮修复

残余裸 eval 五桶归因（A2 12 次、B1 10 次、B2 13 次、B3 9 次）：

| 桶 | 实例 | 修复 |
|---|---|---|
| 授予后回读（最大头，每案 1-6 次） | B2 授予后连读 traits/class  advancement/getRollData().scale；A2 回读 196KB items dump 找"额外攻击/长剑" | 回执 verification 新增 `grantedItems`（commit 前后 item id 差集，advancement 实际授予清单：名称/类型/uuid）、`preservedItems`（既有条目保留计数）、`scale`（职业 scale 值打平，如 `rogue.sneak-attack:"2d6"`）、`init`、`spellcasting.byLevel`（按环法术计数） |
| 种族原文调研（A2 ×4） | plan 种族步骤只写 "fixed ability bonuses" 不带值；体型无摘要；移动速度不在 plan 里（种族条目直接携带 movement，非 advancement） | ASI 摘要逐属性列明（`str+1, dex+1…`）；SizeAdvancement 走通用 dataFor 摘要（`"med"`）；新增 ScaleValueAdvancement 分支从 `configuration.scale[level]` 渲染骰子（`scale: 2d6`）；plan 顶层新增 `race:{uuid,name,movement}` |
| 共享 fill 键困惑（B2） | 游荡者 技能×4 + 技能×1 + 专精×2 同吃 `choices.skills`，模型只填 5 个被拒，翻 class 原文 3 次才搞懂 | plan 新增 `fillAllocation`（按单 fill 键聚合 total + 槽位消耗顺序 + note）；ADVANCEMENT_NEEDS_CHOICE 拒绝信息追加共享键分配（`[choices.skills feeds 技能×4 → 专精×2]`），重试零调研 |
| 装备发现回退翻包（A2/A3 各 1 次） | "Explorer's Pack" 0 命中：2014 包条目名是纯中文"探索者套组"，identifier `explorers-pack`，而匹配归一化 `[\s_-]` 保留了撇号 | 名称/identifier 归一化改 `[^\p{L}\p{N}]`（撇号/弯撇号全剥），search 与 browse 三处同步；工具描述与 skill 写明标点不敏感 |
| itemType 误过滤（A2） | `itemType:"equipment"` 漏掉武器类长剑/手斧（原生 type=weapon） | 工具描述 + skill 写明：names 模式不要带 itemType，equipment 不含武器 |

额外发现并修复的**回执保真缺陷**：回执读取发生在 commit 后、系统下一次自主 prepare 前，
`details.race` 未链接、`movement.walk` 读得 0（真实终值 30）——回执会主动误导。
修复：verification 读取前 `actor.reset()` 重备，race 改读嵌入 race 条目（不等 details.race
链接），movement 派生值为空时按 prepareRace 语义回退种族条目移动值。活冒烟：人类游荡者 3 级
回执 movement.walk=30、race 含 uuid/name/size、scale 2d6、grantedItems 13 条全列。

SDK 151 绿；桌面 496 绿；bundle revision 21。skill 教义同步：回执覆盖清单（grantedItems/
preservedItems/scale/init/byLevel）、fillAllocation 用法、names 模式勿带 itemType、
identifier 匹配标点不敏感。

## 12. 第五轮：v5 批次归因 + 专精独立 fill 键（2026-09-15 落地）

### 12.1 v5 批次（12 trials）结果

工具臂 6/6 全绿：A1 18c/48s、A2 19c/41s、A3 24c/76s、B1 18c/67s、B2 25c/87s、B3 25c/85s。
js 臂 A2/B1 超时、B2 FAIL actor.exists（控制臂自身波动，不修）。

### 12.2 v5 残余裸 eval 归因（trace 逐条）

| 桶 | 实例 | 修复 |
|---|---|---|
| 专精丢选择（真 bug） | B2 模型 67s 裸写 `system.skills.slt.value:2`，读取 before=**0**——专精槽选了未熟练技能，dnd5e 原生静默丢弃（expertise 只做 1→2，从不 0→2，dnd5e.mjs:9793） | 见 12.3 |
| 回执缺专精等级 | B2 38-59s、A3 51s、B1 25s 回读 traits 验证专精 | 回执 `verification.traits.expertise:{skills,tools}`（value≥2 清单） |
| 回执缺活动计数 | A3 68s 回读轻锤 activities、B1 62s 回读武器/特性活动 | grantedItems/createdItems/spellFill.created 条目带 `activities` 计数 |
| 圣徽 2014 包无此条目 | B1 search 兜底"Holy Symbol"（只在 dnd5e.equipment24） | 数据缺口非工具 bug，search 兜底路径工作正常，不修 |
| 存在性预查/怪物源预读（每案 2-3 次） | benchmark 工具策略不含 foundry_actor_create 的设计内行为 | 不修 |

### 12.3 专精修复：从"提示"到"独立键 + 写前校验"（冒烟推翻初版设计）

初版设计（note 写"同一 key 同时填进技能槽和专精槽是合法的"）在活冒烟时被发现**机制上
不可表达**：`take()` 对每个值只消费一次且 schema `uniqueItems:true` 禁止重复——同一个
key 被技能槽吃掉后根本到不了专精槽。终版设计：

- 专精槽（TraitAdvancement `mode:"expertise"`）独立 fill 键 **`choices.expertise`**：
  与 choices.skills 共用 skills:/tool: 词汇表，但不共消费队列。plan 的
  choiceRequirement 带 `mode:"expertise"` + `note`（说明须选已熟练项）；fillAllocation
  里 choices.skills 与 choices.expertise 各自成行。
- **写前校验**：专精每个值必须在"卡面已熟练（skills/tools value≥1）∪ 本次调用前面
  技能/工具槽已选"集合内——该集合随槽位处理顺序累积（与原生 apply 顺序一致），非法值
  以 ADVANCEMENT_NEEDS_CHOICE 整体拒绝并点名，零写入。
- **写后兜底**：提交后按定居值复查，仍被原生丢弃的报 `EXPERTISE_NOT_LANDED` 警告
  （如种族 grant 在 class 专精之后落地的边角序）。
- 活冒烟（人类游荡者 1 级）：skills×4 + expertise 双选同 key → completed、零警告、
  `traits.expertise.skills:[ins,slt]` 真实落地；expertise 选未熟练 → rejected
  ADVANCEMENT_NEEDS_CHOICE 点名 skills:inv、actor 零写入。烟雾 actor 已删。

SDK 156 绿（新增 3 个 advance 用例 + 1 个 list 用例 + additionalItems activities 用例）；
桌面 496 绿；bundle revision 22。工具描述（advance/plan）与两个 skill 同步为
choices.expertise 语义。

### 12.4 v6 批次归因 → 第四轮修复（NPC preservation 回执）

v6 工具臂 6/6 core 全绿（A1 25c/55s、A2 21c/45s、A3 26c/80s、B1 22c/69s、B2 19c/79s、
B3 23c/68s），但残余裸 eval 未如预期下降（B1 12、B2 10、B3 9）。逐条归因：

| 桶 | 实例 | 处置 |
|---|---|---|
| NPC 保留证明（最大头） | B1 8 次、B2 6 次：dump 全量 traits、toObject 深读、遍历 NPC dataModel schema 枚举字段，只为证明"原怪物的抗免/感官/语言没被职业扩展洗掉" | 回执新增 `preservation.changed`（仅 NPC）：advance 前后对固有特性族（dr/di/dv/ci/cv/senses/size/languages/details.type/movement）做 before/after diff，空数组 = 原卡未动；保留证明从"模型自己枚举字段做 diff"变成回执一句话 |
| 创建期存在性检查 + Actor.create（每案 2-3 次） | benchmark 工具策略不含 foundry_actor_create，模型按 fixture 要求先查重再裸建 | 设计内行为，不修 |
| 怪物源/职业源预读（B 组每案 1-3 次） | 模型从 monsters 包读源 NPC、从 classes 包读职业文档做语义理解 | 设计内（源预读）/低频语义好奇（职业文档），不修 |
| 按 identifier 找条目（A1 ×2） | grantedItems 有 name/type/uuid 无 identifier，模型回读 items 按 identifier 定位 | grantedItems 补 `identifier` 字段 |
| 种族文档复读（A2 ×2） | plan 已下发种族 ASI/语言池/movement，模型仍读原文确认——低频语义好奇 | 不修（D5：不禁止，观察） |

SDK 159 绿（新增 NPC preservation 干净/有变两例 + grantedItems identifier 一例）；桌面
496 绿；bundle revision 23。

### 12.5 v7 批次归因 → 第五轮修复（trait 落地审计）

v7 工具臂 6/6 core 全绿（A1 21c/57s/bare4、A2 18c/40s/bare4、A3 25c/81s/bare10、
B1 25c/104s/bare14、B2 28c/86s/bare13、B3 22c/80s/bare8）。关键发现：preservation
回执没能降 B 组裸 eval——B1 trace 思考链显示模型收到了 `preservation.changed` 仍继续
审计。真正原因：模型看到回执 `traits.armor:[]`/`traits.weapons:[]` 无法区分"没授予"
和"授予被丢弃"，44s→98s 花 ~8 次 eval 调查，实证出 **dnd5e 5.3.3 的 NPCData 模型
根本没有 `traits.armorProf`/`weaponProf` 字段**（character 有；`Trait.actorKeyPath(key)`
签名不是传 key，直接调用会 throw）。也就是说怪物挂职业等级后，职业给的护甲/武器熟练
在原生 dnd5e 下就是静默丢弃的——模型在替我们探明一个数据模型事实。

修复（runtime + 回执）：

- **落地审计**：advance 提交后遍历 resolved plans 的 TraitAdvancement 条目，非 expertise
  槽逐个 chosen key 跑 `traitLanded()`：skills/saves/tool 直接查 value/proficient≥1；
  其他族经 `CONFIG.DND5E.traits[family].actorKeyPath`（weapons→weapon 单数回退）定位
  目标，目标字段不存在 → 判定丢弃；languages 特判 traits.languages；`setHas` 兼容
  Set/{value:Set}/数组。整个检查以 `CONFIG.DND5E.traits` 存在为门（mock fixture 没有 →
  旧测试零幻影警告）。未落地报 `TRAIT_GRANT_NOT_LANDED` 并按 (code,value) 去重——
  一个职业等级的同族授予来自多个 advancement 条目（职业+子职业+战斗风格），不去重
  同 key 会重复出现（活冒烟：9 条 → 去重后 6 条）。expertise 槽维持
  `EXPERTISE_NOT_LANDED`（文案同步改为"在同次调用的 skills/tools 槽里先选熟练"）。
- **回执 `traits.tools` 口径修正**：`toolProf` ∪ `system.tools` 中 value≥1 的 key——
  NPC 的工具熟练住在 `system.tools`，旧口径在 NPC 上恒为空。
- 工具描述与 skill 教义同步：收到 `TRAIT_GRANT_NOT_LANDED` 即在报告披露，不回读
  数据模型求证，不手工修补。

活冒烟（狼人副本 + fighter 1 级）：completed，6 条去重后的 `TRAIT_GRANT_NOT_LANDED`
（armor:lgt/med/hvy/shl、weapons:sim/mar），preservation.changed=[]，烟雾 actor 已删。
SDK 161 绿；桌面 496 绿；bundle revision 24。

### 12.6 v8 批次（12 trials）→ 迭代循环退出评估

v8 全绿（12/12 core），工具臂对比 v7：

| case | v7 calls/ms/bare | v8 calls/ms/bare | v8 js 臂 ms/bare |
|---|---|---|---|
| A1 | 21c/57s/4 | 21c/49s/4 | 197s/18 |
| A2 | 18c/40s/4 | 19c/50s/6 | 92s/17 |
| A3 | 25c/81s/10 | 28c/93s/7 | 284s/41 |
| B1 | 25c/104s/14 | 17c/43s/5 | 67s/10 |
| B2 | 28c/86s/13 | 16c/42s/5 | 185s/29 |
| B3 | 22c/80s/8 | 19c/50s/3 | 113s/11 |

B 组裸 eval 14/13/8 → 5/5/3、时长 104/86/80s → 43/42/50s：trait 落地审计 +
preservation 回执 + skill 教义（收到警告即披露）消除了 B1 那种 54s 的数据模型求证。
工具臂全面 2-4 倍快于裸 JS 臂且零 core 失败。

残余裸 eval 逐条归因（A1/A2/A3/B1/B3 trace 全文）：只剩三桶，均无工具缺口——

1. **创建期存在性检查 + Actor.create**（每案 2 次，含一次语法重试）：benchmark 工具
   策略刻意不含 actor_create，设计内行为。
2. **写后终态验证回读**（每案 1-5 次）：回读 spellcasting byLevel、traits 数组、
   grantedItems identifier——**回执已全部覆盖**，模型在原始读里和 Set 序列化反复搏斗
   （A2 连续 4 次重试 `arr(s.traits.armorProf.value)`），恰是回执已给干净数组的字段。
   skill 已教"收到 completed 即对账完成"，这是模型的出报告前自查习惯，不是工具缺口；
   按 D5 原则不禁止，继续观察。
3. **怪物/职业源预读**（B 组 1-2 次）：语义理解性预读，低频，设计内。

退出评估结论：**break loop**。工具臂时长 42-93s（js 臂 67-284s），core 全绿，残余
裸写无系统性工具问题。观察项（不修，下轮数据恶化再议）：写后自查回读若在未来批次
重新放大，优先考虑在回执里附"报告可直接引用的终态摘要块"而非加新工具。

## 13. 第六轮：choices 槽位寻址（2026-09-16 定稿）

### 13.1 触发：线上会话五连拒

备团会话造「半精灵龙脉术士 5 级」（arcane 2014 包），actor_advance 连续 5 次
写入前拒绝。模型五次尝试传的都是合法候选（野性面具等 UUID 就在 plan 下发的
candidates 里），全部被拒。逐条归因（回执 + runtime 源码 + 模块 leveldb 原始
配置三方互证）：

- **Bug A：职业 ASI 盲抢 feats 桶**。`asi-or-feat` 节点（2014 每职业 4/8/12/16/19
  级）执行 `take("choices.feats", () => true, 1)`——不看候选池，抓桶里剩下的
  第一个值。stepSets 按 class → race → subclass 顺序破坏性消费共享桶，种族
  「半精灵变体」ItemChoice 排在职业 4 级 ASI 之后，它的变体值永远先被 ASI
  抢走当"专长"，于是恒报 `need 1, have 0`。双重腐蚀：ASI 侧也被写进一个
  种族特性 UUID 冒充的假专长（native feat 分支不校验类型，仅拒绝兜底挡住了写入）。
- **Bug B1：种族 ASI 不查 abilityScoreUsed**。race 侧 ASI 分支直接读
  `choices.abilityScore`，职业 ASI 用过后种族会再应用一次同一组加点。
- **Bug B2：单一 abilityScore 键**（旧 backlog 已记）：职业 4 级 ASI 与种族
  浮动 ASI 共用一个键，表达不了两组不同分配。
- **Bug C：混合 ASI 丢 fixed**。半精灵种族 ASI 真实配置
  `points:2, fixed:{cha:2}`，旧代码 `if (points <= 0)` 才把 fixed 写进
  assignments——points>0 时 +2 魅力整段丢失。native 语义（dnd5e 编译源码实证）：
  `value.assignments = fixed + floating` 合并存储，flow 的已用点算法也是
  `assignments - fixed`；我们非 initial 路径下 fixed 不会自动应用，必须自己并入。

根因同构：choices 按"值类别"设公共桶（feats/abilityScore/…），节点按固定顺序
破坏性消费——一个桶喂多个节点、且有节点不做池匹配盲抓时，退化成先到先得，
模型无法表达"这个值给哪个节点"。

### 13.2 方案：槽位寻址

choices 改为 `bySlot: Record<slot, SlotValue>`：key 原样抄自 plan 的
choiceRequirements[].key（= slot），每个节点只读自己的 key。线格式与校验见
§3.8；plan 侧新增 choicesTemplate 填空骨架、key 字段取代 fill、删除
fillAllocation，见 §3.3。

破坏性变更（探索期不留双格式）：

- advance 删除旧桶：`choices.{skills,tools,cantrips,preparedSpells,feats,languages,
  expertise,abilityScore}` 全部移除；`choices.hp` 保留为隐藏覆盖（plan 不下发）。
- plan 删除 `fillAllocation`；choiceRequirements 的 `fill` 字段被 `key` 取代
  （subclass-uuid 的 key 就是字符串 "subclassUuid"，仍填顶层入参）。
- 旧 UNCONSUMED_CHOICE 警告随桶一起消失，未知 slot 变成写入前拒绝。

实现纪律（写进代码注释与测试）：

1. **slot 稳定性**：slot = `label:level:kind:序号`，plan 与 advance 走同一份
   enumerateAdvancementStepSets 枚举，序号确定性一致——回归测试锁死两边 slot 集合相等。
2. **子职业对齐**：plan 预插 subclass 枚举、advance 在 SubclassAdvancement apply 后
   扫子职业步骤，两条路径产生的 subclass: 前缀 slot 必须一致。
3. **专精顺序约束保留**：expertise 槽校验"须已熟练（卡面或本次调用更早槽位）"，
   landedTraits 仍按步骤顺序累积——这是规则本身的数据依赖，不是桶消费。
4. **default 槽重复选取拒绝（2026-09-17，逸闻学院案）**：dnd5e `TraitAdvancement.apply`
   对 `mode:"default"` 无条件写熟练值 1——重选已熟练项会把已落专精（2）踩回 1
   （原生 UI 把已熟练项标 selected 不可再选，API 侧本无护栏）。default 模式槽的
   skills:/tool: 选取若已在 landedTraits（卡面或本次调用更早槽位）中，写入前整体
   拒绝并点名。languages/dr/di/ci/dv 是集合添加、幂等无害，不在拒绝范围；
   expertise/upgrade 模式本就要求已熟练项，也不受影响。
   已知边界：若某池全部候选都已在卡面（理论情形），原生会按需减 count 而我们仍
   要求满额——暂无真实案命中，命中再议。

### 13.3 验收

正路一条链路：browse class → plan（含子职业池）→ browse race → plan（带
subclassUuid）→ advance 一次通过。半精灵龙脉术士 5 级：变体特性进 race 槽、
超魔法 ×2 进 class:3 槽、职业与种族 ASI 各填各的；回执 abilities 分解里
cha 的 race 分量 = +2。

实测记录（2026-09-16，COS 世界 / dnd5e 5.3.3 / fvtt-cli --port 9230 直连）：
browse class/race 目录 → plan（不带 subclass 拿 8 项子职业池）→ plan（带龙族血脉）
→ actor_create（标准数组随 dnd5e.abilities 落地）→ names[] 批量解析 11 法术 + 2 装备
→ advance 一次 completed。回执：cha 15→19（race+2 为固定加成、asi+2 为 4 级加点）、
con 14 / wis 13（种族浮动点）、hp 37/37（含龙族体魄每级 +1）、slotFill 4/3/2、
语言 draconic+common+elvish、技能 arc/per、超魔法瞬发+孪生、变体特性敏锐感官落地、
16 granted + 13 created。第一次提交被 SOURCE_MISMATCH 拒（火球术在 arcane 包实名就是
"火球术"而非"火球术 Fireball"）——expectedName 漂移护栏按设计工作，零写入，
照抄 browse 原名后通过。

### 13.4 附带修复：trait 落地审计的叶存储口径

首轮实测暴露出 TRAIT_GRANT_NOT_LANDED 8 连误报：审计按 full remainder
（`sim:dagger`/`standard:common`）查卡面，而 dnd5e 实际只存叶段
（`dagger`/`common`）——audit 改成 full remainder 与叶段双口径匹配（skills/saves
本就只有一段，不受影响；tool 分支同样补叶段回退）。回归测试：叶存储的
weapon:sim:dagger 与 languages:standard:* 不再产生警告。误报若留着会训练模型
忽视真警告（v7 B1 那种 NPC 护甲/武器熟练真丢失），必须修。
