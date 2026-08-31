---
name: arcane-fvtt-mods
description: 安装、升级或检查本机 Foundry VTT 模组、游戏 system 与 Arcane Demo world。当用户提供 module.json manifest URL、说“安装/升级这个 mod”或“安装 dnd5e 等 system”，要求检查“Arcane 包/国内镜像有什么更新”，要求安装、更新、重置 arcane-demo，或 Foundry Core 装完后继续 Demo 环境时使用。所有内容统一从 arcane mirror 的 OSS 索引安装；Foundry Core 本身的安装不属于本 skill。
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

- 用户给出 `module.json` manifest URL，或点名安装/升级一个 mod：读取
  [references/install.md](references/install.md)。
- 用户问 Arcane 包、国内镜像或本机 mod 有什么更新：读取
  [references/updates.md](references/updates.md)。
- 用户要求安装、检查、更新或重置 Arcane Demo world，安装 FVTT 后继续 Demo 环境，或点名
  安装 dnd5e 等 system：读取 [references/demo-world.md](references/demo-world.md)。

只读的 `inspect` / `catalog` / `world-inspect` / `world-catalog` 可以直接执行。下载前说明来源、
目标与已知体积；写入 `<数据目录>/Data/modules`、`<数据目录>/Data/systems` 或
`<数据目录>/Data/worlds`、停服或重启前展示计划。计划是告知，不是反复追问：用户明确要求
安装/升级，或在更新表后说“升级”、“全部升级”或点名选择的包，即视为对表中准确版本、体积、
备份与一次停服重启计划的授权；不要针对相同计划重复追问。只有 mirror 未收录的包需要额外
一次风险提示（见「共同边界」）。

## 共同边界

- 只接受 HTTPS manifest 和 download URL。外部 manifest 是分发元数据的唯一规范来源；archive 内根
  `module.json` / `system.json` / `world.json` 的 `id`、`version` 必须与它完全一致。archive 内保留的
  上游 `manifest` / `download` URL 允许不同，但仅在 ZIP bytes/SHA256 与包身份均已通过校验后，helper
  才会把已验证外部 manifest 的原始字节写入 staging。身份、哈希或外部 URL 不一致仍必须拒绝。
- 默认镜像目录是 `https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json`。这是带
  `generated` 时间的全局当前版本索引，不是名为 `latest.json` 的指针。
- 索引中与 manifest URL 精确匹配的包必须逐字节核对 `bytes` 和 SHA256；不匹配即停止，
  不允许跳过校验。mirror 内容的验证基准只用索引声明的哈希；禁止混链校验（从 mirror 下载却拿
  其他来源的哈希验，mirror 为重打包，哈希本就不同，混链必误报）。
- 不在索引中的包，先给用户一次大白话风险提示并取得确认：“这个不在 arcane mirror 选过的 mod
  之内，安装可能产生不可知后果，确认要安装吗？如果你希望 arcane mirror 收录这个 mod，可以去
  官网 https://arcanedesk.bitterbebop.cn/ 反馈我们。”确认后 `stage`；计算出的 SHA256 与实际体积
  写入最终报告，它只是本次下载指纹，不能描述成发布方签名或官方哈希，也不再向用户二次确认；
  随后 `commit` 必须传相同的 `--accept-sha256`。
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
- 不直接编辑 world 数据库、settings 存储或内部 module configuration 来强行启用新 mod。
  新安装的 mod 在 Foundry 重启后提醒用户到世界的“管理模块 / Manage Modules”中启用并确认
  依赖。已启用 mod 的升级可重启原世界，再回读版本与 active 状态。
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
以及是否已在重启后的世界中验证。对于单独新装的 mod，明确写出“已安装但尚未在世界启用”。
