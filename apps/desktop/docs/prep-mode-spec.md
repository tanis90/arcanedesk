# Prep Mode

Prep mode 为 DM 提供本地文件、平台 shell 与受控 Foundry 页面能力。它和战斗模式使用不同的
AgentHost profile，但共享会话、ProviderStore 和 Foundry panel。

安全边界：

- 只在用户选择的工作目录中读写备团文件；没有选择时使用 app-owned 空白 workspace。
- 不把安装目录、启动 shell 的当前目录或开发 checkout 冒充用户项目。
- Windows 使用 PowerShell，macOS 使用 Bash；子进程继承 App 管理的 Node 路径。
- 安装/修复/升级/迁移前必须先读完对应 skill 的 SKILL.md 再动手（prompt 级硬顺序，见 system-prompts/prep.md）；网络工件先落盘、校验、确认，再使用。
- 商业 Foundry 工件、license 与 EULA 必须由用户提供或完成。
- 页面写操作遵循检查、最小修改、回读和不确定结果不盲重试原则。

用户工作目录只保存路径偏好，不复制用户内容。切换目录时关闭当前 prep host 并用新 cwd
创建会话，避免工具仍指向旧项目。

公开 skills：

- `arcane-fvtt-setup`：用户提供物料的安装/迁移；
- `arcane-fvtt-ops`：既有实例的启停、日志与端口排障；
- `arcane-fvtt-mods`：从 `module.json` 安装 mod，并把本地版本与 Arcane OSS 全局索引对比后按用户选择升级；
- `arcane-module-reader`：在明确云上传同意后整理用户有权处理的 PDF；
- `arcane-actor-images`：把用户图片写入世界 Data 的稳定相对路径。
