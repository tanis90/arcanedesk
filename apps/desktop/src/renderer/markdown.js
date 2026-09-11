// Markdown 渲染管线(对齐 kimi code web 能力集,不引入 Vue/Worker):
//   KaTeX 占位符保护(跳过代码围栏/行内代码,防 _ * 被 md 吃掉)
//   → marked.lexer 拿 tokens → 递归手工构建 DOM(安全风格:不用 innerHTML;
//     hljs 高亮串与 mermaid SVG 是两个例外,见各自注释)
//   → 代码块 hljs 高亮 + 语言条/复制按钮 → ```mermaid 围栏走 mermaid 渲染。
// 流式 message_delta 仍是纯 textContent,只在定稿时调一次 renderMarkdown。
"use strict";

// classic script 全局作用域防撞(chat.js 也声明了顶层 t):整文件包 IIFE,
// 对外只暴露 window.arcaneMd(与 keycapture.js 同款模式)。
(function () {
  // i18n:head 的 i18n.js 先于本文件加载(同 chat.js 约定)
  const t = window.ArcaneI18n.t;

  // ---------- 小工具 ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- KaTeX 公式:$...$ / $$...$$ 先替换成占位符,DOM 构建时还原 ----------

/**
 * 抽出数学片段换成 %%ARCKATEX_{nonce}_{n}%% 占位符;代码围栏与行内代码里的 $ 不动。
 * 顺带把中文编号 "1、" 归一成 "1. "(旧 markdown-lite 支持,marked 不认)。
 * @param {string} text
 * @returns {{ text: string, math: Array<{ tex: string, display: boolean }> }}
 */
function extractMath(text) {
  // 每次渲染换一个 nonce 并随 math 数组走:正文里字面的 %%ARCKATEX_0%% 是用户文本,
  // 还原时只认本次渲染产出的占位符,不把用户文本错当公式
  const math = /** @type {Array<{ tex: string, display: boolean }> & { nonce: string }} */ ([]);
  math.nonce = Math.random().toString(36).slice(2, 10);
  const lines = String(text ?? "").split("\n");
  const out = [];
  // 围栏追踪与 marked 对齐:~~~ 也是合法围栏;闭合必须与开符同字符、长度 ≥ 开符
  // (```` 围栏里的一行 ``` 是内容)。追踪错了会把代码块里的 $...$ 抽成占位符,
  // 而占位符在代码块里不会被还原,用户就看到 %%ARCKATEX%% 残渣
  let fenceChar = "";
  let fenceLen = 0;
  let seg = [];
  const flushSeg = () => {
    if (seg.length) {
      out.push(scanMathSegment(seg.join("\n"), math));
      seg = [];
    }
  };
  for (const line of lines) {
    const fence = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceChar) {
      // 闭合行上只允许围栏符本身(marked 同样不认 ```js 这种带信息的闭合)
      const closing = fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen
        && !line.trimStart().slice(fence[1].length).trim();
      if (closing) {
        fenceChar = "";
        fenceLen = 0;
      }
      out.push(line);
      continue;
    }
    if (fence) {
      flushSeg();
      fenceChar = fence[1][0];
      fenceLen = fence[1].length;
      out.push(line);
      continue;
    }
    seg.push(line.replace(/^(\s*\d+)、\s*/, "$1. ")); // 中文编号 → CommonMark
  }
  flushSeg();
  return { text: out.join("\n"), math };
}

/**
 * 扫描一段无代码围栏的文本:$$块级(可跨行)、$行内(不跨行)、反引号代码整段跳过。
 * 行内闭合规则对齐 pandoc:开 $ 后非空白;闭 $ 前非空白、后非数字(保护 "价格 $5 和 $10")。
 */
function scanMathSegment(seg, math) {
  let out = "";
  let j = 0;
  const pushMath = (tex, display) => {
    math.push({ tex, display });
    return `%%ARCKATEX_${math.nonce}_${math.length - 1}%%`;
  };
  while (j < seg.length) {
    if (seg.startsWith("\\$", j)) {
      out += "\\$";
      j += 2;
      continue;
    }
    if (seg[j] === "`") {
      let run = 1;
      while (seg[j + run] === "`") run++;
      const ticks = "`".repeat(run);
      const close = seg.indexOf(ticks, j + run);
      if (close === -1) {
        out += seg.slice(j);
        break;
      }
      out += seg.slice(j, close + run);
      j = close + run;
      continue;
    }
    if (seg.startsWith("$$", j)) {
      let close = seg.indexOf("$$", j + 2);
      while (close !== -1 && seg[close - 1] === "\\") close = seg.indexOf("$$", close + 2);
      if (close === -1) {
        out += "$$";
        j += 2;
        continue;
      }
      out += pushMath(seg.slice(j + 2, close), true);
      j = close + 2;
      continue;
    }
    if (seg[j] === "$" && j + 1 < seg.length && !/\s/.test(seg[j + 1])) {
      let k = j + 1;
      let found = -1;
      while (k < seg.length && seg[k] !== "\n") {
        if (seg[k] === "\\") {
          k += 2;
          continue;
        }
        if (seg[k] === "$" && !/\s/.test(seg[k - 1]) && !(k + 1 < seg.length && /[0-9]/.test(seg[k + 1]))) {
          found = k;
          break;
        }
        k++;
      }
      if (found > j + 1) {
        out += pushMath(seg.slice(j + 1, found), false);
        j = found + 1;
        continue;
      }
      out += "$";
      j++;
      continue;
    }
    out += seg[j];
    j++;
  }
  return out;
}

/** 文本节点按占位符切开,命中处插入 KaTeX 渲染结果;只认本次渲染 nonce 的占位符。 */
function appendTextWithMath(container, text, math) {
  const nonce = String(math?.nonce ?? "");
  const pattern = new RegExp(`(%%ARCKATEX_${nonce}_\\d+%%)`);
  for (const part of String(text ?? "").split(pattern)) {
    if (!part) continue;
    const m = new RegExp(`^%%ARCKATEX_${nonce}_(\\d+)%%$`).exec(part);
    if (m && math?.[Number(m[1])]) container.appendChild(renderKatex(math[Number(m[1])]));
    else container.appendChild(document.createTextNode(part));
  }
}

/** 渲染一条公式;katex 缺失或语法错误时原样显示源码,不崩整段。 */
function renderKatex(entry) {
  const tex = entry?.tex ?? "";
  const display = Boolean(entry?.display);
  const raw = display ? `$$${tex}$$` : `$${tex}$`;
  const katex = /** @type {any} */ (window).katex;
  // display 公式:span 提为块级(CSS),超宽横向滚动
  const node = el("span", display ? "md-katex md-katex-display" : "md-katex");
  if (!katex) {
    node.textContent = raw;
    return node;
  }
  try {
    katex.render(tex, node, { displayMode: display, throwOnError: true });
  } catch {
    node.textContent = raw;
    node.classList.add("md-katex-err");
  }
  return node;
}

// ---------- mermaid 图表(```mermaid 围栏 → SVG;库本地加载,不可用/失败退回代码块) ----------

let mermaidSeq = 0; // mermaid.render 要求全局唯一 id

/** mermaid 全局对象(index.html 的本地 <script> 挂在 window 上;加载失败时为 undefined)。 */
function mermaidLib() {
  return /** @type {any} */ (window).mermaid ?? null;
}

/**
 * 渲染一个 mermaid 围栏块:默认显示图,源码折叠在「源码」里(复用 pre.md-code)。
 * 库缺失时直接退回普通代码块;渲染异步进行,失败只影响本块(显示源码 + 一行错误)。
 * @param {HTMLElement} container
 * @param {string} source
 */
function appendMermaidBlock(container, source) {
  const lib = mermaidLib();
  if (!lib) {
    container.appendChild(el("pre", "md-code", source));
    return;
  }
  const root = el("div", "md-mermaid");
  const view = el("div", "md-mermaid-view");
  const details = el("details", "md-mermaid-src");
  details.append(el("summary", null, t("md.mermaidSource")), el("pre", "md-code", source));
  root.append(view, details);
  container.appendChild(root);

  const theme = document.documentElement.dataset.theme === "light" ? "neutral" : "dark";
  const id = `md-mermaid-${Date.now()}-${mermaidSeq++}`;
  (async () => {
    try {
      // suppressErrorRendering:失败时只抛错,不让 mermaid 把错误图插进 document.body
      lib.initialize({ startOnLoad: false, securityLevel: "strict", theme, suppressErrorRendering: true });
      const { svg } = await lib.render(id, source);
      // 例外一:innerHTML 插入 mermaid 输出的 SVG 字符串(securityLevel strict 已 sanitize)
      view.innerHTML = svg;
    } catch (error) {
      view.textContent = "";
      view.appendChild(el("div", "md-mermaid-error", t("md.mermaidFailed", { error: error?.message ?? error })));
      details.open = true; // 失败时直接展开源码
      // 兜底清掉 mermaid 可能已挂到 body 的临时/错误节点,避免残留浮条消不掉
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  })();
}

// ---------- 围栏渲染器注册表(md-reader-spec §6) ----------

/**
 * 按 fence language 查表,命中即渲染,未命中保持源码块(管线缺省行为,无需降级逻辑)。
 * 表挂在渲染管线本体上,所以 chat 气泡与右屏阅读器两处同时生效;
 * 扩展新图类型 = 加一条注册项。只收纯离线渲染器(服务器通道的否决理由见 spec §10)。
 */
const FENCE_RENDERERS = new Map([
  ["mermaid", appendMermaidBlock],
]);

// ---------- .md 路径 → 可点锚点(md-reader-spec §4.2) ----------

/** 页面能不能真的打开笔记:chat 页有 arcane.openMdReader,阅读器页没有(v1 不做笔记间跳转)。
    打不开就不产出可点外观——摆一个点了没反应的锚点比纯文本更糟(design-rules R5)。 */
function canOpenNotes() {
  return typeof /** @type {any} */ (window).arcane?.openMdReader === "function";
}

// 路径分量里的字符:含 CJK(npc-张三.md),排除空白、引号/反引号/尖括号这类包裹符、
// ASCII 标点,以及全角引号与句读——它们在句子里做分隔符比在文件名里出现得多得多,
// 不排除就会把 “notes/a.md” 的左引号一起吃进路径。
const SEGMENT_CHAR = "[^\\s<>\"'`|*?()\\[\\]{},;:/\\\\“”‘’「」『』《》（）【】、。，；：！？…]";
const NOTE_PATH_PATTERN = new RegExp(
  "(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|/)?" + // 盘符 / ./ ../ / 绝对 POSIX 起点
  "(?:" + SEGMENT_CHAR + "+[\\\\/])*" + // 中间分量
  SEGMENT_CHAR + "*?" + // 文件名(懒匹配,允许 CJK 名)
  "\\.(?:md|markdown)" +
  // 行号:v1 只剥除、不跳转。两个分支的边界都要额外拒绝 ":"——
  // 否则 a.md:12:34x 回溯成行号组放弃后,a.md:12x 会链成 "a.md" + 悬空 ":12x",把非路径链成链接
  "(?:(?::\\d+(?::\\d+)?)(?![\\w.\\-:])|(?![\\w.\\-:]))", // 右边界:a.md.bak / a.mdx 不算
  "gi",
);

/** 文件名首字符是否 ASCII。CJK 开头的文件名只在两种情况下认(见 findNotePaths)。 */
function startsAscii(value) {
  return /^[A-Za-z0-9_]/.test(value);
}

/** 去掉行号与后缀后的文件名主干;空主干(".md")不是路径。 */
function stemOf(name) {
  return name.replace(/\.(?:md|markdown)(?::\d+(?::\d+)?)?$/i, "");
}

/**
 * 能不能当路径字符。直接复用 SEGMENT_CHAR:两份字符集写两遍早晚会走形,
 * 而"能不能当路径字符"与"是不是词边界"就是同一个问题的正反两面。
 */
const PATH_CHAR = new RegExp(SEGMENT_CHAR);

/**
 * 命中处是否被词边界夹住(串首与串尾算边界)。
 * 只有 CJK 开头的裸文件名需要这个判定:汉字没有词边界,不夹住就会把前后的散文一起吃进链接。
 */
function isDelimited(source, start, end) {
  const before = start === 0 ? "" : source[start - 1];
  const after = end >= source.length ? "" : source[end];
  return (before === "" || !PATH_CHAR.test(before)) && (after === "" || !PATH_CHAR.test(after));
}

/**
 * 命中处所在的空白分隔词元是不是个 URL(scheme:// 或 www. 开头)。那段属于外部链接,不是本地笔记。
 * 正常渲染时 marked 的 gfm 自动链接已经把裸 URL 包成 <a>,walker 会跳过;
 * 这里守的是行内 <code> 里的 URL 与 findNotePaths 被单独调用的场合。
 */
function insideUrl(source, start) {
  let tokenStart = start;
  while (tokenStart > 0 && !/\s/.test(source[tokenStart - 1])) tokenStart--;
  const token = source.slice(tokenStart).replace(/^[^\w]+/, "");
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(token);
}

/**
 * 在一段文本里找出所有笔记路径形态。
 * 覆盖:相对(notes/a.md、./a.md)、绝对 POSIX(/home/u/a.md)、Windows 盘符
 * (C:\Users\x\a.md 与 C:/Users/x/a.md)、行号(a.md:12)。包裹符与尾部标点已不在字符集里。
 *
 * CJK 开头的裸文件名分两步判:先看汉字后面是不是藏着一个 ASCII 名
 * ("见README.md" → 让回粘着的散文,只链 "README.md");不是就要求它独立成词
 * ("笔记 张三.md 很好" / <code>张三.md</code>)。两头都不成立则丢弃——宁可不链也不错链:
 * 链错了用户点进去只看见"找不到这份笔记",却看不出是自己名字写错了还是程序吃错了字。
 *
 * @param {string} text
 * @returns {Array<{ start: number, end: number, path: string }>}
 */
function findNotePaths(text) {
  const source = String(text ?? "");
  const hits = [];
  for (const match of source.matchAll(NOTE_PATH_PATTERN)) {
    const start = match.index;
    const path = match[0];
    if (insideUrl(source, start)) continue;
    // 文件名在 path 里的起点 = 跳过盘符与各层分量之后
    const nameOffset = pathLengthBeforeName(path);
    const name = path.slice(nameOffset);
    if (!stemOf(name)) continue; // ".md" 这种没主干的不是路径
    if (startsAscii(name) || nameOffset > 0) {
      hits.push({ start, end: start + path.length, path });
      continue;
    }
    const stripped = name.replace(/^[^\x00-\x7f]+/, "");
    if (startsAscii(stripped)) {
      const offset = start + name.length - stripped.length;
      hits.push({ start: offset, end: offset + stripped.length, path: stripped });
      continue;
    }
    if (isDelimited(source, start, start + path.length)) hits.push({ start, end: start + path.length, path });
  }
  return hits;
}

/** 路径里文件名之前的长度(盘符 + 各层分量),用来定位文件名首字符。 */
function pathLengthBeforeName(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index === -1 ? 0 : index + 1;
}

/** href 形式的笔记路径([文字](笔记.md)):有 scheme 的一律不是本地笔记。 */
function noteHref(href) {
  const value = String(href ?? "").trim().replace(/^<(.*)>$/, "$1");
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  if (!/\.(?:md|markdown)(?::\d+(?::\d+)?)?$/i.test(value)) return null;
  // agent 常把 CJK 文件名 percent-encode(CommonMark 合法,如 plans/%E6%88%98%E6%9C%AF.md);
  // 不解码的话交给 main 的路径查无此文件。% 序列残缺时 decodeURIComponent 抛错,保留原样
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 可点笔记锚点。故意不挂 href:两个宿主页都是 file://,挂上去一点就把整个 view 导航走。
 * 无 href 的 <a> 不可聚焦,所以自己补 tabIndex + role;点击由宿主页的事件委托接管(spec §8)。
 */
function noteAnchor(rawPath, tokens, math) {
  const a = el("a", "md-path");
  a.dataset.mdPath = rawPath;
  a.tabIndex = 0;
  a.setAttribute("role", "link");
  if (tokens?.length) renderInlines(a, tokens, math);
  else a.textContent = rawPath;
  return a;
}

/**
 * 渲染完的容器里遍历文本节点,把裸路径包成锚点。
 * 高亮代码块(hljs)里的路径是源码不是入口,跳过;纯文本围栏(```text 文件清单)放行。
 * 已包好的锚点不重复处理。
 * KaTeX 产物(.md-katex)里的"路径"是公式文本,包上链接会把公式视觉破坏,同样跳过。
 * 行内 <code> 里的路径要处理——反引号包裹是 spec §4.2 明列的形态。
 */
function linkifyNotePaths(root) {
  if (!canOpenNotes()) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("a, .md-katex")) return NodeFilter.FILTER_REJECT;
      // 高亮代码块(hljs)里的路径是源码不是入口,跳过;纯文本围栏(```text 等无高亮)
      // 是 agent 列文件清单的常客,里面的路径要可点。行内 <code> 不在 pre 里,不受影响。
      const code = node.parentElement?.closest("code");
      if (code?.classList?.contains("hljs")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const text = node.nodeValue;
    const hits = findNotePaths(text);
    if (!hits.length) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const hit of hits) {
      if (hit.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, hit.start)));
      fragment.appendChild(noteAnchor(hit.path, null, null));
      cursor = hit.end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }
}

