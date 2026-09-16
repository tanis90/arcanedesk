# Catalog 与 Character Advancement 联动设计

状态：设计稿，基于 COS（Foundry 13.351、dnd5e 5.3.3）和 `actorAdvance` 第一版验证结果。

## 1. 目标

让模型用 catalog 判断“哪些选项合法、要做哪些选择”，再让 `actorAdvance` 把这些选择交给 dnd5e 原生 Advancement。模型不复制完整 progression JSON，不重新拼装职业特性，也不手写 HP、法术位或资源字段。

这条链路解决的是信息交接和责任边界问题：

```text
content_list(classFeature)
        ↓  progressionRef（服务端持有完整计划）
content_list(spell / weapon, progressionRef)
        ↓  紧凑候选和选择约束
模型只提交 choices
        ↓
actorAdvance(progressionRef, choices)
        ↓
dnd5e AdvancementManager → native Actor commit → read-back
```

`progressionRef` 是 Desktop 会话内的不透明引用，不是模型可以修改的 JSON，也不是新的 Actor 数据 schema。

## 2. progressionRef 的生命周期

### 2.1 创建

`foundry_content_list` 查询 `type: "classFeature"` 时，除紧凑摘要外创建一个服务端快照：

```ts
interface ProgressionSnapshot {
  ref: string;                 // opaque, session-bound
  world: { origin: string; id: string };
  rules: "2014" | "2024";
  class: { uuid: string; identifier: string; name: string };
  subclass?: { uuid: string; identifier: string; name: string };
  race?: { uuid: string; identifier: string; name: string };
  targetLevel: number;
  steps: Array<{
    stepId: string;
    level: number;
    advancementType: string;
    choiceKind?: "skills" | "tools" | "cantrips" | "spells" | "abilityScore" | "subclass";
    count?: number;
    pool?: string[];
    automatic: boolean;
  }>;
  automaticSourceUuids: string[];
  allowedSourceUuids: string[];
  sourceHashes: Record<string, string>;
  revision: number;
  expiresAt: number;
}
```

对模型只返回：

```json
{
  "progressionRef": "prg_...",
  "rules": "2014",
  "class": { "identifier": "wizard", "name": "Wizard" },
  "subclass": { "identifier": "school-of-evocation", "name": "Evocation" },
  "targetLevel": 5,
  "choices": [
    { "stepId": "class:1:skills", "kind": "skills", "count": 2, "pool": ["skills:arc", "skills:his", "skills:ins", "skills:inv", "skills:med", "skills:rel"] },
    { "stepId": "class:1:cantrips", "kind": "cantrips", "count": 3 },
    { "stepId": "class:4:ability-score", "kind": "abilityScore", "count": 2 }
  ],
  "automatic": { "stepCount": 11, "itemCount": 8 }
}
```

完整 advancement configuration、effects、uses 和自动授予 Item 的数据留在快照中，不进入模型上下文。`pool` 只保留选择键；需要实际 Item 的步骤返回 UUID/name/level 等小候选，不返回全文。

### 2.2 补充候选

后续 catalog 查询携带 `progressionRef`：

```json
{
  "progressionRef": "prg_...",
  "scope": "compendium",
  "type": "spell",
  "class": "wizard",
  "subclass": "school-of-evocation",
  "characterLevel": 5,
  "query": "火球术"
}
```

返回的是同一计划下的紧凑候选：

```json
{
  "progressionRef": "prg_...",
  "items": [{
    "uuid": "Compendium....Item.fireball",
    "name": "Fireball",
    "level": 3,
    "classEligible": true,
    "subclassGranted": false,
    "levelEligible": true,
    "eligibilityReason": "wizard spell list; character level permits 3rd-level spells"
  }]
}
```

候选 UUID、资格结果和来源哈希写入快照的 `allowedSourceUuids`。如果返回分页，下一页仍绑定同一个 ref；不能把另一个职业或规则版本的 UUID 混入计划。weapon/item 查询同样只加入候选来源，不把它们变成自动授予。

### 2.3 消费

`actorAdvance` 增加一个入口分支：

```ts
interface ActorAdvanceWithPlanInput {
  actorUuid: string;
  readRef: string;
  progressionRef: string;
  choices?: {
    [stepId: string]: { chosen?: string[]; selected?: string[]; value?: unknown };
  };
  additionalItems?: CompendiumGrant[];
}
```

Desktop 在 dispatch 前完成以下检查：

1. `progressionRef` 属于当前 session/task、当前 world，未过期且是最新 revision；
2. Actor 是 Character，`readRef` 仍指向同一个 Actor；
3. 计划中的 class/subclass/race UUID 仍能由 `fromUuid` 解析，类型、规则版本和 source hash 未变化；
4. 每个 `stepId` 的选择数量、选择键、候选 UUID 都符合快照；模型不能提交自动步骤的替代 Item；
5. `additionalItems` 只能使用计划允许的候选或明确的独立装备 UUID，并再次校验名称、类型和来源。

Runtime 只接收 Desktop 解析后的 canonical source UUID 和 choices，仍然重新 `fromUuid`，然后执行第一版已经验证的 clone → public `advancement.apply()` → native commit → read-back。`progressionRef` 失效或选择不全时返回 `ADVANCEMENT_PLAN_STALE` / `ADVANCEMENT_NEEDS_CHOICE`，不产生世界写入。

## 3. A1 的完整链路

