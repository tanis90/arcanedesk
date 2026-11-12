# foundry_open 面板回大厅导航（play→lobby）——技术方案

> 状态：技术方案，未实现
> 涉及仓：arcanedesk（apps/desktop）；不改 mt-foundry-compat 服务端
> 日期：2026-11-12
> 背景：PR #54（大厅动作下发）本地验收发现的能力缺口——面板停在 play 页时 agent 无法回大厅执行大厅动作

## 0. 目标与边界

给 `foundry_open` 补上 mtcompat 档 **play→lobby 方向的显式导航**，使"备团会话中途回大厅导包/选包、再回 play"成为 agent 可独立完成的往返：

1. prep 模式下，面板停在 play.html（GM 会话运行中）时，`foundry_open` 传入大厅目标（主入口或 `lobby.html`）即导航到大厅。
2. 导航回执明示 GM 会话已退出，并指明回程路径（`foundry_lobby_campaigns_list` 的 `playUrl`）。
3. 大厅动作（import/packs/campaign 选包）完成后，agent 用 `foundry_open(playUrl)` 回到 play 页，runtime 自动重采用，工具面不中断。

明确不做：

- 不改 mt-foundry-compat 服务端，不新增 typed 导航动作（见 §3 方案 B，留作未来升级路径）。
- 不放开 combat 模式：combat 档 play 页保持只回状态（用户拍板，2026-11-12）。
- 不加审批。现状本无审批链：`maybeRequestApproval` 默认断电（`ARCANE_APPROVALS=1` 才启用，`src/main/agent-host.js:65/1129`）；`WRITE_ACTIONS`（`src/main/mt-lobby-client.js:36`）只是导航打断时的错误码分流，不是权限门（用户确认，2026-11-12）。
- 不做 play↔play 跨 campaign 直跳：同 pathname（仅 query 不同）保持幂等只回状态，换战役走大厅中转——与页面自身"回大厅再进"的行为一致。
- 不动 `/auth/**` 登录 hold、不动同 pathname 幂等、不动 lobby→play 既有导航。
- 不动工具声明面：`foundry_open` 在两档所有模式的工具表里本就常驻（`src/main/foundry-tool-policy.js:44-53`），本方案零 loadout 变化。

这里的"自有 VTT"特指 **mt compat**（ArcaneMap 三受信 origin 的 `lobby.html`/`play.html`）。

## 1. 问题与根因

### 1.1 验收现场（PR #54，2026-11-12）

面板停在 play.html（GM 游戏页，`window.game` 就绪），用户要求 agent 做大厅动作。四条路全断：

| # | 路径 | 结果 |
|---|---|---|
| 1 | `foundry_open`（根地址 / `lobby.html` 全路径 / `/lobby.html`） | 三次调用全返回同一 play.html 状态，path 不变，不报错也不导航 |
| 2 | 页面运行时 `globalThis.__MT_LOBBY_SERVICE__` | play 页未装配（实测 `false`）；该服务只挂 lobby.html |
| 3 | `foundry_page_eval` 执行 `location.assign` | 技术可行但无授权语义，等于绕过"别静默踢 GM 会话"的保护；skill 亦禁止在 lobby/auth 页用 eval |
| 4 | `ui.nav` | 空桩 `{}` |

两个 skill（`arcane-mt-packs`、`arcane-world-import`）对此的官方指引是"**停下来让用户更新/重开 ArcaneDesk**"——即当前设计对"面板在 play 页、需要大厅动作"的答案是用户手动切。

### 1.2 根因：继承 + 时机，非前端技术障碍

