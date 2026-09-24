# WebMCP 备团（prep）模式对齐计划（2026-09-24）

> 状态：计划（未实现）。前置：play.v1 四件套已随模块 0.5.0 发布（见
> [`play-tools-design-2026-09-21.md`](play-tools-design-2026-09-21.md)）。

## 1. 事实来源与范围

「备团模式」是 Desktop prep 模式的 UI 名称（`messages.js`：
`"header.mode.prep": "备团模式"`，「备团 = 内容准备，跑团 = 探索、扮演与战斗」）。
其 SDK 工具面 = `TOOL_NAMES_BY_MODE.prep` 里的 `foundry_*` 族，共 **11 个 action**，
即当前 WebMCP 与 Desktop 的全部剩余差距（CLI 专用 24 个不在任何模型入口内，
见 2026-09-24 差距盘点）：

| 域 | SDK action | Desktop 工具 | 读/写 |
|---|---|---|---|
| 内容发现 | contentSearch | foundry_content_search | 读 |
| 内容发现 | compendiumBrowse | foundry_compendium_browse | 读 |
| 内容发现 | advancementPlan | foundry_advancement_plan | 读 |
| Actor 读 | actorRead | foundry_actor_get | 读（签发 readRef） |
| Actor 建 | actorCreate | foundry_actor_create | 写 |
| Actor 改 | actorEdit | foundry_actor_update | 写（readRef） |
| Actor 授物 | actorGrantItems | foundry_actor_grant_items | 写（readRef） |
| Actor 升级 | actorAdvance | foundry_actor_advance | 写（readRef） |
| 场景读 | sceneRead | foundry_scene_get | 读（签发 readRef） |
| 场景写 | sceneApply | foundry_scene_apply | 写（readRef） |
| 图像 | imageApply | foundry_image | 写（仅 dataPath 变体） |

Desktop 备团还有一批**非 SDK 宿主工具，显式排除**：`foundry_open`（已有
arcane_probe 等价）、`foundry_screenshot` / `browser_evaluate`（Electron/CDP 宿主
能力；browser_evaluate 永不复刻——等价于全开 43 个 action 并绕过一切 schema）、
`request_user_input` / `open_document` / `web_search`（Desktop 产品功能）、pi 内置
read/edit/write/grep/find/ls/powershell（备团工作目录围栏属宿主文件系统，WebMCP
客户端如 Codex 自带等价能力，不归模块管）。计划完成后 WebMCP 覆盖 Desktop 两种
模式的全部 SDK 工具面。

## 2. 与 play 面的核心架构差异：readRef 会话机制

prep 写契约不靠 turn 快照，靠**乐观锁读状态**。Desktop `foundry-services.js` 的
机制要在模块内复刻（`prep-session.js`）：

- **readRefs**：`actorRead` / `sceneRead` 返回时剥离 `readState`，签发会话级
  readRef（randomUUID），`readRefs Map` 存克隆。内存态、页面会话生存——重载即
  失效，重读即恢复（Desktop parity：它的 readRefs 同为会话内存）。
- **写前校验**：非创建类写必须携带 readRef，且 `readState[actorUuid|sceneUuid]`
  与目标一致，否则 `READ_REF_INVALID`（"Read this document in the current session
  first"）。
- **world identity**：模块现取 `{origin: location.origin, id: game.world.id}`
  （play 面同款），runtime `WORLD_CHANGED` 兜底。
- **requestId**：沿用模型供给幂等键 + world 级账本（§4）。
- **runtime 二层校验**：`READ_REF_STALE` / `READ_REF_INVALID` / `NAME_COLLISION`
  / `SOURCE_MISMATCH` 等由 SDK runtime 兜底，模块层负责会话门控与回执。

## 3. 审批层的设计决策（实现前需拍板）

Desktop 每个备团写工具走 `maybeRequestApproval` DM 弹窗；WebMCP 无宿主审批层。
候选：

- **(a) 直写（推荐首版）**：GM 实时门控 + readRef 乐观锁 + 账本回执。备团写
  本身是可逆内容操作（不似战斗消耗），且 rejected 无副作用可修正重试。
