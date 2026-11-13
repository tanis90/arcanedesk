# 大厅能力下发（原生 File + typed tools）——ArcaneDesk 驱动 mt compat 大厅

> 状态：技术方案 v2 已实现；真实本地后端 + Electron/CDP 验收通过
> 涉及仓：mt-foundry-compat（业务真源）→ arcanedesk（桌面端 0.9.0）→ skills r49
> 日期：2026-11-11（设计）/ 2026-11-12（实现与验收）
> 追加：play → lobby → play 往返（方案 B）见 [foundry-open-lobby-return-plan.md](foundry-open-lobby-return-plan.md)；大厅 typed 工具随之由 8 个增至 9 个。

## 0. 目标与边界

把 mt compat 战役大厅已经具备的能力，以小型 typed tool 面交付给 ArcaneDesk agent：

1. 上传 FVTT 世界包：解析、素材上传、创建战役、文档写入、导入批次与失败清理。
2. 上传合集包：写入用户个人库、`userpack-assets` 与导入批次；同 moduleId 重传即替换。
3. 管理合集库：合集/单包清单、条目只读预览、按合集或单包删除。
4. 管理战役选包：读取已选引用，增量勾选/取消，维护 SRD 两旗并 bump `packsRev`。
5. 往返游戏页：Agent 当前在某个战役的 play 页而任务需要大厅时，用 `foundry_lobby_return` 回大厅，完成后再用真实 `returnPlayUrl` 回到原战役。

明确不做：

- 不在 Electron/Node 重写世界或合集导入业务，不把 access token 交给 agent 或 Node。
- 不新增本地 HTTP 服务、一次性 ticket、自定义协议、通用 REST/eval 工具。
- 不为 9 个固定工具引入 tool_search、Code Mode 或 WebMCP 依赖。
- 不承诺页面关闭/刷新后任务继续；中断只支持对账，不自动重放。
- 新版主路径不收密码。旧版 dnd5e（<5.3.0）与大厅保持一致地拒绝并指引升级；旧 ROPC 脚本已从 skill bundle 删除，没有旧 CLI 降级通道。
- 第一阶段不变更后端 API/Schema，不触发后端发版。
- 文件只接受 prep cwd 与 Desktop 自有镜像缓存；目录外读取、目录外授权、系统文件选择器及新的权限/审批框架本期都不做。写操作只接 App 现有审批机制，不新增强制审批级别。

这里的“自有 VTT”特指 **mt compat**；“FVTT”指普通 Foundry VTT 页面。两者共享 ArcaneDesk，但不共享本方案的 lobby 专有工具。

## 1. 硬约束

