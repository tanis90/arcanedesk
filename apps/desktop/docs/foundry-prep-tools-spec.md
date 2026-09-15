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
    count: number; valueFormat: string; fill: string[]; candidates?: string[];
    candidateNames?: Record<string, string>; cap?: number; required: boolean }>;
  spellBudget: { ability: string | null; progression: string; cantrips?: number;
    known?: number; book?: number;
    fullList?: { maxLevel: number; count: number;
      candidates: Array<{ uuid: string; name: string; level: number }> } } | null;
  coverage: { nativeStepCount: number; automaticStepCount: number;
    choiceStepCount: number; uncoveredRequiredSteps: string[] };
  warnings: object[];
}
```

语义备注：

- **子职业两次调用约定**：不带 subclassUuid 先拿计划（choiceRequirements 里
  valueFormat="subclass-uuid" 的步骤自带 candidates/candidateNames 池）；定下子职业后
  带 subclassUuid 重调一次，子职业自身的授予/选择步骤才会枚举（slot 带 subclass: 前缀）。
- **HP 永不进 choiceRequirements**（D1）：1 级满骰、后续级固定均值，dnd5e 原生计算；
  automaticSteps 给信息性摘要（"hp: max hit die (6) + con mod" / "hp: fixed 4 (d6
  average) + con mod"）。choices.hp 保留为 advance 隐藏覆盖项（DM 掷骰 HP 才传），
  plan 不下发、不询问。不做 HP 数值 preview（D2）——对错由验收夹具判断，skill 引导
  模型信任工具而非自行验算。
- **choiceRequirements 是唯一的填写清单**：fill 指明填到 advance 入参的哪个键
  （choices.skills / choices.cantrips / choices.abilityScore / subclass-uuid …），
  candidates 是该步骤的合法候选池，从池中选，不凭记忆。
- **spellBudget.fullList**：准备施法者（2014 牧师/德鲁伊/圣武士/奇械）能会的全部法术
  （按环位上限枚举自模块标注包）。这类职业"会"整个职业法术列表，准备是 DM 与玩家
  游戏时决定的页签标记，工具不管理。配套 advance 的 fullSpellList 开关使用。
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

### 3.8 foundry_actor_advance（现状 + fullSpellList 已落地）

```ts
input: { actorUuid: string; readRef: string; classUuid: string; subclassUuid?: string;
  raceUuid?: string; targetLevel: number;
  choices?: { skills?: string[]; tools?: string[]; cantrips?: string[];
    preparedSpells?: string[]; feats?: string[]; hp?: "max" | "avg";
    abilityScore?: Record<string, 1 | 2> };
  additionalItems?: CompendiumGrant[];   // ≤ 50；法术书、装备同一出口
  fullSpellList?: boolean }              // 仅 fullList 职业合法，否则写入前拒绝
```

HP、职业特性、资源、衍生值由 dnd5e 原生计算；缺/错选择在任何写入前拒绝。回执
verification 覆盖 actor 终态全字段（D3）：abilities（每属性 before/after + race/asi
分解，回答"人类 +1 是否落地"类问题）、subclass（uuid/name）、race（uuid/name/size）、
movement（walk 及非零其他）、languages（applied + 种族默认池 note）、traits（豁免/
技能/护甲/武器/工具熟练）、proficiency.bonus、spellcasting（ability/slots/戏法与法术
计数）、ac、resources（带 uses 条目）、hpFill/spellFill。收到回执即对账完成，禁止再
裸 eval 自检；回执未覆盖的字段先视为工具缺口上报，再考虑补读。

## 4. 主流程（发现 → 建档 → 写入）

```
1. foundry_actor_create            建空 character（B 组：source=compendium 复制怪物）
2. browse type:"class"             拿 classUuid（按 DM 指令的 rules 选行）
3. advancement_plan                完整计划 + 子职业池 + spellBudget
4. browse type:"race"              拿 raceUuid（A 组）
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

1. **选择型种族进工具**（todo，下轮迭代优先级最高）：半精灵（+2 魅力 + 两项自选
   +1）、变体人类（自选专长）、高等精灵（自选戏法）等"种族带选择"形态，v1 走
   skill 执行路径（advance 后 actor_update SET 补终值并在报告中注明）；下一迭代
   把种族侧 ASI 自选/trait 选择池纳入 plan.choiceRequirements 与 advance.choices。
2. **itemType 零命中回退**（观察项）：browse 带 itemType 过滤零命中时不回退
   （实例："材料包"实际 type=container，按 equipment 查得 0）。若 trace 再出现
   误过滤导致的回退搜索，再考虑零命中时去掉过滤重试并在结果标注。
3. **B 组 NPC 职业等级支持**（已知大坑，本轮不动）：plan/advance 目前
   ACTOR_TYPE_UNSUPPORTED 拒 NPC；B 组走怪物复制源路径。
