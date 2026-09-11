// markdown.js 的笔记路径识别与 fence 注册表(md-reader-spec §4.2 / §6 / §9)。
//
// 这两处是"点得开笔记"的唯一判据:识别错了,用户点进去只看见错误页却看不出原因;
// fence 表错了,mermaid 会退回源码块而没人发现。所以按 §9 跑全形态,含负例。
import assert from "node:assert/strict";
import test from "node:test";

import { descendants, loadMarkdownPipeline } from "./fixtures/mini-dom.mjs";

/** 只取路径与偏移,断言里少写噪音。
    Array.from 把结果拉回宿主 realm:vm 里的数组原型不同,deepStrictEqual 会当成不相等。 */
function pathsOf(text) {
  const { arcaneMd } = loadMarkdownPipeline();
  return Array.from(arcaneMd.findNotePaths(text), (hit) => hit.path);
}

function hitsOf(text) {
  const { arcaneMd } = loadMarkdownPipeline();
  return Array.from(arcaneMd.findNotePaths(text));
}

// ---------- §4.2 覆盖形态 ----------

test("bare note paths are recognised in every documented shape", () => {
  assert.deepEqual(pathsOf("notes/npc.md"), ["notes/npc.md"]);
  assert.deepEqual(pathsOf("./npc.md"), ["./npc.md"]);
  assert.deepEqual(pathsOf("../shared/npc.md"), ["../shared/npc.md"]);
  assert.deepEqual(pathsOf("npc.markdown"), ["npc.markdown"]);
  assert.deepEqual(pathsOf("/home/dm/campaign/npc.md"), ["/home/dm/campaign/npc.md"]);
  assert.deepEqual(pathsOf("C:\\Users\\dm\\npc.md"), ["C:\\Users\\dm\\npc.md"]);
  assert.deepEqual(pathsOf("C:/Users/dm/npc.md"), ["C:/Users/dm/npc.md"]);
  assert.deepEqual(pathsOf("深窟/三层/守门人.md"), ["深窟/三层/守门人.md"]);
});

test("a line suffix is stripped, not followed", () => {
  assert.deepEqual(pathsOf("notes/npc.md:42"), ["notes/npc.md:42"]);
  assert.deepEqual(pathsOf("notes/npc.md:42:7"), ["notes/npc.md:42:7"]);
  // 交给 main 的规范化那一步剥行号(md-reader-note.normalizeNotePath),锚点保留原样
  const [hit] = hitsOf("见 notes/npc.md:42 那段");
  assert.equal(hit.path, "notes/npc.md:42");
  assert.equal("见 notes/npc.md:42 那段".slice(hit.start, hit.end), hit.path, "offsets must slice back to the path");
});

test("a dangling colon after the extension rejects the whole match", () => {
  // 行号组回溯掉之后,边界必须连 ":" 一起拒绝,否则 a.md:12x 会链成 "a.md" + 悬空 ":12x"
  assert.deepEqual(pathsOf("a.md:12x"), []);
  assert.deepEqual(pathsOf("a.md:12"), ["a.md:12"]); // 行号仍含在 path 里,main 侧剥除(v1 不跳转)
  assert.deepEqual(pathsOf("a.md"), ["a.md"]);
});

test("a column suffix followed by junk does not half-linkify either", () => {
  // 行号分支自己的 lookahead 同样要拒绝 ":":a.md:12:34x 回溯后不能留下 "a.md:12" + 悬空 ":34x"
  assert.deepEqual(pathsOf("a.md:12:34x"), []);
  assert.deepEqual(pathsOf("a.md:12:34"), ["a.md:12:34"]); // 完整行:列号照常全量命中
});

test("wrappers and trailing punctuation stay outside the match", () => {
  assert.deepEqual(pathsOf("`notes/npc.md`"), ["notes/npc.md"]);
  assert.deepEqual(pathsOf('"notes/npc.md"'), ["notes/npc.md"]);
  assert.deepEqual(pathsOf("“notes/npc.md”"), ["notes/npc.md"]);
  assert.deepEqual(pathsOf("<notes/npc.md>"), ["notes/npc.md"]);
  assert.deepEqual(pathsOf("打开 notes/npc.md，然后"), ["notes/npc.md"]);
});

test("several paths in one message all come back, in order", () => {
  assert.deepEqual(pathsOf("先读 notes/a.md 再读 notes/b.md"), ["notes/a.md", "notes/b.md"]);
});