// ---------- marked tokens → DOM ----------

/** URL 白名单:链接只放行 http/https;图片额外放行 data:image/。其余返回 null 降级。 */
function safeUrl(url, allowDataImage) {
  const u = String(url ?? "").trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (allowDataImage && /^data:image\//i.test(u)) return u;
  return null;
}

function applyAlign(cell, align) {
  if (align === "center" || align === "right") cell.style.textAlign = align;
}

function renderBlocks(container, tokens, math) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "space":
      case "def": // 链接定义本身不渲染
        break;
      case "hr":
        container.appendChild(el("hr", "md-hr"));
        break;
      case "heading": {
        // 保持旧 lite 行为:无论几级标题都用 h4(现有 CSS 只定义了 h4)
        const h = el("h4");
        renderInlines(h, token.tokens, math);
        container.appendChild(h);
        break;
      }
      case "paragraph": {
        const p = el("p");
        renderInlines(p, token.tokens, math);
        container.appendChild(p);
        break;
      }
      case "text":
        // 紧凑列表项里的块级 text:直接铺行内内容,不包 <p>
        renderInlines(container, token.tokens ?? [token], math);
        break;
      case "code":
        renderCodeBlock(container, token);
        break;
      case "table":
        renderTable(container, token, math);
        break;
      case "blockquote": {
        const quote = el("blockquote", "md-quote");
        renderBlocks(quote, token.tokens, math);
        container.appendChild(quote);
        break;
      }
      case "list":
        renderList(container, token, math);
        break;
      case "html": {
        // 原始 HTML 不走 innerHTML,降级为纯文本展示
        container.appendChild(el("p", null, token.text ?? ""));
        break;
      }
      default: {
        if (Array.isArray(token.tokens)) {
          const p = el("p");
          renderInlines(p, token.tokens, math);
          container.appendChild(p);
        }
        break;
      }
    }
  }
}