| # | 约束 | 依据 |
|---|---|---|
| C1 | 鉴权只来自页面 Keycloak PKCE 会话 `__MT_AUTH__`；模型、tool 结果、journal 不接触密码/token | `web/mt-oidc.mjs`、`web/lobby.mjs:759` |
| C2 | 页面是受信远端 `WebContentsView`：contextIsolation 开、nodeIntegration 关、无 preload | `src/main/main.js:454` |
| C3 | 文件字节不得进入模型上下文、base64-eval 或 journal；50–500MB 包继续走 Blob 随机读取和素材惰性解压 | `web/zip-source.mjs:1` |
| C4 | UI 与 agent 必须共享同一业务服务，保留映射、替换、归属、批次和失败清理语义 | `web/import-panel.mjs:911`、`web/import-module-client.mjs:1026` |
| C5 | 合集库与战役引用是两种资源；更新必须保留未涉及数据，不得用全量覆盖方便实现 | `web/lobby.mjs:1471`、`web/lobby.mjs:1747` |
| C6 | play 的 game readiness 和 Foundry SDK 行为不变；lobby 不伪装成“没有 game 的游戏页” | `src/main/page-profiles.js:107`、`packages/foundry-sdk/src/client.ts:603` |
| C7 | runtime 业务真源在 mt compat；桌面拷贝只做离线兜底并记录 parity | `web/agent-runtime.js` |
| C8 | 新增页内全局服务缝必须登记 owner/生命周期/验收面 | `mt-foundry-compat/docs/runtime-seams.md` |
| C9 | 工具面遵循奥卡姆剃刀：每个工具必须有不可替代的资源或独立的读写/审批语义 | 本方案 §3.5 |
| C10 | 本地验收与用户点头先于提交/PR/部署；skills 走独立 revision 与 minAppVersion fail-closed | 两仓既有发布纪律 |

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | typed lobby actions，不做业务 DOM 自动化 | 业务状态、错误、清理和验收必须稳定；唯一 DOM 节点是服务专用隐藏文件框，不依赖可见 UI 选择器 |
| D2 | 用 Chromium `DOM.setFileInputFiles` 交付本地文件 | 直接产生磁盘 backed `File`，复用现有 Blob 管线；无需 HTTP/CORS/LNA、ticket、base64 或 Electron 业务重写 |
| D3 | 独立 `MtLobbyClient`，不改 Foundry SDK preflight | lobby 与 play 的鉴权、路径和就绪语义不同；避免污染现有 `mtCompatIsReady` |
| D4 | LLM 只见 `import_start + import_job`，inspect 藏在 start 内 | 四个 RPC 工具会增加上下文与编排错误；内部仍保留 inspect/run/status/cancel 清晰边界 |
| D5 | 初始全集新增 8 个大厅业务工具 | 覆盖完整能力且不为列表、预览、战役目录制造重复工具 |
| D6 | 战役选包只增量 update；合集删除有独立审批和版本指纹 | 防止全量 set 漏项、误取消引用及按旧清单删除 |
| D7 | 工具实现静态注册，模型声明按真实页面档位动态切换 | 会话启动不知道目标，且同一会话可能切换 VTT；不需要动态加载实现，更不能只靠启动时静态名单 |
| D8 | 动态声明不是安全边界；每次调用都重新校验目标并绑定页面 epoch | 历史消息、模型误调用、页面切换都可能绕过当前工具名单 |
| D9 | 档位粒度停在 foundry/mtcompat，不按 lobby/play 路由反复装卸 | 保持缓存稳定；lobby→play 后仍需查询 job、读取合集或核对结果 |
| D10 | 复用现有镜像流程产生的真实暂存产物，再走同一原生 File 通道 | Desktop 只识别带可信标记、hash 与真实 ZIP 的 `world-stage`/`stage` 目录；不新增下载器或 `sourceUrl` 输入，不开放桶 CORS |
| D11 | CDP 验收分“大厅 runtime”与“真实 Desktop tool”两层 | 直接调 runtime 会绕过路径围栏、审批、tool policy 和 job 管理，不能冒充端到端 |
| D12 | Code Mode 只留作未来只读批量聚合选项；WebMCP 只借鉴生命周期 | 官方也建议审批敏感写操作走直接调用；当前不需要新协议或脚本执行面 |
| D13 | 追加第 9 个工具 `foundry_lobby_return`，不改 `foundry_open` 幂等 | 同源/同 pathname 幂等是 `foundry_open` 的正确语义，为回大厅放宽会让所有导航调用失去重放保护；独立无参 typed action 与 play 原生“返回战役大厅”共用退出实现，失败语义可枚举 |

## 3. 技术设计

### 3.1 总体链路

```text
LLM：9 个 typed tools
  ↓
Desktop tool policy + 每次调用的目标守卫
  ↓
MtLobbyClient（独立 preflight、串行队列、navigationEpoch）
  ├─ 原生 File 适配器：realpath/hash → 固定 CDP → File
  └─ mt compat agent-runtime 薄分发
        ↓
      __MT_LOBBY_SERVICE__
        ├─ 共享世界导入服务
        ├─ importModuleZip 现有合集管线
        ├─ 合集库服务
        └─ 战役选包服务
        ↓
      页面会话 → REST / upload-pool / OSS
```

工具实现随 App 受信发布，不从页面或模型动态下载 JavaScript。页面只提供已版本化的业务 runtime；原生文件绑定只在 `import_start` 首次需要时执行，不启动任何常驻服务。

### 3.2 mt compat：共享业务服务

#### 世界与合集导入

新增无 DOM 的导入编排服务，现有面板和 agent 都调用它：

- 世界档抽取 `import-panel.mjs:911-1267` 的业务段，不复制第二份流程：
  版本/系统拒绝档 → 资产计划与上传 → 创建或校验战役及 ruleset → 映射与归属 →
  封面 → 集合写入 → 导入批次 → 报告 → 失败清理。
- 合集档直接复用 `readModuleZip` / `importModuleZip`：
  `profile/me` 个人库、`userpack-assets`、条目/meta/批次、同 moduleId 替换和资源保护。
