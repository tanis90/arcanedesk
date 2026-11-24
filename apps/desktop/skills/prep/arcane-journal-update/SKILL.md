---
name: arcane-journal-update
description: 在 Foundry 或奥法地图（mtcompat play）中创建、编辑冒险日志、调查记录、DM 笔记、玩家 handout 或 JournalEntry 文字页/插图页时使用。用户说“帮我写一条日志”“记录这次调查”“给玩家一份手记”时使用。
---

# 日志与 Handout

这里处理的是世界里的 **JournalEntry / JournalEntryPage**，不是聊天消息或系统操作审计日志。当前没有 `foundry_journal_create/update`，不要虚构工具；用原生 Document API 完成，并用实际 UUID 和回读证明结果。

## 页面与交互预算

- 自有提问为 0：用户已经给标题和正文就直接写；明确要求润色、补写或创作时可直接完成，不为文风反复追问。登录与写操作审批沿用 App 既有流程。
- 先用 `world_status` 确认 ready 游戏页和 GM 身份。大厅、登录页和玩家账号不做日志写入。
- 用户没说明可见范围时，默认按 DM 私有处理；只有明确给玩家的 handout 才设置 `ownership: { default: 2 }`（Observer）。已有日志的权限不被静默扩大。
- 用户给的是事实记录时，不补造剧情、线索、NPC 对话或调查结果。用户要求创作/润色时才发挥，并保持已有事实不变。

## 创建一条文字日志

使用 `foundry_page_eval` 一次创建 JournalEntry 和**一个**文字页：

```js
foundry_page_eval({
  code: `const journal = await CONFIG.JournalEntry.documentClass.create({
    name: "教堂调查记录",
  });
  const pages = await journal.createEmbeddedDocuments("JournalEntryPage", [{
    name: "第一次调查",
    type: "text",
    text: { content: "<p>我们在祭坛后发现了被移动过的暗门。</p>" },
  }]);
  return { journalUuid: journal.uuid, pageUuid: pages[0]?.uuid };`,
})
```

正文只使用简单段落、标题、列表、引用和表格等必要 HTML。不要写脚本、事件属性、iframe 或外部跟踪资源；不要把密码、token 或无关隐私写进日志。

**多页必须循环单页创建**，不要一次向 `createEmbeddedDocuments` 传多页。每个页面都要有明确 `name` 和 `type:"text"`。给玩家的 handout 在 JournalEntry 创建参数中加 `ownership: { default: 2 }`。

## 编辑已有日志

1. 用 `fromUuid` 读取真实 JournalEntry 和目标页，确认不是合集条目或错误文档。
2. 只更新用户指定的标题、正文、图片或权限，保留其它页面、图片、文件夹和未提及字段。不要整份覆盖 `toObject()` 后回写。
3. 回读目标页的 `uuid/name/type/text.content/ownership`，报告实际改动。`partial/indeterminate` 不自动重放，先按 UUID 对账。

如果要追加一页，仍按“一次一页”的方式创建，不改写其它页面。删除页面属于独立破坏性操作，必须先取得用户对删除范围的明确确认。

## 图片与插图页

- 创建 `type:"image"` 的页面后，把返回的 `pageUuid` 交给 `foundry_image({ sourcePath, targetUuid })`，由工具上传并设置 `src`。
- 文字页中插图使用 `foundry_image` 上传后返回的 `dataPath` 写简单 `<img>`，不要用 `foundry_image` 覆盖文字页正文。私有 URL 的显示由页面换签处理，不把签名 query 写进文档。
- 只为用户点名或语义需要的页面配图，不为了“有图”而随意找无关图片。人物头像的选择规则归 `arcane-actor-update`，地图归 `arcane-scene-import`。

## 完成标准

- 报告 `journalUuid` 与相关 `pageUuid`，以及实际标题、页名、类型和玩家可见性。
- 创建后读回确认页面真实存在、正文或图片地址正确；不凭工具未报错就宣称完成。
- 不把操作审计日志、聊天消息或模型生成文本当作已落库的 JournalEntry。
