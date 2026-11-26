# Map Builder Source Attach 技术方案

## 1. 目标与边界

让 ArcaneDesk 的 LLM 先按 `docs/userpack-authoring.md` 的原生数据规范在当前世界创建 Item，再通过一个 `map_builder_source_attach` 工具，把这些 Item 及其依赖发布到用户合集并给当前战役启用。玩家随后可在车卡器中选择内容，升级器继续解析 advancement、法术、专长、装备和物品授予。

首版目标：

- DND 2014/2024：`class/subclass/race/background/feat/spell` 及起始装备、普通授予物品。
- CoC：`skill/occupation` 及其技能引用。
- 支持新建和同 `moduleId` 的增量新增/更新；目标 Compendium UUID 稳定。
- 支持结构化 Dry run、真实导入、战役选包、回原 play 页和来源回读。
- 纯数据内容；保留 activities、effects、advancement、富文本与素材引用。

明确不在首版承诺：

- 自定义商店目录接入；商店仍有独立索引和结算来源。
- 任意脚本、宏、runtimeHost 或自定义 Item 类型获得执行能力。
- 真实玩家建卡、升级、战斗和刷新持久化被工具回执冒充验收；这些另做真实账号验收。
- 首版不提供条目删除；未涉及的旧 pack 和旧条目不得被隐式删除。

规模上限：20 个根 Item、200 个依赖文档、依赖深度 8、单文档 8 MiB、素材总量 32 MiB。超限引导走现有 ZIP 合集导入，不生成第二套长程通道。

## 2. 基线与仓库

- Desk：`feat/map-builder-source-attach`，基于 `origin/feat/mtcompat-tool-acceptance`。
- Map：`feat/builder-source-attach-runtime`，基于 `origin/feat/generic-userpack`。
- Map 的泛型用户包统一使用 `user-<moduleId>`，ZIP 的 canonical 引用由现有导入器改写。
- 本功能不把 ZIP 当作 Agent 中间产物。ZIP 仍是作者之间的分享格式；Agent 内部使用 canonical module dump。

## 3. 模型工具契约

### 3.1 输入

```ts
{
  sourceUuids: string[];   // 必填，1..20 个世界 Item.<id>
  moduleId?: string;       // 可选，不含 user-；缺省 homebrew-<campaignId>
  title?: string;          // 可选，缺省使用合集默认名称
  version?: string;        // 可选；新建 1.0.0，更新时递增 patch
  dryRun?: boolean;        // 可选，默认 false
}
```

规则：

- 根节点只接受当前世界的 `Item.<id>`；已有 Compendium 文档作为外部依赖，不重复打包。
- DND 根类型支持 `class/subclass/race/background/feat/spell` 和车卡可消费的装备/物品；CoC 支持 `skill/occupation`。
- 多个根节点一次传入，例如职业及其多个子职业。依赖由工具推导，不要求 LLM 逐项列举。
- `moduleId/title/version` 是合集元数据，不让 LLM 填 packId、ownerPid、revision 或存储信封。
- 默认一次调用完成校验、导入、选包和回读；`dryRun:true` 只产出计划，零写入。
- `version` 省略时由 Map 按同合集已有版本决定；Desk 不猜版本，也不把它做成必填。
- 不新增人工审批节点。现有 `maybeRequestApproval` 只作为 Desk 统一写入门，默认配置自动放行。

### 3.2 成功输出

```ts
{
  status: "completed";
  operationRef: string;
  jobId: string;
  module: { id: string; title: string; version: string };
  target: { campaignId: string; system: string };
  plan: {
    digest: string;
    rootCount: number;
    dependencyCount: number;
    exposure: object;
    packs: Array<{ packId: string; operation: "create" | "update"; entries: number }>;
    assets: { reuse: number; upload: number; bytes: number };
    warnings: Array<{ code: string; path?: string; message: string }>;
  };
  published: {
    batchId: string;
    uuidMap: Array<{ sourceUuid: string; uuid: string }>;
    dependencyDocuments: number;
    entryFailures: unknown[];
    assetFailures: unknown[];
  };
  campaign: { attachedPackIds: string[]; packsRev: number | null };
  verification: {
    packRegistry: "passed" | "failed";
    identityCandidates: "passed" | "not-applicable" | "failed";
    featCandidates: "passed" | "not-applicable" | "failed";
    spellLists: "passed" | "not-applicable" | "failed";
    dependencyResolution: "passed" | "failed";
    readback: "passed" | "failed";
    unresolvedRefs: string[];
    candidateFailures: Array<{ feature: string; path?: string; bucket?: string; packId?: string; classIdentifier?: string }>;
    verificationErrors: Array<{ feature: string; error: string }>;
  };
  navigation: { returnedToPlay: boolean; url: string | null };
}
```

