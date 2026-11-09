---
name: arcane-fvtt-setup
description: 在本机 Windows/macOS 或远程 Linux 服务器上安装、修复、升级、迁移 Foundry VTT 13，或部署、接管云服务器上的 FVTT。用户说"帮我装 Foundry/FVTT""从零部署""重装/升级""迁移到新机器"，或"我买了台服务器/阿里云/腾讯云 ECS，帮我把 Foundry 装上去""部署到服务器""连上我的服务器"，或提供 Foundry ZIP/EXE/DMG/timed URL 时使用。本机既有实例的日常启停、日志与端口排障改用 arcane-fvtt-ops；服务器实例由本 skill 的 server 轨道接管运维；模组管理归 arcane-fvtt-mods。
---

# Foundry VTT 安装与部署（本机 / 服务器）

面向不懂技术的小白 DM。先判定目标轨道，再按轨道读对应 reference 执行；物料纪律、
钉版基线、内容安装与验收口径两条轨道共享同一份（本文）。使用当前 Agent 会话已经
准备好的 Arcane Node 和平台原生能力；不要要求用户安装 Node、Git、Git Bash 或包管理器。

## 目标判定（先于一切动作）

- target = **server**：用户明说服务器/云主机/ECS/SSH/公网 IP，或"部署到服务器"
  "连上我的服务器"。
- target = **local**（默认）：其余情况，含"帮我装 Foundry""装到这台电脑"。
- 不确定时默认 local，并在计划里带一句"也可以装到你的服务器上，现在说一声即可"
  （告知，不占交互点）。确认门前两条轨道全部只读，切换轨道零损失。

## 路由

- **local**：[references/local-install.md](references/local-install.md)（安装计划与确认、
  物料识别、目录推导、Core 安装、内容安装、验收交接）；Windows/macOS 物料细节按需读
  [references/windows-install.md](references/windows-install.md) 与
  [references/macos-install.md](references/macos-install.md)。
- **server**：首次接入先读 [references/server-ssh.md](references/server-ssh.md)（问三个
  事实、skill 自备密钥、用户跑唯一一条命令）；部署/接管/冲突处理读
  [references/server-deploy.md](references/server-deploy.md)——§1 探测序列、§2 Docker
  安装四层降级、§3 本体交付、§4 镜像通道与部署、§5 冲突三选一、§6 裸机纪律；云厂商
  安全组/密钥对/下载源速查 [references/server-vendor-map.md](references/server-vendor-map.md)。
  已配置 `arcane-server` SSH 别名则直接探测，不走接入引导。
- 本机 30000 在监听 → 已有本机部署，日常启停转 arcane-fvtt-ops，不重装。

## 共享纪律（两条轨道同一份）

**钉版基线**：Foundry 13.351 / dnd5e 5.3.3 / Node 22.23.2。本机以
`ARCANE_FVTT_DISTRIBUTION_FILE`（community-distribution.json）为钉版事实源，服务器以
镜像通道 `server-release.json` 的 foundry/node 字段为准，两份文件由发布管线保证一致；
bump 钉版时两边同步。

**Foundry 本体用户自供**：入口只有一个——登录 foundryvtt.com → 用户资料 →
**Purchased Licenses** 标签页（`/releases` 页只是发行说明，没有下载按钮）。指导用户：
①Versions 下拉**不要用默认** "Recommended"（最新稳定版），选 **Older Stable → 13.351**；
②Operating System 下拉按轨道分叉——local 选 Windows / macOS 安装包，server 选
**Node.JS**（跨平台构建，专用服务器定位；13.338 起 "Linux" 与 "Node.JS" 是两个独立
选项，不是 Linux 桌面构建）。绝不猜测或代填付费下载 URL。交付方式：用户拖入本地
文件，或复制 **Timed URL**（5 分钟有效）立即交给 skill 下载。

