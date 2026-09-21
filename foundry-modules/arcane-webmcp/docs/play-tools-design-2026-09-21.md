# WebMCP 跑团模式工具全开 — 设计（2026-09-21）
> 状态：已于 2026-09-21 在 `feat/webmcp-play-tools` 分支实现（模块 0.5.0，41/41 测试）。§9.2 本地真世界验证跑待做。

## 1. 范围与事实来源

「跑团模式」以 Desktop 的权威清单为准（`apps/desktop/src/main/foundry-tool-policy.js` 的
`TOOL_NAMES_BY_MODE.combat`）：

| Desktop 工具 | SDK action | WebMCP 现状 |
|---|---|---|
| foundry_open | —（宿主连接） | 已有 `arcane_probe` 等价覆盖 |
| world_status | worldInfo（近似） | 已有 `arcane_world_info` |
| foundry_static_context | `staticContext` | **缺** |
| foundry_play_context | `playContext` | **缺** |
| foundry_execute_action | `executeAction` | **缺** |
| foundry_conditions_set | `conditionsSet` | **缺** |

本设计补齐后四个，即 play.v1 协议族（`arcane.play.v1`），使 WebMCP 的跑团能力面与
Desktop 跑团模式逐一对齐。既有 turn.v2 工具（battleContext / turnContext / executeTurn）
保留为已验证的过渡面，见 §7。

## 2. 为什么要复刻一层宿主逻辑

Desktop 的模型侧只传 `actionRef`，`PlayExecuteInput` 里的 `world / contextRef / turn /
resolvedActions` 全部由宿主（`foundry-services.js`）组装：staticContext 快照缓存、
turn 快照缓存、actionRef→resolvedActions 解析、operation 回执账本。WebMCP 没有宿主，
这一层必须进模块。runtime 侧已自带二层校验（`STATIC_CONTEXT_STALE` / `TURN_CHANGED` /
`WORLD_CHANGED` / `BATTLE_NOT_ACTIVE`），模块层的价值是**先读后写**状态机和
requestId 幂等账本，两层职责与 Desktop 完全同构：

```
MCP client
  -> arcane_static_context / arcane_play_context（读，落 PlaySession 快照）
  -> arcane_execute_action / arcane_conditions_set（写，过守卫链 + PlayLedger）
     -> SDK runtime（requireGM + 过期/身份二层校验）
        -> Foundry 世界
```

## 3. 新增模块结构

```
src/play-session.js   # PlaySession：staticSnapshot / turnSnapshot 缓存 + actionRef 解析 + playContext join
src/play-ledger.js    # PlayLedger：world 级持久回执账本（模式取自 turn-execution.js）
```

### PlaySession（内存态，随页面生存）

- `staticSnapshot`：`runtime("staticContext")` 返回的完整手册（contextRef、scope、
  combatants[].actions）。读取成功后 **清空 turnSnapshot**（手册刷新作废回合证据，
  与 Desktop `readStatic` 一致）。
- `turnSnapshot`：`runtime("playContext")` 且 `view=turn` 时缓存。
- `resolveActions(specs)`：按 `actionRef` 在 staticSnapshot.combatants 中解析出
  `resolvedActions[]`（actionId、sourceTokenUuid、actorUuid、itemId、activityId），
  未命中返回 `ACTION_REFERENCE_UNKNOWN`，上限 20 条。
- `joinPlayContext(data)`：复刻 Desktop `readPlay` 的 join —— `availableActionIds`
  （稳定 id）映射为 actionRef；narrative 动作按资源余量过滤；附加
  `staticContextValid`。**此逻辑与 Desktop 重复**，v1 用逐字节 parity 测试锁住，
  后续作为 SDK 增量字段（playContext 直接返回 actionRefs）下沉，届时两处一起删。

### PlayLedger（world 级 Foundry setting 持久，模式取自 turn-execution.js）

- setting `playOperationLedger`，schemaVersion 1，上限 20 条，world scope，config: false。
- 键：模型供给的 `requestId`（WebMCP 无 taskId/toolCallId 消息边界，requestId 同时
  兼作 operationRef —— Desktop 里两者本就同值 `requestId: operationRef`）。
- 指纹：`{worldId, action, resolvedArgs}` 的 JSON 指纹；同 requestId 不同指纹拒绝
  `IDEMPOTENCY_KEY_REUSE`。