模型输出不包含完整 dump、文档全文或 base64。根 UUID 映射完整返回，依赖只返回计数、失败和必要诊断。

### 3.3 Dry run 输出

返回 `status:"preview"`、上述 `plan` 和显式 `coverage`：

```ts
{
  schema: "passed" | "failed";
  identityAndVersions: "passed" | "failed";
  dependencyClosure: "passed" | "failed";
  catalogExposure: "passed" | "failed";
  spellLists: "passed" | "failed" | "not-applicable";
  startingEquipment: "passed" | "failed" | "not-applicable";
  assetPreflight: "passed" | "failed" | "warning";
  campaignPreflight: "passed" | "failed";
  advancementApply: "not-run";
  persistenceAfterRefresh: "not-run";
  playerBuild: "not-run";
  automationExecution: "not-run";
  crossClientRefresh: "not-run";
}
```

`issues.errors` 为零才允许执行。`issues.warnings` 必须指出不支持或只部分支持的能力，例如 summon activity。

### 3.4 失败输出

- `rejected`：写入前失败，带 `code/issues/retry:false`。
- `partial`：导入或选包已开始，带 `jobId/operationRef`、完成阶段、实际 packIds、条目/素材失败和剩余阶段。
- `indeterminate`：导航、超时或页面中断导致结果未知，带 `operationRef/jobId`；先查 `map_lobby_import_job` 和战役选包状态，禁止盲目重放。
- `completed`：导入无条目/素材失败、战役选包成功、注册刷新与来源回读全部通过。

## 4. 总体架构

```text
LLM 创建/修改世界 Item
  → Desk map_builder_source_attach
  → Map play builderSourcePlan（只读）
      读取根 Item、推导依赖与曝光、生成 canonical dump + plan + digest
  → dryRun 时直接返回 preview
  → Desk 保存 returnPlayUrl，复用 map_lobby_return 到大厅
  → Map lobby builderSourceImportStart（专用内部 workflow）
      合并同模块旧条目，调用现有 import job / importModuleZip({dump, replace})
  → Desk 复用 lobbyImportStatus 等待终态
  → Desk 复用 lobbyCampaignPacksGet/Update 一次性启用所有必需 pack
  → foundry_open(returnPlayUrl) 回原战役
  → worldInfo 确认同一 campaign 的 play 页 game.ready 与 world id
  → 刷新用户包注册，回读身份候选、专长候选、法术列表、UUID 与引用闭包
  → 输出 completed / partial / indeterminate
```

不注册第二套模型通用 API。`builderSourcePlan` 和大厅 prepared-dump 入口是 Map 内部能力，模型只看见 Desk 的 `map_builder_source_attach`。现有 `map_lobby_import_job` 继续负责导入 job 对账。

## 5. Map 实现面

### 5.1 Play：builderSourcePlan

新增独立模块，避免继续膨胀 `agent-runtime.js`：

- 校验 ready play、GM、world 和参数。
- 通过原生 Document API/`fromUuid` 读取世界 Item，使用 `toObject()` 或 plain-object JSON 复制。
- 递归扫描：
  - `system.advancement` 的 ItemGrant、ItemChoice、ASI-feat；
  - `classIdentifier`、职业 Subclass advancement 与规则版本；
  - `system.startingEquipment` 的 linked、OR/AND、generic、currency；
  - `flags.spellClasses`、`preparedSpellTable`、`mtcompat.advancementPolicy`；
  - activities、effects、召唤和富文本中的 UUID；
  - Item 图片、activity 图片、advancement 图标、富文本素材。
- 只打包世界 Item；已有 Compendium 引用保留并验证可解析/已启用。未启用的外部依赖报错，不静默复制。
- 生成稳定映射：`Item.<id> → Compendium.<moduleId>.<packName>.Item.<same-id>`。
- 深度遍历文档，把世界 UUID 改写为 canonical UUID；之后仍由现有导入器统一改写为 `user-<moduleId>`。
- 生成 canonical dump，兼容 `readModuleZip` 的返回形状：`moduleJson/moduleId/title/version/packs/entryCount/outwardEntryCount/assets/rawAssetBytes/warnings`。
- 远端素材在 play 页按真实签名机制读取字节，以有界 base64 传输给 Desk；禁止把签名 query 写入文档。内置 `systems/packages` 引用不重复上传。

