# 新导航自动验收证据

2026-09-07。生产主进程、preload、renderer 与真实 Pi SDK；模型响应来自隔离 loopback 服务。

运行 `node apps/desktop/test/smoke-production-sidebar.mjs`：第一阶段通过 Electron debugger 的 CDP Runtime 和 Input 域操作真实页面，包括右键、⋯菜单、输入标题、确认删除；第二阶段退出后用同一临时数据重新启动，检查持久性且不调用模型。

| 场景 | 截图 |
| --- | --- |
| 置顶及同名不同项目，A/B 同时运行 | [running-projects](running-projects.png) |
| 会话右键菜单 | [session-menu](session-menu.png) |
| 标题／项目搜索弹层 | [search](search.png) |
| 已归档页面 | [archives](archives.png) |
| 宽窗口 | [wide](wide.png) |
| 窄窗口 | [minimum](minimum.png) |
| 456px 聊天分屏展开侧栏 | [split](split.png) |

最终截图已查看。分屏通过生产 panelLayout 参数设置，没有加载真正的 Foundry 覆盖层，所以右侧为空白；该图证明导航抽屉布局，不证明物理拖动或操作系统托盘。

[CDP 与重启日志](cdp-and-restart.txt)、[场景清单](result.json)、[静态检查](static-checks.txt)、[全量单测](unit-tests.txt)。系统交互另填 [人工表单](../manual-acceptance.html)。性能见 [新基准](../performance-navigation.json)。

验收脚本先等待真实 DOM 条件，再发送 CDP 鼠标事件；不通过直接调用菜单业务函数替代主要点击路径。后台数据、模型流和延迟回包闸门由测试控制。归档回包被故意截留，用户打开归档页后再放行，验证迟到结果不抢回导航。

目录缺失回归只临时移动已校验位于测试根目录内的项目，恢复会话后提交返回 PROJECT_UNAVAILABLE，模型请求数不增加，原目录不被重建；随后还原测试目录。归档后直接 IPC 提交返回 SESSION_ARCHIVED。最终日志包含首进程与重启进程两项 PASS。