- 状态机：dispatch 前持久 `started`，终态 `completed / rejected / partial /
  indeterminate` 持久回填；回执丢失返回不可重放的 indeterminate。
- `arcane_play_context(view=operation, operationRef)` 与既有
  `arcane_execute_turn_receipts` 同源思路，直接查账本。

## 4. 四个工具的契约

所有工具每调用实时 `requireGm`（与既有工具同一模式）。schema 逐字段对齐 Desktop
`foundry-tools.js`，上限不变（actions ≤20、targets ≤20、conditions ≤8、
targetTokenUuids ≤100 等）。

### arcane_static_context（读）

- 入参：空对象。
- 执行：`runtime("staticContext", {}, { requireGM: true })`；缓存快照；清 turn 证据。
- 描述语对齐 Desktop：一次取得全部受支持能力；战斗/切 Scene 才重读；读后必读 turn。

### arcane_play_context（读）

- 入参：`{view?: "current" | "turn"}` 或 `{view: "operation", operationRef: string}`。
- `operation` 视图查 PlayLedger（无 runtime 调用）；其余视图调
  `runtime("playContext", {}, { requireGM: true })`，`turn` 视图落 turnSnapshot，
  返回值经 `joinPlayContext` 加工（actionRef + staticContextValid）。

### arcane_execute_action（写，destructiveHint: true）

模型侧入参（与 Desktop 完全同形，外加 requestId）：

```jsonc
{
  "requestId": "…",                      // 幂等键，兼作 operationRef
  "actionRef": "…",                      // 与 actions 二选一
  "targetTokenUuids": ["…"],             // 可选，≤100
  "input": {                             // 可选
    "spellLevel": 1-9, "attackRollMode": "normal|advantage|disadvantage",
    "selections": {}, "allocation": [], "declaredRiders": [], "targetSpec": {}
  },
  "actions": [ /* 同形数组，≤20 */ ],
  "resolution": "auto|narrative",        // 可选，默认 auto
  "advance": false                       // 可选，默认 false
}
```

守卫链（顺序即实现顺序，全部在 dispatch 前）：

1. `requireGm`（实时）
2. 入参白名单 + requestId 格式
3. PlayLedger 重放检查（同 requestId 同指纹 → 返回存量回执；同 requestId 异指纹 →
   `IDEMPOTENCY_KEY_REUSE`）
4. `STATIC_CONTEXT_REQUIRED`：本页面会话必须先读过 static_context
5. `ACTION_REFERENCE_UNKNOWN`：actionRef 解析（≤20）
6. `TURN_CONTEXT_REQUIRED`：快照 scope 有 combatId 时，turnSnapshot 必须存在且
   contextRef 与手册一致 —— 「每次执行前必读 turn、没有新鲜豁免」由**模块强制**，
   不依赖模型自觉
7. 持久 `started` 后 dispatch：
   `runtime("executeAction", {world, contextRef, turn, resolvedActions, resolution, advance}, { requireGM: true })`
   —— world 由模块现取 `{origin: location.origin, id: game.world.id}`（对齐
   `foundry-input-context.js`），模型不回显任何身份
8. 回执经 `normalizeFoundryWriteReceipt` 的 executeAction 分支同款归一（steps 摘要、
   retry:false 语义），落账本
9. **战斗中任何执行（含失败/中断）后清 turnSnapshot** —— 下一次执行必须重读 turn

runtime 二层校验兜底：`STATIC_CONTEXT_STALE`（手册过期）、`TURN_CHANGED`（回合漂移）、
`WORLD_CHANGED`、`BATTLE_NOT_ACTIVE`、`ACTION_*` 系列。rejected 无副作用可修正重试；
partial/indeterminate 禁止重放（查 operation 视图）。

### arcane_conditions_set（写，destructiveHint: true）

```jsonc
{
  "requestId": "…",
  "targets": [ { "kind": "token", "tokenUuid": "…" }
             | { "kind": "name", "name": "…", "scope": "focus" }
             | { "kind": "selected" } ],          // ≤20
  "conditions": [ { "key": "prone", "active": true } ]  // ≤8
}
```

- 中文别名表逐字节复制 `foundry-services.js` 的 `aliases`（倒地→prone、专注→
  concentrating 等），parity 测试锁住。