// ---------- 负例:认错比不认更糟 ----------

test("lookalikes are left as plain text", () => {
  assert.deepEqual(pathsOf("notes/npc.md.bak"), []);
  assert.deepEqual(pathsOf("notes/npc.mdx"), []);
  assert.deepEqual(pathsOf("notes/npcmd"), []);
  assert.deepEqual(pathsOf(".md"), []);
  assert.deepEqual(pathsOf("notes/"), []);
});

test("a URL is an external link, never a local note", () => {
  assert.deepEqual(pathsOf("https://example.com/notes/npc.md"), []);
  assert.deepEqual(pathsOf("http://127.0.0.1:30000/a.md"), []);
  assert.deepEqual(pathsOf("www.example.com/a.md"), []);
  // 同一段里 URL 与真笔记并存时只认真笔记
  assert.deepEqual(pathsOf("见 https://e.com/x.md 与 notes/real.md"), ["notes/real.md"]);
});

test("prose glued to an ASCII file name is given back", () => {
  const [hit] = hitsOf("详见README.md 的第三节");
  assert.equal(hit.path, "README.md");
  assert.equal("详见README.md 的第三节".slice(hit.start, hit.end), "README.md");
});

test("a CJK file name only links when it stands as its own token", () => {
  // 前面是分隔符:整条路径都是笔记名
  assert.deepEqual(pathsOf("深窟/守门人.md"), ["深窟/守门人.md"]);
  // 独立成词:认
  assert.deepEqual(pathsOf("笔记 守门人.md 已写好"), ["守门人.md"]);
  assert.deepEqual(pathsOf("守门人.md"), ["守门人.md"]);
  assert.deepEqual(pathsOf("（守门人.md）"), ["守门人.md"]);
  // 粘在散文里、又没有 ASCII 名可让回去:宁可不链
  assert.deepEqual(pathsOf("读守门人.md吧"), []);
});

// ---------- 渲染后的锚点形态 ----------

test("rendered paragraphs turn bare paths into keyboard-reachable anchors", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "agent 写好了 notes/npc-张三.md，点开看看。");
  const anchors = [...descendants(container)].filter((node) => node.classList.contains("md-path"));
  assert.equal(anchors.length, 1);
  const anchor = anchors[0];
  assert.equal(anchor.tagName, "A");
  assert.equal(anchor.dataset.mdPath, "notes/npc-张三.md");
  assert.equal(anchor.textContent, "notes/npc-张三.md");
  // 两个宿主页都是 file://,挂 href 一点就把整个 view 导航走,所以故意没有
  assert.equal(anchor.href, undefined);
  assert.equal(anchor.tabIndex, 0);
  assert.equal(anchor.getAttribute("role"), "link");
  const paragraph = container.querySelector("p");
  assert.equal(paragraph.textContent, "agent 写好了 notes/npc-张三.md，点开看看。", "prose around the path survives");
});

test("a markdown link to a note becomes the same anchor, keeping its label", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "[守门人设定](notes/gatekeeper.md)");
  const anchor = container.querySelector("a.md-path");
  assert.ok(anchor, "note link should render as a clickable anchor");
  assert.equal(anchor.dataset.mdPath, "notes/gatekeeper.md");
  assert.equal(anchor.textContent, "守门人设定");
});

test("a percent-encoded note href is decoded before it reaches the opener", () => {
  // agent 常把 CJK 文件名 percent-encode(CommonMark 合法);不解码 main 侧查无此文件
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "[战术](plans/%E6%88%98%E6%9C%AF.md)");
  const anchor = container.querySelector("a.md-path");
  assert.ok(anchor, "encoded href still linkifies");
  assert.equal(anchor.dataset.mdPath, "plans/战术.md");
  assert.equal(anchor.textContent, "战术");
});

test("a malformed percent sequence keeps the href as written", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "[x](plans/%zz.md)");
  const anchor = container.querySelector("a.md-path");
  assert.ok(anchor, "malformed encoding should not drop the link");
  assert.equal(anchor.dataset.mdPath, "plans/%zz.md");
});

test("http links are untouched by the note pass", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "[规则书](https://example.com/rules) 与 notes/a.md");
  const links = [...descendants(container)].filter((node) => node.tagName === "A");
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "https://example.com/rules");
  assert.equal(links[0].classList.contains("md-path"), false);
  assert.equal(links[1].dataset.mdPath, "notes/a.md");
});