- 纯素材 zip、旧版 dnd5e 按大厅现有规则拒绝，不为 agent 开侧门。
- `failurePolicy: "abort" | "continue"` 默认 `abort`；选择 continue 必须出现在批准计划中。
- `__MT_IMPORT__` 继续作为 UI 观测投影，不能充当多 job 注册表。

#### 合集库与战役选包

抽取大厅现有私有逻辑为 UI/agent 共用服务：

- `loadProfileImportState` 聚合合集、单包、legacy 行和素材账。
- 条目读取复用 user-pack REST provider，强制分页/搜索，不把整个合集塞给模型。
- 删除复用 `createProfileScope(...).purge`，语义保持：世界中已取用的快照不变；未 detach 的引用会成为 missing。
- 选包读取包含 selected、missing refs、内建只读组和 enabledSources。
- 更新时重新读取，合并 add/remove，保留 ownerPid、missing refs 和其他 enabledSources 字段；PUT 后只 bump 一次 `packsRev` 并回读。

#### runtime 接法

`agent-runtime.js` 会序列化后脱离 ESM 闭包执行，不能直接捕获新 import。由模块装配一个登记过的 `globalThis.__MT_LOBBY_SERVICE__`，runtime 只做白名单薄分发。

内部动作可以保持细粒度：

- 文件 slot 创建、inspect、run、status、cancel。
- campaigns list、packs list/read/delete。
- campaign packs get/update。

这些内部动作不等于 LLM 工具数量。`lobby.html` 显式装配服务与 runtime；apiSurface、runtime version 和 `docs/runtime-seams.md` 同步更新。

### 3.3 原生 File 通道

`import_start` 内部按以下顺序执行：

1. Desktop 校验 `sourcePath`：只允许 prep cwd 与 Desktop 自有镜像缓存，做 realpath 围栏、普通文件、size/mtime 和流式 sha256 检查；目录外路径直接拒绝，不增加授权兜底。
2. `MtLobbyClient` 完成受信 origin + lobby 路径 + 页面会话 + runtime/service 版本 preflight。
3. Desktop 用固定 `Runtime.evaluate` 取得服务专用隐藏 `<input type="file">` 的 remote object。
4. 调用 `DOM.setFileInputFiles({files:[realpath], objectId})`；随后可 detach debugger。
5. runtime inspect 读取真实 `File`，生成内部 `preparationId`，绑定文件身份、解析 dump、目标、替换范围和计划。
6. 展示服务生成的实际计划，经 App 现有审批机制处理后 run，返回 `{jobId, plan}`；不新增强制审批级别。
7. `import_job` 查询或取消；完整报告只在终态返回。

约束：

- CDP 表达式和命令由 Desktop 固定持有，模型只传路径，不能传代码。
- 文件框不是现有业务面板的选择器，不点击文件框，不依赖 change 事件。
- 不弹 OS 文件选择器，不打开 DevTools 窗口，也不要求显示导入面板。
- 页面只能获得这一次明确授权的 `File`；切换文档后授权自然失效。
- 大小与 zip 安全上限沿用 `zip-source` 和服务端政策，不另造无依据的 1GiB 主通道限制。
- `preparationId` 只在 Desktop/runtime 内部使用，不暴露给 LLM。

本机 Electron 44 探针已验证：隐藏文件框可绑定真实文件、detach 后仍可切片读取、`File.path === null`、DevTools 已打开时仍可附加。该探针只证明机制，不替代真实大型世界包云端验收。

### 3.4 独立 MtLobbyClient

职责仅限：

- 受信 origin、lobby 路径、`__MT_AUTH__`、runtime/service 版本检查。
- lobby action 白名单、串行队列、导航安全 evaluate。
- 原生文件绑定、job 与 `webContents.id + navigationEpoch` 关联。
- `LOGIN_REQUIRED`、`PROFILE_MISMATCH`、`CAPABILITY_UNAVAILABLE`、`JOB_INDETERMINATE` 等稳定错误。

不修改：

- `PAGE_PROFILES.mtcompat.isReady` 的游戏语义。
- Foundry SDK 的 `/game` preflight。
- 普通 Foundry 的 runtime 与工具名单。

### 3.5 LLM 工具面（当前 9 个）

