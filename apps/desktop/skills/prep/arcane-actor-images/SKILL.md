---
name: arcane-actor-images
description: 在 Foundry 世界里新建或修改人物（Actor、角色、NPC）时同步维护角色卡头像与地图 token 图像。创建人物、给人物配图、发现 token 拖上地图没有头像、补 token 图或批量修正人物图像时使用。
---

# 人物头像与 Token 图像同步

Foundry 里「角色卡上的头像」和「拖进地图的 token 图像」是互不联动的字段：只设头像，token 会显示默认的神秘人剪影。凡是创建人物或修改人物图像，两个位置必须一起设置、一起回读验证，不允许只改其一。

## 字段位置（V13）

- `actor.img` — 角色卡和 Actor 目录里显示的头像。
- `actor.prototypeToken.texture.src` — 之后新拖入场景的 token 默认图像。
- 动态 token 环：`prototypeToken.ring.enabled` 为 true 时，token 画面主体取自 `prototypeToken.ring.subject.texture`，必须与上面两个字段一起设置（通常同一张图）。

## 创建人物时的默认动作

1. 用户没有分别提供头像图和 token 图时，三个字段用同一张图；用户分别提供时分别设置，并向用户确认哪张图用在哪。
2. 图片文件先落进世界 Data 目录内（如 `worlds/<世界id>/assets/`)，字段写世界内相对路径；禁止引用本机绝对路径或临时目录——迁移世界、换机器后图会全丢。
3. 写入后逐个回读 `img`、`prototypeToken.texture.src`（环启用时含 `ring.subject.texture`），并确认路径指向的文件真实存在。

## 已在场景里的存量 token

改 `prototypeToken` 只影响之后放置的 token，不会改已放置在场景里的。修正存量：遍历相关 Scene 的 token 文档，把属于该人物的 token 的 `texture.src`（环启用时含 `ring.subject.texture`）一并更新，或让用户删除后重拖。所有写调用 await 并回读验证。

## 验收

1. 角色卡 / Actor 目录显示头像。
2. 新拖一个 token 到场景，显示正确图像。
3. 场景中该人物已有的 token 图像已同步。