`builderSourcePlan` 只返回结构化结果，不写世界、个人库或战役选包。

### 5.2 Lobby：prepared dump 导入

在现有大厅 import service 增加 prepared-module preparation：

- 接收 Desk 传来的 canonical dump 和素材字节，不读取文件槽、不生成 ZIP。
- 读取本人库中同 `moduleId` 的旧 meta/entries。
- 对本次目标 pack 做增量合并：
  - 旧条目把本模块 `Compendium.user-<moduleId>` 归一回 canonical 后，按 `_id` 合并；
  - 新内容覆盖同 `_id` 旧条目，未涉及旧条目保留；
  - 未涉及的 pack 不进入 replace；
  - 首版无删除，不因旧 pack 未出现在本次依赖闭包而 purge。
- `replace.packIds` 只包含本次实际更新的 pack，复用现有素材保留、失败清理和批次逻辑。
- 调用 `runModule`/`importModuleZip({dump, replace})`，沿用现有 `lobbyImportStatus/Cancel`。
- 导入返回的 `entryFailures`/`assetFailures` 数组或真实 `runModule` 的 `totals.failed`/`assets.failures` 数值都不得被 Desk 折叠成成功；数值无法展开明细时至少生成 `{code,count}` 诊断。

大厅 service 版本、API surface revision、操作清单、runtime seams 和发布 FULL 清单按仓内约定同步更新。

## 6. Desk 实现面

新增 `map_builder_source_attach` 专用工具，mtcompat 备团档激活：

- 参数使用 TypeBox 严格校验；`sourceUuids` 去重但保持根顺序。
- 通过页面 runtime 调 `builderSourcePlan`，不把代码串交给 LLM。
- 通过 `FoundryOperationStore` 记录 operationRef、digest、jobId 和结果，防止同一 tool call 重放。
- Dry run 只返回计划。正式调用时内部完成大厅导航、导入等待、选包、返回 play 和回读。
- 大厅导航只复用 `map_lobby_return` 的同等 typed 实现，禁止 `location.assign`、裸 REST 或 `map_page_eval` 操作大厅。
- 战役选包先读 `lobbyCampaignPacksGet`，以刚读到的 `expectedRevision` 增量 add 全部必需 pack；revision 漂移则重新读取，不重放导入。
- 返回 play 使用真实 `returnPlayUrl` 和 `foundry_open` 同等入口。
- 回读 `__MT_REGISTER_USER_PACKS__`、车卡 `listChoices`、专长/法术/装备来源及全部新 UUID。
- `map_lobby_import_job` 仍是导入未知状态的对账入口；本工具不另造 job 查询 API。
- 在 `foundry-tool-policy.js`、telemetry taxonomy 和工具声明测试中同步登记。

### 6.1 实现对齐（2026-11-27）