| Tool | 最小入参 | 返回与独立理由 |
|---|---|---|
| `foundry_lobby_rulesets_list` | `{}` | 当前部署 `rulesets.mjs` 的 `{id,label,system,supportLevel?}`，世界导入前读取并让用户选择；不由 skill 硬编码规则 |
| `foundry_lobby_import_start` | 世界：`{sourcePath, expectedKind?, campaignName?, ruleset, failurePolicy?}`；合集包：`{sourcePath, expectedKind:"collection", failurePolicy?}` | 内部绑定、inspect、现有审批链并启动，返回 `{jobId, plan}`；唯一导入写入口。世界（含自动识别）的 `ruleset` 由用户明确选择，缺参或不在当前规则列表都拒绝，不走大厅默认值 |
| `foundry_lobby_import_job` | `{jobId, action:"status", waitMs?}` 或 `{jobId, action:"cancel"}` | 长任务状态与生命周期；status 默认精简，终态才给完整报告 |
| `foundry_lobby_campaigns_list` | `{}` | 战役目录 `{id,name,ruleset,owner,playUrl}`，解决按名称发现目标 |
| `foundry_lobby_campaign_packs_get` | `{campaignId}` | 当前选包、missing、内建组、SRD 和选包 `revision`，是 update 的读取前置 |
| `foundry_lobby_campaign_packs_update` | `{campaignId, expectedRevision, add?, remove?, enabledSourcesPatch?}` | 唯一选包写入口；增量合并、现有审批链、回读、packsRev |
| `foundry_lobby_packs_read` | `{}`、`{moduleId?}` 或 `{packId, query?, cursor?, limit?}` | 合集库清单与条目预览两个只读形态；清单给库 `revision`，条目强制分页 |
| `foundry_lobby_packs_delete` | `{packIds, expectedRevision}` | 唯一合集库删除入口；影响预览、现有审批链、purge 与清理结果 |
| `foundry_lobby_return` | `{}` | 仅 mtcompat 备团：把当前 play 页送回大厅，回执 `{status,from,to,returnPlayUrl}`（已在大厅为 `alreadyInLobby:true`）；回游戏用 `foundry_open({url:returnPlayUrl})`，不改 `foundry_open` 幂等 |

明确不提供：

- 独立 inspect/run/status/cancel 四件套。
- 全量 `campaign_packs_set`、单独“更新合集包”工具或删除时自动 detach。
- `preparationId`、`keepAssetIds`、原始 REST/eval、CDP 或文件绑定工具。
- 额外登录工具；继续使用 `foundry_open`，需要登录时结束当前轮次让用户直接在面板登录。

审批边界：start、update、delete 统一接 App 现有 `maybeRequestApproval`，是否展示审批卡及缺省放行行为完全沿用当前策略，不新增强制审批级别或权限框架；status/list/get/read 只读；cancel 只能取消已启动的 job，且“已接受取消”不等于“已停止并清理”。

输出纪律：轮询只给 phase/progress/currentItem/failureCount；完整 failures/report 仅终态或显式错误返回；清单与条目有界。

实现后的精确契约补充：

- `import_start` 的外部 `expectedKind` 只接受 `world | collection`；Desktop 调 runtime 前把 `collection` 归一为内部 `module`，报告保留 `kind:"module"`，不把 `module` 加回公共工具 schema。
- job 快照同时保留 `phase`、`status`、`terminal`；成功为 `succeeded`，`failed`/`cancelled` 也是终态。`cancelling` 只表示已接受取消。
- `packs_read` 清单形态保留 `packCount`，空库明确为 0；条目形态只给有界预览、分页游标与包摘要。
- 所有 stale revision 都报 `REVISION_MISMATCH`，且在批准和底层写入之前拒绝。
- `enabledSourcesPatch` 只接受非空 `{srd2014?:boolean,srd2024?:boolean}`；refs 或 sources 有实际变化才恰好 bump 一次 `packsRev`，sources-only 也 bump，no-op 不写不 bump。
- 删除预览包含 `affectedCampaigns`、关联素材去重数与条目/批次统计；公共删除不暴露 `keepAssetIds`，不自动 detach，世界快照保持不变。
- 工具结果隐藏本地完整路径，但保留完整的 HTTP/HTTPS 业务 URL（包括含 `/var/` 段的 URL）；`preparationId`、文件字节和凭证不进入模型结果。

#### play → lobby → play 往返（方案 B）

```text
play → foundry_lobby_return({}) → lobby 动作 → foundry_open({url:returnPlayUrl}) → play
```

