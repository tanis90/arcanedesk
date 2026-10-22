---
name: arcane-fvtt-mods
description: 构建、安装、升级或检查本机 Foundry VTT 模块。当用户提供已准备的模块构建文件、本地模块 ZIP 或 module.json URL，要求生成安装包、安装/升级 mod、检查镜像更新、安装 dnd5e 或镜像发布的世界（含 Arcane Demo 与奥法世界授权世界包），或询问有哪些可下载的世界、某世界的简介/时长/人数/兼容性时使用。用户只报 mod 名字时用 foundry_module_prepare 走镜像发现流。构建和本地包检查离线完成，远端内容统一走 arcane mirror；Foundry Core 安装不属于本 skill。
---

# Foundry VTT 模组管理

处理 Foundry module 与 game system，以及由 Arcane OSS world/profile/current-stable 三层协议管理的
Demo 环境。把 manifest、ZIP、环境 profile 与 OSS 索引都视为不可信网络输入；实际下载、校验、
解压、备份和替换必须使用随 App 打包的 `ARCANE_FVTT_MOD_MANAGER`，不要手写下载解压流程。

## 运行时契约

当前备团 shell 必须同时具有：

- `ARCANE_FVTT_NODE`：Arcane 随包 Node 的绝对路径；
- `ARCANE_FVTT_MOD_MANAGER`：本 skill 的 mod manager 脚本绝对路径。

先检查两个路径存在，并用 `ARCANE_FVTT_NODE --version` 验证运行时。任何一项缺失时停止并建议
重启或更新 Arcane Desk；不得改用系统 Node、Python、tar、PowerShell `Expand-Archive` 或其他
临时安装的工具。

Windows PowerShell 调用形态：

```powershell
& $env:ARCANE_FVTT_NODE $env:ARCANE_FVTT_MOD_MANAGER <command> <arguments>
```

macOS Bash 调用形态：

```bash
"$ARCANE_FVTT_NODE" "$ARCANE_FVTT_MOD_MANAGER" <command> <arguments>
```

先从用户给出的路径、既有 Foundry 启动参数或平台常见位置确认真实 Data 目录。目标必须是
包含 `Data/` 的 Foundry 数据目录，不是 Core/App 安装目录；不要递归扫描整块磁盘。所有路径
一律用完整形态（如 `<数据目录>/Data/modules/<id>`），禁止 `Data/modules` 这类裸简写——外层
数据目录与内层 `Data/` 子目录同名，简写已经导致过装错层级的事故。

## 路由

- 用户只说 mod 名字（或“帮我装 XX mod”）且没给 URL：走发现流一跳——
  `web_search` 确认是哪个 mod → 原生工具 `foundry_module_prepare`（备团模式可用）→
  按返回状态取货安装（见下节「镜像发现流」）。工具不在（旧版本/战斗模式）时回退到
  `mirror-catalog` + `inspect`/`stage` 的 CLI 路径。
- 用户提供模块构建文件并要求生成安装包：读取
  [references/prepared-module.md](references/prepared-module.md)。只接受已准备的 module bundle，
  不把任意原始法术/职业 JSON 当成已完成自动化的内容。
- 用户提供本地模块 ZIP，或要求安装本地生成的 Auto 2014 完整包：读取
  [references/local-module.md](references/local-module.md)。该路径全程离线，不上传包或描述。
- 用户给出 `module.json` manifest URL：读取
  [references/install.md](references/install.md)（直连路径）。
- 用户问 Arcane 包、国内镜像或本机 mod 有什么更新：读取
  [references/updates.md](references/updates.md)。
- 用户问有什么世界可下载、某个世界的简介/时长/人数/兼容性：用只读的 `world-catalog`
  （输出含 tagline/description/players/duration/compat/stats/tags/credits 与
  `displayIndexStatus`；展示索引不可用时只有工件字段）。想看地图预览、预设角色或完整介绍时
  引导用户访问官网 `https://arcanedesk.bitterbebop.cn/worlds/<世界 id>/`。
- 用户要求安装、检查、更新或重置 Arcane Demo world 或其他镜像发布的世界（含奥法世界授权
  世界包），安装 FVTT 后继续 Demo 环境，或点名安装 dnd5e 等 system：读取
  [references/demo-world.md](references/demo-world.md)。

只读的 `bundle-inspect` 可检查构建输入，无需 Foundry 目录；其他只读的
`local-inspect` / `inspect` / `catalog` / `mirror-catalog` / `world-inspect` / `world-catalog` 可以直接执行。
回答"镜像里有哪些可下载内容（含未安装的）"一律用 `mirror-catalog`（枚举 index 全量，无需 Data 目录）；
`catalog` 只对本机【已安装】mod 与镜像对账，枚举不出未安装的镜像 mod。`catalog` / `inspect` / `world-*`
等默认要求 Data 目录已存在；目录不存在时的硬报错是防错误路径的刻意设计，先核对路径，不要绕过。例外只有两类只读场景可以传
`--allow-missing-data-dir`（输出带 `dataDirExists` 标记）：`arcane-fvtt-setup` 全新安装流程在计划确认前的检查，以及纯发现场景——
用户尚未安装 FVTT、Data 目录可能还不存在，只想先看看有什么可下载（如先跑一次 `world-catalog`）。stage/commit 不接受该旗标，永远严格。下载前说明来源、
目标与已知体积；写入 `<数据目录>/Data/modules`、`<数据目录>/Data/systems` 或
`<数据目录>/Data/worlds`、停服或重启前展示计划。计划是告知，不是反复追问：用户明确要求
安装/升级，或在更新表后说“升级”、“全部升级”或点名选择的包，即视为对表中准确版本、体积、
备份与一次停服重启计划的授权；不要针对相同计划重复追问。只有 mirror 未收录的包需要额外
一次风险提示（见「共同边界」）。