- **回读实现**：Map 只承诺 `builderSourcePlan` 与大厅 `builderSourceImportStart`，没有额外的 typed verify action。Desk 在回原 play 后执行固定只读 `pageEval` 脚本：先做 `__MT_REGISTER_USER_PACKS__`、`game.packs`、`fromUuid`、根 identifier 与引用闭包检查；再动态 `import("./studio/data.mjs")`，用 `__MT_BRIDGE__.auth` 调 `listChoices(rulesVersion,{auth,refresh:true})` 验证 class/subclass/race/background 根按 `_id + pack` 进入候选，用 `loadFeatOptions` 验证可选择专长根，用 `loadSpellOptions` + `classSpellFilter` 验证 dump 中全部 spell 文档与 `spellClasses`/plan `spellLists` 对应的职业候选。`rulesVersion` 只从根文档 `system.source.rules` 或 plan 的明确字段推导，缺省 2014。URL 回到 play 后先通过 typed `worldInfo`（`readyTimeoutMs:30000`、`executionTimeoutMs:30000`）确认 `ready:true` 与 `world.id`，并再次校验当前仍是同一 `?campaign=` 的 play URL；大厅/登录 URL 即使能返回读面也不接受。ready 失败或超时按 `VERIFICATION_UNAVAILABLE` 的 `partial` 处理，不派发 `pageEval`、不重放导入。脚本不接受模型输入，不是大厅操作，也不替代 `map_page_eval` 的模型入口；任一读面失败都记 `readback`/`verificationErrors` 并只能 `partial`。注意 `pageEval` 的 code 按 async function body 执行（Map 包装为 `new Function("return (async()=>{\n"+code+"\n})()")()`），脚本必须以顶层 `return (async () => { ... })()` 返回结果；裸 IIFE 会让回执 `status:"completed"` 但 `value` 为空。
- **UUID 映射**：优先采用 plan 的 `uuidMap` / `roots`；缺失时按设计约定的相同 `_id` 映射从 dump 推导，并统一改写为 `Compendium.user-<moduleId>.*`。模型输出仍只含根映射与失败诊断。
- **失败计数**：兼容真实 `runModule` 报告的 `report.totals.failed`（条目数）与 `report.assets.failures`（素材数）数值口径，也兼容新入口的 `entryFailures`/`assetFailures` 数组和旧 `report.failures` 合集。数组优先保留明细；只有数值时生成 `{code:"ENTRY_FAILURES"|"ASSET_FAILURES",count}` 诊断。任一项 >0、任一数组非空或 mixed failures 非空都只能 `partial`。
- **preflight 兼容**：`builderSourceImportStart` 加进大厅 client 的 action 白名单与写动作集，但不进旧部署的 required preflight 集；旧 Map 只会让本工具报 `CAPABILITY_UNAVAILABLE`，不会打断世界导入、合集导入与选包等既有工具。
- **世界漂移门**：正式 apply 在首次规划后、离开 play 前用相同参数再规划一次，只比较 `plan.digest`。缺失 digest、第二次 rejected/异常或 digest 漂移都在本地拒绝，绝不进入大厅；一致时继续用初次 dump。dryRun 不受影响，仍只规划一次。
- **状态判定**：写入前失败一律 `rejected`；内容导入已派发后的失败为 `partial`；导航结果未知、job 未知或回原 play 未确认为 `indeterminate`。`completed` 还要求 plan 的内部引用闭包与回读全部通过。
- **revision 漂移**：选包更新最多重读 3 次选包并重试 add；导入只派发一次，任何一次重试都不重跑 `builderSourceImportStart`。
- **版本回执**：进入大厅前的 `plan.module.version` / `dump.version` 只是规划值。默认版本由大厅在读取本人旧合集后递增，因此正式导入等待终态后，Desk 使用 `job.report.module` 中匹配当前 `moduleId` 的真实标题与版本覆盖成功及后续回执；不能把规划默认的 `1.0.0` 当作已入库版本。Dry run 仍展示规划值，不预猜实际版本。
- **失败清理**：partial/indeterminate 不自动回 play、不自动重放；回执明确给出 `jobId`/`operationRef`、实际 packIds 与后续对账入口。若导入已完成但回 play 失败，结果保持 `indeterminate` 而不是伪造 `completed`。

## 7. 内容角色与曝光推导

- `class/subclass/race/background` → identity。
- `feat(type.value="feat")` → featCatalog；`class/race` 等特性只作为间接授予。
- 角色不明的新根 feat 返回 `FEAT_ROLE_AMBIGUOUS`，不靠 pack 名猜测。
- `spell` → 只有 `spellClasses` 等结构化关联才进入对应职业法术列表；不把所有法术自动公开给所有职业。
- 普通装备/物品 → 默认只作为 advancement/startingEquipment 依赖；不进入商店。
- CoC 按真实 `skill/occupation` 类型推导角色 pack，并检查单来源、单角色 pack 和身份冲突。

pack 名采用稳定语义名，例如 `classes/subclasses/races/backgrounds/feats/classfeatures/spells/equipment`；CoC 使用单一技能角色 pack 与单一职业角色 pack。名称只是存储约定，曝光还必须满足真实文档字段。

## 8. Dry run 校验范围

写入前拒绝：

- 非世界根 Item、非法类型、schema/ID/identifier/rules 版本错误。
- 依赖缺失、循环、深度/数量超限、类型错误、外部包未启用。
- 子职业与主职业、Subclass advancement、解锁等级不匹配。
- feat 角色歧义、空候选、数量不合法、法术列表为空或跨模块。
- 起始装备组回链断裂、泛型 key 不支持、数量/货币不合法。
- 素材不存在、不可读、超限、临时签名或本机路径。
- CoC 多来源/多角色 pack 和身份冲突。

