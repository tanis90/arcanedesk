---
name: arcane-world-create
description: 在奥法地图（mt compat）大厅从空白创建战役/世界，不使用 Foundry 世界 ZIP。用户说“新建世界”“创建战役”“开一个空白团”时使用；导入现有世界 ZIP 改用 arcane-world-import。
---

# 从空白创建奥法战役

这里调用 Map 自己的 `lobbyCampaignCreate` 轻量 action。Desk 的世界导入工具不参与，不能把创建空白战役写成上传空 ZIP。

## 创建前边界

先按 `arcane-mt-lobby` 确认大厅页面、导航与通用写入原则。本 skill 只增加三项创建特有边界，不额外追问：

1. 规则选择：先用 `foundry_lobby_rulesets_list` 读取当前支持的规则并让用户明确选择；创建后不可改，不替用户决定。
2. 登录：未登录时让用户在右侧面板自行登录，不收账号密码。
3. 创建审批：沿用 App 现有写审批，拒绝即零写入。

战役名使用用户提供的名称；未起名时用“未命名战役”并在报告里说明可后续改名，不为此多问一次。

## 创建流程

1. 先用 `foundry_lobby_campaigns_list` 读取已有战役，避免重名重复创建，并保留已有 id 供异常对账。已经存在同名战役时默认报告现有战役，不重复创建。
2. 调用 `foundry_lobby_rulesets_list`，让用户从真实返回项中选择 `id`；不在列表中的规则不创建。
3. 查询 Map 的操作声明，确认它是允许通用调用的轻量 action，并读取参数 schema 和示例：

   ```js
   foundry_api_search({
     query: "创建战役",
     prefix: "lobbyCampaignCreate",
     kind: "action",
     limit: 1,
   })
   ```

   必须找到 `id="lobbyCampaignCreate"`、`kind="action"` 的操作。`job`、`workflow` 或 `ACTION_UNKNOWN` 都不能用通用调用硬试；旧 Map 缺少 `apiOperationSearch` 时报告版本缺口，不改成裸 REST 或页面 eval。

4. 使用 Map 操作 id 和 JSON 参数创建：

   ```js
   foundry_api_call({
     id: "lobbyCampaignCreate",
     args: { name: "渡鸦岭", ruleset: "2024" },
   })
   ```

   `foundry_api_call` 只接受 Map 的轻量同步 JSON action，不接受 Desk 工具名、JavaScript、文件或导入任务。
5. 成功后检查 `status:"completed"`、战役 `id/name/ruleset` 和 `playUrl`，再用 `foundry_lobby_campaigns_list` 回读同一战役。CoC 等规则若被 Map 的创建门禁拒绝，照实报告，不绕过可用性检查。

## 异常与完成

- `partial`、`CAMPAIGN_CREATE_PARTIAL` 或 `JOB_INDETERMINATE` 不重放。用创建前的战役 id 清单和当前列表对账；部分回执带 `campaignId` 时以该 id 查询，不能只凭名称猜创建结果。
- 创建成功但封面或规则落档等后续步骤失败时，保留已有战役并报告未完成项，不删除、不重建。
- 从原战役来且不进入新战役时，用保留的 `returnPlayUrl` 调用 `foundry_open` 返回；用户明确要求进入新战役时才打开返回的 `playUrl`。
- 最终报告战役名、规则、id、`playUrl` 和未完成项。只有回读确认存在才称创建完成。

## 与导入的边界

- 本地 Foundry 世界 ZIP 或合集 ZIP 是长程异步导入，转 `arcane-world-import` / `arcane-mt-packs`，始终使用对应的 start/job 专用工具，不走 `foundry_api_call`。
- 地图图片、场景 JSON、UVTT 等场景导入转 `arcane-scene-import`，不从空白战役名称反推场景创建方式。