function renderInlines(container, tokens, math) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
        if (Array.isArray(token.tokens)) renderInlines(container, token.tokens, math);
        else appendTextWithMath(container, token.text, math);
        break;
      case "escape":
        container.appendChild(document.createTextNode(token.text ?? ""));
        break;
      case "strong":
      case "em":
      case "del": {
        const node = el(token.type === "del" ? "del" : token.type);
        renderInlines(node, token.tokens, math);
        container.appendChild(node);
        break;
      }
      case "codespan":
        container.appendChild(el("code", null, token.text ?? ""));
        break;
      case "br":
        container.appendChild(document.createElement("br"));
        break;
      case "link": {
        const href = safeUrl(token.href, false);
        if (!href) {
          // 非 http/https:指向 .md/.markdown 的转成可点笔记锚点(§4.2),
          // 其余(javascript: 等)只渲染链接文字,不挂链接
          const note = canOpenNotes() ? noteHref(token.href) : null;
          if (note) {
            container.appendChild(noteAnchor(note, token.tokens ?? [], math));
            break;
          }
          renderInlines(container, token.tokens ?? [], math);
          break;
        }
        const a = el("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        renderInlines(a, token.tokens ?? [], math);
        container.appendChild(a);
        break;
      }
      case "image": {
        const src = safeUrl(token.href, true);
        if (!src) {
          container.appendChild(document.createTextNode(token.text ? `![${token.text}]` : ""));
          break;
        }
        const img = document.createElement("img");
        img.className = "md-img";
        img.src = src;
        img.alt = token.text ?? "";
        if (token.title) img.title = token.title;
        container.appendChild(img);
        break;
      }
      case "html":
        container.appendChild(document.createTextNode(token.text ?? ""));
        break;
      default:
        if (Array.isArray(token.tokens)) renderInlines(container, token.tokens, math);
        else if (token.text) appendTextWithMath(container, token.text, math);
        break;
    }
  }
}

