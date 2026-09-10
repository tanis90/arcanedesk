# Markdown 阅读器实现评审（codex/md-reader-impl）

日期：2026-09-10。评审对象：worktree `arcanedesk-md-reader-impl`，分支 `codex/md-reader-impl`，HEAD `30ce13b`（M1–M8，diff 约 +3600 行）。评审基准：[md-reader-spec.md](md-reader-spec.md) 与 [design-rules.md](design-rules.md)。

**总分：81 / 100。** 结论：架构与工程纪律是 A 级（状态机唯一 owner、零新依赖、测试 445 项全绿且不变量真的被断言、证据链诚实）；但存在 1 个真实运行时 bug（Foundry 崩溃不可感知）、1 个 spec 与代码共同造成的 UX 死端、1 个渲染管线 bug，验收用的 CDP 场景恰好没覆盖到真实 FVTT 页面。修复优先级见 §6。

## 1. 四个已上报问题的根因判定

### BUG-1 正文栏过窄（设计问题，代码符合 spec）

`.md-doc { max-width: 68ch }`（`md-reader.html:138`）是 spec §5.2 的原文，实现忠实执行了。但验收截图暴露了两个叠加效应：右屏本身被 chat 挤窄时，68ch 的居中栏再吃掉两侧留白，正文实际宽度远小于面板宽度，页面重心明显偏右。参考实现（智谱）的正文是满铺的。

**定性：spec 设计失误，不是实现 bug。** 68ch 是桌面宽屏排版经验值，不适用于"宽度被分栏挤压的面板"。修正方向：正文栏宽度改为自适应面板（如 `max-width: min(72ch, 92%)` 或干脆满铺 + 适度 padding），并把它写回 spec §5.2。

### BUG-2 拖拽分栏后出现「查看后续消息」（**既有 bug，与本 PR 无关**）

完整链条（`main` 分支逐字节相同，可复现）：

1. 拖拽分栏 → `applyPanelLayout()` 改 `margin-right` → `#messages` 回流 → Chromium scroll-anchoring 移动 `scrollTop` → 触发 scroll 事件 → `chat.js:575` `followLatest` 变 false（不再贴底 80px 内）；
2. 下一次 snapshot 刷新（窗口 focus 重同步 `chat.js:3100` 是最常见的触发——点原生 view 再点回 chat 就会发）；
3. `chat.js:305`：`keepReading` 为 true 时**无条件** `hasNewer: true`，不看 payload 里实际的 `hasNewer`——设计意图是"用户在翻旧页不要拽走"，但对"在最新页只是没贴底"误伤 → 幽灵「查看后续消息」；
4. 点它 → `history-index.js:72` `start = records.length` → 空页且 `firstKey/lastKey: null, hasOlder: true` → renderer 清空整个对话区；
5. 再点「查看更早的消息」→ `history-index.js:68` null key 直接抛 `INVALID_HISTORY_QUERY`。

**定性：pre-existing，建议从本 PR 拆出单独修**（`chat.js:305` 只在 hasNewer 已为 true 时保留；main 侧空页不应报 `hasOlder:true` 带 null key；`renderHistoryNavigation` 遇到 null key 不渲染按钮）。本 PR 的责任仅在于让拖拽触发变得更频繁。

### BUG-3 关面板再开只剩阅读器，Foundry 永远回不来（**spec 与代码共同造成的死端**）

机制：

1. `closePanel()` 销毁两个 view，记下 `lastContent = { surface, origin, path }`（`panel-surface-controller.js:170`）；
2. `openPanel()` 恢复时**丢弃 origin**：`restore?.surface === "reader"` → 直接 `showReader(restore.path)`（`:163`）；
3. `showReader` 重新快照 origin——foundryView 刚被销毁，必为 `closed`（`:117-119`）→ 返回按钮显示「✕ 关闭」；
4. 此后形成闭环：③ → closePanel（又记下 reader）→ ① → 又是 reader。**用户够不到 Foundry**，唯一出口是 agent 调 `foundry_open`。

代码完全符合 spec §3.4 的修订注记（"重开时 foundryView 必不存在，一律落 READER_C"），所以这是**评审时漏掉的设计缺陷，实现无责**。结合本次验收意见（顶栏按钮语义应收敛为"打开/收起右屏"，不与 Foundry 状态绑定），修正方向二选一：

