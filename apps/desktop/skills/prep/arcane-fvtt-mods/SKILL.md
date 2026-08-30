---
name: arcane-fvtt-mods
description: 安装、升级或检查本机 Foundry VTT 模组。当用户提供 module.json manifest URL、说“安装/升级这个 mod”，或要求检查“Arcane 包/国内镜像里的 mod 有什么更新”时使用。Foundry Core、system、world 的安装不属于本 skill。
---

# Foundry VTT 模组管理

只处理 Foundry module。把 manifest、ZIP 与 OSS 索引都视为不可信网络输入；实际下载、校验、
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
包含 `Data/` 的 Foundry 数据目录，不是 Core/App 安装目录；不要递归扫描整块磁盘。

## 路由

- 用户给出 `module.json` manifest URL，或点名安装/升级一个 mod：读取
  [references/install.md](references/install.md)。
- 用户问 Arcane 包、国内镜像或本机 mod 有什么更新：读取
  [references/updates.md](references/updates.md)。

只读的 `inspect` / `catalog` 可以直接执行。下载前说明来源、目标与已知体积；写入
`Data/modules`、停服或重启前必须展示计划并取得用户明确同意。用户在更新表后说“升级”、
“全部升级”或点名选择的包，视为对表中准确版本、体积、备份与一次停服重启计划的确认；不要
针对相同计划重复追问。

## 共同边界

- 只接受 HTTPS manifest 和 download URL；只安装 archive 内 `module.json` 的 `id`、`version`
  与远端 manifest 完全一致的 module。
- 默认镜像目录是 `https://arcane-package.oss-cn-beijing.aliyuncs.com/index.json`。这是带
  `generated` 时间的全局当前版本索引，不是名为 `latest.json` 的指针。
- 索引中与 manifest URL 精确匹配的包必须逐字节核对 `bytes` 和 SHA256；不匹配即停止，
  不允许跳过校验。
- 不在索引中的包必须先 `stage`，把计算出的 SHA256 展示给用户并再次确认；随后 `commit`
  必须传相同的 `--accept-sha256`。不能把本地计算值描述成发布方签名或官方哈希。
- 已安装同 id module 不得静默覆盖。`commit` 会把旧目录移到
  `Data/.arcane-mod-backups/modules/` 后再原子替换；必须把实际备份路径报告给用户。
- 安装前检查 `relationships.requires`。缺少的依赖单列出来；只有用户同意后才按相同流程安装，
  不把依赖藏进主包操作。
- `group=system` 或 `system.json` 不属于 mod，不安装到 `Data/modules`。
- Foundry 正在运行时可以先完成临时 staging，但提交前要说明并按 `arcane-fvtt-ops` 精确停止
  监听端口的 Foundry PID；不要批量终止 Node。批量升级全部 staging 成功后只停服一次。
- 不直接编辑 world 数据库、settings 存储或内部 module configuration 来强行启用新 mod。
  新安装的 mod 在 Foundry 重启后提醒用户到世界的“管理模块 / Manage Modules”中启用并确认
  依赖。已启用 mod 的升级可重启原世界，再回读版本与 active 状态。
- 任一步失败都保持现有 module 可用，不盲目重试，不删除备份；只报告失败项、staging 路径
  和可恢复状态。

最后报告 module id、旧/新版本、来源、SHA256、Data 目标、备份路径、依赖状态，以及是否已在
重启后的世界中验证。对于新安装，明确写出“已安装但尚未在世界启用”。