- **detected 短路继承自 Foundry 档**。`openFoundryView` 的同源幂等原为真 Foundry VTT 而设（"面板已开且与目标同源时绝不导航，保护已登录的 world 会话"，`src/main/main.js:679`）。commit `301a53b`（2026-11-11）建 mtcompat 分支时，"在站内且 detected → 只回状态"一支被原样搬入（`src/main/main.js:771-786`）。
- **该 commit 的动机是登录幂等**。它删掉 120 秒固定登录守卫、换成 URL/path 幂等（`isMtCompatNavigationHold`），解决的是 Keycloak 登录中途重复 open 导致授权码丢失、整轮重来。跨 pathname 显式导航分支只覆盖"未进游戏"阶段（lobby→play）。
- **当时没有回头需求**。`301a53b` 落地时大厅动作尚不存在，工作流单向：lobby→（导入/选包）→play。PR #54 补了大厅 typed 动作，但其设计假设"做大厅动作时面板已在 lobby.html"，未覆盖"agent 正跑在 play 页要把面板带回去"的场景。`docs/lobby-actions-plan.md` 验收项写了"lobby→play→lobby 不改变 active set"，预见了往返路线，却只论证了工具面稳定，往返的导航机制从未设计。

## 2. 前端可行性核查（全部就绪）

| 顾虑 | 事实 | 依据 |
|---|---|---|
| 踢会话后要重登录？ | 不用。认证在 Keycloak cookie + SPA sessionStorage；lobby↔play 同 origin、同 webContents，sessionStorage 共享 | `src/main/page-profiles.js:158-160` |
| 回 play 的 URL 从哪来？ | typed 工具已返回：`foundry_lobby_campaigns_list` → `playUrl` | `src/main/lobby-tools.js`、`skills/prep/arcane-world-import/SKILL.md:32` |
| 回 play 后 runtime 怎么恢复？ | 既有路径：`loadFoundryPage` → 巡检 → `maybeAdoptPageMtRuntimeSource`（A1 页面真源），每次加载都跑；登录完成后 SPA 自跳回 play 走的就是这条路 | `src/main/main.js`（loadFoundryPage 尾部） |
| 导航打断进行中的调用？ | 协议层已预案：`TARGET_CHANGED`（读）/ `JOB_INDETERMINATE`（写），不自动重放 | `src/main/mt-lobby-client.js:219/360` |
| 页面允许离开吗？ | play 页自带"返回战役大厅"链接，SPA 把该跳转当正常用户动作，无卸载守卫 | 验收现场人工确认 |
| 导航会折腾工具面吗？ | 不会。lobby↔play 同档不装卸（D9 既有决策） | `src/main/main.js:263`、`docs/lobby-actions-plan.md` §2 D9 |

未验证项（实现前需一次人工确认）：服务端 GM 断开后重进是否完全无摩擦（如 GM 锁）。与手动点击页面链接等价，已列入 §8 验收清单。

## 3. 方案选择

| 方案 | 内容 | 判断 |
|---|---|---|
| **A. foundry_open 开口子（本方案）** | detected 短路降级为"同 pathname 幂等"：归一化后目标 pathname 与当前不同（且 prep 档）即导航 | **采用**。desktop-only，一张 diff；认证保持、playUrl 回程、runtime 重采用、中断语义全部复用既有机制 |
| B. typed 导航动作 | 服务端在 play 页 `__MT_AGENT_RUNTIME__` 动作面挂 `navigateToLobby()` 并进 apiSurface 声明，desktop 包成 typed 工具（如 `foundry_lobby_open`），随 `refreshToolLoadout` 注入 | 否决（现阶段）。完全 typed-first、可复用页面链接的跳转逻辑，但要跨仓（server+desktop）、协调部署、过 runtime parity 门，成本约 5-10 倍。导航暂非高频一等能力；若未来成为，按此升级 |
| C. pageEval `location.assign` | agent 在 play 页用 eval 强制导航 | 否决。绕过保护、无授权语义、receipt 无导航语义；与"typed 优先、eval 兜底"哲学相悖 |
| D. 补实 `ui.nav` | 渲染层 UI 导航通道下发 | 否决。`ui.nav` 是渲染层 UI 通道，不是 agent 工具面；为 agent 开 UI 通道混淆边界 |

选 A 的核心论据：`foundry_open` 本就是"LLM 用 URL 参数决定去哪"的 loader（主入口/`lobby.html` 归一到大厅、`playUrl` 进 game 页，`src/main/agent-host.js:1331-1335`），lobby→play 方向已通；本方案只是把方向**补对称**，不是加新能力面。