- (b) 模块级 armed 确认开关：复用 write-probe 的 idle/armed 思想做全局「写总闸」，
  Foundry setting 持久，DM 在界面切换。成本：多一个 setting + 工具描述分支。
- (c) 先 dry-run 后执行：SDK 部分维护动作有 dry-run，非全量支持，不做。

默认按 (a) 实施；若真世界验证期发现误写率高，再加 (b)。

## 4. 复用与改造

- **play-ledger**：`LEDGER_ACTIONS` 白名单从 `["executeAction", "conditionsSet"]`
  扩展收编 prep 六写（actorCreate/actorEdit/actorGrantItems/actorAdvance/
  sceneApply/imageApply）；账本机制（requestId 指纹幂等、started 先持久、
  partial/indeterminate 禁重放、上限淘汰）原样复用，更名或保持
  `playOperationLedger` 为通用写账本（倾向保持，避免迁移）。
- **normalizePlayWriteReceipt**：补回 Desktop `upload-image` 步骤分支
  （dataPaths/targets 映射）——P3 imageApply 会产出该步。
- **schema parity**：11 个工具的 JSON Schema 对照 Desktop `foundry-tools.js`
  的 typebox 定义逐字段移植（上限：grant items ≤50、token 布局 ≤100、
  choices bySlot 等），测试冻结。
- **validateDataImagePath 同款校验**：模块内移植（PNG/JPEG/WebP、Data 相对、
  无 `..`/反斜杠/控制字符，≤4096）。`sourcePath` / `upload` 变体一律
  `CAPABILITY_UNAVAILABLE` 拒绝（无宿主字节通道，契约禁止 model 供 base64）。

## 5. 分期

### P1 — 读类五件（零写风险，纯收益）

`arcane_content_search` / `arcane_compendium_browse` / `arcane_advancement_plan` /
`arcane_actor_get` / `arcane_scene_get`。GM 门控只读；actor_get/scene_get 签发
readRef。工作量约为 play 面的 1/3（无状态机，仅 schema + 校验）。

### P2 — 建卡写类四件

`arcane_actor_create` / `arcane_actor_update` / `arcane_actor_grant_items` /
`arcane_actor_advance`。全部走 readRef 门控 + 账本；actor_advance 的 choices
bySlot 槽位校验按 Desktop 描述全量移植（CHOICE_SLOT_UNKNOWN 语义）。
描述文案以 Desktop foundry-tools.js 的英文描述为底（含升级链全部坑位说明）。

### P3 — 场景与图像两件

`arcane_scene_apply`（create/update 双形 + token 布局 + readRef）/
`arcane_image`（imageApply dataPath-only；targetUuid 可选，syncPlacedTokens 保留）。

每期交付：单测（守卫链/readRef 过期/世界漂移/schema parity）+ `npm run check`
全绿；P2 起可选真世界跑（需 Codex 内置浏览器，场景：建卡→升级→授物）。

## 6. 语义差异（Desktop vs WebMCP，全部显式化）

| 维度 | Desktop | WebMCP | 处置 |
|---|---|---|---|
| 写审批 | maybeRequestApproval 弹窗 | 无 | §3 决策，默认直写 |
| 图像 | sourcePath 本地上传 + dataPath | 仅 dataPath | 上传变体拒绝；描述声明 |
| cwd 围栏 | 备团目录 M3 围栏 | 无（客户端自理） | 模块不管文件系统 |
| browser_evaluate/screenshot | 备团可用 | 永不 | 等价全开，明确排除 |
| readRefs | 会话内存 | 会话内存（页面会话） | parity，重载重读 |

## 7. 工具面最终形态

12 → **23 个**（1 probe + 22 GM 门控）；备团族完成后，WebMCP 与 Desktop 两模式
的 SDK 工具面 100% 对齐（43 个 action 中模型入口 19 个全覆盖，CLI 专用 24 个
维持无模型入口的设计）。

## 8. 实施顺序

1. play-ledger 白名单扩展 + 更名判定（半小时级）
2. P1 读类五件 + parity 单测
3. P2 建卡四件 + readRef 机制 + 账本接线
4. P3 场景/图像 + normalize 补分支
5. README 工具清单 + 本计划状态更新；真世界验证跑（可与 play 面的 §9.2 合并
   一次做）
