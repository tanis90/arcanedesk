# play → lobby 独立返回工具（方案 B）——实施计划

> 状态：实施中
> 涉及仓：`mt-foundry-compat`、`arcanedesk`
> 日期：2026-11-13
> 取代：此前修改 `foundry_open` 同源幂等的方案 A；A 不再实施

## 1. 目标与边界

新增无参数 typed 工具 `foundry_lobby_return`，让 prep Agent 能从 detected play 页安全回到大厅，完成大厅动作后再用真实 `returnPlayUrl` 回到原战役。

```text
play → foundry_lobby_return → lobby 动作 → foundry_open(returnPlayUrl) → play
```

明确不做：

- 不改 `foundry_open` 的同源/同 pathname 幂等，不实施方案 A。
- 不用 `foundry_page_eval`、`location.assign` 或 `ui.nav` 代替 typed action。
- combat 与普通 Foundry 不注入该工具。
- 不修改 `packages/foundry-sdk` 的通用导航错误语义，不修改 `arcaneVTT-server` 或数据库。
- 不新增审批卡；prep 引导需在导航前说明会暂时离开当前游戏。

## 2. 仓库职责

### `tanis90/mt-foundry-compat`（前端真源，必改）

负责原生退出、实时连接清理、战役身份和 runtime action。生产 compat 比公开 main 新，实施前必须先同步生产源码基线，不能从旧 main 覆盖线上。

### `tanis90/arcanedesk`（Desktop，必改）

负责工具声明、模式隔离、runtime 调用、预期导航回执、大厅就绪确认、skills 和 Desktop 验收。

### 其它仓

- `arcanedesk-ops`：只使用既有部署与巡检流程，通常不改代码。
- `packages/foundry-sdk`：不为本动作放宽通用 `NAVIGATED`/indeterminate 规则。
- `arcaneVTT-server`：导航不涉及服务端 REST 或世界数据写入，不改。

## 3. 对外契约

### 3.1 Agent 工具

```js
foundry_lobby_return({})
```

正常结果：

```js
{
  status: "completed",
  from: { path: "/user-files/compat/play.html", campaignId: "..." },
  to: { path: "/user-files/compat/lobby.html" },
  returnPlayUrl: "https://arcanemap.com/user-files/compat/play.html?campaign=..."
}
```

已经在大厅时幂等返回：

```js
{ status: "completed", alreadyInLobby: true }
```

回游戏仍使用 `foundry_open({url: returnPlayUrl})`。

### 3.2 前端 runtime action

在 play runtime 注册：

```js
navigateToLobby({})
```

它必须与用户点击“返回战役大厅”共用同一退出与导航实现，负责：

- 从当前 URL 的 `?campaign=` 获取战役身份，不以 `game.world.id` 代替。
- 退出/清理 live client、socket 与订阅，避免自动重连或重复初始化。
- 执行原生大厅导航。
- 重复调用不重复清理，不改变任何世界文档。

同步更新 action 白名单、runtime 协议版本、apiSurface、`docs/runtime-seams.md` 和部署探针。新增静态模块必须登记 `tools/deploy.mjs` 的 `KEY_CHECKS`。

### 3.3 Desktop 确认协议

`foundry_lobby_return` 按以下顺序执行：

1. 校验 prep、当前页面与 runtime。
2. 保存当前可信 play URL 作为 `returnPlayUrl`；campaign 来自 URL，不依赖旧目标记忆。
3. 通过现有 runtime 串行队列调用 `navigateToLobby`。
4. `completed` 或预期的 `NAVIGATED` 都只进入确认阶段，不把后者直接当失败。
5. 验证当前是受信 lobby。
6. 等待 auth、runtime、`__MT_LOBBY_SERVICE__` preflight 全部通过。
7. 返回成功与 `returnPlayUrl`。

失败语义：

- 旧前端无 action：`CAPABILITY_UNAVAILABLE`。
- 登录失效：`LOGIN_REQUIRED`。
- 目的地错误：`TARGET_CHANGED`。
- 结果无法确认：`JOB_INDETERMINATE`。
- 均不自动重放、不降级 eval。

`NAVIGATED` 对普通工具仍是中断；只有本工具可把它视为“导航已发起”，且必须经大厅就绪确认后才能报成功。

