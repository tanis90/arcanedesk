---
name: arcane-world-import
description: 把用户本地的 Foundry VTT（FVTT）dnd5e 世界一键导入自托管 MythicTable 云端（默认 https://vtt.arcanedesk.bitterbebop.cn:30002）。当用户说"把这个世界传到云端/导入云端/上传到 MythicTable/在云端开这个世界"，或给出 FVTT 世界目录、世界 zip 要求导入云端战役时使用。旧版本 dnd5e 世界（< 5.3.0）自动离线迁移；本地 FVTT 安装运维归 arcane-fvtt-setup/ops，云端 FVTT 服务器部署归 arcane-fvtt-server；本 skill 只管"本地世界 → 云端战役"的搬运。
---

# FVTT 世界 → MythicTable 云端导入

一条命令完成：读取本地世界（目录或 zip）→ 版本探测 → 旧版 dnd5e 自动迁移 → 资产上传 + 图片 URL
重写 → 文档批量写入云端战役 → 输出结构化 JSON（各集合计数/跳过项/缺失资产/战役链接）。
工具是 `scripts/import-world.mjs`（同目录 vendored import-core/import-migrate/import-assets，零外部依赖），
**不要手写 curl 或裸 fetch 去调 MythicTable REST**——鉴权、并发、重试、URL 重写都在脚本里。

## 用户交互预算

**恒定 2 次**：①导入计划确认（dry-run 报告 + 目标战役，一句话放行）；②MythicTable 账号密码
（A 类账户边界，request_user_input 收集）。同一世界的相同计划第二次导入不重复问（授权沿用）；
账号密码每次现收、绝不落盘。

## 运行时契约

- Node 用 `ARCANE_FVTT_NODE`（Arcane 随包 Node，缺失时停止并建议重启 App，不得改用系统 Node）。
- 在本 skill 目录下执行；stdout 只有最终结果 JSON，进度日志走 stderr。

```bash
"$ARCANE_FVTT_NODE" scripts/import-world.mjs <世界目录|世界包.zip> --create "<新战役名>" [选项]
```

选项：`--campaign <既有战役id>`（并入既有战役）、`--base <url>`（默认
https://vtt.arcanedesk.bitterbebop.cn:30002）、`--user <账号>`、`--dnd5e <本机 dnd5e 系统目录>`、
`--data-dir <FVTT 数据目录>`（自动找 `<目录>/systems/dnd5e` 或 `<目录>/Data/systems/dnd5e`）、
`--dry-run`、`--report <路径>`（结果 JSON 落盘）。

## 流程

1. **收两个事实**：世界路径（目录或 zip，FVTT 里 Setup 界面的 Edit Folder 可看到位置）；
   目标战役（默认建议**新建**，让用户起个名；点名既有战役才用 `--campaign <id>`）。
2. **定位数据目录**（C 类，不问）：从上下文、用户给的路径或 arcane-fvtt-ops 已知信息推断
   `<数据目录>/Data/systems/dnd5e`。旧版迁移与 dnd5e 内建图标核对都依赖它；找不到且世界
   < 5.3.0 时脚本会明确报缺，此时再向用户要一次数据目录位置（算入计划确认那次交互）。
3. **dry-run**（不需要账号）：把计划讲给用户——世界名/版本/是否迁移及统计、各集合文档数、
   资产上传条数与体积、缺失资产数、目标战役名（既有战役要点名"将并入既有战役，纯追加不去重"）。
   用户一句"可以/继续"放行。
4. **收账号密码**：request_user_input 一次收 MythicTable 账号与密码，随后以
   `MT_PASS='<密码>' "$ARCANE_FVTT_NODE" scripts/import-world.mjs … --user <账号>` 单条命令执行。
5. **解析结果 JSON 并汇报**：各集合写入数、T3 跳过（聊天记录/世界设置不导入）、迁移统计
   （applied/unchanged/failed，failed 文档不落库要点名）、missing 资产（icons//modules/未随包
   携带，仅报告不阻断）、战役 playUrl（`<base>/user-files/compat/play.html?campaign=<id>`）。
6. 失败按下面的文案表向用户解释并给下一步；**不盲目重试写了一半的战役**（重跑会叠重复文档，
   先软删该战役再完整重导）。

## 凭据纪律

- 账号密码只经 request_user_input 进对话、经 `MT_PASS` 环境变量进脚本；**不写任何文件、
  不进日志、回复与报告里不复述密码**。脚本输出里也不会带凭据或 token。
- 登录失败文案由脚本给出（401=账号密码错；"Account is not fully set up"=服务器端账号资料不全，
  需管理员补 firstName/lastName；网络错=连通性问题）；照读脚本消息，不要自行猜测。

## 失败处置表

| 脚本 error.code | 含义与下一步 |
|---|---|
| WORLD_REJECTED | NeDB 旧格式（core ≤ 10）：让用户先在 FVTT 里把世界开一次升级到 v11+ 再导出重来 |
| MIGRATE_ENV_MISSING / MIGRATE_ENV_OLDER | 找不到本机 dnd5e 或本机 dnd5e 比世界还旧：先按 arcane-fvtt-mods 装/升级 systems/dnd5e 再导入 |
| MIGRATE_BOOT_FAILED / MIGRATE_FAILED | 本机 dnd5e 文件与迁移层不兼容：报告原文，建议重装 dnd5e 5.3.x |
| UNREACHABLE | 网络不通：检查网络与服务器地址后重试（此时云端零写入） |
| AUTH_BAD_CREDENTIALS | 账号密码错：向用户重新收集一次（只重收凭据，计划不重问） |
| AUTH_PROFILE_INCOMPLETE | 服务器端账号资料不全：需要云端管理员补全，不是用户密码问题 |
| AUTH_EXPIRED | 会话中途过期：战役已部分写入，先软删该战役再带新凭据完整重导 |
| CAMPAIGN_NOT_FOUND | 既有战役 id 不对或不属于该账号：核对 id 或改 --create |
| UPLOAD_FAILED / write.failed>0 | 部分失败：报告失败清单；战役不完整，建议软删重导 |

## 边界

- 只有 dnd5e 世界做版本迁移（< 5.3.0 自动走，报告迁移统计）；其它系统世界按 T1 文档照收不迁移，
  云端兼容层只运行 dnd5e（结果 JSON 会注明）。
- 不导入：聊天记录（chatmessages）、世界设置（settings）、世界自有 compendium packs（二期）。
  users 落库时剥离密码字段，只作追溯面。
- 资产单文件超 30 MiB 跳过并列报告；缺失资产（icons/、modules/、未随包携带）保留原值仅报告。
- 导入到既有战役是**纯追加**，云端不去重：重复导入同一战役会产生重复文档，默认总是新建战役。
- 迁移引擎 = 本机 dnd5e 5.3.x 的官方迁移代码（离线直载）；本机 dnd5e 版本与云端基线不一致时
  脚本会警告，建议先升级本机 dnd5e 再导入。
