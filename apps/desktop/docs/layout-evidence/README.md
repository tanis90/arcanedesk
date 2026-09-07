# 多尺寸渲染布局验收

2026-09-07，M8n4。执行 `node apps/desktop/test/review-layout.mjs`，通过。

使用实际 Electron renderer、preload 和生产 ActivityCenter，模型与会话 IPC 使用受控数据。任务 A 持续运行，输入框保留草稿；活动入口显示运行 1。逐项检查活动入口、任务状态、输入框、停止及发送按钮的非零尺寸、可见性和视口边界，并人工查看全部截图。

| 场景 | 内容尺寸 | 聊天宽度 | 截图 |
| --- | --- | --- | --- |
| 最小尺寸 | 1080×640 | 全宽，侧栏固定 | [minimum](minimum.png) |
| 宽窗口 | 1520×920 | 全宽，侧栏固定 | [wide](wide.png) |
| 分屏 | 1520×920 | 456px，侧栏收起 | [split](split.png) |
| 最小分屏 | 1080×640 | 320px，侧栏收起 | [split-minimum](split-minimum.png) |

[原始几何数据](layout.json) 随截图保留。分屏边界包含生产布局的 6px 分隔区。测试等待侧栏真实 CSS 动画收起到视口外后才截图；初次两帧等待截到了动画中途，不计为最终证据。

此验收设置 Electron 内容视口及 renderer 的面板布局状态，未加载右侧 Foundry WebContentsView，所以截图右侧留空。它证明上述尺寸的聊天布局，不证明物理窗口拖动、系统缩放、托盘或通知点击；实际 Foundry 操作另见 [世界写入验收](../foundry-resource-acceptance.md)。