## 4. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | detected 短路降级为"同 pathname 幂等"：归一化后目标 pathname 与当前不同 → 尊重参数导航；相同（含 query 不同）→ 只回状态。`/auth/**` hold 与同 pathname 幂等原样保留 | 幂等的本意是防登录中途重载与重复打开抖动，不是禁止跨页跳转；play?campaign=A→B 同 pathname 不放，换战役走大厅，与页面行为一致 |
| D2 | 仅 prep 档放开；combat 档 play 页保持只回状态 | 战斗中踢 GM 会话代价远高于备团（用户拍板）。mode 来源可靠：host profile 默认 `mode: "combat"`（`src/main/agent-host.js:134`），prep 显式传 `"prep"` |
| D3 | 不加审批 | 现状无审批链在运行（§0）；踢会话数据无损（世界在服务端），加确认会把"回大厅导包再回来"拆成两次人工打断 |
| D4 | 导航发生时回执必须明示会话退出 + 回程指引 | LLM 与用户都要知道发生了什么、怎么回来；这也是 combat 不放开之外的另一道软护栏 |
| D5 | 归一化语义不变：主入口/`lobby.html` → 大厅；`playUrl` → play。不新增参数 | LLM 的"参数"就是 URL，既有设计意图；零接口变化 |
| D6 | 导航判定抽为纯函数（如 `shouldNavigateMtCompat(current, target)`）放 `page-profiles.js`，`isMtCompatNavigationHold` 不动 | main.js 的 `openFoundryView` 深嵌 Electron 依赖不可直测；纯函数四象限可单测，`isMtCompatNavigationHold` 的登录语义零回归风险 |

## 5. 改动清单

1. **`src/main/page-profiles.js`**：新增导出纯函数 `shouldNavigateMtCompat(current, target)`——同 origin 且归一化 pathname 不同返回 true（复用既有的入口归一化逻辑，主入口 `/` → `lobby.html`）；`/auth/**` 恒 false；同 pathname 恒 false。
2. **`src/main/main.js` `openFoundryView`**：mtcompat 分支 detected 命中处（771-786 区域），在"只回状态"前插入判定——`allowSessionExit && shouldNavigateMtCompat(current, target)` 为真则走 `loadFoundryPage(target)` 并在返回 summary 尾注会话退出提示；否则维持现状。函数签名加可选第二参 `{ allowSessionExit }`（默认 false，两处调用点不传即现状）。
3. **mode 门的落点**：不改 `openFoundryView` 内部取 mode（它没有 host 上下文），在 main.js 两处 `openFoundry: openFoundryView` 注入点分别包装——prep registry 注入 `(url) => openFoundryView(url, { allowSessionExit: true })`，combat registry 保持原样。改动局部、语义显式，openFoundryView 不感知"模式"概念。
4. **`src/main/agent-host.js` foundry_open description**：幂等段（约 1328 行）更新为"同 lobby/play pathname 重复打开只回状态；prep 模式下 lobby↔play 跨 pathname 显式导航（GM 会话退出并在回执注明）；combat 模式 play 页保持只读状态"。一两句为限。
5. **skills（两处各一句）**：
   - `skills/prep/arcane-mt-packs/SKILL.md`："page.path 不是大厅时停下来让用户更新/重开" → "page.path 是 play.html 时，用 `foundry_open` 传主入口回大厅（GM 会话会退出，回执有回程指引）；只有 App 版本过旧（无 activatedTools）才让用户更新/重开"。
   - `skills/prep/arcane-world-import/SKILL.md:34` 同步。
6. **测试**：
   - `test/page-profiles.test.mjs`：`shouldNavigateMtCompat` 全象限——同/跨 pathname × 归一化主入口 × `/auth/**` × query-only × 跨 origin。
   - `test/agent-host-tools.test.mjs`：foundry_open description 断言若有快照需同步。
   - 行为集成沿用既有 fixture 路径（`test/fixtures/lobby-e2e-app.mjs` 一族）补 prep play→lobby→play 往返一例；combat 只回状态一例。

