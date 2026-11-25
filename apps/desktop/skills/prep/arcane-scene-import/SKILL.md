---
name: arcane-scene-import
description: 在奥法地图（mtcompat play）中导入地图或创建/更新场景，包括 Foundry 场景 JSON、Dungeondraft/Universal VTT（.dd2vtt/.uvtt/.df2vtt）、纯 PNG/JPEG/WebP 图片，以及“图片+JSON 一次上传地图”时使用。
---

# 奥法地图场景导入

`map_scene_import` 是三种地图来源的统一入口。工具内部完成有界读取、图片解码与上传、原生解析、场景写入和回读；你只传备团目录内的文件路径，不接触 Base64，不逐段拼墙灯。

## 页面与交互预算

- 自有提问为 0：格式、尺寸、文件名和默认网格由工具或来源决定；登录与写操作审批沿用 App 既有流程。
- 先用 `world_status` 确认 ready 的 mtcompat `play.html` 和 GM 身份。大厅、登录页、普通 Foundry 或玩家账号不走本工具。
- 只处理用户点名或备团目录内的文件。用户明确给出目录外文件时，先复制到本次任务专用的 cwd 子目录，禁止覆盖，核对字节数和 SHA-256 后传副本；不扫盘、不复制无关文件、不用 shell 上传。

## 三种来源怎么选

| 来源 | 调用方式与结果 |
|---|---|
| Foundry 场景 `.json`（≤10 MiB） | 原生导入墙、灯、网格、尺寸等内容。可用 `backgroundSourcePath` 同时传本地背景图（≤32 MiB），也可沿用 JSON 内的裸 HTTPS 背景。 |
| Universal VTT `.dd2vtt/.uvtt/.df2vtt`（≤32 MiB） | 使用文件自己的 `resolution`、内嵌图片、墙体和门窗。不要另传背景，网格来自文件。 |
| 纯 `.png/.jpg/.jpeg/.webp`（≤32 MiB） | 上传并应用背景，以真实图片像素作为场景宽高，offset=0、scale=1；换图会重置旧旋转元数据。没有墙灯，也不会从图片猜网格。 |

扩展名决定分流；不要把 JSON 改名成图片，或把图片改名成 `.dd2vtt`。`backgroundSourcePath` 只允许搭配 Foundry JSON。

## 正面示例

Dungeondraft / Universal VTT，一次完成内嵌图上传与场景导入：

```js
map_scene_import({
  operation: "create",
  sourcePath: "maps/church.dd2vtt",
})
```

Foundry JSON 和独立背景图一次提交：

```js
map_scene_import({
  operation: "create",
  sourcePath: "maps/church.json",
  backgroundSourcePath: "maps/church.jpg",
})
```

只有一张图片，并已知每格像素与距离：

```js
map_scene_import({
  operation: "create",
  sourcePath: "maps/church.jpg",
  name: "教堂",
  grid: { type: 1, size: 150, distance: 5, units: "ft" },
})
```

`name` 只用于纯图片 create；省略时使用文件名。`grid` 只用于纯图片，update 未提供时保留原网格。不知道每格像素时省略 `grid`，使用系统/原场景默认并在报告中说明，后续在原生画布对齐，不猜数值。`type` 使用当前系统支持的网格类型，`size`/`distance` 必须为正数。

## 更新已有场景

先读真实场景拿 `readRef`，再导入。create 不需要 `sceneUuid/readRef`。

```js
foundry_scene_get({
  sceneUuid: "Scene.<id>",
  include: ["walls", "lights"],
})

map_scene_import({
  operation: "update",
  sceneUuid: "Scene.<id>",
  readRef: "<上一步返回值>",
  sourcePath: "maps/church.dd2vtt",
})
```

读取后场景内容发生并发变化时，`READ_REF_STALE` 是零写入；重新读取再决定，不用旧引用重试。纯图片 update 会更新背景与像素尺寸，未传 `grid` 时保留原网格；改场景名用 `foundry_scene_apply`，不在图片 update 里传 `name`。

## 回执与失败处置

- 成功回执看 `format/sceneUuid/dataPath/stats/verification`：格式、场景 UUID、持久图片地址、墙灯或 UVTT 门窗统计、尺寸和网格必须与实际任务一致。持久引用保持无签名，私有桶显示经页面换签，不把签名 URL 写回文档。
- `completed` 才表示导入落定；`partial/indeterminate` 不自动重放，先用 `foundry_scene_get` 对账。图片上传成功而导入失败时，保留回执中的 `dataPath` 供人工复核，不重复上传。
- `SCENE_FORMAT_UNSUPPORTED`、`SCENE_SIZE_INVALID`、`IMAGE_DECODE_FAILED` 或格式组合错误时修正输入，不改扩展名绕过。
- 旧 App/runtime 不认识多格式导入时报告版本缺口，不退回 `browser_evaluate` 或 `map_page_eval` 手搓场景。
- 头像、物品图、Token 图和富文本图片仍用 `foundry_image`，不要用场景导入替代。Token 放置和小范围场景元数据修改才用 `foundry_scene_apply`。
- 场景导入是带文件处理和专门回执的 workflow，始终用 `map_scene_import`，不走通用 `map_api_call`。