- 只在 mtcompat prep 注入；combat 与普通 Foundry 不声明，combat prompt 不改。与 play 原生“返回战役大厅”共用退出实现，清理 live client/socket/订阅一次，保留 Keycloak 会话。
- `completed` 与预期 `NAVIGATED` 都只进入确认阶段：Desktop 再确认受信 lobby 且 auth/runtime/`__MT_LOBBY_SERVICE__` 就绪后才报成功；Agent 不把导航中断当可重放失败。
- `CAPABILITY_UNAVAILABLE`（旧前端无 action）、`PROFILE_MISMATCH`（不在 ready play 页或缺 `?campaign=`）、`LOGIN_REQUIRED`、`TARGET_CHANGED`、`JOB_INDETERMINATE` 均不自动重放，也不降级 `foundry_page_eval`。
- 回程 URL 由 play URL 的 `?campaign=` 决定，不用 `game.world.id` 猜；不串战役。
- 引导落在现有 skill：世界导入与内容包分别沿用 `arcane-world-import`、`arcane-mt-packs`，不新增独立路由 skill。完整契约见 [foundry-open-lobby-return-plan.md](foundry-open-lobby-return-plan.md)。

### 3.6 版本指纹与中断语义

`expectedRevision` 是客户端读模型指纹，用来发现“Agent 读完后状态已变化”，不是假装后端已有 CAS：

- update/delete 前重新读取并比较；不一致则零写入拒绝。
- ArcaneDesk 内同一资源串行，写后立即回读并返回真实结果。
- 第一阶段后端没有 If-Match，跨客户端在“最后读取→PUT/purge”之间仍有小竞态窗；不得宣称完全防止并发覆盖。若未来需要硬保证，再单独立后端条件写契约。

job 只活在当前大厅文档：

- 每页一个活动导入；UI 与 Agent 不并发写同一导入状态。
- 页面导航、刷新、崩溃或目标切换使旧 job 进入 indeterminate。
- 回到大厅后先查战役、批次和库状态，不自动重新导入。
- 工具从模型视图移除不会隐式取消 job；任务是否可继续只看原目标 epoch。

### 3.7 双 VTT：动态能力声明，而非动态实现装载

#### 三层模型

1. **注册层**：全部受信 tool 实现随 App 静态注册，无按需进程、MCP server 或脚本下载。
2. **声明层**：按宿主确认的真实页面档位，决定哪些 schema 进入下一次模型请求。
3. **执行层**：每次调用独立检查 profile、受信 origin、目标 webContents、navigationEpoch 和版本；声明错误不能变成越权执行。

#### 会话流程

```text
会话启动：不知道目标
  → 通用工具 + foundry_open；mt compat lobby 工具不声明
  → foundry_open(url) 由 URL/origin 识别 foundry 或 mtcompat
  → 宿主计算该档位的工具集并刷新 active tools
  → 下一次模型请求即可使用新工具，不要求用户再发一轮“继续”
```

`foundry_open` 是自然 loader，不新增 `search_tools` 或 `enable_mtcompat` 工具。返回中增加 `profile` 与本档新增的 `activatedTools`，让模型明确知道能力已变化。

规则：

- 只有宿主依据受信 URL/runtime 证据切换，不能由用户或模型一句“这是 mt compat”开通。
- mt compat prep 增加本方案 9 个工具；combat 和普通 Foundry 不增加。
- lobby↔play、auth 跳转保持同一档位，不重复装卸；只在 foundry↔mtcompat 或面板失效时改变。
- 会话恢复时重新对账，不能盲信历史 system message 中残留的 active tools。
- 多 resident session 共享一个面板，激活可随当前档位刷新；已开始的调用仍按捕获的目标和页面租约执行，不能因另一会话切换页面而静默改目标。
- 懒加载工具的说明放在 tool `description` 和 `foundry_open` 结果中，避免用 attach 时静态 prompt 片段承载错误的档位信息；档位序言若保留也必须随 loadout 重算。

#### 为什么不选另外三种机制

