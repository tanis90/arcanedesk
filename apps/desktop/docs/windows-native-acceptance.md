# Windows 原生交互验收

日期：2026-09-07。产品代码基线：`761c446`；本次新增交互验收入口，不修改产品生命周期代码。整体规格与剩余项见 [验收审计](acceptance-audit.md)。

## 可复现入口

在仓库根目录执行 `node apps/desktop/test/review-native-lifecycle.mjs`。这是交互入口，不是无人值守 smoke：窗口出现后需要实际操作窗口按钮与系统对话框。

入口运行生产 main、IPC、renderer、真实 Pi SDK 和原生 Tray；隔离 userData、agent 及模型配置。loopback 模型输出 `A partial` 后等待，不使用用户 provider 或真实外部工具。不会替换 showMessageBox；窗口标题为 `ArcaneDesk — Native acceptance`。正常验收以“停止任务并退出”结束，runner 只有在任务 stopped、busy=false、托盘销毁且模型仅调用一次时返回成功。

## 本次实际操作与结果

Windows Computer Use 通过返回的独立窗口句柄进行输入，未操作 Codex 窗口。截图显示约 1522×921 的浅色窗口，标题、活动计数、任务进行中、半截回复、补充当前任务和停止入口可见。

1. 实际点击系统关闭按钮，原生“退出 ArcaneDesk”对话框出现，显示“取消”“停止任务并退出”“后台继续”。
2. 点击“取消”，对话框消失，界面仍显示任务进行中、`A partial` 和补充入口。
3. 实际点击最小化按钮。主进程记录 `NATIVE minimized busy=true`；窗口状态查询确认已最小化。
4. 使用 Windows 窗口激活恢复。记录 `NATIVE restored busy=true`；原任务状态、半截回复及操作入口仍在。
5. 再次点击系统关闭，点击原生“停止任务并退出”。SDK 报告请求取消，最终断言通过：任务 stopped、busy=false、托盘已销毁、请求严格为一次 A。runner exit 0，随后 Windows 窗口清单中该窗口消失。

成功标记：`PASS native review: real dialog stop-and-exit settles task and destroys tray`。

## 范围与已发现的问题

- 以上是实际系统输入和原生对话框的证据，补充此前仅程序调用托盘/关闭回调的测试。
- 本次未点击后台继续和系统托盘，未验证 toast 展示/点击、后台完成不抢焦点、多尺寸布局或 macOS。不能据此关闭整个 G7。
- 发现普通会话列表首轮仍显示 `(no messages)` 和 0 条，而活动区和正文已显示 `production-A`。这会影响用户识别会话，登记为 G9；后续 M8n2 已修复并由生产 metadata 验收关闭，详见验收审计 E17。
- 首次启动时 Electron 主窗口未进入可见列表；测试入口增加显式 window.show 后可见。该次启动不计入通过；结束了已核实属于此测试的进程后重跑。产品默认启动逻辑未改。
- 原生对话框的首次 accessibility 索引点击返回索引不可用；重新截图后用当前截图坐标点击成功，未重复使用失效索引。

## Foundry 环境调查

本机存在旧验收安装 `D:\fvtt-e2e\Foundry Virtual Tabletop` 与数据 `D:\fvtt-e2e-data`（配置端口 30199、world=null，含 test001 世界），以及既有 `D:\FVTT_DATA`。调查时没有发现历史 30001 或 30199 服务监听。未启动或修改这些世界；G6 实际 Foundry 操作仍未验收。
