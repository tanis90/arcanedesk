# macOS 安装流程

由 `../SKILL.md` 的「安装 Foundry Core」引用，仅包含 macOS 桌面物料（DMG）。共享的运行时契约、物料识别、Data 内容安装、验收与安全纪律都在 `../SKILL.md`；Windows 流程在 `windows-install.md`。

## macOS DMG

DMG 是官方桌面应用安装路径，不要强迫用户改用 ZIP。

1. 本地 DMG 直接使用；用 Arcane Node 记录 SHA256。
2. 用 `hdiutil attach -readonly -nobrowse` 挂载，找到 `Foundry Virtual Tabletop.app`；用 `codesign --verify --deep --strict` 和 `spctl --assess --type execute` 检查签名/Gatekeeper 结果。
3. 将 App 复制到用户选择的 `/Applications`、`~/Applications` 或其他明确目标；需要系统授权或弹出安全确认时交给用户处理。复制后卸载镜像。
4. 从 `.app/Contents/Resources/app/package.json` 和 `main.js` 验证版本与入口。交互使用可 `open` 该 App；Agent 运维服务器时可用 Arcane Node 运行其中的 `main.js`。
5. 默认保留下载工件的 quarantine，并让 Gatekeeper 正常完成首次验证。只有实际出现 `library load disallowed by system policy` / `ERR_DLOPEN_FAILED`，且已重新核对本次 DMG 的 SHA256、`codesign` 与 `spctl` 结果和准确 App 路径后，才把清除 quarantine 作为故障修复选项解释给用户。得到用户明确授权后，定点执行 `xattr -dr com.apple.quarantine "<App 路径>"`，随后再次验签并启动验证。禁止重签、去签或替换 App 包内任何文件，也不要用 `ELECTRON_RUN_AS_NODE` 执行包内 Electron。

不得把清 quarantine 当成默认安装步骤。不关闭 Gatekeeper，不用未签名副本替换用户提供的 App，也不替用户批准其他来路不明的软件。
