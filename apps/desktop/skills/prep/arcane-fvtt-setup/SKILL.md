---
name: arcane-fvtt-setup
description: 在本机 Windows/macOS 安装、修复、升级或迁移 Foundry VTT 13 社区环境。用户说“帮我装 Foundry/FVTT”“从零部署”“重装/升级”“迁移到新机器”，或提供 Foundry ZIP/EXE/DMG/timed URL 时使用。既有实例的日常启停、日志和端口排障改用 arcane-fvtt-ops。
---

# Foundry VTT 社区安装与修复

面向不懂技术的小白 DM。使用当前 Agent 会话已经准备好的 Arcane Node 和平台原生能力；
不要要求用户安装 Node、Git、Git Bash 或包管理器。

## 用户交互预算

一次完整安装，用户交互点最多 3 个，除此之外不得再有提问、确认或选择：

1. **提供 Foundry 付费工件**：粘贴官方 timed URL 或拖入本地安装文件。给用户图文指引
   （登录 foundryvtt.com → Purchased Licenses → 复制对应平台的下载链接）。
   交付物料即授权整个安装计划。
2. **处理 OS 安全弹窗**：UAC、Gatekeeper、安全软件提示必须对用户可见并由用户处理。
   弹窗前用一句话预告会出现什么窗口、点哪个按钮；用户取消 UAC 就停止。
3. **浏览器内收尾**：EULA、license 激活、GM 登录由用户在 Foundry 页面完成，
   Agent 在服务就绪后给出精确步骤，不代办。

下载、覆盖文件或修改配置前仍要说明来源、目标与副作用，但这是告知，不等待批准。
新增任何用户交互前，先论证为什么不能归入这 3 点。

## 运行时契约

App 会在 Agent 启动前解压并校验随包 Node。当前 shell 中：

- `ARCANE_FVTT_NODE` 是 Node 可执行文件的绝对路径。
- `node` 和 `npm` 应解析到同一目录，但不修改用户或系统 PATH。
- `ARCANE_FVTT_DISTRIBUTION_FILE` 指向随包 `community-distribution.json`。

开始前核对三项，并验证 Node 版本等于清单 `core.node`。环境变量缺失、文件不存在或版本
不符时停止，建议重启或更新 Arcane Desk；不要回退到系统 Node 或替用户安装另一个 Node。

社区清单没有 Arcane 镜像、官方私有模块、预制世界或默认大体积下载。Foundry Core 始终由
用户从其 Purchased Licenses 页面提供；清单不会提供或猜测付费下载地址。

## 安装计划声明

用户提出安装时、任何下载开始之前，用一段话声明完整计划：

- 装什么：Foundry Core `<core.foundry>`，以及 Arcane Demo 环境（Demo world 及环境
  profile 从 arcane mirror 索引实时解析出的 system/modules，见下文「内容安装」）；
- 总下载量：Core 物料体积 + 内容体积（内容体积以只读 `world-inspect` 实时解析为准，
  可在物料就绪后补全，但内容下载必须在声明之后）；
- 解析后的 Core 目录与 Data 目录准确绝对路径；
- 一句「不想装哪部分，现在说一声」。

声明显示信息但不等待批准；用户交付物料即为对声明计划的授权。OSS 尚未发布 world 时
计划只含 Core；不猜 URL，Core 安装仍可独立成功。

## 物料识别与目录解析

按以下顺序处理：

1. 用户指定的既有 Foundry 安装：验证完整可用后优先复用。
2. 用户提供的本地 `.zip`、`.exe` 或 `.dmg`：检查格式、签名/哈希和内容后使用。
3. 用户提供的 Foundry 官方 timed URL：确认是 Foundry 官方 HTTPS 地址后下载到临时目录。
4. 用户没有安装或物料：说明 Foundry 是付费软件，请用户自行取得官方工件或 timed URL。

目录永远不问用户，用平台默认值，并在计划声明与最终报告中写清准确路径。Core 目录与
Data 目录必须分开。用户只给父目录时，在其下创建 `FoundryVTT-<core.foundry>`；完全未
指定时，Windows 使用 `%LOCALAPPDATA%\ArcaneDesk\runtime\foundry\<版本>`，macOS 使用
ArcaneDesk `userData/runtime/foundry/<版本>`。Data 目录完全未指定时，Windows 使用
`%LOCALAPPDATA%\ArcaneDesk\runtime\foundry-data`，macOS 使用 ArcaneDesk
`userData/runtime/foundry-data`。不要递归扫描整块磁盘，不要把未知非空目录当作安装
目标，也不要发明其他默认位置。

目标目录已存在且非空时：验证为同版本完整安装则直接复用；否则先把现有目录做时间戳
备份再继续，备份未成功不得继续，备份位置写进最终报告。不静默覆盖。

## 安装 Foundry Core

平台细节按需读取：

- Windows：[references/windows-install.md](references/windows-install.md)
- macOS：[references/macos-install.md](references/macos-install.md)

Node.js distribution ZIP 流程：

1. 本地文件直接使用；只有用户提供 timed URL 时才联网下载，下载属计划内授权。
2. 检查 HTTP 状态、最终 URL、大小与文件类型。
3. 用 `ARCANE_FVTT_NODE` 计算 SHA256 并报告。官方 timed URL 没有预声明哈希时，不宣称
   与某个固定哈希匹配，只把计算值作为此次安装和重试的身份依据。
