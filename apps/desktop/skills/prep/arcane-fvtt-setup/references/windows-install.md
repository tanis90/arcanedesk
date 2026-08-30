# Windows 安装流程

由 `../SKILL.md` 的「按物料类型安装 Core」引用，仅包含 Windows 桌面物料（EXE / 便携 ZIP）。共享的运行时契约、物料识别、Data 内容安装、验收与安全纪律都在 `../SKILL.md`；macOS 流程在 `macos-install.md`。

## Windows Portable Build ZIP

这是 Windows V13 官方提供的免安装桌面发行物，适合 Agent 全自动部署到任意目录；不要把它误判为 Node.js distribution。

1. 先在不解压到目标目录的情况下检查归档结构。Portable Build 应包含 `App/Foundry Virtual Tabletop.exe`、`App/resources/app/package.json` 和 `App/resources/app/main.js`；Node.js distribution 则以自身的 `main.js` 和 `package.json` 为入口。结构不匹配时停止，不猜类型。
2. 用 Arcane Node 计算并记录 SHA256。只有用户给出 timed URL 时才下载；下载检查与 Node.js distribution 相同。
3. 解压到目标旁的 staging 目录，拒绝绝对路径、`..` 跳转和会逃出 staging 的链接或归档条目。校验 `App/resources/app/package.json` 中的 Foundry 版本后，再将完整 portable 根目录原子移动到已解析的 Core 目录。
4. 目标非空时不得合并解压或静默覆盖。有效的同版本 Portable Build 直接复用；否则先让用户选择新目录或确认备份替换。
5. 普通桌面启动使用 `App/Foundry Virtual Tabletop.exe`。Agent 做 headless 运维时，使用 `ARCANE_FVTT_NODE` 执行 `App/resources/app/main.js --dataPath=<独立 Data 目录>`。
6. 官方 Portable Build 首次桌面启动会在 portable 根目录创建 `Config`、`Data` 和 `Logs`。Arcane 默认仍显式传入用户选择的独立 Data 目录；只有用户明确要求“完全便携、自包含”时才采用这些相邻目录。

## Windows EXE

EXE 是官方桌面应用安装路径，不要用 Node 解包或模拟安装器。

1. 用 PowerShell `Get-AuthenticodeSignature` 检查签名状态和发布者，并用 Arcane Node 记录 SHA256。签名无效、缺失或发布者异常时停止，让用户确认来源。
2. 静默安装只能使用发行清单 `core.windowsInstaller` 中与当前文件 SHA256、字节数和签名发布者全部匹配的参数组合，而且该组合必须同时支持指定准确安装目录和等待最终退出。不要仅凭安装器框架、文件名或网上常见参数猜 `/S`、`/quiet`、`/D` 等开关。没有匹配方案时改用前台安装或建议 Windows Portable Build。
3. 已知静默方案且目标目录不存在或为空时，用户要求安装即授权安装本身；先告知解析后的准确目录，然后可以静默执行，不再为同一目录重复询问。对于清单登记的 NSIS 安装器，用 PowerShell `Start-Process -Verb RunAs -Wait -PassThru` 启动：原始参数为 `/S /D=<准确 Core 目录>`，`/S` 区分大小写，`/D=` 必须是最后一项，路径即使含空格也不能给 `/D` 值加引号。先验证目标是绝对路径且不含换行或 NUL，不通过 shell 拼接命令。UAC 和安全软件提示仍须可见并由用户处理；用户取消 UAC 就停止。静默模式不得用来绕过提权、代替用户接受 Foundry EULA 或填写许可证。
4. 前台安装作为兼容路径：显示安装器窗口，由用户处理安装选项。用户明确选择静默时不要无理由退回前台；只有参数未验证、目标冲突或静默尝试失败时才说明原因并回退。
5. 无论静默进程返回什么退出码，都重新探测实际安装位置；只有目标中的 `resources/app/package.json`、`resources/app/main.js`、版本和入口全部通过校验才算成功。不要把安装器父进程提前退出当作安装成功。
6. 交互使用可启动安装结果中的桌面 EXE；Agent 运维服务器时可用 Arcane Node 运行其中的 `main.js`。

启动失败时先报告实际进程错误、签名结果和 Windows 事件证据。没有对应证据时，不要把失败归因于 Defender、360 或其他杀毒软件。
