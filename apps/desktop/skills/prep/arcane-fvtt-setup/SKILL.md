---
name: arcane-fvtt-setup
description: 在本机 Windows/macOS 安装、修复、升级或迁移 Foundry VTT 13 社区环境。用户说“帮我装 Foundry/FVTT”“从零部署”“重装/升级”“迁移到新机器”，或提供 Foundry ZIP/EXE/DMG/timed URL 时使用。既有实例的日常启停、日志和端口排障改用 arcane-fvtt-ops。
---

# Foundry VTT 社区安装与修复

面向不懂技术的 DM。使用当前 Agent 会话已经准备好的 Arcane Node 和平台原生能力；
不要要求用户安装 Node、Git、Git Bash 或包管理器。下载、启动安装器、覆盖文件或修改配置
前，先说明来源、目标、预计体积和副作用。

## 运行时契约

App 会在 Agent 启动前解压并校验随包 Node。当前 shell 中：

- `ARCANE_FVTT_NODE` 是 Node 可执行文件的绝对路径。
- `node` 和 `npm` 应解析到同一目录，但不修改用户或系统 PATH。
- `ARCANE_FVTT_DISTRIBUTION_FILE` 指向随包 `community-distribution.json`。

开始前核对三项，并验证 Node 版本等于清单 `core.node`。环境变量缺失、文件不存在或版本
不符时停止，建议重启或更新 Arcane Desk；不要回退到系统 Node 或替用户安装另一个 Node。

社区清单没有 Arcane 镜像、官方私有模块、预制世界或默认大体积下载。Foundry Core 始终由
用户从其 Purchased Licenses 页面提供；清单不会提供或猜测付费下载地址。

## 先识别现状和用户物料

按以下顺序处理：

1. 用户指定的既有 Foundry 安装：验证完整可用后优先复用。
2. 用户提供的本地 `.zip`、`.exe` 或 `.dmg`：检查格式、签名/哈希和内容后使用。
3. 用户提供的 Foundry 官方 timed URL：确认是 Foundry 官方 HTTPS 地址后下载到临时目录。
4. 用户没有安装或物料：说明 Foundry 是付费软件，请用户自行取得官方工件或 timed URL。

最多补问会改变结果的两项：Core 目标目录与 Data 目录。Core 目录与 Data 目录必须分开；Data 目录包含
`Config`、`Data/systems`、`Data/modules`、`Data/worlds` 和 `Logs`。不要递归扫描整块磁盘，
不要把未知非空目录当作安装目标。

用户只给父目录时，在其下创建 `FoundryVTT-<core.foundry>`。完全未指定时，Windows 使用
`%LOCALAPPDATA%\Arcane Desk\runtime\foundry\<版本>`，macOS 使用 Arcane
`userData/runtime/foundry/<版本>`。采用默认值前告诉用户准确路径。

## 安装 Foundry Core

平台细节按需读取：

- Windows：[references/windows-install.md](references/windows-install.md)
- macOS：[references/macos-install.md](references/macos-install.md)

Node.js distribution ZIP 流程：

1. 本地文件直接使用；只有用户提供 timed URL 时才联网下载。
2. 下载前明确告知来源与目标并取得确认；检查 HTTP 状态、最终 URL、大小与文件类型。
3. 用 `ARCANE_FVTT_NODE` 计算 SHA256 并报告。官方 timed URL 没有预声明哈希时，不宣称
   与某个固定哈希匹配，只把计算值作为此次安装和重试的身份依据。
4. 查看归档顶层结构并拒绝绝对路径、`..` 穿越、符号链接逃逸或异常设备文件。
5. 解压到同一磁盘的 staging 目录，定位 `main.js` 与 `package.json`，验证版本等于
   `core.foundry` 后再原子移动到目标。未知非空目录不得覆盖。
6. 后续 headless 运行始终用 `ARCANE_FVTT_NODE` 的绝对路径。

## 可选 Data 内容

`community-distribution.json` 的 `installDefaults.systems/modules/worlds` 全部为空，Desktop 不打包 Demo world、
其版本或依赖清单。不得因为用户只说“安装 Foundry”就静默下载 system、module 或 world。

Foundry Core 启动验收后，普通安装只询问一次用户是否继续安装“完整 Arcane Demo 环境”；先调用
`arcane-fvtt-mods` 的只读 `world-inspect`，让它从 OSS 当前 world、环境 profile 和 stable package 快照解析
准确总下载量、Core/system/module/world 版本、哈希与目标 Data 目录，再让用户选择。用户拒绝或暂不选择时
就以 Core 安装完成交接，
不重复劝说。用户一开始明确要求“完整 Arcane/FVTT 环境”“带 Demo 世界”时，视为已选择该能力，
仍须展示准确计划，然后按 `arcane-fvtt-mods` 的 `references/demo-world.md` 完成 staging、一次停服提交和
`--world=arcane-demo` 验收。OSS 尚未发布 world 时不要猜 URL，Core 安装仍可独立成功。

用户明确要求 dnd5e 时，从清单 `systems` 读取固定上游 URL、版本、许可证与 SHA256，
并在下载前展示这些信息、目标目录和是否会覆盖，得到明确同意后才继续。只使用清单中的
GitHub 上游，不使用代理池或第三方镜像。下载后必须逐字节核对 SHA256，再检查 manifest 的
`id`、`version` 和归档路径，全部通过才从 staging 移入 `Data/systems/dnd5e`。

其他第三方 system/module/world 只有在用户明确要求并提供官方 manifest 或下载来源时处理：

1. 先读取 manifest 和许可证，说明会向哪个域名下载、预计大小和安装目标。
2. 获取用户明确同意后下载到临时目录；不得把网络响应直接送入 shell 或脚本解释器执行。
3. 计算 SHA256、检查归档路径与 manifest 身份。没有发布方预声明哈希时，把计算值展示给
   用户并再次确认后才安装；有预声明哈希时必须完全匹配。
4. 已有同 id 内容不得静默覆盖；先备份或改用新 id，并取得确认。

失败时保留原目录，不留下半安装状态；只重试失败项。任何单项超过 250 MB 时必须单独
说明体积并确认，不能把大下载藏在“默认组件”中。

## 验收与交接

根据用户实际选择验收：

1. Arcane Node 与清单版本一致。
2. Foundry `package.json` 版本、`main.js` 与 Core/Data 路径明确。
3. 已安装内容的 manifest id、版本、来源和 SHA256 有记录。
4. 用 Arcane Node 启动 `main.js --dataPath=<Data目录>`；需要时再加 `--world=<id>`。
5. 日志出现 `Server started and listening on port 30000`，本机地址有响应。

macOS 发生明确的 quarantine 原生模块错误时，先按参考流程验证应用签名与路径。只有用户
明确授权后，才可把 `xattr -dr com.apple.quarantine` 用作定点故障修复；不得作为默认安装
步骤，也不得重签、去签或替换 App 包内文件。

最后报告实际路径、安装来源、版本、SHA256、安装了哪些可选内容，以及仍需用户在 Foundry
页面完成的 EULA、license 激活或 GM 登录。不要打印 license key、完整 `options.json` 或凭据。

## 安全纪律

- 不静默覆盖 Core、世界、用户数据或不同版本目录；删除、迁移和覆盖前先备份并确认路径。
- 不把 App 安装目录当成可写 Data 目录。
- 不自行获取 Foundry 付费工件、license 或 EULA 同意。
- 不使用 shell 管道直接执行网络响应；所有下载先落盘、验证，再按确认的步骤使用。
- UAC、Gatekeeper 和安全软件提示必须可见，Agent 不绕过它们。