- A（推荐）：`closePanel` 时若 surface=reader 且 origin=foundry，`lastContent` 记为 foundry——重开落在 Foundry（重载一次），笔记从 chat 路径可再次进入；
- B：`openPanel` 恢复 reader 且 origin=foundry 时先 `loadFoundry()` 再 `showReader()`——恢复现场最完整，代价是一次静默 FVTT 加载（spec 当初正是为了避开它）。

### BUG-4 返回 Foundry 黑屏重载、配置弹窗复现（**真实 bug：崩溃不可感知**）

返回路径本身被证明是干净的：`leaveReader` → origin=foundry 分支只做 `setVisible` 翻转（`panel-surface-controller.js:143-148`），全程不碰 `loadFoundryPage`；打开阅读器也不销毁/重建 foundryView；两个 view 同 `session.defaultSession`，无 partition 冲突。

黑屏 + 重新配置的真实机制：**foundry 的 renderer 进程在被遮住期间死了**（WebGL 页面被 Chromium 判定 occlusion 后丢弃/崩溃，重新显示时从头加载，Foundry 自己也会因 socket 断开重放加入流程），而代码察觉不到：

- `isUsable()`（`:313`）只查 `webContents.isDestroyed()`。Electron 里 renderer 崩溃（`render-process-gone`）后 `isDestroyed()` 仍是 **false**，必须查 `isCrashed()`——于是 `leaveReader` 的守卫把一块死黑屏重新摆了出来，而它自己设计的兜底（`ensureFoundryView` 重建）根本进不去；
- `createFoundryView`（`main.js:344-375`）只挂了 `once("destroyed")`，**没有 `render-process-gone` 监听**，隐藏期间崩溃无人知晓、无人清理；
- 单测把"崩溃"建模成 `destroyed = true`（`panel-surface-controller.test.mjs:402`），与真实崩溃语义不符——所以这个洞穿过了全部 445 项测试。CDP 验收里的 foundryView 显示的是静态 `foundry-unavailable.html`（无 FVTT 服务器），真实 `/game`（WebGL + websocket）恰恰是没被测到的场景。

**修法**：`isUsable` 加 `!webContents.isCrashed()`；`createFoundryView` 加 `render-process-gone`（日志 + `foundryRuntime.invalidate()` + 权限状态清理）；测试改用 isCrashed 语义的 mock；用真实 FVTT 实例人工复测一次。

## 2. 其余代码级发现

### Bug / 脆弱性

| # | 严重度 | 位置 | 问题 |
|---|---|---|---|
| F1 | bug | `markdown.js:357-361` | KaTeX 渲染产物会被 linkify：`acceptNode` 只排除 `pre, a`，`$\text{README.md}$` 这类公式先渲染成 `.md-katex` span，再被包上 `<a class="md-path">`，公式视觉被破坏。修：排除列表加 `.md-katex`。 |
| F2 | fragility | `markdown.js:239-240` | `a.md:12x`（行号后带非数字）回溯后误匹配为 `a.md` + 悬空 `:12x`。修：行号组未参与时边界断言也要拒绝 `:`。 |
| F3 | fragility | `main.js:478` | `loadFoundryPage` 无条件解引用 `foundryView().webContents`；view 在 `reloadFoundry` 检查后到此之间销毁会抛 TypeError（被 IPC 包装接住，只产生一次莫名其妙的 `{ok:false}`）。修：复用 `failedPage` 的守卫。 |
| F4 | minor | `chat.js:624-634` | 点击委托未检查 `event.button`，中键也会打开阅读器。 |
| F5 | minor | `mini-dom.mjs:196` | 假 `createTreeWalker` 产出非文档序（根的直接文本子节点被 unshift 到所有深层节点前）。linkify 边走边改 DOM，未来出现 `text,<b>,text` 同层混合结构时测试与真实浏览器静默分叉。修：单趟深度优先收集。 |
| F6 | hygiene | `md-reader-note.test.mjs:19` | 每个测试 `mkdtempSync` 但只有最后一个清理，每跑一遍漏 ~15 个临时目录。 |

### 缺失 / spec 与代码不一致

| # | 位置 | 问题 |
|---|---|---|
| M1 | spec §3.2 vs 代码 | spec 把"切战斗模式"列为 ④ 触发源，但 `mode:set`（main.js:976）完全不碰面板——而 §4.4 又说"切模式本身不改变 surface"。**spec 内部矛盾**，代码遵循的是 §4.4。修 spec：从 §3.2 的 ④ 列举中删掉"切战斗模式"。 |
| M2 | `ui:locale`（main.js:1536） | 语言热切换不推给阅读器（主题有 `onTheme` 通道，语言没有）：阅读器 chrome 停在旧语言直到销毁重建。spec 未要求，但主题/语言不对称是个坑。低优先。 |
| M3 | `panel-surface-controller.test.mjs` | FOUNDRY × ③ 的 no-op 格子只在混合序列里隐式覆盖，缺一条显式断言。 |
| M4 | 路径形态 | UNC 路径、带空格路径、`x.md#anchor` 不支持——v1 可接受，但应写进 spec §1 非目标，免得以后被当 bug 提。 |

