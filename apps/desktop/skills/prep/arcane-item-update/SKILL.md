---
name: arcane-item-update
description: 在 Foundry 或奥法地图（mtcompat play）中复制合集物品、创建自定义世界 Item（装备/武器/法术/特性）、给已有物品换图，或需要区分“创建世界 Item”和“把物品授予 Actor”时使用。来源查找配合 arcane-content-catalog，人物授予配合 arcane-actor-update。
---

# 物品（Item）创建与更新

先分清目标：**世界里独立存在的 Item**，还是 **某个 Actor 身上的一件物品**。两者不是同一个操作。

## 页面与交互预算

- 自有提问为 0：能复用合集来源就不自建；缺少自定义字段时保留来源默认值并在报告里说明，不凭记忆编字段。登录与写操作审批沿用 App 既有流程。
- 先用 `world_status` 确认 ready 游戏页与 GM 身份。大厅、登录页和玩家账号不做物品写入。
- 发现来源用 `arcane-content-catalog` 的 `foundry_compendium_browse`；确需按名称兜底用 `foundry_content_search`。不要猜 UUID，不要拿世界 Item 当 compendium Item。

## 已有合集物品：授予 Actor 用 typed 工具

`foundry_actor_grant_items` 只负责把**已存在的合集 Item**授予 Actor，不会在世界物品目录创建独立 Item。

```js
foundry_actor_grant_items({
  actorUuid: "Actor.<id>",
  readRef: "<foundry_actor_get(include:['items']) 的返回值>",
  items: [{
    uuid: "Compendium.<pack>.Item.<entry>",
    expectedName: "<照抄 browse 返回的 name>",
    expectedType: "weapon",
    quantity: 1,
  }],
})
```

授予前读取 Actor 的 `items` 投影；同来源已存在时回执记 `skippedExisting`，不叠加、不替换。装备或整批起始物品优先随 `foundry_actor_advance` 的 `additionalItems` 一次落地。

## 世界 Item 创建：当前没有独立 typed 工具

没有 `foundry_item_create`，不要虚构这个调用，也不要用 `foundry_actor_grant_items` 冒充世界创建。

优先复用合集文档并改名/做有限自定义：

1. 用 browse 找到精确合集 UUID，读取完整来源文档。
2. 在 ready 游戏页走原生 Document API：Foundry 用 `browser_evaluate`；mtcompat 先用 `map_api_search({ prefix: "game.items" })` 读取声明面，再用 `map_page_eval` 并读取 `touched/missing`。复制来源数据，去掉原 `_id` 与不适用于目标世界的目录归属，再创建世界 Item；保留来源类型和未明确要求修改的字段。
3. 回读新 Item 的 `uuid/name/type/system`，以及与任务相关的 `activities/effects`。只完成创建不等于规则自动化已经可用；来源缺失、字段不兼容或执行能力未知要照实报告。
4. 需要给 NPC/PC 使用时，另走 `foundry_actor_grant_items`（合集来源）或原生嵌入 Item 路径，并核对实际归属，不把“世界已创建”当成“Actor 已持有”。

自定义规则字段没有可靠来源时，不从物品名称猜结构。只改用户明确要求的字段；`partial/indeterminate` 不自动重放，先按 UUID 对账。

## 物品图片：使用 foundry_image

已有世界 Item（含 Actor 的嵌入 Item）换图时，不需要重写物品数据：

```js
foundry_image({
  sourcePath: "assets/sun-sword.png",
  targetUuid: "Item.<world-item-id>",
})
```

嵌入 Item 使用完整 UUID，如 `Actor.<actorId>.Item.<itemId>`。工具内部上传并更新 `img`，返回的 `dataPath` 可复用；私有地址的读取由页面换签处理。合集目标不直接改写，先复制到世界再换图。人物头像和 Token 图仍归 `arcane-actor-update`，场景背景归 `arcane-scene-import`。

## 验收边界

- 报告实际完成的是世界 Item、Actor 嵌入 Item，还是仅发现来源；给出 UUID 和来源。
- 图片看 `dataPath` 与文档步骤，写入失败不重复上传。
- 不把合集物品默认字段当作自定义规则已验证，也不把物品卡可显示当作自动化可执行。
