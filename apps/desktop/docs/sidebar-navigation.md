# Kimi Code 侧栏参考资料

2026-09-07。仅保留参考来源；此前侧栏设计已合并到 [唯一技术方案](architecture.md)，本文不再独立定义产品规则。当前实现状态见 [验收清单](acceptance-audit.md)。

## Kimi 参考核对

2026-09-07 补充实际内置浏览器操作：用户提供的 localhost:58627 界面，登录后验证新建行右侧留白可点击、整行悬停加深、搜索弹层键盘选择和点击外部关闭，并截图检查。Kimi 的会话行尾在悬停时出现置顶／归档快捷按钮；测试时误触归档已从设置恢复，原会话留在列表。ArcaneDesk 只参考整行命中和搜索入口，保留明确 ⋯ 菜单，不复刻行尾快捷归档。没有向 Kimi 提交新消息。

本地 Pi 0.84.3：`dist/core/session-manager.d.ts` 的 SessionInfo 包含 name、cwd、firstMessage、allMessagesText；`dist/modes/interactive/components/session-selector-search.js` 实现终端过滤。没有独立公开搜索 API，本轮选择现有导航摘要的标题／目录轻量搜索。唯一行为定义见 architecture.md。

已浅克隆两个官方仓库，未安装依赖或运行其服务：

| 仓库 | 本地目录 | 核对版本 |
| --- | --- | --- |
| [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) | `C:\Users\yangqi\code\references\kimi-code` | `fb0353a8ba5ceb7e8ae4e27f3260b3c8c8d80784` |
| [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) | `C:\Users\yangqi\code\references\kimi-cli` | `86f136422a0aae6b217ea49e7ea1d2e8a1defcd2` |

新版的 Web 参考来自仓库内构建产物，并非可读的原始组件源码。`apps/kimi-code/dist-web/assets/index-CiHMlsuo.js` 中可核对：

- `kimi-web.pinned-sessions` 保存置顶身份；pin/unpin 独立于任务运行状态。
- `Jle` 将会话拆为 pinned/unpinned；workspaceGroups 按工作区构造项目会话，排除置顶项。
- `SessionRow` 在同一行根据 busy、pendingInteraction、unread 等信息区分运行、需回应及未读，不另复制一份活动会话。

旧版有可读的 [sessions.tsx](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/web/src/features/sessions/sessions.tsx)：按 workDir 分组、文件夹名展示、完整路径提示、折叠组和目录内新建入口。旧版结构与截图并非完全相同，不据此宣称截图版本使用同一组件。


归档与删除研究：旧 kimi-cli 的 `src/kimi_cli/web/api/sessions.py` 以 PATCH 修改 archived 状态，DELETE 停止会话进程并删除会话目录；新版 kimi-code 的 `packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts` 归档保留数据但清理 Agent，delete 删除会话目录、索引及文件历史记录。两个版本对运行中归档的实现不同，不能直接移植。ArcaneDesk 的确定规则见唯一技术方案：未结束任务禁止归档。