### 过度设计检查（结论：无实质过度设计）

- `mini-dom.mjs`（254 行假 DOM）：spec 零新依赖排除了 jsdom，它用 `vm` 跑**真 markdown.js + 真 vendor marked**，头部诚实写明假了什么——分寸恰当；
- `review-md-reader.mjs`（374 行 CDP 验收）：有真实调用者（里程碑验收流程），验证的是单测结构性无法覆盖的东西（独立 CDP target、真实 CSP 下的 mermaid、真实 Esc 栈）——符合 R4；
- `panel-surface-controller.js` 不 import electron、hooks 注入——这是 444 行状态机测试能脱离窗口跑的前提，是设计而非奢侈。

### 范围 creep（轻微）

里程碑记录里混入了一个与本特性无关的生产 bugfix（"关面板再开会从远端 world 掉回 localhost:30000"，commit `8ceb3f6`）。改动本身正确且有测试，但应单独提 PR。

## 3. 做得好的地方（防误删清单）

- 状态机四态 × 四事件**全转移表**都有测试，§3.5 不变量在正确层级被断言（单 view 可见性逐转移检查、③ 不触发 FVTT 加载按调用次数断言）；
- 崩溃即常态（R1）在控制器里有真实设计：阅读期间 foundry 崩掉 → ③ 落 closePanel 而不是亮白屏（缺陷只在崩溃检测手段，见 BUG-4）；
- 信任边界干净：`md-reader:open` 唯一校验点；`isTrustedReaderIpc` 正确镜像 chat 侧检查；readerView preload 只有三个单向方法，拿不到任何文件系统能力；
- 读链（`md-reader-note.js`）单一入口供 ②/F5/①恢复三处复用（R2），错误全走页内错误页（R5），截断劈开多字节字符的 `\uFFFD` 收尾细节都处理了；
- fence 注册表是 mermaid 特判的忠实搬迁，行为不变；
- 证据文档（`md-reader-evidence/README.md`）主动写明"哪些信号不可靠、哪里留了人工"——不是走过场；
- 分栏拖拽的指针穿透从只绑 foundryView 扩展到 activeView，顺带修了"拖拽划过阅读器断流"这个 base 上就存在的潜伏问题。

## 4. 评分明细

| 维度 | 得分 | 说明 |
|---|---|---|
| 架构与代码质量 | 24/25 | 控制器/读链/preload 均为教科书级；扣 1：`loadFoundryPage` 解引用守卫不一致 |
| spec 符合度 | 18/20 | 高度忠实；扣 2：spec §3.2 矛盾未在实施时挑出来回报，注释引入错别字（main.js:419"只有跟源"） |
| 正确性与鲁棒性 | 13/20 | BUG-4（崩溃不可感知）+ F1（KaTeX 被 linkify）+ F2 正则边界 |
| 测试与验收 | 17/20 | 445 全绿实测确认；扣 3：崩溃 mock 语义错误、假 TreeWalker 顺序分叉、真实 FVTT 场景未覆盖、临时目录泄漏 |
| UX 落地 | 9/15 | BUG-1 版式被验收否决（spec 责任各半）、BUG-3 死端（spec 责任）、M2 语言不对称 |
| **合计** | **81/100** | |

## 5. 修复优先级

| 优先级 | 项 | 归属 |
|---|---|---|
| P0 | BUG-4：isCrashed + render-process-gone + isCrashed 语义的测试 mock + 真实 FVTT 人工复测 | 代码 |
| P0 | BUG-3：定方案 A/B，同步改 spec §3.4 与控制器 | spec + 代码 |
| P0 | BUG-1：正文栏宽度改自适应，回写 spec §5.2 | spec + 代码 |
| P1 | F1 KaTeX 排除、M1 spec §3.2 矛盾修正 | 代码 + spec |
| P2 | BUG-2 拆独立修复（既有 bug）；F2/F3/F5/F6/M3/M4 一并处理 | 代码/测试 |
| P3 | M2 语言热切换通道；范围 creep 的 bugfix 拆 PR | 流程 |