A1：2014 人类、5 级塑能法师、智力 18、火球术、长棍。

### 3.1 现在模型需要做的事

当前 A1 模型通常要自己完成这些工作：

- 找 class/subclass/race 来源；
- 读完整 class advancement，区分自动 grant 和待选择项；
- 判断 5 级法师的戏法、法术书数量、可准备法术和最高环位；
- 搜索火球术和长棍并确认 2014 来源；
- 手写职业 Item、feature Item、spell Item、技能、法术位、HP、ASI 和装备字段；
- 处理 `system.prepared`、`system.uses`、来源标记和 derived fields。

这正是 A1 中源码探索、超大 catalog 返回、遗漏 detail 和写后字段不一致的主要来源。

### 3.2 联动后的调用

1. `foundry_actor_create` 创建空白 `character` Actor；随后 `foundry_actor_get(include:["items"])` 取得 `readRef`。
2. `foundry_content_list(classFeature, class=wizard, subclass=school-of-evocation, characterLevel=5, rules=2014)` 返回 `progressionRef` 和三类摘要：自动步骤、技能选择、戏法/ASI 选择。
3. `foundry_content_list(spell, progressionRef=..., class=wizard, subclass=school-of-evocation, characterLevel=5)` 返回法师可选法术的分页候选；`query=火球术` 在同一 ref 下返回唯一 Fireball UUID。
4. `foundry_content_list(weapon, progressionRef=..., query=长棍)` 返回长棍 UUID。模型不再从所有 Item 名称中猜测来源。
5. 模型只决定：技能、戏法、4 级 ASI、法术书/准备法术、装备。自动职业特性和等级派生不进入模型写入参数。
6. `foundry_actor_advance({actorUuid, readRef, progressionRef, choices, additionalItems})`：原生 dnd5e 处理 1–5 级 advancement；工具只把模型选择映射到对应 step。
7. 返回等级、HP、法术位、职业/子职特性、来源和 Item verification；若某个选择缺失，补 choices 后重新发起一个新的未写入请求。

### 3.3 A1 能解决什么

| A1 问题 | progressionRef 的处理 |
| --- | --- |
| 模型不知道哪些职业特性是自动的 | 快照标出 automatic steps；自动 Item 不需要模型枚举 |
| 只调用一次 list，漏掉完整 progression | list 在服务端保存完整 step graph；模型只看到 choice summary |
| 把候选集合当成必须全部导入 | choices 与 automatic grants 分离；未选候选不会写入 |
| 手写 HP、法术位和 class scale | actorAdvance 交给 native Advancement，不接受这些字段的任意 patch |
| 火球术来源和职业资格混淆 | spell candidate 同时返回规则资格、实际 UUID 和 source hash |
| 35 KB 全文导致思考和上下文浪费 | 模型只收到摘要与最终候选；detail 只针对选中的需要全文的 Item |
| 写入后才发现缺 feature/resource | commit 前检查所有必选 step，commit 后做 read-back |

### 3.4 A1 仍需要单独处理的部分

`progressionRef` 不能凭空解决三类不属于职业 progression 的输入：

1. **初始能力值**：A1 的“智力 18、其他标准数组”不是 4 级 ASI。需要在 `actorCreate` 或一个独立的 bounded Character setup 输入中表达最终能力值；不能把它误塞进 progression choices。
2. **法师法术书和准备状态**：dnd5e 的 advancement step 负责原生职业成长，但 A1 指定的 14 本法术书和准备集合需要明确的 `spellbook`/`preparedSpells` 选择入口。必须由工具从 UUID 读取 Item，再设置原生 preparation 字段；不能由模型提交完整 Item 文档。
3. **起始装备组合**：长棍可以作为 `additionalItems`，但起始装备的数量、装备状态和熟练应由受限装备入口或明确的 grant 语义处理。不能把一套完整 Actor system 作为替代品。

因此第一阶段的验收应拆成两层：先证明 progressionRef + actorAdvance 正确处理 class/subclass/race 的原生成长，再增加 abilities/spellbook/equipment 三个明确入口。不能把第一阶段的通过误报成完整 A1 角色创建器完成。

## 4. 失效与安全边界

- ref 只在当前 session/task、world 和规则版本内有效，建议 TTL 15 分钟；过期必须重新 list。
- ref 不允许模型修改；客户端传入的 `classUuid`、自动 grant 或 source document 不能覆盖快照。
- list/detail 的查询结果不是写入证明；actorAdvance 的 read-back 才是完成证明。
- dispatch 前任何校验失败都必须 zero-write；dispatch 后异常沿用 `partial` / `indeterminate`，禁止自动重放。
- catalog 只提供候选和资格；原生 advancement 决定如何应用，Actor 本身决定最终派生字段。

## 5. 实施顺序

1. 将现有实验 `foundry_content_list` 的 progression projection 收敛为上述摘要，并补 `progressionRef` 存储、TTL、world/session 绑定。
2. 让 spell/weapon list 接受 progressionRef，记录候选 UUID 和来源哈希；保持现有 search/detail 兼容。
3. 为 `actorAdvance` 增加 progressionRef 输入分支，先只支持 class/subclass/race/技能/戏法/ASI。
4. 用 A1 做 zero-write 缺 choice、stale ref、错误来源和成功 read-back 四类测试。
5. 再设计初始能力值、spellbook/prepared、equipment 的 bounded 输入；每增加一类都单独回归 A1 和 A3。