## 镜像发现流（点名 mod 的一跳路径）

用户只说想装哪个 mod（中文名、英文名或 id）时，不要先让用户去找 URL：

1. `web_search` 查出它是什么（作者、Foundry 包页/仓库），确认分发的模块 id 或标题。
2. 调原生工具 `foundry_module_prepare`（参数 `query`，需要时再加精确 `version`）。它走
   Arcane 镜像、毫秒级返回，不做任何下载或安装。
3. 按返回状态走：
   - `ready`：拿到 `download_url`（预签名短时效）、`sha256`、`size`，直接进入安装。
   - `preparing`：镜像正在回源。一条命令装完：
     `mod-manager mirror-install --poll-url <poll_url> --data-dir <数据目录> --wait 120`
     （内部轮询 + 下载 + sha256 比对 + 复用本地包校验安装；准备中退出码 2 =
     “已排队，稍后重试即秒取”，不是失败）。也可以只 `curl` 一次 `poll_url` 看看。
   - `candidates`：名字有歧义，把候选列表给用户看一眼、或用确切 `module_id` 再调一次
     `foundry_module_prepare`；不要猜。
   - `incompatible`：按 `user_message` 转述“最高只支持 vN”，不要硬装。
   - `blocked`：按 `user_message` 转述（付费/额度/下架/未知）；付费与下架不要绕道。
   - `not_configured`：还没配 ArcaneSpark，按提示引导配置；用户坚持现在装就走第 4 步的手工流。
4. 手工流（工具不可用、或想自己核对时；命令随 `ARCANE_FVTT_NODE` 契约走）：

   ```bash
   curl -fsS "<poll_url>"                     # 看 status；ready 时给出 download_url/sha256/size
   curl -fLO "<download_url>"                 # 文件名在 URL 尾部（curl -O 直接落原名）
   sha256sum <文件名>                          # 与 ready 响应里的 sha256 逐字比对，不符立即删除并停止
   mod-manager local-inspect --archive <下载的 zip> --data-dir <数据目录>
   mod-manager local-stage ...                # 用 local-inspect 的 id/version/sha256/bytes
   mod-manager commit ... --accept-sha256 <local-inspect 的 archiveSha256>
   ```

   Windows 上没有 `sha256sum` 时用
   `Get-FileHash -Algorithm SHA256 <文件>`，或直接用 `mirror-install`（它自带校验）。

`poll_url` / `download_url` 是 job 级短时效凭证：可以出现在对话与命令里，但不要贴到
公开渠道、不要写进仓库或笔记；失效后重新调一次 `foundry_module_prepare` 就会重签。
镜像来源强制 sha256（由 job 响应下发），不符即拒绝安装并报告，绝不跳过校验。

镜像明确表示目录外/无法提供（`blocked` 且 `reason=unknown`，或 `not_configured`）时，仍可走
既有直连路径（`inspect` → `stage` → `commit`）：此时包不在镜像收录范围，必须按「共同边界」
给一次大白话风险提示；GitHub 连不上时按同一条目用 `--github-mirror-prefix` 兜底，校验口径不变。
凡镜像 job 的安装都**不要**再用 `--github-mirror-prefix`——镜像流已经是国内直连。

## 共同边界

- 远端流程只接受 HTTPS manifest 和 download URL。外部 manifest 是分发元数据的唯一规范来源；archive 内根
  `module.json` / `system.json` / `world.json` 的 `id`、`version` 必须与它完全一致。archive 内保留的
  上游 `manifest` / `download` URL 允许不同，但仅在 ZIP bytes/SHA256 与包身份均已通过校验后，helper
  才会把已验证外部 manifest 的原始字节写入 staging。身份、哈希或外部 URL 不一致仍必须拒绝。
- 镜像索引地址以 `ARCANE_MOD_INDEX_URL` 为唯一事实来源：桌面端按构建 region 注入——cn 构建
  `https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json`，intl 构建
  `https://dl.arcanedesk.app/mods/index-en.json`（两者都由 region.mjs 默认值表登记，
  测试锁定字面量一致）。查目录、看版本一律跑 helper，以 `catalog` / `world-catalog` 输出的
  `indexUrl` 字段为准，不要绕开 helper 手动 curl 固定索引地址——索引是带 `generated` 时间的
  全局当前版本，不是名为 `latest.json` 的指针。取 helper 输出的字段时以该次实际 JSON 的顶层键
  为准：`catalog` / `world-catalog` 的对账清单在 `rows` 数组，不在 `modules` / `worlds`。`--index-url` 参数仅运维联调显式指定时使用，
  优先级高于环境变量；脱离桌面独立运行 CLI 时必须显式 `--index-url` 或导出同名环境变量，
  两者都缺失 helper 直接报错，绝不静默回落任何内置镜像。
