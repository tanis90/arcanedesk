---
name: arcane-mt-lobby
description: 在奥法地图（mt compat）大厅创建或管理战役、导入世界、管理合集包，或需要区分 Map API 与 Desk 工具、action/workflow/job 时使用。大厅写入前必读；具体字段和流程再加载对应专项 skill。
---

# 奥法地图大厅操作总则

本 skill 只负责大厅的共同路由与安全边界，不替代各专项的参数和回执说明。**任何大厅动作前必须先读取本文件，不能只读专项 skill 就开始调用工具。**

当前已经是 mtcompat 大厅或游戏页时，优先复用当前 URL 的 origin（包括内部 dev 部署）；只有没有现成页面时才使用公共主入口，不要把默认域名当成必须重新打开的目标。

## 先加载正确的专项

| 用户目标 | 执行类型 | 下一步 |
|---|---|---|
| 从空白创建战役/世界 | Map 轻量 action | `arcane-world-create` |
| 上传 Foundry 世界 ZIP | 长程 job | `arcane-world-import` |
| 上传/替换合集 ZIP、管理个人内容包或战役选包 | 通用 action、文件 workflow 与长程 job | `arcane-mt-packs` |
| 导入地图图片、场景 JSON 或 UVTT | 文件 workflow | `arcane-scene-import` |
| 在游戏页处理人物、物品、日志等文档 | 对应领域 skill + Map 声明面 | 先查对应 `apiSurface` 前缀 |

## 页面与登录

- 使用 `foundry_open` 进入或复用受信大厅。未登录时让用户在右侧面板自行登录，不收账号密码、验证码或 token。
- 当前在游戏页而任务必须进大厅时，先说明会暂时离开，再调用 `map_lobby_return({})` 并保留真实 `returnPlayUrl`；完成后按用户目标回到原战役或打开新战役。
- `lobby.html` 与 `/auth/**` 不调用 `world_status`、`map_page_eval` 或 `foundry_screenshot`，不改成裸导航、裸 REST 或页面脚本。

## 能力发现与执行分流

1. **先使用当前已激活的 Desk 工具**。模型工具列表和 `activatedTools` 是 Desk 自己的能力发现，不把 Desk 工具名写进 Map 的声明。
2. 没有合适的 Desk 工具时，用 `map_api_search` 查询 **Map 自有 API**。`map_api_call` 只接 Map 的轻量、同步、JSON action，不接 JavaScript、文件、Desk 工具名或任意 action 名。
3. `workflow` 和 `job` 不走通用 `map_api_call`：文件 workflow 走对应专用工具，长程 job 走对应的 start/status/cancel。收到 `OPERATION_KIND_UNSUPPORTED` 时不硬试、不换 eval。
4. 游戏页的原生 Foundry 兼容面先查对应 `apiSurface` 前缀，再使用 `map_page_eval` 并读取 `touched/missing`；声明条目不是 Desk 工具名，也不是通用调用许可。

## 写入原则

- 空白创建和世界 ZIP 导入前，先用 `map_api_call({ id: "lobbyRulesetsList", args: {} })` 读取真实规则并让用户明确选择；创建后不可改。合集包上传不套用规则选择。
- 写操作沿用 App 现有审批；拒绝即零写入。先查同名、已有 id、revision 或 readRef，避免重复创建与陈旧写入。
- 成功后按实际类型回读：战役看 id/ruleset/playUrl，job 看 phase/progress/failureCount，合集与选包看 revision 和实际 refs。
- `partial/indeterminate` 不重放，先按已有 id、jobId、批次或 revision 对账；部分成功不删除、不重建，除非用户明确指定清理范围。
- 最终报告实际完成的文档、链接、权限和未完成项，不把“已发起”“已上传”或“审批通过”当成任务全部完成。