test("paths inside a code fence stay source, paths inside inline code link", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "```\ncat notes/secret.md\n```\n\n用 `notes/inline.md` 这个文件。");
  const pre = container.querySelector("pre.md-code");
  assert.equal(pre.querySelectorAll("a.md-path").length, 0, "fence content is source, not an entry point");
  assert.match(pre.textContent, /notes\/secret\.md/);
  const inline = [...descendants(container)].filter((node) => node.tagName === "CODE" && node.parentElement?.tagName !== "PRE");
  assert.equal(inline.length, 1);
  assert.equal(inline[0].querySelector("a.md-path")?.dataset.mdPath, "notes/inline.md");
});

test("rendered math is display, not an entry point: no anchors inside KaTeX output", () => {
  // katex 桩把公式源码原样填进 .md-katex span;公式里的"路径"是公式文本,linkify 不得碰
  const katex = { render: (tex, node) => { node.textContent = tex; } };
  const { container, arcaneMd } = loadMarkdownPipeline({ globals: { katex } });
  arcaneMd.render(container, "公式 $notes/formula.md$ 与正文 notes/prose.md。");
  const math = container.querySelector(".md-katex");
  assert.ok(math, "math renders through the KaTeX path");
  assert.equal(math.textContent, "notes/formula.md");
  assert.equal(math.querySelectorAll("a.md-path").length, 0, "paths inside rendered formulas stay formula text");
  const anchors = [...descendants(container)].filter((node) => node.classList.contains("md-path"));
  assert.deepEqual(anchors.map((node) => node.dataset.mdPath), ["notes/prose.md"], "prose paths still link");
});

test("the reader page produces no anchors it cannot honour", () => {
  // 阅读器页没有 window.arcane.openMdReader:摆一个点了没反应的锚点比纯文本更糟(R5)
  const { container, arcaneMd } = loadMarkdownPipeline({ canOpenNotes: false });
  arcaneMd.render(container, "见 notes/a.md 与 [笔记](notes/b.md)");
  assert.equal(container.querySelectorAll("a.md-path").length, 0);
  assert.match(container.textContent, /notes\/a\.md/);
});

// ---------- §6 fence 渲染器注册表 ----------

test("a mermaid fence goes through the registry", async () => {
  const calls = [];
  const mermaid = {
    initialize: (config) => calls.push(["initialize", config.theme]),
    render: async (id, source) => { calls.push(["render", id, source]); return { svg: "<svg></svg>" }; },
  };
  const { container, arcaneMd } = loadMarkdownPipeline({ globals: { mermaid } });
  arcaneMd.render(container, "```mermaid\ngraph TD; A-->B;\n```");
  assert.ok(container.querySelector("div.md-mermaid"), "registry hit renders the diagram shell");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0]?.[0], "initialize");
  assert.equal(calls[1]?.[0], "render");
  assert.equal(calls[1]?.[2], "graph TD; A-->B;");
});

test("an unregistered fence language keeps the source block", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "```plantuml\n@startuml\nA -> B\n@enduml\n```");
  assert.equal(container.querySelector("div.md-mermaid"), null);
  const box = container.querySelector("div.md-codeblock");
  assert.ok(box, "unknown language falls back to the default code block");
  assert.equal(box.querySelector(".md-codeblock-lang").textContent, "plantuml");
  assert.match(box.querySelector("pre.md-code").textContent, /@startuml/);
});

test("a plain language fence still gets the default block", () => {
  const { container, arcaneMd } = loadMarkdownPipeline();
  arcaneMd.render(container, "```json\n{\"a\":1}\n```");
  assert.ok(container.querySelector("div.md-codeblock"));
  assert.equal(container.querySelector(".md-codeblock-lang").textContent, "json");
});

// ---------- §5.5 文案键:阅读器页的错误分支全靠它们 ----------

test("the reader strings exist in both locales", async () => {
  await import("../src/shared/i18n/messages.js");
  const messages = /** @type {any} */ (globalThis).ARCANE_MESSAGES;
  for (const key of ["reader.back", "reader.close", "reader.error.missing", "reader.error.outside", "reader.error.encoding", "reader.truncated"]) {
    assert.ok(messages["zh-CN"][key], `zh-CN missing ${key}`);
    assert.ok(messages["en-US"][key], `en-US missing ${key}`);
  }
});
