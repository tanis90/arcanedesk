// markdown.js 是 classic script,靠 window/document 活着,仓库里又没有 jsdom(spec §2:零新增依赖)。
// 这里给一个只覆盖 markdown.js 实际用到的那十几个 DOM 面目的最小实现,
// 让 node --test 能真的跑渲染管线(路径锚点、fence 注册表分发),而不是靠正则读源码猜行为。
//
// 刻意不做的事:innerHTML 不解析(存原串,断言看结构不看串)、不做布局、不做事件冒泡。
// 需要这些的验收在 smoke 里起真窗口做,不在这里假装。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL("../../", import.meta.url));

/** 选择器匹配:只支持 `tag`、`.class`、`tag.class` 与逗号列表——markdown.js 只用到这些。 */
function matchesSelector(node, selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const [tag, ...classes] = part.split(".");
      if (tag && node.tagName !== tag.toUpperCase()) return false;
      return classes.every((name) => node.classList.contains(name));
    });
}

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
}

class MiniClassList {
  #node;
  constructor(node) { this.#node = node; }
  #tokens() { return String(this.#node.className ?? "").split(/\s+/).filter(Boolean); }
  #write(tokens) { this.#node.className = [...new Set(tokens)].join(" "); }
  add(...names) { this.#write([...this.#tokens(), ...names]); }
  remove(...names) { this.#write(this.#tokens().filter((token) => !names.includes(token))); }
  contains(name) { return this.#tokens().includes(name); }
}

class MiniText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = String(value ?? "");
    this.parentElement = null;
  }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value ?? ""); }
  replaceWith(...nodes) { replaceNode(this, nodes); }
  remove() { this.parentElement?.removeChild(this); }
}

class MiniFragment {
  constructor() {
    this.nodeType = 11;
    this.childNodes = [];
    this.parentElement = null;
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  appendChild(child) { return adopt(this, child); }
  append(...kids) { for (const kid of kids) this.appendChild(kid); }
  removeChild(child) { return detach(this, child); }
}

function replaceNode(node, nodes) {
  const parent = node.parentElement;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  // DocumentFragment 插进去就消失,只留它的孩子(真 DOM 的语义,linkify 靠它)
  const inserted = nodes.flatMap((item) => {
    if (typeof item === "string") return [new MiniText(item)];
    if (item.nodeType === 11) {
      const kids = [...item.childNodes];
      item.childNodes = [];
      return kids;
    }
    return [item];
  });
  parent.childNodes.splice(index, 1, ...inserted);
  for (const item of inserted) item.parentElement = parent;
  node.parentElement = null;
}

function adopt(parent, child) {
  const node = typeof child === "string" ? new MiniText(child) : child;
  if (node.nodeType === 11) {
    for (const grandchild of [...node.childNodes]) adopt(parent, grandchild);
    return child;
  }
  node.parentElement?.removeChild(node);
  node.parentElement = parent;
  parent.childNodes.push(node);
  return node;
}

function detach(parent, child) {
  const index = parent.childNodes.indexOf(child);
  if (index >= 0) parent.childNodes.splice(index, 1);
  child.parentElement = null;
  return child;
}

class MiniElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag ?? "").toUpperCase();
    this.childNodes = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.classList = new MiniClassList(this);
    this.listeners = new Map();
    this.innerHTML = null;
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get textContent() {
    if (this.innerHTML != null) return this.innerHTML;
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this.innerHTML = null;
    if (value !== "" && value != null) this.childNodes.push(Object.assign(new MiniText(value), { parentElement: this }));
  }
  appendChild(child) { return adopt(this, child); }
  append(...kids) { for (const kid of kids) this.appendChild(kid); }
  removeChild(child) { return detach(this, child); }
  replaceWith(...nodes) { replaceNode(this, nodes); }
  remove() { this.parentElement?.removeChild(this); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[camelCase(name.slice(5))] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  /** 测试用:直接触发监听器,不做冒泡(markdown.js 只在自己节点上绑)。 */
  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.nodeType === 1 && matchesSelector(node, selector)) return node;
    }
    return null;
  }
  querySelector(selector) {
    for (const node of descendants(this)) if (matchesSelector(node, selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    return [...descendants(this)].filter((node) => matchesSelector(node, selector));
  }
}

function* descendants(root) {
  for (const child of root.childNodes ?? []) {
    if (child.nodeType === 1) {
      yield child;
      yield* descendants(child);
    }
  }
}

/**
 * 建一套最小 DOM + window。
 * @param {object} [options]
 * @param {boolean} [options.canOpenNotes] 挂 window.arcane.openMdReader(chat 页 true,阅读器页 false)
 * @param {object} [options.globals] 追加到 window 上的库桩(marked / mermaid / hljs / katex)
 */
export function createMiniDom({ canOpenNotes = true, globals = {} } = {}) {
  const documentElement = new MiniElement("html");
  documentElement.dataset.theme = "dark";
  const body = new MiniElement("body");
  const byId = new Map();

  const document = {
    documentElement,
    body,
    createElement: (tag) => new MiniElement(tag),
    createTextNode: (value) => new MiniText(value),
    createDocumentFragment: () => new MiniFragment(),
    getElementById: (id) => byId.get(String(id)) ?? null,
    createTreeWalker(root, _whatToShow, filter) {
      const texts = [];
      for (const node of descendants(root)) {
        for (const child of node.childNodes) if (child.nodeType === 3) texts.push(child);
      }
      for (const child of root.childNodes ?? []) if (child.nodeType === 3) texts.unshift(child);
      let cursor = -1;
      let currentNode = root;
      return {
        get currentNode() { return currentNode; },
        nextNode() {
          while (++cursor < texts.length) {
            const node = texts[cursor];
            const verdict = filter?.acceptNode ? filter.acceptNode(node) : 1;
            if (verdict === 1) { currentNode = node; return node; }
          }
          currentNode = null;
          return null;
        },
      };
    },
  };

  const window = {
    document,
    ArcaneI18n: { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) },
    navigator: { clipboard: { writeText: async () => {} } },
    ...globals,
  };
  if (canOpenNotes) window.arcane = { openMdReader: async () => ({ ok: true }) };

  const context = vm.createContext({
    window,
    document,
    navigator: window.navigator,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    console,
  });
  context.globalThis = context;
  return { window, document, context, byId };
}

/**
 * 在最小 DOM 里跑一遍 markdown.js,拿到 window.arcaneMd 与一个空容器。
 * marked 用仓库里的真货(fence 与链接形态必须由真 lexer 决定,桩会骗人);
 * hljs / katex / mermaid 默认缺席,管线本来就有降级分支,需要时由调用方传桩。
 */
export function loadMarkdownPipeline(options = {}) {
  const { marked } = require("marked");
  const dom = createMiniDom({
    ...options,
    globals: { marked, ...options.globals },
  });
  const source = readFileSync(new URL("../../src/renderer/markdown.js", import.meta.url), "utf8");
  vm.runInContext(source, dom.context, { filename: "markdown.js" });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  return { ...dom, container, arcaneMd: dom.window.arcaneMd, appRoot };
}

export { MiniElement, MiniText, descendants, matchesSelector };
