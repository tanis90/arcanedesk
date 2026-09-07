# 实际 Foundry 资源竞争验收

日期：2026-09-07。产品基线：`7e3deb8`。入口：[review-production-foundry.mjs](../test/review-production-foundry.mjs)，复用生产 main fixture 的 foundry-scenario。

## 环境和边界

使用本机已授权 Foundry 13.351 安装及 Node 22.23.2。将旧 E2E 的 test001 世界和 dnd5e 5.3.3 系统复制到新临时目录，使用既有许可证配置，在 loopback 30219 端口启动该副本。原 E2E 数据与用户世界没有被本次操作修改。许可证校验成功，不修改许可证或绕过登录。测试 GM 登录就绪后才运行。

复现须先启动隔离的 test001 副本于 `http://127.0.0.1:30219`，然后在仓库根目录执行 `node apps/desktop/test/review-production-foundry.mjs`。不要将该端口指向用户工作世界。窗口为 `ArcaneDesk — Isolated Foundry acceptance`；等待测试 GM 登录，最长十分钟。用户已明确授权此测试 GM 使用空密码、以后由助手登录；无需向模型提交密码。

ArcaneDesk 使用独立 userData、真实生产 IPC/renderer、Pi SDK、browser_evaluate 工具和资源协调器。模型端点为 loopback，输出确定的工具调用；Foundry 页面、Document API、服务端数据库均为真实实现。测试只创建带随机 probe 标记的 JournalEntry，不改变既有演员、场景或战斗。

## 实际经过与断言

1. A 经真实模型工具调用进入 Foundry 页面代码，在可控 Promise 前等待，持有 `foundry:page`。先校验 game.ready、GM 及 test001 世界身份。
2. 切换到 B，B 的模型也请求 browser_evaluate。主进程和页面均显示 B 等待资源，其页面代码尚未执行。
3. 在 B 点击停止。B 落 stopped；A 仍 busy；页面标记证实 B 的代码没有运行。
4. 返回 A 并释放测试 Promise。A 使用公开 JournalEntry.create 创建文档，真实工具结果回到 SDK，模型生成终稿，任务结束。
5. 按随机 probe 标记查询世界，恰好找到一个文档；再次确认 B 从未执行。用公开 Document.delete 清理该测试文档。
6. 最终模型调用严格为 A、B、A：A 初始调用与工具结果续轮，B 仅初始调用。没有因切换或停止重新提交 A。

2026-09-07 17:11:38 本地服务端日志记录同一个测试 JournalEntry 的创建和删除。runner 返回 exit 0，输出：`PASS production Foundry: actual Document write, queued task cancellation and single execution`。

## 证据范围

本项补齐 G6 的生产页面/实际世界写入、同资源等待及取消联合场景。页面操作超时后继续持有资源、导航替换旧执行环境另由既有 Electron resource fixture 验证；本项不声称覆盖所有 Foundry 系统和模块行为，也不替代系统托盘/通知或物理多尺寸验收。失败时不要盲目重放写入，应先检查隔离世界中的 probe 文档。
