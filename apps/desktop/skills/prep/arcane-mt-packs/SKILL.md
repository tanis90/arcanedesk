---
name: arcane-mt-packs
description: 管理 ArcaneDesk mt compat 大厅（奥法地图）的个人内容包库与战役选包。当用户要“上传/替换合集包”“看看我的内容包”“预览包里有什么”“给战役勾选/取消内容包”“删掉某个内容包”，或给出当前备团目录里的 module zip 时使用。上传/替换走大厅导入工具，不收账号密码；世界包导入用 arcane-world-import。
---

# mt compat 内容包与战役选包

mt compat 大厅里有两层内容资源：**个人内容包库**（上传后归当前账号所有，物理存在大厅）和**战役选包**（战役引用库里的包，play 页据此聚合 compendium）。本 skill 只管这两层，以及删除包后的影响说明；世界包导入属于 `arcane-world-import`。

所有动作走 `foundry_open` 与 `foundry_lobby_*` typed 工具。不要手写 HTTP、在页面里跑脚本或用 shell 调云端接口。

## 用户交互预算

- **自有提问最多 1 次**：只在战役重名、工具无法唯一确定目标时问一句“是哪一个”。其它情况（找包、分页、目标战役、SRD 开关）都从工具读取或用默认值。
- **登录**：仅未登录时发生，用户在右侧面板自己登录。你不收账号密码、不代填、不猜测。
- **写操作审批**：上传/替换、战役选包、删除各自走 App 现有审批；拒绝即零写入。审批不是新交互点。

## 文件边界（硬规则）

- 只处理**当前备团工作目录（agent cwd）内**的 zip，以及 Desktop 已下载并管理的镜像缓存；后者由工具内部识别。
- 用户给出 cwd 之外的路径时，明确拒绝：“工具只能读取当前备团目录和 ArcaneDesk 自己缓存的内容包，目录外的文件读不了。”不要读取它，不要申请目录外授权，也不要让用户复制到任意临时目录。用户可以把包放进当前备团目录。
- 只接受普通 `.zip`；目录形态不走这条通道。

## 工具面

- `foundry_open`：打开/复用大厅。默认主入口 `https://arcanemap.com/`（工具归一到 compat 大厅）；用户已用其它受信地址时沿用。`profile` 必须是 `mtcompat`，`page.path` 必须命中受信 compat 目录的 `lobby.html`，大厅工具应出现在 `activatedTools` 里；这个名单只表示当前产品档位的工具面，不代表大厅已登录或游戏页已就绪。
- `foundry_lobby_return`：无参数，把当前游戏页送回大厅；回执给出真实 `returnPlayUrl`，大厅动作结束后用它回原战役（见下节）。
- `foundry_lobby_import_start`：上传/替换内容包的写入口，入参 `{sourcePath, expectedKind?, failurePolicy?}`。
- `foundry_lobby_import_job`：`{jobId, action:"status", waitMs?}` 或 `{jobId, action:"cancel"}`。
- `foundry_lobby_packs_read`：只读。`{}` 或 `{moduleId}` 读库清单；`{packId, query?, cursor?, limit?}` 分页预览条目。
- `foundry_lobby_campaigns_list`：只读，按名字找战役 `id`。
- `foundry_lobby_campaign_packs_get`：只读，读战役当前选包、missing、内建只读组、SRD 开关与 `revision`。
- `foundry_lobby_campaign_packs_update`：选包唯一写入口，`{campaignId, expectedRevision, add?, remove?, enabledSourcesPatch?}`。
- `foundry_lobby_packs_delete`：库删除唯一写入口，`{packIds, expectedRevision}`。

大厅工具不在 `activatedTools` 里、`profile` 不是 `mtcompat`，或 `page.path` 不是大厅时，停下来让用户更新/重开 ArcaneDesk；不要改用页面脚本、裸 HTTP 或旧脚本。登录完成后重试原来的大厅操作，不用 `foundry_open` 轮询，不用 `world_status` 检查大厅，也不在 `lobby.html` 或 `/auth/**` 调用 `foundry_page_eval`、`foundry_screenshot`。

## 当前在游戏页时（play → lobby → play）

用户可能正停在某个战役的游戏页（`play.html`）里，而内容包、选包或删除必须在大厅完成。这时：

1. 先一句话说明“要暂时离开当前游戏、回大厅处理，完成后再回到这个战役”，然后调用无参数 `foundry_lobby_return({})`。
2. 成功回执 `status:"completed"`，带 `from`、`to` 和真实 `returnPlayUrl`；`alreadyInLobby:true` 表示本来就在大厅，直接继续。把 `returnPlayUrl` 原样留住，不要自己拼。
3. 内部导航可能以 `NAVIGATED` 结束，这不是失败：Desktop 会接着确认大厅已就绪。不要重放，也不要在确认前再调一次或改走页面脚本。
4. 大厅动作结束（成功、失败或取消）后，用 `foundry_open({url:returnPlayUrl})` 回到原战役；回执显示 `mtcompat` 的 `play.html` 后再继续游戏内操作。