| 机制 | 业界事实 | 本方案判断 |
|---|---|---|
| 小工具集直接声明 | OpenAI 对小集合/高频工具推荐 eager；结构最简单、缓存稳定 | 9 个工具本身不大，但跨档位直接暴露会产生错误能力；可作降级，不作首选 |
| 宿主 loader 动态激活 | Pi 支持 loader 执行时改变 active tools，并在下一次模型请求前生效；移除/替换使用普通完整工具表，可能损失缓存 | **采用**。能力来源确定、集合小且需要宿主权限判定，不需要模型搜索 |
| 模型 tool_search / deferred loading | OpenAI/Pi 适合大目录、少量按需工具；增加发现步骤和检索不确定性，已加载工具会影响后续上下文与缓存 | 不采用。9 个固定工具没有目录发现问题，且 tool_search 不能代替执行权限门 |
| Code Mode / Programmatic Tool Calling | 适合并行、循环、聚合大量只读结果；OpenAI 明确建议写操作/审批敏感动作默认直接调用 | 不作为主路径。未来可用同一 typed 只读工具做批量聚合，写面仍直接调用 |
| Codex WebMCP site tools | 页面注册预定义工具，访问时发现，导航后可能失效；调用绑定来源页面与注册并经过安全审查 | 借鉴生命周期和来源绑定；当前标准/宿主支持不构成收益，不另加协议适配器 |

动态激活的验收目标首先是**正确能力和不中断会话**，不是机械追求 token 下降。档位切换应低频；token、缓存命中和延迟用代表性任务对比，而不是假设动态总是更省。

### 3.8 与现状的 gap

- `TOOL_NAMES_BY_PROFILE` 已有正确的分档概念，但只在 `AgentHost.attach()` 读取一次；页面后开或跨档切换不会刷新当前会话。
- `foundry_open` 已返回 profile，可复用为 loader；Pi 当前版本已有 `setActiveToolsByName`，无需重建会话或更换 SDK。
- mt compat 支持面序言和 eval 描述也在 attach 时快照，需随 loadout 重算或移出静态序言。
- `PageProfileRoutedRuntime` 解决 play 路由，不解决 lobby preflight、原生文件和 lobby job。
- 世界导入及合集管理仍有大段 UI 私有编排，必须先抽共享服务，不能让 agent 再抄一份。
- r45 `arcane-world-import` 仍是旧服务器、ROPC 和旧导入语义，不能只改两行提示就当作新能力。

## 4. 实施顺序

### Stage 1 —— mt-foundry-compat

1. 抽取世界导入共享服务，面板改为同一服务调用；合集直接复用现有管线。
2. 抽取合集库与战役选包服务，加入增量更新和版本指纹。
3. 装配 `__MT_LOBBY_SERVICE__`、文件 slot、job registry 与 runtime 薄分发。
4. 更新 apiSurface、runtime version、发布清单和 runtime-seams。
5. 新增 `tools/stage22-lobby-actions-verify.mjs`：Node 基线、浏览器 File 注入、REST/play 对账、失败与清理。

### Stage 2 —— arcanedesk

1. 实现 `MtLobbyClient` 与原生 File 适配器。
2. 新增 `lobby-tools.js` 的 9 个工具，保持 schema 精确、输出有界、审批 deny 零底层写；`foundry_lobby_return` 走 runtime `navigateToLobby` 与大厅就绪确认，不碰 `foundry_open` 幂等。
3. 扩展 `foundry_open` 为 loader：按真实档位刷新所有相关 host 的 active tools，返回 activatedTools。
4. 执行层独立目标守卫、资源租约、navigationEpoch 和 indeterminate 对账。
5. runtime 按真实来源同步 parity，不跨版本盲拷。
6. 完成 node:test、Electron fixture、真实 tool + CDP E2E 和双档位策略测试。

### Stage 3 —— skills r46

- `arcane-world-import` v2：定位 zip → `foundry_open`（需要则用户登录）→ `import_start` → `import_job` → 报告/playUrl；不再收密码。
- 新 `arcane-mt-packs`：上传/替换、清单/预览、战役勾选/取消、删除及其 packsRev 生效链。
- skill 不指导模型使用 Code Mode、tool_search、裸 REST 或 ROPC 作为主路径。
- `bundle.json` revision 单调增加，minAppVersion 钉包含本方案的桌面版本；旧 App fail-closed 留旧 bundle。

## 5. 验收设计

### 5.0 已执行的验收（2026-11-12）