/** 代码块:头部小条(语言名 + 复制按钮)+ pre.md-code;有语言且 hljs 认识才高亮。 */
function renderCodeBlock(container, token) {
  const lang = String(token.lang ?? "").trim().split(/\s+/)[0].toLowerCase();
  const code = token.text ?? "";
  const fenceRenderer = FENCE_RENDERERS.get(lang);
  if (fenceRenderer) {
    fenceRenderer(container, code);
    return;
  }
  const box = el("div", "md-codeblock");
  const head = el("div", "md-codeblock-head");
  head.appendChild(el("span", "md-codeblock-lang", lang || "text"));
  const copyBtn = el("button", "md-codeblock-copy", t("md.copy"));
  copyBtn.type = "button";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = t("md.copied");
      setTimeout(() => {
        copyBtn.textContent = t("md.copy");
      }, 1200);
    } catch {
      /* 剪贴板不可用:静默降级 */
    }
  });
  head.appendChild(copyBtn);
  const pre = el("pre", "md-code");
  const codeEl = document.createElement("code");
  const hljs = /** @type {any} */ (window).hljs;
  if (hljs && lang && hljs.getLanguage(lang)) {
    // 例外二:hljs.highlight 的输出是对源码逐段转义后的高亮 HTML
    codeEl.innerHTML = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    codeEl.className = `hljs language-${lang}`;
  } else {
    codeEl.textContent = code; // 未知语言:纯文本不高亮
  }
  pre.appendChild(codeEl);
  box.append(head, pre);
  container.appendChild(box);
}

