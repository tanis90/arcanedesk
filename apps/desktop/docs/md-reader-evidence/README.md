# 右屏 Markdown 阅读器验收证据

2026-09-10。复跑命令（worktree 根目录）：`node apps/desktop/test/review-md-reader.mjs`。通过。

夹具 `test/fixtures/production-main-smoke.cjs --md-reader-review` 只把三份笔记写到临时备团目录然后待命；
点击、换页、切主题、Esc 全部由 runner 通过 CDP 从**进程外**发出，走真实的输入与 IPC 栈。
夹具不替 runner 按任何按钮，否则验收就成了自己给自己打分。

| 截图 | 现场 | 证明 |
| --- | --- | --- |
| [01](01-foundry-surface.png) | ① 开面板 | Foundry surface 是独立 page target（本地无 FVTT，落既有连接失败页） |
| [02](02-chat-anchor.png) | chat | 生产渲染管线把 `notes/gatekeeper.md` 变成无 href、可聚焦、role=link 的锚点 |
| [03](03-reader-over-foundry.png) | READER_F | 正文渲染、按钮自称「返回 Foundry」、68ch 居中衬线排版；正文里的两个 md 路径不成锚点（R5） |
| [04](04-reader-dark.png) | 暗色 | 顶栏切主题广播到阅读器页，内容不重读不重渲染 |
| [05](05-reader-error.png) | 错误页 | 越界路径在阅读器内渲染错误页，chat 侧零打扰，Foundry 不受影响 |
| [06](06-reader-restored.png) | READER_C | ① 关闭前是笔记 → 重开恢复笔记，按钮改称「关闭」（origin 重新快照成 closed） |
| [07](07-reader-mermaid.png) | mermaid | vendored mermaid 在阅读器页 CSP 下真渲染出 SVG，未走失败回退 |

[review.json](review.json) 记录三个 target 的 id、逐条断言与截图清单。
「阅读器是独立 page target」是 §2 的外部可观测证据：它是 main 侧第二个 `WebContentsView`，不是 chat 页里的 DOM。

进程内不变量（同一时刻最多一个 view 可见、隐藏 view 的 `getVisible()` 为 false、③ 与 ④ 绝不重载 Foundry 页）
由 `test/fixtures/md-reader-panel.cjs` 把守，随 `node test/smoke-md-reader.mjs` 复跑。

## 为什么不用 document.visibilityState 当「只有一个 view 可见」的证据

实测两头都不成立：窗口隐藏时（普通 smoke）两张页都报 hidden，分不出谁可见；
而 CDP 客户端 `Page.enable` 过的 target 会把 `setVisible(false)` 盖掉，一律报 visible。
所以不变量 1 的权威证据只能是 main 里的 `view.getVisible()`。
review.json 里的 `visibilityStateAfterEscape` 只是如实记录读数，不当门禁。

## 仍留人工（spec §9 手测清单）

- en-US 语言下的阅读器页观感。键集一致性已有 i18n 单测把守，排版观感留人工。
- 分栏拖拽 / resize / F11 全屏下双 view 切换无闪烁。闪烁是感知项：自动化能证明 bounds 与可见性正确，证明不了「没闪」。