- compat `npm run test:lobby-actions`：**70/70**，覆盖 Node 服务、浏览器原生 File 绑定、runtime 分发、REST、替换、选包与取消。DND/BRP 无头 ready 均为 0 报错，`p3-boot-integration-verify` 38/38。
- Desktop `npm run test:e2e:lobby`：16 项全过，覆盖真实 tool 注册、原生 File、合集/选包、镜像暂存目录、审批拒绝零写入和 `Page.fileChooserOpened=0`；没有系统文件浏览器或 DevTools 窗口参与。
- ArcaneDesk 根 `npm run verify` 通过（源码边界、文档、类型检查、全部 workspace 测试、build 和 pack 检查）；runtime 与 compat 真源逐字节一致。skills 相关 72/72 通过。
- 使用 `BaccanoEva/arcaneVTT-server` 的 Go 后端、真实 MongoDB 7、local file store 与本地开发身份，执行 `node scripts/full-acceptance.mjs`：**world 20 + packs 71 + large 21 + negative 39 = 151 项全过**。world 实际进入 play 且回读角色、场景、物品；packs 覆盖 v1→v2 替换、分页、选包、删除与 stale 零写入；negative 覆盖审批拒绝、目录越界与导航 indeterminate。
- 大包 ZIP 为 **367,042,146 bytes**，实际上传 **350 件 / 350 MiB**；没有整 ZIP `arrayBuffer()`，最大 Blob 分片 **4 MiB**，清理后资产配额恢复。报告在本机 `D:/code/arcane-family/.tmp/lobby-actions-worktrees/acceptance/logs/full-acceptance-latest.json`，测试战役和合集均已清理。
- 人工 UI 小包与真实 Desktop tool 小包也已对账：均为 3 个文档、6 件素材成功上传并清理。未使用本地 HTTP 文件服务或 ticket。

未执行生产部署、生产账号验收、安装包 smoke 或 OSS skills 发布。compat 全仓 `npm test` 仍有既存文档契约漂移、`profile-access-verify` 两项基线失败（已在干净 `origin/main` 同现）及 Windows symlink/硬编码 shell 限制；这些不作为本功能通过项，也不以跳过测试的方式掩盖。后端 `go vet ./...` 通过，Go 全量测试有 `internal/feedback` 的 Windows 文件权限位断言差异（666 vs 600），与本次零后端改动无关。

### 5.1 分层门

| 层 | 驱动 | 证明什么 |
|---|---|---|
| Node 单测/集成 | schema、policy、service fixture、revision、审批 deny | 无云端时输入、权限、状态机和清理边界正确 |
| compat CDP | 真实 lobby 页 + `DOM.setFileInputFiles` + runtime | 共享业务、原生 File、runtime、REST/OSS 与 play 生效 |
| Desktop E2E | Electron fixture 中执行真实 tool，外部 CDP 驱动/断言 | tool→Desktop 原生绑定→runtime→云端的完整交付链 |
| 安装包 smoke | `--remote-debugging-port` + 真实 tool 验收入口 | 打包后工具注册、loader、runtime parity 和资源路径正确 |

真实 Desktop tool 验收沿用 `test/smoke-foundry-image.mjs` 的“real tool → service → runtime”模式；原生绑定必须在 Electron 主进程执行。不得只调页内 runtime 就宣称 Desktop 通过，也不为生产增加通用远程 tool-invocation 后门。

### 5.2 世界包

- mini fixture 与一个 300–500MB 代表性包分别跑通。
- 同名 zip 分别走人工文件选择与 Agent 通道；去掉 id/时间戳后报告、集合计数、素材计划一致。
- REST 回读 ruleset、集合、素材、导入批次；play 回读 `game.actors/scenes/items/...`，不是只看 tool 成功。
- 记录 `Page.fileChooserOpened` 必须为 0，无额外窗口/page target；`File.path` 不暴露。
- 记录 Blob 读取，不能对完整 zip 做一次 `arrayBuffer()`；记录代表性大包的 renderer 内存和实际上传进度。

### 5.3 合集与选包

- 上传后清单、条目预览、素材和批次计数正确；分页不会整包进入上下文。
- 同 moduleId v1→v2 替换：无重复包，旧包 purge 正确，复用素材保留，世界快照不变。
- 勾选/取消后，未涉及 refs、missing refs、ownerPid 和其他 enabledSources 字段不变；packsRev 恰好 bump 一次，play 重拉生效。
- stale `expectedRevision` 零写入拒绝；写后回读返回真实状态。
- 删除的影响预览、审批、meta/entries/batch/素材结果正确；未 detach 的引用按现有 missing 语义呈现。

### 5.4 双档位动态能力

至少覆盖：

1. 新会话未知目标时不声明 9 个 lobby 工具。
2. 同一会话首次 `foundry_open(mtcompat)` 后，下一次模型请求已激活准确 9 个工具，无需额外用户轮次。
3. 首次打开普通 FVTT 不激活；mtcompat→FVTT 后旧调用被移除且执行层仍 fail-closed。
4. lobby→play→lobby 不改变 active set，不反复重载或清空 job。
5. 恢复带历史工具声明的会话时按当前真实档位对账。
6. 一个 resident session 运行导入时，另一会话请求切换页面受租约/epoch 约束，不静默改目标。
7. tool schema/描述变化只发生在档位切换，记录 token/cache 指标作对照，不设“动态必然更省”的假断言。