## 6. 行为矩阵（改后全貌）

| 起始页 | mode | 目标 | 结果 |
|---|---|---|---|
| lobby | prep | playUrl | 导航（现状，不变） |
| play（detected） | **prep** | 主入口 / `lobby.html` | **导航 + 会话退出尾注（新）** |
| play（detected） | prep | play.html?campaign=B（同 pathname） | 只回状态（现状，不变） |
| play（detected） | combat | 任意 | 只回状态（现状，不变） |
| `/auth/**` | 任意 | 同源任意 | login-in-progress（现状，不变） |
| play（未 detected，引导中） | prep | lobby | 导航（现状，不变） |
| 面板关闭/空态 | 任意 | 任意受信地址 | 全新 view 加载（现状，不变） |

## 7. 回执格式

导航发生且来源页 detected（即真实退出了 GM 会话）时，summary 追加一行（面向模型的英文，随工具结果返回）：

```text
GM session exited by this navigation. Re-enter the game with the campaign playUrl
from foundry_lobby_campaigns_list; world data is server-side and unaffected.
```

未 detected 的普通跨 pathname 导航（lobby→play、引导中→lobby）不加尾注。

## 8. 验收清单

- [ ] 单测：`shouldNavigateMtCompat` 全象限绿；`isMtCompatNavigationHold` 既有用例零改动零回归。
- [ ] prep 会话实测：play 页 `foundry_open(主入口)` → 面板到 lobby，回执含尾注；`foundry_lobby_campaigns_list` → `foundry_open(playUrl)` → 回 play，日志见 runtime 采用，foundry 工具可用。
- [ ] combat 会话实测：同样调用只回状态，面板不动。
- [ ] 同 pathname（play→play 换 campaign query）实测只回状态。
- [ ] 登录中途（`/auth/**`）重复 open 仍 login-in-progress（回归 301a53b 场景）。
- [ ] 服务端 GM 断开重进无锁：手动点页面"返回战役大厅"链接走一个来回等价验证。
- [ ] 既有 desktop 测试套全绿（PR #54 基线 953 项）。

## 9. 风险与缓解

| 风险 | 评估 | 缓解 |
|---|---|---|
| prep agent 误踢运行中的 GM 会话 | 数据无损（世界在服务端），打断的是"正在进行的事" | D4 回执尾注 + skill 指引"导航前向用户说明"；combat 已整体不放（最大风险面已挡） |
| combat 与 prep 共享面板，prep 导航会波及 combat 会话看到的页面 | 既有语义即如此（D9 同档共享、多 resident session 共享面板；进行中调用按捕获目标与页面租约执行，被导航打断报 TARGET_CHANGED/JOB_INDETERMINATE，不静默改目标） | 无新增风险；`docs/lobby-actions-plan.md` §3.7 既有约定兜底 |
| 服务端 GM 重进有锁/摩擦 | 本仓代码无法验证 | §8 人工确认项；若存在，则页面自身链接同样受限，属服务端问题另行处理 |
| foundry_open description 增长影响 prompt | 增量控制在两句内 | 文案审校时合并进既有幂等段，不另起段 |
| 中断写任务后 agent 盲目重放 | 既有防护：JOB_INDETERMINATE 不自动重放 | 无新增动作；skill 已有"结果未知时对账"指引 |

## 10. 未来路径

- 导航若成为高频一等能力（如 agent 自主多战役轮转），升级为方案 B：服务端 play 页 `__MT_AGENT_RUNTIME__` 挂 typed 导航动作并进 apiSurface 声明，desktop 包工具、走 `refreshToolLoadout` 注入；届时可复用页面链接的 SPA 自导航逻辑（优雅断 socket），本方案的 D4 尾注语义平移。
- combat 档是否放开留待战斗流真实需求出现再议；放开时建议先过一次产品评审（战斗中断的代价评估）。
