# macOS 安装流程

由 `../SKILL.md` 的「安装 Foundry Core」引用，仅包含 macOS 桌面物料（DMG）。共享的交互预算、运行时契约、物料识别、内容安装、验收与安全底线都在 `../SKILL.md`；Windows 流程在 `windows-install.md`。

## macOS DMG

DMG 是官方桌面应用安装路径，不要强迫用户改用 ZIP。

1. 本地 DMG 直接使用；用 Arcane Node 记录 SHA256。
2. 用 `hdiutil attach -readonly -nobrowse` 挂载，找到 `Foundry Virtual Tabletop.app`；用 `codesign --verify --deep --strict` 和 `spctl --assess --type execute` 检查签名/Gatekeeper 结果。
3. 将 App 复制到用户选择的 `/Applications`、`~/Applications` 或其他明确目标；需要系统授权或弹出安全确认时交给用户处理。复制后卸载镜像。
4. 从 `.app/Contents/Resources/app/package.json` 和 `main.js` 验证版本与入口。交互使用可 `open` 该 App；Agent 运维服务器时可用 Arcane Node 运行其中的 `main.js`。
5. 拷贝完成后、第一次 `open` 或 headless 启动之前，必须清掉拷贝带来的隔离属性：先向用户说明要清除本次安装副本的 quarantine 及原因（一句告知即可，不是等待批准），然后执行 `xattr -dr com.apple.quarantine "<App 路径>"`。不清则包内原生模块（`classic_level.node` 等）对任何进程都禁止加载，headless 必失败，报 `library load disallowed by system policy` / `ERR_DLOPEN_FAILED`；GUI 首启也会被 Gatekeeper 弹窗拦截（弹窗里点「移到废纸篓」会删掉刚装好的 App）。这不是 Node 或 macOS 版本问题。禁止重签、去签或替换 App 包内任何文件，也不要用 `ELECTRON_RUN_AS_NODE` 执行包内 Electron。

只对本次安装且 SHA256 已记录、`codesign` 与 `spctl` 结果已核对的 App 副本清 quarantine；不关闭 Gatekeeper，不用未签名副本替换用户提供的 App，也不替用户批准其他来路不明的软件。