### 5.5 失败与安全

- 审批拒绝、路径越界、非普通文件、source 变更均在写前失败。
- 未登录、错误 profile、非受信 origin、runtime 版本不符均 fail-closed。
- 取消必须等实际停止和清理；导航/崩溃标 indeterminate，绝不自动重放。
- 分别验证“零文档写入可清本批资源/空战役”和“已有文档写入保留现场”。
- journal、tool 输出和模型上下文不含 token、zip 字节或完整本地路径。
- 默认打本地栈与专用测试账号；唯一战役/包前缀，teardown 软删战役并 purge 测试包。线上仅用户明确要求时另跑。

### 5.6 play → lobby → play 往返（方案 B）

- prep play → `foundry_lobby_return({})`，回执 `from`/`to`/`returnPlayUrl` 正确，campaign 来自 play URL 的 `?campaign=`。
- 返回大厅后第一次 `foundry_lobby_campaigns_list` 立即成功（auth/runtime/`__MT_LOBBY_SERVICE__` 就绪确认生效）。
- 用 `returnPlayUrl` 回到原战役，runtime 恢复，不串世界。
- `completed` 与预期 `NAVIGATED` 都经确认阶段才报成功；错误目的地、超时、runtime 缺席不报假成功。
- 已在大厅时 `alreadyInLobby:true` 幂等；重复调用不重复清理。
- combat 工具列表无 `foundry_lobby_return`；连续三次往返无重复 socket/监听，认证不丢，GM 重进无锁。

## 6. 发布与回滚

1. 本期交付范围是两个仓库的 `feat/mtcompat-lobby-actions` 分支；不自动创建 PR、合并、部署生产或发布 skills 到 OSS。
2. 后续生产发布仍需分别走 compat 与 ArcaneDesk 的评审/发布流程；安装包 smoke 是发布前检查，不能用源码 Electron 验收替代。
3. skills r46 起（当前 r49）的 `minAppVersion:"0.9.0"` 让旧 App fail-closed；只有包含本功能的 Desktop 发布后才推进 skill bundle。
4. 回滚可分别撤掉 lobby runtime 装配、Desktop 版本或 skills latest 指针；业务数据不做逆向迁移。

## 7. 残余风险

| 风险 | 处理 |
|---|---|
| 原生通道大包内存与进度 | 已由 367MB ZIP / 350 件素材真实上传解除；最大 Blob 分片 4MiB，无整包 arrayBuffer，资产配额已恢复 |
| job 依赖大厅文档存活 | 第一版明确不保证后台持续；导航后只读对账，不另起 Node 导入管线 |
| runtime 多版本同步漂移 | 页面真源优先、桌面 parity 门和 play 回归 |
| 动态工具切换造成缓存损失 | 只在 VTT 档位变化时切换；不在 lobby/play 路由间切换；懒工具主要依赖 description |
| 后端无条件写 CAS | revision 只作 stale 检测，回读真实结果；硬并发保证另立后端契约，不夸大 |
| 多会话共享一个页面 | 目标租约 + epoch；工具激活不能代替资源互斥 |

## 8. 官方依据

- [Electron debugger](https://www.electronjs.org/docs/latest/api/debugger) 与 [Chromium `DOM.setFileInputFiles`](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles)：原生文件通道。
- [Pi Dynamic Tool Loading](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#dynamic-tool-loading)：loader 执行期间改变 active tools，下一次模型请求前生效；纯新增可保留原生 deferred/cache 形态，移除/替换走普通完整工具表。
- [Pi Code Mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md)：脚本并行/组合工具、过滤中间结果，输出限额与真实副作用说明。
- [OpenAI Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search)：小集合 eager、大目录 deferred、namespace 与缓存取舍。
- [OpenAI Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)：并行/聚合适用；写操作和审批敏感动作默认直接调用。
- [Codex 配置中的 direct/deferred/code_mode](https://developers.openai.com/codex/config-file/config-reference)：三种模型接触面的明确分工。
- [Codex WebMCP site tools](https://developers.openai.com/codex/webmcp)：访问页面时发现、页面生命周期、来源绑定和逐次安全审查。
