# 交互减负实施与验收

日期：2026-09-08。范围：0.4.3 差异评审中确定的六项优先问题。未修改用户的 tmp-signing 目录，未推送、发布安装包或更改用户模型配置。

| 功能 | 最终行为 | 自动化证据 |
| --- | --- | --- |
| 归档提示 | “已归档 · 撤销”默认 5 秒消失，无 ×；鼠标或键盘焦点停留时延后 | activity smoke 验证自动消失且不抢输入焦点；production sidebar 验证撤销和重启恢复 |
| 后台进展 | 去掉顶部通知横条，保留会话标记与已启用的系统通知 | activity smoke 验证后台完成不改当前会话、草稿和焦点；跨模式提问与通知目标仍正确 |
| 阅读新进展 | 与回到底部合成一个按钮，位于消息区底部，不覆盖输入框 | activity smoke 验证未读标记、点击到最新、边界位置；history smoke 验证分页、锚点与附件 |
| 普通同步 | 缓存先显示，正常校准静默；慢于 1 秒或失败才提示 | conversation smoke 验证缓存静默、慢同步反馈、迟到请求与草稿隔离 |
| 错误展示 | 默认简述，原文纯文本折叠；模型失败保留在分页历史，正常停止不生成错误消息 | activity/conversation smoke 验证折叠、展开、刷新与 HTML 不执行；history-index 单测验证错误历史 |
| Foundry 连接失败 | 自动重试一次后，错误显示在右侧；Agent 成功打开替换错误页；刷新保留原 URL | panel-ui smoke 用生产 main、真实 Electron 页面及本地 HTTP 服务验证拒绝连接两次、恢复、再次失败和恢复，无模型调用 |

验证结果：全量 425 项单测通过；源码边界与 TypeScript 检查通过；activity、conversation、history、生产 sidebar／第二进程重启、panel-ui 交互回归通过。最后截图检查发现向下按钮覆盖输入区，修正后通过 activity 回归和位置断言。截图位于 interaction-evidence 与 navigation-evidence。自动化使用隔离配置、受控模型和本地测试页面；没有将测试回调或截图等同于操作系统物理点击。

本轮实际桌面验收表见 [manual-interaction-priority.md](manual-interaction-priority.md)。原有托盘与系统通知的真实送达验收仍以原人工表为准。