/** 表格:外套一层 md-table-wrap,超宽时表内横向滚动,不撑破气泡(kimi web 同款)。 */
function renderTable(container, token, math) {
  const wrap = el("div", "md-table-wrap");
  const table = el("table", "md-table");
  const thead = el("thead");
  const hr = el("tr");
  (token.header ?? []).forEach((cell, index) => {
    const th = el("th");
    applyAlign(th, token.align?.[index]);
    renderInlines(th, cell.tokens ?? [], math);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const row of token.rows ?? []) {
    const tr = el("tr");
    (row ?? []).forEach((cell, index) => {
      const td = el("td");
      applyAlign(td, token.align?.[index]);
      renderInlines(td, cell.tokens ?? [], math);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

/** 列表:支持嵌套(list_item.tokens 递归)与 GFM 任务列表勾选框。 */
function renderList(container, token, math) {
  const list = el(token.ordered ? "ol" : "ul");
  if (token.ordered && typeof token.start === "number" && token.start > 1) {
    list.setAttribute("start", String(token.start));
  }
  for (const item of token.items ?? []) {
    const li = el("li");
    if (item.task) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.disabled = true;
      box.checked = Boolean(item.checked);
      li.append(box, document.createTextNode(" "));
    }
    renderBlocks(li, item.tokens ?? [], math);
    list.appendChild(li);
  }
  container.appendChild(list);
}

/**
 * 渲染一段 markdown 到容器(消息定稿时调用一次)。
 * marked 缺失/解析异常时退化成纯文本段落,不让整条消息崩掉。
 * @param {HTMLElement} container
 * @param {string} text
 */
function renderMarkdown(container, text) {
  const marked = /** @type {any} */ (window).marked;
  if (!marked) {
    for (const chunk of String(text ?? "").split(/\n{2,}/)) container.appendChild(el("p", null, chunk));
    return;
  }
  const { text: protectedText, math } = extractMath(text);
  let tokens;
  try {
    tokens = marked.lexer(protectedText, { gfm: true, breaks: false });
  } catch {
    container.appendChild(el("p", null, text));
    return;
  }
  renderBlocks(container, tokens ?? [], math);
  linkifyNotePaths(container);
}

// ---------- hljs 高亮主题:暗 nord / 亮 stackoverflow-light(均避开红色系) ----------
// 只切换两个 <link> 的 disabled,不重渲代码;主题切换由 data-theme 属性驱动。

function applyHljsTheme() {
  const light = document.documentElement.dataset.theme === "light";
  const darkLink = /** @type {HTMLLinkElement | null} */ (document.getElementById("hljs-theme-dark"));
  const lightLink = /** @type {HTMLLinkElement | null} */ (document.getElementById("hljs-theme-light"));
  if (darkLink) darkLink.disabled = light;
  if (lightLink) lightLink.disabled = !light;
}

applyHljsTheme();
new MutationObserver(applyHljsTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

  // 入口挂 window:chat.js 通过 window.arcaneMd.render 调用(tsc 模块作用域下不能直接引用函数名)
  // findNotePaths 也挂出去:它是路径形态的唯一判据,单测按 spec §9 跑全形态。
  /** @type {any} */ (window).arcaneMd = { render: renderMarkdown, findNotePaths };
})();
