---
name: arcane-world-import
description: 把本地 Foundry VTT（FVTT）世界包（zip）导入 ArcaneDesk 的 mt compat 云端战役（奥法地图大厅）。当用户说“把这个世界传到云端/导入云端/上传到奥法地图/在云端开这个世界/帮我在大厅里导入世界”，或给出当前备团目录里的世界 zip 要求导入时使用。世界包必须位于当前备团工作目录（Desktop 镜像缓存由工具内部处理）；导入走大厅 typed 工具，不收账号密码；旧版 dnd5e（<5.3.0）按大厅规则拒绝并指引升级；本地 FVTT 安装与运维归 arcane-fvtt-setup/ops。
---

# FVTT 世界 → mt compat 云端战役

把当前备团目录里的 FVTT 世界 zip 交给 ArcaneDesk 的 mt compat 大厅（奥法地图）：大厅负责解析、素材上传、创建或复用战役、文档写入、导入批次与失败清理。你和用户只面对 `foundry_open` 与 `foundry_lobby_*` 这几个 typed 工具；不要手写 HTTP、在页面里跑脚本或用 shell 调云端接口。

## 用户交互预算

恒定 2 点：

1. **登录**（A 类账户边界，仅未登录时）：用户在右侧面板的 Keycloak 登录页自己登录。你不收账号密码、不代填、不猜测，也不把登录成功当成计划授权。
2. **导入计划确认**：`foundry_lobby_import_start` 生成计划后走 App 现有审批（是否弹审批卡、缺省放行完全由 App 决定）。用户拒绝即零写入。

除这两点外不再提问：世界包发现、战役命名、规则版本、失败处理都有默认值，用报告交代。登录后的“继续”和审批的“可以”都不是新交互点。

## 文件边界（硬规则）

- 只处理**当前备团工作目录（agent cwd）内**的 zip，以及 Desktop 已下载并管理的镜像缓存；后者由工具内部识别，你只传工具展示/返回的路径。
- 用户给出 cwd 之外的路径时，明确拒绝：“工具只能读取当前备团目录和 ArcaneDesk 自己缓存的世界包，目录外的文件读不了。”不要读取它，不要申请目录外授权，也不要让用户把包复制到任意临时目录。用户可以把世界包放进当前备团目录，或使用 Desktop 已缓存的世界包。
- 只接受普通 `.zip` 文件；目录形态的世界不走这条通道。路径不存在、不是普通文件、读取中被改动都由工具在写前拒绝，照实报告，零重试。

## 工具面

- `foundry_open`：打开/复用右侧大厅页。默认 `https://arcanemap.ssskill.cn/user-files/compat/lobby.html`；用户已用 `.com`/`.cn` 或其它受信地址时沿用，不臆造 IP、端口或分支域名。
- `foundry_lobby_import_start`：唯一的世界导入写入口，入参 `{sourcePath, expectedKind?, campaignName?, ruleset?, failurePolicy?}`。
- `foundry_lobby_import_job`：`{jobId, action:"status", waitMs?}` 或 `{jobId, action:"cancel"}`。
- `foundry_lobby_campaigns_list`：只读；核对导入后的战役与 `playUrl`。

`foundry_open` 返回 `profile` 与 `activatedTools`。`profile` 必须是 `mtcompat`；大厅工具还没出现在 `activatedTools` 里时，说明页面档位不对或 App 版本不足——停下来让用户更新/重开 App，不要改用页面脚本、裸 HTTP 或旧脚本。工具激活会在下一次模型请求生效，不需要让用户再发一轮“继续”。

## 主流程

1. **定位世界包**：在当前备团目录用只读的 `ls`/`find` 找 `.zip`，优先用户点名的文件；多个候选时取用户点名的，没点名就取最近修改的。不要递归扫描整块磁盘。不确定是不是世界包时不要猜，交给 `import_start` 嗅探，计划里的世界标题会让用户发现选错。
2. **打开大厅**：`foundry_open` 传入大厅地址。若右侧出现 Keycloak 登录屏，结束本轮，请用户直接在右侧面板登录/注册；用户说登录好了再继续。**绝不索取密码、验证码或 token**。
3. **启动导入**：调用 `foundry_lobby_import_start`：
   - `sourcePath` 用 cwd 内路径（相对或绝对均可，但必须在 cwd 内）；
   - `expectedKind: "world"`（用户已明确是世界包时）；不确定就不传，让工具嗅探并在计划里给出结论；
   - `campaignName` 用用户起的名字；没起名就不传，沿用世界标题，不追问。这个名字决定计划是新建还是复用同名战役；
   - `ruleset` 只在用户明确要求 2014/2024 时传；dnd5e 默认按大厅预选（2024），规则创建后不可变；
   - `failurePolicy` 默认 `"abort"`。只有用户明确说“能导多少导多少”时才用 `"continue"`，并且它必须出现在批准的计划里。
   工具会先解析、生成真实计划并走 App 现有审批；返回 `{jobId, plan}` 才表示已启动。