明确标为 `not-run`：真实 advancement apply、刷新持久化、玩家建卡、战斗自动化、跨端刷新。Dry run 不声称替代这些验收。

## 9. 状态、并发与更新

- plan digest 覆盖根/依赖文档、素材、moduleId、campaignId、曝光与目标 pack。
- **离开 play 前重算 digest**：正式 apply 在首次 `builderSourcePlan` 之后、`navigateToLobby` 之前，用完全相同的参数再规划一次。初次/再次 digest 任一缺失都拒绝（`PLAN_DIGEST_MISSING`）；第二次 rejected、抛错或缺 plan/dump 协议异常都拒绝（`PLAN_RECHECK_FAILED`）；digest 不一致返回 `TARGET_CHANGED`，提示重新 dryRun。所有拒绝路径零大厅导航、零写入。digest 一致时继续使用初次 dump，不在大厅里再规划；大厅侧仍按自己的 `dump.digest` 复核。dryRun 只规划一次。
- 选包使用最新 `expectedRevision`；漂移只重读选包状态，不重新导入。
- 同一世界 Item 重复发布保持目标 UUID 不变，已有 Actor 快照不改写。
- 同 moduleId 更新必须合并旧条目，禁止整模块清空后只写本次根节点。
- 导入开始后发生导航/超时：保留 jobId，先查 job 和选包，不盲目重试。
- `partial` 必须暴露素材/条目失败；只有全部必要步骤和回读通过才可 `completed`。

## 10. Skill 与文档

新增 `arcane-builder-source-attach` skill，负责：

- 路由“自定义职业/子职业/物种/背景/专长/法术并接入车卡器”。
- 先读 `arcane-item-update` 完成世界 Item authoring，再读 `arcane-builder-source-attach`。
- 使用随包携带的用户合集数据规范，覆盖五种 advancement 根 Item、法术列表、装备组、CoC 技能/职业。
- 默认一次 `map_builder_source_attach`；拿不准发布影响时先 `dryRun:true`，由 LLM 自己判断是否继续。
- 不把世界 Item 创建成功当成玩家可用；必须检查工具回执中的选包与 verification。
- `partial/indeterminate` 先对账，不盲目重放；真实玩家验收另行报告。

同步更新 `arcane-item-update` 的路由和 skill bundle revision，遵守 skill 自包含约束。

## 11. 验证计划

### Map 自动测试

- canonical dump、依赖闭包、引用改写、规则版本与角色曝光。
- class+subclass+feat+spell+starting equipment；独立 feat；background/race；CoC skill/occupation。
- 缺引用、循环、跨包未启用、空法术表、坏装备组、素材超限均零写入拒绝。
- prepared dump 与旧包合并：新增/更新保留旧条目和未涉及 pack。
- 现有 `generic-userpack-verify`、import、lobby actions、api surface、headless 不回归。

### Desk 自动测试

- 参数校验、工具激活、dryRun 零写入。
- play→lobby→play 状态机、job 等待、选包 revision、回读和四态。
- partial/indeterminate 不重放；条目/素材失败不伪装 completed。
- 更新合并、skill 自包含、bundle revision、全仓 verify。

### 真实 Desk LLM 验收

在隔离战役由真实聊天驱动：

1. 创建一个自定义职业、一个子职业、职业特性、法术和起始装备；先 Dry run 修掉一个缺引用，再正式接入。
2. 检查工具实际读取正确 skill、参数正确、无人工审批依赖、无 page_eval 替代专用工作流。
3. 回读用户包和战役选包；玩家账号能选择职业/子职业，特性、法术、装备正确入卡。
4. 连续升一级，核对 advancement、来源和刷新持久化。
5. 再发布一个独立 feat，确认旧职业/子职业仍存在，无整包覆盖和重复候选。
6. 至少覆盖一个 negative：缺依赖不得写入；一个 update：同 UUID 更新不重复。
7. CoC 用自动测试覆盖；若本轮真实账号执行，则记录真实结果，不把未执行写成通过。

结束删除隔离战役、测试合集、上传素材和本地临时产物，停止 Desk/keyring/遥测进程。

## 12. 子 Agent 分工

- Map coder：实现 play planner、prepared-dump 大厅导入、Map 测试、runtime seams/发布清单/PROGRESS。
- Desk coder：实现模型工具、状态机、skill、Desk 测试与文档同步。
- 主 Agent：复核方案与 diff，跑集成测试，处理跨仓契约，执行真实 LLM/玩家验收与清理。