**内容安装一律走 arcane mirror**：Demo 环境（world + 环境 profile 解析出的
system/modules）默认安装，不单独询问——统一按 `arcane-fvtt-mods` 的
[references/demo-world.md](../arcane-fvtt-mods/references/demo-world.md) 流程执行；本机在
Core 验收后接 world-inspect → staging → 提交，服务器由镜像入口脚本首启自动完成
（从 region mod 索引下载，字节级校验同源）。mirror 未收录的 mod 给一次大白话风险
提示（话术见 arcane-fvtt-mods）。禁止混链校验；不使用代理池或第三方镜像。

**数据目录双层结构**：`<数据目录>`（`--dataPath` 指向的位置）下才是 `Config/`、`Data/`、
`Logs/`；外层与内层 Data 同名。所有路径一律完整形态（如
`<数据目录>/Data/systems/dnd5e`），`Data/systems` 这类裸简写已导致过装错层级的事故。
任何内容装完后必须从最终绝对路径回读 manifest（id/version）验收。服务器轨道的世界
迁移（rsync `Config/ + Data/`）沿用同一结构。

**验收口径**：Core 就绪后 `/api/status` 返回钉版版本号；装了 Demo 的世界加载、
`systemVersion=5.3.3`；最后交付准确路径/URL、安装来源、SHA256、备份位置（如有）、
已装内容清单，以及仍需用户完成的 EULA / license 激活 / GM 初始凭据。

## 交互预算（轨道制）

- **local 4 点**：①提供 Foundry 付费工件；②确认安装计划（唯一确认门，确认后相同
  计划不再追问）；③处理 OS 安全弹窗（UAC/Gatekeeper，取消即停止）；④浏览器内收尾。
- **server 5 点**：①接入时问三个事实（哪家云/公网 IP/密码还是 .pem）；②用户自己终端
  跑一条公钥安装命令（输 yes + 服务器密码）；③冲突三选一（仅当探测发现冲突）；
  ④"装了但停着——帮你启动？"；⑤激活面板里用户自己填 adminKey + license key。
- 其余一切（发行版、docker 有无、下载源、安全组引导、探测问句）都是 skill 侧探测与
  并行提示，不占交互点。对来源、目标与副作用的说明是告知，不等待批准。新增任何
  交互前，先论证为什么不能归入预算内已有交互点。

## 运行时契约

App 会在 Agent 启动前解压并校验随包 Node。当前 shell 中：

- `ARCANE_FVTT_NODE` 是 Node 可执行文件的绝对路径；`node` 和 `npm` 应解析到同一目录，
  但不修改用户或系统 PATH。
- `ARCANE_FVTT_DISTRIBUTION_FILE` 指向随包 `community-distribution.json`。

local 轨道开始前核对两项路径存在，并验证 Node 版本等于清单 `core.node`；缺失、不存在
或版本不符时停止，建议重启或更新 Arcane Desk，不要回退到系统 Node 或替用户安装另一
个 Node。社区清单没有 Arcane 镜像、官方私有模块、预制世界或默认大体积下载；Foundry
Core 始终由用户从其 Purchased Licenses 页面提供。

## 安全底线（两轨并集）

- 私钥材料永不进入对话（会话会被持久化快照重放）；密码只在用户自己终端里输给
  ssh；license key / adminKey 只在面板表单里填。
- 不代取 Foundry 付费工件、license，不代替用户同意 EULA。
- 不绕过 UAC、Gatekeeper 和安全软件提示；静默安装不得用于绕过提权。
- 不静默覆盖 Core、世界、用户数据；冲突先备份，备份成功才继续，备份位置写进报告。
- 所有下载先落盘、验证，再按已确认的计划使用；不执行网络响应。
- 服务器轨道全程零 `docker pull`、零 registry、零加速器配置：镜像 tar.gz 只从 arcane
  mirror 下载（server-deploy.md §4），bytes+SHA256 校验后 `docker load`；第三方源只
  允许 docker 安装降级链里的包仓库，且仅当第一方镜像不可达。
- 30000 对公网开放是部署目的，安全边界是 FVTT 用户/密码体系；真正绝不可暴露的是
  CDP 调试端口。
- 不把 App 安装目录当成可写 Data 目录；不打印 license key、完整 `options.json`
  或凭据。