4. **讲清计划**：把 `plan` 翻成一句话——世界名/系统版本、战役名与计划给出的 `new`/`existing` 结论（`new` 新建 / `existing` 复用同名战役）、规则、文档与素材数量、缺失素材、失败策略。审批计划必须明确 new/existing：不存在才新建；同名且 ruleset 一致时复用并追加，ruleset 不一致会被拒绝。不要在审批之外再要一次“开始吗”。
5. **跟进任务**：用 `foundry_lobby_import_job` 的 `status` 配 `waitMs` 等待。轮询期间只说 `phase`/`progress`/`currentItem`/`failureCount`，不要每轮复述整份报告；完整 failures/report 只在终态或显式错误时读。
6. **收尾报告**：给出战役名、各集合写入数、素材上传数与缺失清单、失败项、跳过项（聊天记录/世界设置/世界自有 compendium 不导入），以及 `playUrl` 可点击链接。`playUrl` 以工具返回为准，不要自己拼。
7. **需要取消**：`action:"cancel"`。被接受不等于已停止和清理，继续 `status` 到终态，照实报告残留的战役/批次；不要立刻重导。

## 失败处置

| 工具结果 | 含义与下一步 |
|---|---|
| `LOGIN_REQUIRED` | 大厅未登录：结束本轮，请用户在右侧面板自己登录；确认后重试 `import_start`，不要用 `foundry_open` 轮询。 |
| `PROFILE_MISMATCH` / `CAPABILITY_UNAVAILABLE` | 页面不是受信 mt compat 大厅，或 App/页面 runtime 版本不足：重开大厅；仍不行就让用户更新 ArcaneDesk，不要降级到页面脚本或裸 HTTP。 |
| `FILE_OUTSIDE_FENCE` / `FILE_NOT_FOUND` / `FILE_NOT_REGULAR` / `FILE_EMPTY` / `FILE_CHANGED` / `FILE_NOT_READABLE` | 源文件不在 cwd/镜像缓存、不存在、不是普通文件、为空、读取中被改动或不可读：按“文件边界”解释，零写入；修正后重新调用，不沿用旧路径。 |
| `TARGET_UNAVAILABLE` / `TARGET_CHANGED` / `TARGET_TIMEOUT` | 大厅页被关闭、切走或导航打断：结果未知时不重放；重开大厅后查状态对账。 |
| `JOB_NOT_FOUND` | 这个 job 不在当前 App 会话里（App 重启或页面已换）：不要重放；回大厅查战役与批次状态。 |
| `INPUT_INVALID` / `ABORTED` | 参数不合法或调用被取消：修正参数/报告取消；不要原样重试。 |
| `JOB_INDETERMINATE` | 页面导航、刷新或崩溃打断：任务结果未知。重开大厅后先用 `campaigns_list` 查战役状态，批次/库状态以大厅界面和已有结果为准，**不要自动重放**；已生成或半写入的战役请用户在右侧大厅里处理后再决定是否重导。 |
| 旧版 dnd5e（< 5.3.0）被拒 | 与大厅面板同一门：请用户在 FVTT 里把 dnd5e 系统升级到 5.3.x，打开该世界完成一次系统迁移，再重新导出 zip 后重试。没有旧 CLI/ROPC 降级通道，不要尝试本地脚本。 |
| 纯素材 zip / 非世界包被拒 | 大厅只把带 `world.json` 的世界包交给世界导入；素材包不是世界，按大厅提示处理，不硬塞。 |
| `DECLINED`（审批被拒） | 零写入。不要绕过审批重新调用，也不要把拒绝解释成技术失败。 |
| 终态 `failures` / 部分写入 | 报告失败项；不要盲目重试（会叠数据）。若这次是 `campaign.mode:"new"` 且半写入，可让用户在大厅删除这个半成品战役后重导；若是 `campaign.mode:"existing"`，不要删既有战役，报告已追加的文档与批次，让用户决定是否清理后再重导。 |

## 边界

- 没有单独的 `campaignId`/合并参数，不等于永远新建：工具按 `campaignName`（默认世界标题）查同名战役；不存在才新建，同名且 ruleset 一致时复用并追加，ruleset 不一致直接拒绝。不要盲目重复导入同一战役，追加会叠文档。
- 不导入聊天记录、世界设置、世界自有 compendium packs；这些在报告中说明即可。
- 缺失素材（`icons/`、`modules/`、未随包携带）只报告，不阻断导入；超限文件按工具/服务端政策报错，不另造大小门槛。
- 非 dnd5e 世界按大厅现有映射导入，不做系统迁移；旧版 dnd5e 不迁移、直接拒绝并指引升级。
- 客户端只做读取、校验与报告；所有云端写入、替换、清理都在大厅服务里完成，你只按工具返回值汇报。