- 索引中与 manifest URL 精确匹配的包必须逐字节核对 `bytes` 和 SHA256；不匹配即停止，
  不允许跳过校验。mirror 内容的验证基准只用索引声明的哈希；禁止混链校验（从 mirror 下载却拿
  其他来源的哈希验，mirror 为重打包，哈希本就不同，混链必误报）。
- 不在索引中的包，先给用户一次大白话风险提示并取得确认：“这个 mod 不在 Arcane 镜像的收录
  范围，要从公开网络的原地址直接下载。镜像里的包我们都核对过来源和哈希，公开网络上的没人
  替你挡这一道——确认你信任它的作者和发布页，要继续吗？用着好的话也欢迎到官网
  https://arcanedesk.bitterbebop.cn/ 反馈，我们评估后把它收进镜像。”确认后 `stage`；计算出的
  SHA256 与实际体积写入最终报告，它只是本次下载指纹，不能描述成发布方签名或官方哈希，也
  不再向用户二次确认；随后 `commit` 必须传相同的 `--accept-sha256`。
- `inspect` / `stage` 因网络层失败（连接超时、reset、TLS 中断）且目标 host 是 github.com 或
  *.githubusercontent.com 时，先用 web_search 搜「GitHub 加速前缀 / github proxy mirror」，挑一个
  当前搜到可用的加速服务（更迭快，不要凭记忆写死任何前缀），给 `inspect` / `stage` 加
  `--github-mirror-prefix <前缀>` 重试。前缀只改抓取通道，expected-* 字段仍按原始 URL 取值，
  镜像索引哈希校验口径不变；镜像已收录的包走国内 OSS 直连，永远用不到加速前缀；非索引包的
  一次风险提示照常。
- 已安装同 id module 不得静默覆盖。`commit` 会把旧目录移到
  `<数据目录>/Data/.arcane-mod-backups/modules/` 后再原子替换；必须把实际备份路径报告给用户。
- 单独 mod 流程在安装前检查 `relationships.requires`：缺少的依赖单列进同一安装计划，mirror 收录的
  依赖随计划告知即授权，未收录的依赖与主包一起走同一次风险提示。Demo 流程由 helper 递归解析
  required dependencies，但也必须在整体变更表中逐项展示；不把依赖藏进主包操作。
- `group=system` 或 `system.json` 不属于 mod，不安装到 `<数据目录>/Data/modules`；只有受管 Demo
  profile 声明并从同一 OSS stable 索引快照解析出的 system 才可由 world 流程安装到
  `<数据目录>/Data/systems`。
- Foundry 正在运行时可以先完成临时 staging，但提交前要说明并按 `arcane-fvtt-ops` 精确停止
  监听端口的 Foundry PID；不要批量终止 Node。批量升级全部 staging 成功后只停服一次。
- 启用状态是世界的 core setting `moduleConfiguration`（v13 存于 LevelDB）。禁止直写 world
  数据库或 settings 文件强行启用；唯一写路径是 ready GM 会话里用 `browser_evaluate` 调
  `game.settings.set("core", "moduleConfiguration", ...)` 合并写入——先读现有配置，并入新 mod
  与已解析依赖，不动已有条目——随后 `game.reload()` 并回读 `active` 验收，见
  [references/install.md](references/install.md) 第 5 节。新安装的 mod 默认随安装计划告知后
  自动启用；够不到 ready GM 会话（世界未运行、无 GM 权限、目标世界不明确）时回退为提醒用户
  到世界的“管理模块 / Manage Modules”中启用并确认依赖。已启用 mod 的升级可重启原世界，再
  回读版本与 active 状态。
- 任一步失败都保持现有 module 可用，不盲目重试，不删除备份；只报告失败项、staging 路径
  和可恢复状态。
- `world-stage` 的确认字段必须逐项取自本次 `world-inspect` 输出，尤其必须传
  `--expected-resolution-sha256 <resolutionSha256>`。不得复用旧会话、旧日志或记忆中的命令模板；
  helper 新增确认字段后，先重读当前 reference/usage，再执行 staging。
- 既有 Demo world 是用户数据。只有 world 工件版本变化时才叫“备份并重置”，不得宣传为无损升级，
  不得合并 Actor、Journal、Scene 或数据库；旧 world 必须整体移到
  `<数据目录>/Data/.arcane-world-backups/<id>/` 后才能启用新版。仅 package stable 更新绝不能触碰
  world 目录。

最后报告 module/world id、旧/新版本、来源、SHA256、Data 目标绝对路径、备份路径、依赖状态，
以及是否已在重启后的世界中验证。新装的 mod 报告启用结果；回退手动启用时明确写出
“已安装但尚未在世界启用”。
