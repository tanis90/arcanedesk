---
name: arcane-builder-source-attach
description: 把自建职业、子职业、物种/种族、背景、专长、法术、装备，或 CoC 技能与职业接入奥法地图车卡器时使用。先用 arcane-item-update 在当前世界创作 Item，再用 map_builder_source_attach 发布为用户合集并给战役选包；涉及大厅页面时先读 arcane-mt-lobby。不用于商店目录、世界 ZIP 导入或真实玩家建卡验收。
---

# 自定义内容接入车卡器

本 skill 负责“世界 Item → 用户合集 → 战役选包 → 车卡器可用”这条发布链。内容本身的创建与修改归 `arcane-item-update`；大厅登录、页面往返与通用边界归 `arcane-mt-lobby`。

## 分工与前置

1. **先创作世界 Item**：按 `arcane-item-update` 在当前世界创建或修改 `Item.<id>`。本工具只接受世界 Item UUID，不接受合集 UUID、名称、ZIP、user-* 包名或 revision。
2. **涉及大厅前先读 `arcane-mt-lobby/SKILL.md`**：本工具内部会走 play → 大厅 → play；登录、页面往返与统一写入门沿用大厅总则。
3. **发布用 `map_builder_source_attach`**：默认一次调用完成规划、导入、选包、回原 play 与回读。不要自己上传 ZIP、拼 `module.json`、改 `user-*` 包或调用裸 REST。
4. 数据字段不确定时读随包参考 `references/userpack-data-spec.md`；它是本 skill 的运行时规范，不依赖仓库外文件。

## 能接什么

DND 2014/2024：

- 身份：职业、子职业、种族/物种、背景；
- 玩家可直接选择的专长（`system.type.value: "feat"`）；
- 法术与装备/武器/工具/消耗品；
- 由 advancement、起始装备或特性间接授予的内容。

CoC：`skill` 与 `occupation`，以及它们引用的技能与装备。

首版不承诺：商店目录、可执行脚本/宏/runtimeHost、条目删除、真实玩家建卡或升级自动化验收。世界 Item 创建成功不等于玩家可用。

## 调用方式

```js
map_builder_source_attach({
  sourceUuids: ["Item.<职业id>", "Item.<子职业id>", "Item.<法术id>"],
  title: "灰烬秘法",
})
```

- `sourceUuids` 只放本次要公开的**根** Item（1..20 个）。依赖由工具推导，不要逐项列举玩家看不到的内部特性。
- `moduleId` 可省略，缺省 `homebrew-<campaignId>`；不要自带 `user-` 前缀。
- `title` 可省略；`version` 可省略，由工具/Map 按同合集已有版本决定。
- 同一次发布多个根（例如职业 + 多个子职业）传同一个调用；不要拆成多次导入。
- 同 `moduleId` 的后续发布会增量合并旧条目并保留未涉及的旧条目；不要为“更新”另建 moduleId。

### 什么时候用 dryRun

`dryRun: true` 只返回结构化计划（digest、根/依赖数量、曝光、目标 pack、素材、coverage、issues），零写入、不返回 dump/base64。

由你自己判断是否先 dry run：首次发布、依赖多、素材多、身份/法术列表标注不确定时先用 dryRun；计划 clean 后再正式发布。没有人工审批步骤，也不要向用户询问技术参数。

dry run 中 `issues.errors` 必须为空才继续；`issues.warnings` 要如实转述，例如某项自动化不会被发布链路验证。

## 回执四态

- `completed`：导入无条目/素材失败、所有必需 pack 已加入战役、回原 play 后回读通过。回执里的 `published.uuidMap`、`campaign.attachedPackIds`、`verification` 才是对账依据。
- `partial`：导入或选包已开始但未全部成功。带 `jobId`、完成阶段、实际 packIds 和 `entryFailures`/`assetFailures`。
- `indeterminate`：导航、超时或页面中断导致结果未知。带 `operationRef`，可能带 `jobId`。
- `rejected`：写入前失败，带 `code/issues`；不会产生合集或选包变更。发布前会再规划一次比对 digest，世界 Item 在规划后被改动时返回 `TARGET_CHANGED` 且零写入，先重新 dryRun 再重试。

条目/素材失败、选包未完成或回读失败都不得当成 `completed` 汇报。

## partial / indeterminate 对账

1. **不重放本工具**，也不要换 `map_page_eval`、裸 REST 或重新上传 ZIP。
2. 有 `jobId` 时先用 `map_lobby_import_job({ jobId, action: "status" })` 等到终态，读 report/failures。
3. 选包问题用 `map_api_call` 的 `lobbyCampaignPacksGet` 重新读取；revision 漂移只重读选包，不重跑导入。
4. 需要继续修复时，先根据实际状态决定是补发内容还是只补选包；不要盲目再调一次本工具。
5. 回执里的 `navigation.returnedToPlay=false` 时，先 `foundry_open({url: returnPlayUrl})` 回原战役再继续。

## 验收边界

- 工具回读覆盖：用户包注册、根 UUID 解析、identity 候选（class/subclass/race/background 按 `_id + pack` 进入 `listChoices`）、可选择专长候选、法术选项与职业法术过滤（按 dump 中全部 spell 文档和 `spellClasses`）、内部引用闭包；读面失败会明确标 `readback: failed`。不覆盖真实玩家建卡、升级、战斗或刷新持久化。
- 世界里看得到 Item、合集导入成功、统一写入门放行，都不是“玩家已能选择并使用”。
- 最终报告写清实际发布的 moduleId/version、pack、根 UUID、未覆盖项和失败项，不把 `partial` 写成完成。
- 发布后要验证玩家侧时，另走真实账号验收；没有执行就明确写“未执行”。

## 安全与页面边界

- 不接触 Keycloak 账号、密码、验证码或 token；登录由用户在右侧面板完成。
- 大厅页与登录页不做 `map_page_eval`、`browser_evaluate` 或裸导航；play↔lobby 往返只用 typed 通道。
- 不把 dump、文档全文、base64、素材字节或本机路径写进对话、报告或文件。
- 写操作沿用 App 现有统一写入门；被拒绝即零写入，不重试。

## 参考

- `references/userpack-data-spec.md`：五种 advancement 根 Item、法术列表、装备组、CoC 技能/职业、素材与引用闭包、发布前检查。