只有这个工具能把游戏页安全送回大厅：不要用 `foundry_page_eval` 执行 `location.assign`、`ui.nav` 或任何跳转，也不要指望 `foundry_open` 放宽幂等去帮你回大厅。它只在 mtcompat 备团模式提供，跑团/战斗模式没有大厅能力；用户在战斗里要改选包时，请他先切到备团模式。

## 先分清四个概念

- **`revision`**：读取时的状态指纹。删除和改选包都要把刚读到的 `revision` 原样作为 `expectedRevision` 传回；工具会重新读取并比较，不一致就零写入拒绝。它只在本客户端内发现“读完到写前状态变了”，不是服务端的硬并发锁。
- **世界快照**：已经导入某个战役世界的文档是导入时的副本。之后更新或删除内容包**不会改写**世界里已有的 Actor/Item/Scene 等数据；新包内容在后续从 compendium 取用时才生效。
- **missing refs**：战役仍引用某个包，但包已从库主那里删除。读选包时该引用标 `missing`；play 聚合视图跳过它，不报错、不留空壳。删除包不会级联删引用，也不会自动 detach。
- **`packsRev`**：战役档里的选包版本戳。`campaign_packs_update` 成功后恰好 bump 一次，play 端收到广播后重拉聚合内容；删除包没有主动推送，play 下次重拉时按 missing 呈现。

## 上传 / 替换内容包

1. 在大厅页用 `foundry_open` 打开；当前已经开着某个战役的游戏页时，先用上节的 `foundry_lobby_return({})` 回大厅，不要直接 `foundry_open` 大厅地址。未登录就请用户自己登录（见交互预算）。
2. 在 cwd 内找到用户点名的 module zip（含 `module.json` 与 `packs/`）。纯 `world.json` 世界包不是内容包，转 `arcane-world-import`。
3. 调用 `foundry_lobby_import_start({sourcePath, expectedKind:"collection"})`。不要传 `campaignName`/`ruleset`；内容包不创建战役。
4. 工具解析后会给出 module id、版本、包数量、条目数、素材体积与“同 moduleId 将替换旧包”的判断（以返回的 `plan` 为准）。走 App 现有审批；拒绝则零写入。
5. `import_start` 返回 `{jobId, plan}` 后，用 `foundry_lobby_import_job` 跟进。轮询只说 `phase`/`progress`/`currentItem`/`failureCount`，完整报告在终态读。
6. 替换语义：同 moduleId 的旧包会在本次素材上传/复用完成后、新包写库前 purge（只清旧包的 meta/条目/批次，保留本次要用的资源），随后写入新包；**其它 moduleId 的包不动**，世界快照不动，可复用的素材继续复用。不要为了“更新”先删旧包——替换会自动完成，先删只会白丢素材与批次。
7. 完成后用 `foundry_lobby_packs_read({})` 回读库清单与新的 `revision`，在报告里给出实际包名、条目数与替换结果。

## 清单与条目预览（只读）

- `foundry_lobby_packs_read({})`：库清单，含 `revision` 与按 moduleId 分组的包。报告总数、模块数、包名与条目数即可，不倾倒整份清单。
- `foundry_lobby_packs_read({moduleId})`：只看某个 module 的全部包；判断“是否已上传/是否需要替换/整组合集删除”时用。
- `foundry_lobby_packs_read({packId, query?, cursor?, limit?})`：条目预览，强制分页（`limit` 最大 50）。一次只取一页；用 `query` 缩小范围；需要继续时带上一页返回的 `nextCursor`。不要为了“看全”把几千条一次拉进上下文，也不要逐条复述——只说命中数、首页样例与分页状态。
- 读取失败不等于空库：保留上次已知信息，明确说“读取失败”，不要让用户以为包丢了而重复上传。

## 战役选包：勾选 / 取消

1. `foundry_lobby_campaigns_list({})` 按名字找战役；重名且无法唯一确定时只问这一句。不要按列表顺序猜。
2. `foundry_lobby_campaign_packs_get({campaignId})` 读当前状态：已选引用、`missing`、内建只读组（SRD/核心来源）、SRD 两旗与 `revision`。
3. 用大白话说明将发生的变化：新增哪些包、取消哪些包、哪些是 missing、哪些内建组只读不可动。新增前确认包在本人库里（`packs_read` 能读到）；不要引用别人的包。
4. 调用 `foundry_lobby_campaign_packs_update({campaignId, expectedRevision, add?, remove?, enabledSourcesPatch?})`：
   - `expectedRevision` 用第 2 步读到的值，原样传；
   - `add`/`remove` 是 `packId` 字符串数组；身份/归属由工具按当前会话合并，不要传对象或手填别人的 `ownerPid`；
   - 只改 SRD 2024/2014 开关时才传 `enabledSourcesPatch`，它是合并补丁，不覆盖其它字段；
   - 增量合并：未涉及的引用、missing 引用、`ownerPid`、其它 `enabledSources` 字段都保留。