- `mode: "combat"`（本模块只有跑团面；prep 语义不属于 WebMCP）。
- `selectedTokenUuids`：Desktop 是**消息提交时**的画布选择；WebMCP 无消息边界，取
  **调用时**的 `canvas.tokens.controlled` —— 工具描述显式说明这一差异，并建议优先
  用精确 tokenUuid。
- runtime 兜底 `SOURCE_MANAGED` / `SOURCE_OUT_OF_FOCUS` / `CONDITION_CHANGED`。

## 5. 刻意不做的身份回显（设计决策）

既有 `arcane_execute_turn` 要求模型回显 6 个身份字段（bridge session / runtime hash /
world / battle / round+turn / source token）。play 工具族**不采用**：会话、世界、
手册、回合身份全部由模块状态机持有并注入，模型无法（也不需要）回显可能过期的值。
页面重载 → 快照清零 → `STATIC_CONTEXT_REQUIRED` 重新建立。这比「模型背诵身份」更强
（不存在抄旧值蒙混的路径），schema 也更小。requestId 保留模型供给，用于幂等与中断
恢复，这是 WebMCP 侧唯一需要的模型侧身份。

## 6. 与 Desktop 的语义差异（全部显式化）

| 维度 | Desktop | WebMCP | 处置 |
|---|---|---|---|
| world 绑定 | 消息提交时的 panel 快照 | 调用时 `location.origin + game.world.id` | runtime `WORLD_CHANGED` 兜底 |
| selected 语义 | 消息提交时选择 | 调用时画布选择 | 描述声明；建议精确 UUID |
| 回执持久化 | 会话级 jsonl（重启即弃） | world 级 Foundry setting（跨重载） | 更利于中断恢复 |
| 审批层 | `maybeRequestApproval` DM 弹窗 | 无 —— schema 即闸门 | README 威胁模型段说明（见 §8） |
| advance=true | DM 明确要求才传 | 同规则写进工具描述 | 模块不额外拦（runtime 拦非战斗） |

## 7. 工具面最终形态与 turn.v2 的去留

注册 12 个工具：`arcane_probe`（无 GM）+ 11 个 GM 门控（world_info、battle_context、
turn_context、write_probe_state、execute_turn_receipts、write_probe、execute_turn、
static_context、play_context、execute_action、conditions_set）。

- turn.v2 三件（battle/turn context、execute_turn）**保留**：已在线上验证过，删除是
  破坏性变更。工具描述加一句「新客户端优先使用 play 工具族」，待 play 面实测一个
  版本周期后在下一个 minor 移除。
- write_probe 两件保留（测试设施，不动）。

## 8. README 同步修订

- 「Current tools」补 4 个 play 工具。
- 「Security boundary」节按 2026-09-21 评审结论改写：工具面不是访问控制边界（GM
  会话本身就是全部权力），其真实价值是 **injection containment + agent error
  containment + 执行可靠性**（bounded action space、模块强制先读后写、requestId
  幂等、持久回执、不可重放语义）。

## 9. 验证计划

1. **单测**（`test/`，node --test，模式照抄 webmcp.test.js）：
   - 守卫链逐条：GM_REQUIRED / 未知字段 / IDEMPOTENCY_KEY_REUSE /
     STATIC_CONTEXT_REQUIRED / ACTION_REFERENCE_UNKNOWN / TURN_CONTEXT_REQUIRED；
   - joinPlayContext 与 Desktop `readPlay` 的 parity（同一输入同构输出）；
   - conditions 别名表 parity；
   - 战斗执行后 turnSnapshot 清空（含 rejected 路径）；
   - 账本：started→completed 回填、重载恢复、上限淘汰。
2. **本地真世界跑**（D 盘 COS 世界，照 `docs/p2-execute-turn-run-2026-09-03.md` 的
   证据格式出 run 报告）：static→turn→execute 首战顺序、narrative 施法、conditions
   中文别名、中断重放保护、advance 后的 turn 失效重读。
3. `npm run check --workspace @arcanedesk/foundry-webmcp` 全绿；模块版本 0.5.0。

## 10. 实施顺序

1. `play-ledger.js` + 单测（无依赖，纯克隆 turn-execution 模式）
2. `play-session.js`（快照/解析/join）+ parity 单测
3. `webmcp.js` 挂 4 个工具定义 + `module.js` 接线（settings 注册、PlaySession 构造）
4. README + 本设计定稿标记
5. 本地 COS 验证跑 + run 报告
