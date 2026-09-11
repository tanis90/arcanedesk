---
name: arcane-content-catalog
description: 在 Foundry 中需要查找职业、子职、法术、特性、装备或来源 UUID 时使用内容 catalog 工具。
---

# Foundry 内容目录

本 skill 只负责发现来源，不负责写入 Actor。需要精确来源时，先用
`foundry_content_search` 或 `foundry_content_list`，再用 `foundry_content_detail` 读取将要导入的完整文档。

- 模糊名称使用 `foundry_content_search`，始终传入准确的 `type` 和 `scope`；已知来源时传 `packIds`。
- 规则定义的职业成长使用 `foundry_content_list`，传小写 `class`、`subclass` 和 `characterLevel`。
- 每个将被导入且包含 uses、activities、effects 或完整规则文本的 UUID 都必须调用 detail。
- `classEligible`、`levelEligible`、`subclassGranted` 分开判断，不能把搜索命中直接当成授予结果。
- 查询失败时修正参数或报告未解析来源，不能凭名称或记忆猜测 UUID。

查询完成后，把来源 UUID 交给 `arcane-actor-update` 执行写入。技能属性默认由 dnd5e 初始化；不要在目录查询阶段猜测或覆盖
`system.skills.<key>.ability`。