5. 走 App 现有审批；成功后读回真实结果。`packsRev` 由服务在 PUT 后恰好 bump 一次，你不需要手动写；play 端收到广播后重拉聚合内容。世界里已导入的文档不变，新选包从后续取用开始生效。
6. `expectedRevision` 过期：零写入。重新 `campaign_packs_get`，把新状态重新讲给用户再走审批，不要用旧 revision 重试。

## 删除内容包

1. 先用 `foundry_lobby_packs_read({})` 拿最新的库 `revision`；要删整个 module 时用 `{moduleId}` 读出它的全部 `packId`，一次收集、一次提交，不要逐包循环。
2. 讲清影响后再走 App 审批：
   - 删除的是库里的包：meta、全部条目与关联导入批次一起清理；素材按大厅的引用保护规则处理，以工具返回的清理结果为准；
   - 引用它的战役会显示 `missing`，play 聚合跳过；**已导入世界的快照不变**；
   - 引用不会自动移除；用户想清掉引用，事后再用 `campaign_packs_update` 的 `remove`（另一次审批）；
   - 内建 SRD/未知来源不可删，工具会拒绝。
3. 调用 `foundry_lobby_packs_delete({packIds, expectedRevision})`，`expectedRevision` 必须是第 1 步刚读到的库 revision。
4. 成功后报告实际清理结果（包/条目/批次/素材）。`expectedRevision` 过期时零写入，重读后再来；不要盲目重试。
5. 删除不推送 play 端；用户下次重拉时看到 missing 属正常现象，不要把它当故障自动补包。

## 失败处置

| 结果 | 含义与下一步 |
|---|---|
| `LOGIN_REQUIRED` | 未登录：结束本轮，请用户在右侧面板自己登录；确认后重试原操作，不用 `foundry_open` 轮询。 |
| `PROFILE_MISMATCH` / `CAPABILITY_UNAVAILABLE` | 页面不是受信大厅或 App/runtime 版本不足：重开大厅；仍不行让用户更新 ArcaneDesk。 |
| `FILE_OUTSIDE_FENCE` / `FILE_NOT_FOUND` / `FILE_NOT_REGULAR` / `FILE_EMPTY` / `FILE_CHANGED` / `FILE_NOT_READABLE` | 源文件不在 cwd/镜像缓存、不存在、不是普通文件、为空、读取中被改动或不可读：按“文件边界”解释，零写入。 |
| `TARGET_UNAVAILABLE` / `TARGET_CHANGED` / `TARGET_TIMEOUT` | 大厅页被关闭、切走或导航打断：结果未知时不重放；重开大厅后对账。 |
| `foundry_lobby_return` 报错 | `CAPABILITY_UNAVAILABLE` = 页面/runtime 版本不足：重开大厅或让用户更新 App；`PROFILE_MISMATCH` = 当前不是 ready 的 mtcompat 游戏页（或 URL 缺 `?campaign=`），从大厅重新打开该战役；`TARGET_CHANGED` = 面板没有落到预期大厅：不重放，先 `foundry_open` 确认当前页面再按实际情况重来；`LOGIN_REQUIRED` = 结束本轮让用户登录；`JOB_INDETERMINATE` = 结果无法确认，不要自动重放。 |
| `JOB_NOT_FOUND` | 这个 job 不在当前 App 会话里（App 重启或页面已换）：不要重放；回大厅用库清单/战役状态对账。 |
| `INPUT_INVALID` / `ABORTED` | 参数不合法或调用被取消：修正参数/报告取消；不要原样重试。 |
| `REVISION_MISMATCH` | 读后状态已变（当前 revision 已变）：零写入，重新读取并把新状态重新展示、重新审批。 |
| 选包写入被拒 | 包不存在于本人库、引用了别人的包、或超过战役包数上限：照工具错误说明，不猜、不绕过。 |
| `JOB_INDETERMINATE` | 页面导航/刷新/崩溃打断：结果未知。重开大厅先用 `packs_read`/`campaigns_list` 对账，不自动重放导入。 |
| `DECLINED`（审批被拒） | 零写入。不要绕过审批重新调用。 |
| 终态 `failures` / 部分写入 | 报告失败项；不要盲目重试（替换/导入会叠数据或重复清理）。让用户在大厅里处理残留后再决定。 |

## 边界

- 内容包在库里是**不可编辑**的：改条目 = 用同 moduleId 重新上传替换，不提供单条编辑。
- 只引用本人库里的包；一期不支持引用别人的库。
- 删除不级联删战役引用，也不改写世界快照；需要清引用时单独走选包更新。
- 战役本身的创建/删除、世界包导入、规则版本变更不在本 skill：世界用 `arcane-world-import`，战役生命周期用右侧大厅界面。
- 所有云端写入、替换与清理都在大厅服务里完成；你只按工具返回值汇报，失败时不改用其它通道。
