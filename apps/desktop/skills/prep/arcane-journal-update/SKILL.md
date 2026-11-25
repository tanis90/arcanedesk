---
name: arcane-journal-update
description: 在 Foundry 或奥法地图（mtcompat play）中创建、续写或修改冒险日志、调查记录、DM 笔记和玩家 handout，包括 JournalEntry 的 HTML 文字页与插图页。用户说“帮我写一条日志”“记录这次调查”“续写这篇笔记”“给玩家一份手记”时使用。
---

# 日志与 Handout

这里处理世界里的 **JournalEntry / JournalEntryPage**，不是聊天消息或操作审计日志。当前没有结构化日志写入工具，使用原生 Document API，并以真实 UUID 和回读结果验收。

## 页面、运行时与默认范围

- 先用 `world_status` 确认 ready 游戏页和 GM 身份。大厅、登录页和玩家账号不做日志写入。
- mtcompat 使用 `map_page_eval`，读取 `touched/missing` 注记；原生 Foundry 使用 `browser_evaluate`，传入一个异步 IIFE 表达式，不使用顶层 `return`。
- 在 mtcompat 写原生日志 API 前，先调用 `map_api_search({ prefix: "game.journal" })`，读取 `surface.entries` 中的状态和 `note/use`，再按 Document API 示例执行。不要查 `JournalEntry` 或 `CONFIG.JournalEntry` 后把空结果当成不支持。
- 不为文风、排版或默认可见性追问：已有标题和正文就直接写，要求润色或创作时直接完成。续写或修改的目标无法唯一确定时，不猜文档、不写入，报告需要的具体目标。
- 默认创建 DM 私有日志；只有明确给玩家的 handout 才在 JournalEntry 上设置 `ownership: { default: 2 }`（Observer）。已有日志的权限不被静默扩大。Observer 表示玩家可查看，不等于已经在玩家屏幕弹窗展示。
- 用户给的是事实记录时，不补造剧情、线索、NPC 对话或调查结果。用户要求创作或润色时才发挥，并保持已有事实不变。

## 正文使用 HTML

`text.content` 是 HTML 字符串。根据内容使用段落、标题、加粗、列表、引用或表格，不用 Markdown 代替 HTML，也不要给短记录强套长模板。例如：

```html
<h2>教堂调查</h2>
<p>我们在祭坛后发现了<strong>被移动过的暗门</strong>。</p>
<ul>
  <li>暗门通往地下室</li>
  <li>门后留有拖拽痕迹</li>
</ul>
<blockquote>“今晚不要靠近钟楼。”</blockquote>
```

只使用必要的排版标签和属性，不写脚本、事件属性、iframe 或外部跟踪资源，不写入密码、token 或无关隐私。

## 创建文字日志：mtcompat

创建前按名称查询，避免重复创建；用户要求续写时转入后面的编辑流程。以下示例创建一个 JournalEntry 和一个文字页：

```js
map_page_eval({
  code: `const content = [
    "<h2>调查发现</h2>",
    "<p>我们在祭坛后发现了<strong>被移动过的暗门</strong>。</p>",
    "<ul><li>暗门通往地下室</li><li>门后留有拖拽痕迹</li></ul>",
  ].join("\\n");
  const journal = await CONFIG.JournalEntry.documentClass.create({
    name: "教堂调查记录",
  });
  const pages = await journal.createEmbeddedDocuments("JournalEntryPage", [{
    name: "第一次调查",
    type: "text",
    text: { content },
  }]);
  return {
    journalUuid: journal.uuid,
    pageUuid: pages[0]?.uuid,
    content: pages[0]?.text?.content,
  };`,
})
```

给玩家的 handout 只在 JournalEntry 创建参数中增加 `ownership: { default: 2 }`，不为正文另造权限字段。

**多页必须循环单页创建**，每次向 `createEmbeddedDocuments` 传一页。每页都有明确的 `name` 和 `type`。

## 创建文字日志：原生 Foundry

同样的 Document API 在 `browser_evaluate` 中必须作为异步 IIFE 表达式执行：

```js
browser_evaluate({
  code: `(async () => {
    const content = "<h2>调查发现</h2><p>我们发现了<strong>被移动过的暗门</strong>。</p>";
    const journal = await CONFIG.JournalEntry.documentClass.create({
      name: "教堂调查记录",
    });
    const pages = await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name: "第一次调查",
      type: "text",
      text: { content },
    }]);
    return {
      journalUuid: journal.uuid,
      pageUuid: pages[0]?.uuid,
      content: pages[0]?.text?.content,
    };
  })()`,
})
```

## 续写与编辑

1. 用 `fromUuid` 读取真实 JournalEntry 和目标页，确认不是合集条目或错误文档。
2. 续写时保留旧 HTML，在其后追加新段落；修改时只更新用户指定的标题、正文、图片或权限。正文用 `page.update({ "text.content": updatedHtml })` 做字段级更新，不整份覆盖 `toObject()`，不改其它页面。
3. 追加一页仍按单页创建执行，不重写已有页面。删除页面是独立破坏性操作，必须先取得用户对删除范围的明确确认。
4. 回读 JournalEntry 的名称、权限和目标页的 `uuid/name/type/text.content`，报告实际改动。`partial/indeterminate` 不自动重放，先按 UUID 对账。

## 图片与插图页

- 创建 `type:"image"` 的页面后，把返回的 `pageUuid` 交给 `foundry_image({ sourcePath, targetUuid })`，由工具上传并设置 `src`。
- 文字页插图先用不带 `targetUuid` 的 `foundry_image` 上传，再把返回的持久 `dataPath` 写入简单 `<img>`；不要把文字页当图片页覆盖。私有 URL 由页面换签显示，不把签名 query 写进文档。
- 只为用户点名或内容需要的页面配图。人物头像归 `arcane-actor-update`，地图归 `arcane-scene-import`。

## 完成标准

- 报告 `journalUuid`、相关 `pageUuid`、实际标题、页名、类型和玩家可见性。
- 回读确认页面真实存在，HTML 正文或图片地址正确，未要求的页面、权限和图像保持不变。
- 不把模型生成的文字当作已落库日志，也不把 Observer 权限当作已向玩家弹窗展示。