4. 查看归档顶层结构并拒绝绝对路径、`..` 穿越、符号链接逃逸或异常设备文件。
5. 解压到同一磁盘的 staging 目录，定位 `main.js` 与 `package.json`，验证版本等于
   `core.foundry` 后再原子移动到目标。未知非空目录不得覆盖。
6. 后续 headless 运行始终用 `ARCANE_FVTT_NODE` 的绝对路径。

## 目录结构与路径纪律

Foundry 数据目录有内外两层都叫 Data 的结构，装错层级是真实发生过的事故：

```text
<数据目录>                              ← --dataPath 指向的位置
├── Config/                             ← options.json 等
├── Data/
│   ├── systems/<id>                    ← game system，如 dnd5e
│   ├── modules/<id>                    ← module
│   ├── worlds/<id>                     ← world，如 arcane-demo
│   ├── .arcane-mod-backups/            ← mods 流程的替换备份
│   ├── .arcane-world-backups/          ← world 重置备份
│   └── .arcane-managed/profiles/       ← 安装 receipt
└── Logs/
```

- 本文档、对用户输出和内部操作一律用完整形态（如 `<数据目录>/Data/systems/dnd5e`），
  禁止 `Data/systems` 这类裸简写。
- 任何内容装完后，必须从最终绝对路径回读 manifest（`system.json` / `module.json` /
  `world.json` 的 id 与 version）才算装好。装错层级要当场发现，不允许拖到启动后
  扫描不到才暴露。

## 内容安装：一律走 arcane mirror

`community-distribution.json` 的 `installDefaults.systems/modules/worlds` 全部为空，
Desktop 不打包 Demo world、其版本或依赖清单。清单 `systems` 里的 dnd5e 条目只是上游
出处与许可证记录，不得作为安装来源或校验基准。

所有 system/module/world 的安装都交给 `arcane-fvtt-mods`，从 arcane mirror 的 OSS
索引解析：

- **Demo 环境默认安装**：Core 验收后直接继续，不单独询问。按 `arcane-fvtt-mods` 的
  [references/demo-world.md](../arcane-fvtt-mods/references/demo-world.md) 执行：先跑
  只读 `world-inspect` 解析准确包集合、体积与哈希（计划声明的内容体积以此为准），
  然后 staging、一次停服提交、`--world=arcane-demo` 验收。OSS 尚未发布 world 时
  不猜 URL，Core 安装独立成功即可交接。
- **用户点名要 dnd5e**：dnd5e 已收录于 mirror，随 Demo 环境 profile 一并解析安装。
  用户明确不要 Demo world 时，仍按该流程安装，只在启动验收时不传 `--world` 参数；
  world 留在磁盘上不使用。不要改用清单里的 GitHub 条目。
- **用户点名其他 mod**：先查 mirror 索引。已收录的按索引钉死的 bytes 逐字节核对
  SHA256 后直接装，用户明确要求安装即授权。未收录的给一次大白话风险提示并取得确认：
  「这个不在 arcane mirror 选过的 mod 之内，安装可能产生不可知后果，确认要安装吗？
  如果你希望 arcane mirror 收录这个 mod，可以去官网
  https://arcanedesk.bitterbebop.cn/ 反馈我们。」确认后按 `arcane-fvtt-mods` 的
  install 流程安装；SHA256 由 Agent 计算、核对、写进报告，但只是本次下载指纹，
  不再把 hex 串交给用户判断。
- 单项体积与总量已在计划声明里展示，不再单独确认；失败时保留原目录，不留半安装
  状态，只重试失败项。

校验纪律：mirror 内容的验证基准只用索引声明的哈希。禁止混链校验——从 mirror 下载
却拿清单里的 GitHub 哈希去验，必然误报（mirror 为重打包，哈希本就不同）。不使用
代理池或第三方镜像；arcane mirror 是唯一认可的第一方镜像。哈希或身份不符时 helper
会拒绝，不要绕过。

## 验收与交接

根据用户实际选择验收：

1. Arcane Node 与清单版本一致。
2. Foundry `package.json` 版本、`main.js` 与 Core/Data 路径明确。
3. 已安装内容从最终绝对路径回读 manifest 成功；id、版本、来源和 SHA256 有记录
   （mirror 内容以索引与 staging 记录为准）。
4. 用 Arcane Node 启动 `main.js --dataPath=<数据目录>`；装了 Demo 时加
   `--world=arcane-demo`。
5. 日志出现 `Server started and listening on port 30000`，本机地址有响应。

macOS DMG 安装的 App 副本在首次启动前必须按
[references/macos-install.md](references/macos-install.md) 处理 quarantine：核对本次
工件的 SHA256、`codesign` 与 `spctl` 结果和准确 App 路径，向用户说明后用
`xattr -dr com.apple.quarantine` 清除该副本的 quarantine，再做首次启动。不得重签、
去签或替换 App 包内文件。

最后报告实际路径、安装来源、版本、SHA256、备份位置（如有）、安装了哪些内容，以及
仍需用户在 Foundry 页面完成的 EULA、license 激活或 GM 登录。不要打印 license key、
完整 `options.json` 或凭据。

## 安全底线

- 不代取 Foundry 付费工件、license，不代替用户同意 EULA。
- 不绕过 UAC、Gatekeeper 和安全软件提示；静默安装不得用于绕过提权。
- 不静默覆盖 Core、世界、用户数据；冲突先备份，备份成功才继续，备份位置写进报告。
- 所有下载先落盘、验证，再按已声明的计划使用；不执行网络响应。
- 不把 App 安装目录当成可写 Data 目录。
- 不打印 license key、完整 `options.json` 或凭据。