## 4. `mt-foundry-compat` 改动清单

1. 同步生产源码基线并记录基线提交/指纹。
2. 抽取 play 页原生“返回战役大厅”共享实现，UI 与 runtime 共用。
3. 清理 live client/socket/订阅，保持 Keycloak 会话，防止重复监听与自动重连。
4. 在 `web/agent-runtime.js` 注册 `navigateToLobby`，更新 runtime/apiSurface 与协议版本。
5. 更新 `docs/runtime-seams.md`、部署清单及探针。
6. 增加前端验收：UI/runtime 同链、清理一次、campaign/return URL 正确、连续三次往返无重复连接。

## 5. `arcanedesk` 改动清单

1. `src/main/foundry-tool-policy.js`
   - `MTCOMPAT_RUNTIME_ACTIONS` 加 `navigateToLobby`。
   - `LOBBY_TOOL_NAMES` 加 `foundry_lobby_return`。
   - 仍仅 mtcompat prep 注入；combat/Foundry 不声明。
2. `src/main/lobby-tools.js`
   - 实现 `foundry_lobby_return`、已在大厅幂等、真实回程 URL 和上述确认协议。
   - 复用 runtime 队列；导航后旧世界调用不自动重放。
3. `src/main/mt-lobby-client.js`
   - 增加有界只读等待，复用 preflight 等待 auth/runtime/service 就绪。
4. Agent 引导
   - `skills/prep/arcane-world-import/SKILL.md`
   - `skills/prep/arcane-mt-packs/SKILL.md`
   - `system-prompts/prep.md`
   - `system-prompts-intl/prep.md`
   统一为 play 需要大厅时先调 `foundry_lobby_return`，不用 eval；完成后用 `returnPlayUrl` 回游戏。
5. 文档与 skills
   - 本文件作为最终方案 B。
   - `docs/lobby-actions-plan.md` 更新工具数与往返流程。
   - `docs/skill-design-contract.md` 记录契约。
   - `skills/prep/bundle.json` 从 r48 升为 r49。
6. 不新增独立路由 skill，不改 combat prompt。

## 6. 测试与验收

### 6.1 Desktop 单元/集成

- 工具 schema、9 个大厅工具准确激活；prep 可见，combat/Foundry 不可见。
- `completed` 与预期 `NAVIGATED` 都进入确认阶段。
- 已在大厅幂等。
- 错误目的地、超时、runtime 缺席均不报假成功。
- lobby service 延迟时等待，随后第一次 campaigns_list 成功。
- `returnPlayUrl` 保留正确 campaign，不串世界；未知结果不重放。

涉及：`lobby-tools`、`mt-lobby-client`、`direct-foundry-runtime`、`foundry-tool-policy`、`lobby-loadout`、`agent-host-tools` 测试。

### 6.2 真实导航验收

现有 `lobby-e2e-app.mjs` 只构造 lobby tools，不能证明 `openFoundryView`/runtime 接线。必须另做真实 Desktop/Agent 验收：

1. prep play → lobby，回执含正确 from/to/returnPlayUrl。
2. 返回后首次 `foundry_lobby_campaigns_list` 即成功。
3. 用 `returnPlayUrl` 回到原战役，runtime 恢复。
4. combat 工具列表无 `foundry_lobby_return`。
5. 连续三次往返无重复 socket/监听，认证不丢，GM 重进无锁。
6. 全程无世界数据异常变化。

### 6.3 部署顺序

1. 同步生产源码基线。
2. 前端提交并验收，部署 compat main，全部探针通过。
3. Desktop 提交到 PR #54，跑全量测试。
4. 真实生产 prep/combat 验收。
5. 验收通过后发布 r49 skills；必要时回滚 r48。

若失败：前端 action 为增量能力，可回滚 compat；Desktop 新工具 fail-closed，不触碰 `foundry_open` 旧路径；无数据库回滚。

## 7. 完成标准

不是“有一个导航函数”，而是：Agent 能独立、安全地往返大厅与游戏；预期导航不误报失败；大厅工具在返回时立即可用；回程不串战役；实时连接不重复；combat 完全不受影响。
