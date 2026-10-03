#!/usr/bin/env node
// arcane-world-import · FVTT 世界 → MythicTable 云端导入（skill 自包含脚本，零 node_modules）
//
// 同目录 vendored（与 mt-foundry-compat/web 逐字节一致，勿手改；上游为准）：
//   ./import-core.mjs    zip/目录读取 + LevelDB 解析 + 版本探测 + 分层映射
//   ./import-migrate.mjs dnd5e 旧版本 → 当前 schema 迁移纯函数面（env 注入）
//   ./import-assets.mjs  资产引用收集/上传计划/URL 重写
// 编排参考 mt-foundry-compat 的 tools/import-world.mjs、tools/mt-client.mjs、
// tools/mt-batch-write.mjs、tools/mt-upload.mjs（鉴权 ROPC、并发 6 写入、multipart 上传）。
//
// 旧版迁移环境：skill 包内不可携带 node_modules（jsdom 全量点火不可得），改走
// 「裸 Node 最小 stub 直载本机 dnd5e」路径（同 mt-foundry-compat tools/stage9-m3-spike.mjs
// 的 Path B）。dnd5e 代码来自用户本机 FVTT 数据目录的 systems/dnd5e，运行期按参数定位，
// 不是 bundle 依赖。foundry.utils 提供真实现，函数体与 mt-foundry-compat web/bootstrap.mjs
// 的干净室实现一致（MIT）。
//
// 用法：
//   node scripts/import-world.mjs <世界目录|世界包.zip> --create "<新战役名>"
//   node scripts/import-world.mjs <…> --campaign <既有战役id>
// 可选：--base <url>（默认 https://vtt.arcanedesk.bitterbebop.cn:30002）
//       --user <账号>（密码走 MT_PASS 环境变量，或 --pass；脚本不落盘不打日志）
//       --dnd5e <本机 dnd5e 系统目录或 dnd5e.mjs 路径>
//       --data-dir <FVTT 数据目录>（自动推导 <目录>/systems/dnd5e 或 <目录>/Data/systems/dnd5e）
//       --dry-run（只读探测 + 迁移预演 + 资产计划，不写云端、不需要账号）
//       --no-migrate / --skip-assets / --lib-path <MT资产库分类> / --report <结果另存路径>
//
// 输出：stdout 只有最终结果 JSON（给模型解析）；进度日志全走 stderr。
// 退出码：0 成功 / 1 本地拒绝（坏包、NeDB、缺迁移环境、参数错）/ 2 云端失败（鉴权、网络、写入）。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://vtt.arcanedesk.bitterbebop.cn:30002";
const MIGRATE_FLOOR = "5.3.0"; // dnd5e 低于此版本需要导入期迁移（云端兼容层基线 5.3.x）

// ---------- 参数 ----------
const FLAG_WITH_VALUE = new Set(["--campaign", "--create", "--base", "--user", "--pass", "--dnd5e", "--data-dir", "--lib-path", "--report"]);
const opts = { _: [] };
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAG_WITH_VALUE.has(a)) opts[a.slice(2)] = args[++i];
    else if (a.startsWith("--") && a.includes("=")) { const [k, v] = a.slice(2).split("="); opts[k] = v; }
    else if (a.startsWith("--")) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
}
const input = opts._[0];
const base = opts.base ?? DEFAULT_BASE;
const dryRun = !!opts["dry-run"];
const log = (msg) => process.stderr.write(`[import-world] ${msg}\n`);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

function fail(code, message, extra = {}, exitCode = 1) {
  out({ ok: false, error: { code, message }, ...extra });
  log(`✗ ${message}`);
  process.exit(exitCode);
}

if (!input) {
  fail("USAGE", "用法：node scripts/import-world.mjs <世界目录|世界包.zip> (--create \"<新战役名>\" | --campaign <战役id>) [--dry-run] [--base <url>] [--user <账号>] [--dnd5e <路径>] [--data-dir <目录>]", {}, 1);
}
if (!opts.create && !opts.campaign && !dryRun) {
  fail("USAGE", "缺少目标战役：用 --create \"<新战役名>\" 新建，或 --campaign <既有战役id> 并入。", {}, 1);
}
const pass = opts.pass ?? process.env.MT_PASS;
if (!dryRun && !pass) {
  fail("USAGE", "缺少密码：通过环境变量 MT_PASS 传入（推荐，避免进命令行历史），或 --pass。", {}, 1);
}
if (!dryRun && !opts.user) {
  fail("USAGE", "缺少账号：--user <MythicTable 账号名>。", {}, 1);
}
// 自签证书兜底（与 mt-client 一致：云端证书由 renew 流程维护，偶发过期不影响导入）
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";

const startedAt = Date.now();
const { readWorld, detectVersion, mapWorld } = await import("./import-core.mjs");

// ---------- 输入 → import-core source ----------
function statPath(p) { try { return statSync(p); } catch { return null; } }
async function sourceFromInput(path) {
  const stat = statPath(path);
  if (stat?.isFile() || path.endsWith(".zip")) {
    if (!stat?.isFile()) throw new Error(`输入不是文件：${path}`);
    return { kind: "zip", bytes: new Uint8Array(readFileSync(path)), form: "zip" };
  }
  if (!stat?.isDirectory()) throw new Error(`输入不存在或不是目录/zip：${path}`);
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, new Uint8Array(readFileSync(join(dir, entry.name))));
    }
  };
  walk(path, "");
  return { kind: "files", files, form: "dir" };
}

// ---------- 读取 + 版本门 ----------
let dump;
try {
  const source = await sourceFromInput(input);
  dump = await readWorld(source.kind === "zip" ? { kind: "zip", bytes: source.bytes } : { kind: "files", files: source.files });
  dump.__form = source.form;
} catch (e) {
  fail("READ_FAILED", `读取世界失败：${e.message}`, { world: { path: input } }, 1);
}
const version = detectVersion(dump.worldJson, dump.docs);
if (!version.ok || dump.version.nedb) {
  const reason = dump.version.nedb && version.ok
    ? `NeDB 旧格式世界（data/ 下只有 .db、无 LevelDB 目录）：请先在 FVTT 中把世界升级到 v11+ 再导出导入`
    : version.reason;
  fail("WORLD_REJECTED", reason, { world: { path: input, title: dump.worldJson?.title ?? null } }, 1);
}
log(`世界：${dump.worldJson?.title ?? "?"}（${dump.worldJson?.id ?? "?"}，system ${dump.worldJson?.system ?? "?"} core ${version.coreVersion} / dnd5e ${version.systemVersion ?? "?"}）`);

// ---------- 本机 dnd5e 定位（旧版迁移 + builtin 资产核对）----------
function locateDnd5e() {
  const candidates = [];
  if (opts.dnd5e) candidates.push(String(opts.dnd5e));
  if (opts["data-dir"]) candidates.push(join(String(opts["data-dir"]), "systems/dnd5e"), join(String(opts["data-dir"]), "Data", "systems", "dnd5e"));
  for (const candidate of candidates) {
    const stat = statPath(candidate);
    const entry = stat?.isFile() ? candidate : (stat?.isDirectory() ? join(candidate, "dnd5e.mjs") : null);
    if (entry && existsSync(entry)) {
      const root = stat.isFile() ? join(candidate, "..") : candidate;
      let systemVersion = null;
      try { systemVersion = JSON.parse(readFileSync(join(root, "system.json"), "utf8")).version ?? null; } catch { /* system.json 缺失时下面按缺版本处理 */ }
      return { root, entry, systemVersion };
    }
  }
  return null;
}
const dnd5e = locateDnd5e();
if (dnd5e) log(`本机 dnd5e：${dnd5e.entry}（system ${dnd5e.systemVersion ?? "版本未知"}）`);

// ---------- 版本比较（与参考 CLI 同语义：a > b 严格为真）----------
function isNewer(a, b) {
  const p1 = String(a ?? "0.0.0").split(".").map((n) => parseInt(n) || 0);
  const p2 = String(b ?? "0.0.0").split(".").map((n) => parseInt(n) || 0);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const d = (p1[i] ?? 0) - (p2[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const worldSystem = dump.worldJson?.system ?? null;
const fromSystem = version.systemVersion;
const migrationNeeded = worldSystem === "dnd5e" && !!fromSystem && isNewer(MIGRATE_FLOOR, fromSystem);
let migrationInfo = null;

if (migrationNeeded && opts["no-migrate"]) {
  log(`--no-migrate：system ${fromSystem} < ${MIGRATE_FLOOR} 但按参数跳过迁移（旧 schema 直收，云端可能打不开旧卡）`);
  migrationInfo = { needed: true, skipped: "no-migrate", fromSystem };
}

// ---------- 迁移环境（裸 Node 最小 stub 直载本机 dnd5e；spike Path B）----------
const BOOT = { utilsFallback: new Set(), configTouched: new Set(), stubOrder: [] };

// foundry.utils 真实现——函数体与 mt-foundry-compat web/bootstrap.mjs（MIT，干净室）一致
const isPlainObject = (v) => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
};
function deepClone(value) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t !== "object" || t === "function") return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(deepClone);
  if (value?.constructor?.documentName) return value;
  if (typeof value.clone === "function") return value.clone();
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
  return out;
}
function mergeObject(original, other = {}, {
  insertKeys = true, insertValues = true, overwrite = true, recursive = true,
  inplace = true, enforceTypes = false,
} = {}) {
  if (!inplace) original = deepClone(original) ?? {};
  for (const [k, v] of Object.entries(other)) {
    const o = original[k];
    if (recursive && isPlainObject(v) && isPlainObject(o)) {
      mergeObject(o, v, { insertKeys, insertValues, overwrite, recursive, inplace: true, enforceTypes });
      continue;
    }
    if (Array.isArray(v) && Array.isArray(o)) {
      original[k] = [...o];
      for (const item of v) if (!original[k].includes(item)) original[k].push(item);
      continue;
    }
    const has = (k in original);
    if (has && !insertValues) continue;
    if (!has && !insertKeys) continue;
    if (has && !overwrite) continue;
    original[k] = v;
  }
  return original;
}
function getProperty(obj, path) {
  if (!path) return obj;
  return String(path).split(".").reduce((o, k) => (o === null || o === undefined) ? undefined : o[k], obj);
}
function setProperty(obj, path, value) {
  const keys = String(path).split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
  return true;
}
function hasProperty(obj, path) { return getProperty(obj, path) !== undefined; }
function getType(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "Array";
  if (v instanceof Set) return "Set";
  if (v instanceof Map) return "Map";
  if (isPlainObject(v)) return "Object";
  const t = typeof v;
  return t === "function" ? "function" : (t === "string" || t === "number" || t === "boolean") ? t : "Object";
}
function isEmpty(v) {
  return v === null || v === undefined || v === "" ||
    (getType(v) === "Array" && v.length === 0) || (getType(v) === "Object" && Object.keys(v).length === 0);
}
function isNewerVersion(v, target) {
  const a = String(v).split(".").map(Number), b = String(target).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
function flattenObject(obj, { nestKey = (k, d) => (d ? `${d}.${k}` : k) } = {}, d = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = nestKey(k, d);
    if (isPlainObject(v)) flattenObject(v, { nestKey }, key, out);
    else out[key] = v;
  }
  return out;
}
function expandObject(obj, { nestKey = (k) => k.split(".") } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const keys = nestKey(k);
    let cur = out;
    keys.slice(0, -1).forEach((kk) => { cur[kk] ??= {}; cur = cur[kk]; });
    cur[keys.at(-1)] = v;
  }
  return out;
}
function diffObject(original = {}, other = {}) {
  const out = {};
  for (const [k, v] of Object.entries(other)) {
    const o = original[k];
    if (JSON.stringify(o) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}
const REAL_UTILS = {
  mergeObject, getProperty, setProperty, hasProperty, deepClone, duplicate: deepClone,
  getType, isEmpty, isNewerVersion, flattenObject, expandObject, diffObject,
  invertObject: (obj = {}) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k])),
  isDeletionKey: (key) => key === null || key === "-=",
  randomID: (len = 16) => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  },
};

// —— 可继承/可 new 的哑类与深代理（dnd5e 顶层的 extends/Application 面只需可构造）——
function makeExtendableClass(name) {
  const cls = class Dummy extends Object {
    static LOCALIZATION_PREFIXES = [];
    static _customElements = [];
    static metadata = { name };
    constructor(...a) { super(...a); }
    static mixin(B) { return B; }
  };
  Object.defineProperty(cls, "name", { value: name });
  return cls;
}
function deepClassProxy(prefix, cache = new Map()) {
  const base = makeExtendableClass(prefix);
  return new Proxy(base, {
    get(t, prop) {
      if (typeof prop !== "string" || prop === "then" || prop === Symbol.toPrimitive) return undefined;
      if (prop === "prototype") return t.prototype;
      if (prop === "implementation") return deepClassProxy(`${prefix}.implementation`, cache);
      const key = `${prefix}.${prop}`;
      if (!cache.has(key)) cache.set(key, deepClassProxy(key, cache));
      return cache.get(key);
    },
    apply(_t, _thisArg, args) {
      for (const a of args) if (typeof a === "function") return a;
      return base;
    },
    construct() { return {}; },
    has() { return true; },
  });
}
function makeStubFieldClass(name) {
  const cls = class StubField {
    constructor(a = {}, b) {
      if (typeof a === "function") { this.model = a; if (b) Object.assign(this, b); return; }
      if (b !== undefined) {
        if (a && typeof a === "object" && !Array.isArray(a)) this.fields = a; else this.element = a;
        Object.assign(this, b); return;
      }
      if (a && typeof a === "object" && !Array.isArray(a) && !isPlainObject(a)) { this.element = a; return; }
      Object.assign(this, a);
    }
  };
  Object.defineProperty(cls, "name", { value: name });
  return cls;
}
function withFallback(obj, prefix, cache = new Map()) {
  return new Proxy(obj, {
    get(t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      if (prop === "prototype") return t.prototype;
      if (prop in t) return t[prop];
      const key = `${prefix}.${prop}`;
      if (!cache.has(key)) cache.set(key, deepClassProxy(key));
      return cache.get(key);
    },
  });
}
// Foundry 语言扩展 polyfill（迁移路径用到；与 shim 同源）
function polyfillFoundryLang() {
  if (!Number.isNumeric) Number.isNumeric = (n) => {
    if (typeof n === "number") return !isNaN(n) && isFinite(n);
    if (typeof n === "string" && n.trim() !== "") return !isNaN(Number(n));
    return false;
  };
  if (!Number.prototype.toNearest) Number.prototype.toNearest = function (n = 1) { return Math.round(this / n) * n; };
  if (!Number.prototype.between) Number.prototype.between = function (a, b) { return this >= Math.min(a, b) && this <= Math.max(a, b); };
  if (!Math.clamp) Math.clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  if (!Array.prototype.findSplice) Array.prototype.findSplice = function (fn) {
    const i = this.findIndex(fn);
    return i >= 0 ? this.splice(i, 1)[0] : undefined;
  };
  if (!Array.prototype.filterJoin) Array.prototype.filterJoin = function (sep = ",") { return this.filter((v) => v !== null && v !== undefined && v !== "").join(sep); };
  if (!Set.prototype.some) Set.prototype.some = function (fn) { for (const v of this) if (fn(v)) return true; return false; };
  if (!Set.prototype.find) Set.prototype.find = function (fn) { for (const v of this) if (fn(v)) return v; return undefined; };
  if (!Set.prototype.first) Set.prototype.first = function () { for (const v of this) return v; return undefined; };
  if (!Set.prototype.union) Set.prototype.union = function (other) { const out = new Set(this); for (const v of other ?? []) out.add(v); return out; };
  if (!String.prototype.slugify) String.prototype.slugify = function () { return String(this).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); };
  if (!String.prototype.capitalize) String.prototype.capitalize = function () { return this.charAt(0).toUpperCase() + this.slice(1); };
  if (!String.prototype.titleCase) String.prototype.titleCase = function () { return String(this).split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "); };
}
function makeFoundryStub(DataModelBase) {
  polyfillFoundryLang();
  const utilsProxy = new Proxy(REAL_UTILS, {
    get(t, prop) {
      if (prop in t) { const v = t[prop]; return typeof v === "function" ? v.bind(t) : v; }
      if (typeof prop === "string") {
        BOOT.utilsFallback.add(`foundry.utils.${prop}`);
        return () => undefined;
      }
      return undefined;
    },
  });
  const fieldCache = new Map();
  const fields = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      if (!fieldCache.has(prop)) fieldCache.set(prop, makeStubFieldClass(prop));
      return fieldCache.get(prop);
    },
  });
  const base = {
    utils: utilsProxy,
    abstract: withFallback({ DataModel: DataModelBase, TypeDataModel: DataModelBase, DocumentCollection: makeExtendableClass("DocumentCollection") }, "foundry.abstract"),
    data: withFallback({ fields, models: {} }, "foundry.data"),
    helpers: withFallback({
      interaction: withFallback({
        KeyboardManager: {
          MODIFIER_CODES: { Alt: ["Alt"], Control: ["ControlLeft", "ControlRight", "Meta"], Shift: ["Shift"] },
          MODIFIER_KEYS: { Alt: "Alt", Control: "Control", Meta: "Meta", Shift: "Shift" },
        },
      }, "foundry.helpers.interaction"),
    }, "foundry.helpers"),
  };
  return withFallback(base, "foundry");
}
class DataModelBase { static defineSchema() { return {}; } }

// game 桩：离线导入视角（引用视作有效；无在线集合/设置存储）
function makeGameStub(systemVersion) {
  const game = {
    release: { generation: 13, version: "13.351" },
    system: { id: "dnd5e", version: systemVersion ?? "5.3.3" },
    actors: { has: () => true, get: () => undefined, invalidDocumentIds: new Set(), getInvalid: () => null },
    items: { get: () => undefined, map: (fn) => [], invalidDocumentIds: new Set(), getInvalid: () => null },
    folders: { find: () => undefined },
    modules: { get: () => undefined, filter: () => [] },
    packs: { get: () => undefined },
    settings: { get: () => undefined, set: () => true, storage: {} },
    data: { items: [] },
    dnd5e: { macros: {}, rollItemMacro: () => {} },
    compendiumArt: { enabled: false },
    i18n: { localize: (k) => String(k), lang: "en" },
  };
  return new Proxy(game, { get(t, p) { return t[p]; } });
}

// Roll：迁移面子集。dnd5e _migrateActorAC 用 `new Roll(ac.formula).evaluateSync()` 校验自定义
// AC 公式——抛错即清空 formula，因此抛错语义必须与真实现一致。求值器与
// mt-foundry-compat web/bootstrap.mjs 的 MTRoll（MIT 干净室）同源，裁剪到迁移所需面。
function rollTokenize(src) {
  const tokens = [];
  const re = /(\s+)|(\d+(?:\.\d+)?)|(d\d+)|([a-zA-Z_][\w.]*)|(@[\w.]+)|([+\-*/(),=])/g;
  const patterns = [null, null, "num", "dice", "iden", "data", "op"];
  let m, idx = 0;
  while (idx < src.length) {
    m = re.exec(src.slice(idx));
    if (!m || m.index !== 0) throw new Error(`无法解析公式 @${idx}: ${JSON.stringify(src.slice(idx, idx + 12))}`);
    const text = m[0];
    for (let g = 1; g <= 6; g++) if (m[g] !== undefined) { tokens.push({ type: patterns[g], text }); break; }
    idx += text.length;
    re.lastIndex = 0;
  }
  return tokens.filter((t) => t.type !== null);
}
class RollStub {
  static TOOLTIP_TEMPLATE = "";
  static create(formula, data, options) { return new RollStub(formula, data, options); }
  static register() {}
  static validate(formula) {
    const s = String(formula ?? "");
    if (/[()]/.test(s)) {
      let depth = 0;
      for (const ch of s) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth < 0) throw new Error("Unbalanced parentheses in roll formula");
      }
      if (depth !== 0) throw new Error("Unbalanced parentheses in roll formula");
    }
    return true;
  }
  constructor(formula = "", data = {}, options = {}) {
    this.formula = String(formula ?? "");
    this.data = data ?? {};
    this.options = options ?? {};
    this.total = undefined;
    this.evaluated = false;
  }
  async evaluate() { return this.evaluateSync(); }
  async roll() { return this.evaluateSync(); }
  async reroll() { return this.evaluateSync(); }
  async render() { return ""; }
  simplify() { return this; }
  evaluateSync() {
    let src = String(this.formula ?? "").trim();
    while (/[+\-*/]\s*$/.test(src)) src = src.replace(/[+\-*/]\s*$/, "").trim();
    if (!src) { this.total = 0; this.evaluated = true; return this; }
    const substituted = src.replace(/@([\w.]+)/g, (_, path) => {
      const v = getProperty(this.data, path);
      if (v === undefined || v === null) throw new Error(`公式数据缺项 @${path}（公式: ${src}）`);
      return `(${Number(v)})`;
    });
    let ast;
    try {
      ast = this.#parse(rollTokenize(substituted));
      this.total = this.#evalNode(ast);
    } catch (e) {
      throw new Error(`Roll 公式求值失败 "${this.formula}" → "${substituted}": ${e.message}`);
    }
    this.evaluated = true;
    return this;
  }
  #parse(tokens) {
    let pos = 0;
    const peek = (t, v) => tokens[pos]?.type === t && (v === undefined || tokens[pos]?.text === v);
    const eat = (t, v) => { if (!peek(t, v)) throw new Error(`公式语法错误 @token${pos}: ${tokens[pos]?.text}`); return tokens[pos++]; };
    const parseExpr = () => {
      let node = parseTerm();
      while (peek("op", "+") || peek("op", "-")) {
        const op = tokens[pos++].text;
        node = { kind: "op", op, left: node, right: parseTerm() };
      }
      return node;
    };
    const parseTerm = () => {
      let node = parseFactor();
      while (peek("op", "*") || peek("op", "/")) {
        const op = tokens[pos++].text;
        node = { kind: "op", op, left: node, right: parseFactor() };
      }
      return node;
    };
    function parseDieRest(facesFromToken) {
      let faces = facesFromToken ? Number(facesFromToken) : null;
      if (faces === null) {
        const t = tokens[pos];
        if (t?.type === "num") { faces = Number(t.text); pos++; }
        else throw new Error("骰子缺少面数");
      }
      const mods = [];
      while (tokens[pos]?.type === "iden" && /^(kh|kl|k|dh|dl|r|ro|rr|min|max|mt|cs|cf)(\d+)?$/i.test(tokens[pos].text)) {
        mods.push(tokens[pos++].text.toLowerCase());
      }
      return { faces, mods };
    }
    const parseFactor = () => {
      if (peek("op", "-")) { pos++; return { kind: "neg", inner: parseFactor() }; }
      if (peek("op", "(")) { pos++; const e = parseExpr(); eat("op", ")"); return { kind: "group", inner: e }; }
      if (peek("num")) {
        const n = Number(tokens[pos++].text);
        if (peek("dice")) { const t = tokens[pos++].text; return { kind: "dice", number: n, ...parseDieRest(t.slice(1)) }; }
        if (peek("iden") && /^d$/i.test(tokens[pos].text)) { pos++; return { kind: "dice", number: n, ...parseDieRest() }; }
        return { kind: "num", value: n };
      }
      if (peek("dice")) {
        const t = tokens[pos++].text;
        return { kind: "dice", number: 1, ...parseDieRest(t.slice(1)) };
      }
      if (peek("iden")) {
        const name = tokens[pos].text;
        if (/^d$/i.test(name)) { pos++; return { kind: "dice", number: 1, ...parseDieRest() }; }
        if (/^[a-zA-Z_][\w.]*$/.test(name)) {
          if (tokens[pos + 1]?.type === "op" && tokens[pos + 1].text === "(") {
            pos += 2;
            const args = [parseExpr()];
            while (peek("op", ",")) { pos++; args.push(parseExpr()); }
            eat("op", ")");
            return { kind: "func", name: name.toLowerCase(), args };
          }
          pos++;
          return { kind: "data", path: name };
        }
        pos++;
        return { kind: "data", path: name };
      }
      if (peek("data")) {
        const path = tokens[pos++].text.slice(1);
        return { kind: "data", path };
      }
      throw new Error(`公式意外符号 @token${pos}: ${tokens[pos]?.text ?? "EOF"}`);
    };
    const ast = parseExpr();
    if (pos !== tokens.length) throw new Error(`公式尾部有多余内容: ${tokens[pos]?.text}`);
    return ast;
  }
  #evalNode(node) {
    switch (node.kind) {
      case "num": return node.value;
      case "group": return this.#evalNode(node.inner);
      case "neg": return -this.#evalNode(node.inner);
      case "data": {
        const v = getProperty(this.data, node.path);
        if (v === undefined || v === null) throw new Error(`公式数据缺项 @${node.path}`);
        return Number(v);
      }
      case "func": {
        const args = node.args.map((a) => this.#evalNode(a));
        const fns = { min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs };
        const fn = fns[node.name];
        if (!fn) throw new Error(`未知公式函数 ${node.name}`);
        return fn(...args);
      }
      case "op": {
        const l = this.#evalNode(node.left), r = this.#evalNode(node.right);
        return node.op === "+" ? l + r : node.op === "-" ? l - r : node.op === "*" ? l * r : l / r;
      }
      case "dice": return this.#rollDice(node);
      default: throw new Error(`未知 AST 节点 ${node.kind}`);
    }
  }
  #rollDice({ number, faces }) {
    number = Math.min(Math.max(1, Math.floor(number)), 2000);
    if (!(faces >= 1) || faces > 100000) throw new Error(`骰子面数非法: d${faces}`);
    let total = 0;
    for (let i = 0; i < number; i++) total += 1 + Math.floor(Math.random() * faces);
    return total;
  }
}
const INSTALLERS = {
  foundry: () => { globalThis.foundry = makeFoundryStub(DataModelBase); },
  Hooks: () => {
    const noop = () => true;
    globalThis.Hooks = { on: noop, once: noop, off: noop, call: noop, callAll: noop };
  },
  game: () => { globalThis.game = makeGameStub(dnd5e?.systemVersion); },
  ui: () => { globalThis.ui = new Proxy({}, { get: () => undefined }); },
  canvas: () => { globalThis.canvas = undefined; },
  CONST: () => {
    const leaf = () => new Proxy(function () { }, {
      get(_t, p) {
        if (p === Symbol.toPrimitive || p === "valueOf") return () => 0;
        if (p === "then") return undefined;
        return leaf();
      },
      apply() { return 0; },
    });
    globalThis.CONST = new Proxy({}, {
      get(_t, p) {
        if (typeof p !== "string" || p === "then") return undefined;
        return leaf();
      },
    });
  },
  Roll: () => { globalThis.Roll = RollStub; },
  KeyboardManager: () => { globalThis.KeyboardManager = { MODIFIER_CODES: { Alt: ["Alt"], Control: ["ControlLeft", "ControlRight"], Shift: ["Shift"] }, MODIFIER_KEYS: { Alt: "Alt", Control: "Control", Meta: "Meta", Shift: "Shift" } }; },
  ApplicationV2: () => { globalThis.ApplicationV2 = makeExtendableClass("ApplicationV2"); },
  DocumentSheetV2: () => { globalThis.DocumentSheetV2 = makeExtendableClass("DocumentSheetV2"); },
  HandlebarsApplicationMixin: () => { globalThis.HandlebarsApplicationMixin = (Base) => Base; },
  Collection: () => { globalThis.Collection = makeExtendableClass("Collection"); },
  FormApplication: () => { globalThis.FormApplication = makeExtendableClass("FormApplication"); },
  Item: () => { globalThis.Item = makeExtendableClass("Item"); },
  Actor: () => { globalThis.Actor = makeExtendableClass("Actor"); },
  ChatMessage: () => { globalThis.ChatMessage = makeExtendableClass("ChatMessage"); },
  ActiveEffect: () => { globalThis.ActiveEffect = makeExtendableClass("ActiveEffect"); },
  Color: () => { globalThis.Color = makeExtendableClass("Color"); },
  JournalEntryPage: () => { globalThis.JournalEntryPage = makeExtendableClass("JournalEntryPage"); },
  TokenDocument: () => { globalThis.TokenDocument = makeExtendableClass("TokenDocument"); },
  User: () => { globalThis.User = makeExtendableClass("User"); },
  Combat: () => { globalThis.Combat = makeExtendableClass("Combat"); },
  Combatant: () => { globalThis.Combatant = makeExtendableClass("Combatant"); },
  CONFIG: () => {
    globalThis.CONFIG = new Proxy({
      compatibility: { excludePatterns: [] }, Dice: {}, DND5E: undefined,
      Canvas: { detectionModes: {}, layers: {} }, Token: {}, ActiveEffect: {}, Actor: {}, Item: {},
      ChatMessage: {}, JournalEntryPage: {}, Combat: {}, ui: {},
    }, {
      get(t, p) {
        if (typeof p === "string" && p !== "then" && !(p in t)) BOOT.configTouched.add(`CONFIG.${p}`);
        return t[p];
      },
    });
  },
  window: () => {
    globalThis.window = globalThis;
    globalThis.customElements ??= { define() { }, get() { return undefined; }, whenDefined: async () => { } };
  },
};
const CLASS_GLOBALS = ["ApplicationV2", "DocumentSheetV2", "HandlebarsApplicationMixin", "Collection",
  "FormApplication", "Item", "Actor", "ChatMessage", "JournalEntryPage", "ActiveEffect",
  "TokenDocument", "User", "Combat", "Combatant", "KeyboardManager"];

async function bootMigrateEnv(dnd5eEntry) {
  const url0 = pathToFileURL(dnd5eEntry).href;
  // 已知 stub 全部预装，剩余缺口按报错逐个补（防 dnd5e 版本漂移）；缓存戳让失败轮可重求值
  for (const name of ["foundry", "CONST", "CONFIG", "Hooks", "game", "window", ...CLASS_GLOBALS, "Roll", "ui", "canvas"]) {
    INSTALLERS[name]?.();
    BOOT.stubOrder.push(name);
  }
  for (let round = 0; round < 30; round++) {
    let mod;
    try {
      mod = await import(`${url0}?r=${round}-${Date.now()}`);
      const ns = mod?.default && !mod.dataModels ? mod.default : mod;
      if (!ns?.dataModels || !ns?.migrations) throw new Error("dnd5e 模块未导出 dataModels/migrations（文件形状不符）");
      return { ns };
    } catch (e) {
      let name = /^(\w+) is not defined$/.exec(e.message)?.[1];
      if (!name && /not a constructor or null/.test(e.message)) {
        const batch = CLASS_GLOBALS.filter((n) => !(n in globalThis));
        for (const n of batch) INSTALLERS[n]?.();
        if (batch.length) { BOOT.stubOrder.push(`[批次]${batch.join("+")}`); name = batch[0]; }
      }
      if (name && INSTALLERS[name]) {
        INSTALLERS[name]();
        BOOT.stubOrder.push(name);
        continue;
      }
      throw new Error(`dnd5e 迁移环境 boot 失败（${e.message}）——本机 dnd5e 与迁移层不兼容或文件损坏`);
    }
  }
  throw new Error("dnd5e 迁移环境 boot 失败：stub 补齐 30 轮仍未通过（异常的 dnd5e 文件）");
}

// ---------- 迁移执行 ----------
if (migrationNeeded && !opts["no-migrate"]) {
  if (!dnd5e) {
    fail("MIGRATE_ENV_MISSING",
      `世界是 dnd5e ${fromSystem}（< ${MIGRATE_FLOOR}），导入前必须迁移到当前 schema，但没找到本机 dnd5e。`
      + `请用 --dnd5e <本机 dnd5e 系统目录> 或 --data-dir <FVTT 数据目录> 指定（arcane 装机默认在 <数据目录>/Data/systems/dnd5e）。`,
      { world: { path: input, title: dump.worldJson?.title ?? null } }, 1);
  }
  if (dnd5e.systemVersion && isNewer(fromSystem, dnd5e.systemVersion)) {
    fail("MIGRATE_ENV_OLDER",
      `本机 dnd5e（${dnd5e.systemVersion}）比世界的 systemVersion（${fromSystem}）还旧，不能做升级迁移。请先把本机 dnd5e 升级到 ${MIGRATE_FLOOR}+（arcane-fvtt-mods 的系统升级流程）再导入。`,
      { world: { path: input, title: dump.worldJson?.title ?? null } }, 1);
  }
  const toSystem = dnd5e.systemVersion ?? "5.3.3";
  log(`迁移：system ${fromSystem} → ${toSystem}（boot 本机 dnd5e 离线迁移环境…）`);
  const t0 = Date.now();
  const { installMigrateCompat, migrateDocs } = await import("./import-migrate.mjs");
  let env;
  try {
    env = await bootMigrateEnv(dnd5e.entry);
  } catch (e) {
    fail("MIGRATE_BOOT_FAILED", e.message, { world: { path: input, title: dump.worldJson?.title ?? null } }, 1);
  }
  try {
    installMigrateCompat(globalThis.foundry.abstract.DataModel);
    globalThis.CONFIG.DND5E = env.ns.DND5E ?? env.ns.config ?? globalThis.CONFIG.DND5E;
    // CONFIG.*.documentClass：migrateActorData/migrateItemData 的 instanceof 判定读取点
    //（Path A 全量 init 会填；Path B 手工接线到 dnd5e.documents 的真实类）
    const dc = env.ns.documents ?? {};
    if (dc.Item5e) globalThis.CONFIG.Item.documentClass = dc.Item5e;
    if (dc.Actor5e) globalThis.CONFIG.Actor.documentClass = dc.Actor5e;
    if (dc.ActiveEffect5e) globalThis.CONFIG.ActiveEffect.documentClass = dc.ActiveEffect5e;
    if (dc.ChatMessage5e) globalThis.CONFIG.ChatMessage.documentClass = dc.ChatMessage5e;
    if (dc.TokenDocument5e) globalThis.CONFIG.Token.documentClass = dc.TokenDocument5e;
    const keep = Object.keys(dump.docs).filter((c) => dump.docs[c]?.length);
    const src = Object.fromEntries(keep.map((c) => [c, dump.docs[c]]));
    const { docs, report } = migrateDocs(src, {
      fromCore: version.coreVersion, fromSystem, toSystem,
      env: { dataModels: env.ns.dataModels, migrations: env.ns.migrations, documents: env.ns.documents ?? {}, CONFIG: globalThis.CONFIG, game: globalThis.game },
    });
    for (const c of keep) dump.docs[c] = docs[c];
    migrationInfo = {
      needed: true,
      route: report.route.name,
      bestEffort: report.route.bestEffort ?? false,
      fromSystem, toSystem,
      dnd5e: { path: dnd5e.entry, version: dnd5e.systemVersion ?? null },
      totals: report.totals,
      failedDocs: report.failedDocs.slice(0, 20),
      failedDocsTotal: report.failedDocs.length,
      bootNotes: [
        ...(BOOT.utilsFallback.size ? [`未实现的 foundry.utils（已用兜底）：${[...BOOT.utilsFallback].slice(0, 10).join(", ")}`] : []),
        ...(BOOT.configTouched.size ? [`迁移中触达的未知 CONFIG 键：${[...BOOT.configTouched].slice(0, 10).join(", ")}`] : []),
      ],
      durationMs: Date.now() - t0,
    };
    log(`迁移完成（${((Date.now() - t0) / 1000).toFixed(1)}s）：route=${report.route.name} applied=${report.totals.applied} unchanged=${report.totals.unchanged} failed=${report.totals.failed} → system ${toSystem}`);
    for (const f of report.failedDocs.slice(0, 10)) log(`迁移失败（不落库）：${f.coll}/${f.id}（${f.name ?? "?"}）— ${f.error}`);
    if (!dnd5e.systemVersion) log("警告：本机 dnd5e 的 system.json 缺 version，迁移目标版本按 5.3.3 处理");
    else if (!String(dnd5e.systemVersion).startsWith("5.3.")) log(`警告：本机 dnd5e 是 ${dnd5e.systemVersion}，云端兼容层基线是 5.3.x，建议先升级本机 dnd5e 再导入`);
  } catch (e) {
    fail("MIGRATE_FAILED", `迁移执行失败：${e.message}`, { world: { path: input, title: dump.worldJson?.title ?? null } }, 1);
  }
} else if (!migrationNeeded) {
  const why = worldSystem !== "dnd5e"
    ? `system 是 ${worldSystem ?? "?"}（非 dnd5e），不做系统迁移，按 T1 文档照收（云端兼容层只运行 dnd5e）`
    : `system ${fromSystem ?? "?"} ≥ ${MIGRATE_FLOOR} 或版本缺失，直收`;
  log(`迁移：不需要——${why}`);
  migrationInfo = { needed: false, reason: why };
}

// ---------- 资产管线 ----------
const { collectAssetRefs, planAssets, uploadPlannedAssets, rewriteAssetUrls } = await import("./import-assets.mjs");
let assetInfo = { skipped: false };
let assetPlan = null;
let rewritten = dump;
if (opts["skip-assets"]) {
  assetInfo = { skipped: true, reason: "--skip-assets" };
  log("资产：按参数跳过（文档内引用保持原值）");
} else {
  const refs = collectAssetRefs(dump);
  const plan = planAssets(dump, refs, {
    compatBase: `${base}/user-files/compat`,
    ...(dnd5e ? {
      builtinExists: (rel) => (rel.startsWith("dnd5e/")
        ? existsSync(join(dnd5e.root, rel.slice("dnd5e/".length)))
        : false),
    } : {}),
  });
  assetPlan = plan;
  const t = plan.report.totals;
  log(`资产计划：引用 ${t.refs} → 上传 ${t.uploadEntries} 条（去重 ${t.uploadRefs - t.uploadEntries}，${(t.uploadBytes / 1048576).toFixed(1)}MiB）· builtin ${t.builtin} · 外链 ${t.external} · missing ${t.missing} · 超限 ${t.skipped}`);
  assetInfo = {
    skipped: false,
    refs: t.refs,
    plannedUploads: t.uploadEntries,
    plannedUploadBytes: t.uploadBytes,
    dedupedRefs: t.uploadRefs - t.uploadEntries,
    builtin: t.builtin, external: t.external,
    assumedBuiltin: plan.report.assumedBuiltin ?? 0,
    missingCount: t.missing,
    missingSample: plan.missing.slice(0, 30).map((m) => ({ url: m.url, reason: m.reason })),
    overLimit: plan.skipped.slice(0, 20),
    suspiciousCount: plan.suspicious?.length ?? 0,
  };
}

// ---------- dry-run 出口 ----------
function writeReport(result) {
  if (!opts.report) return;
  try {
    writeFileSync(String(opts.report), `${JSON.stringify(result, null, 2)}\n`);
    log(`结果已另存 ${opts.report}`);
  } catch (e) {
    log(`--report 写入失败（不影响导入结果）：${e.message}`);
  }
}
function mapSummary(mapped) {
  return {
    collections: mapped.report.collections,
    skipped: mapped.report.skipped,
    totals: mapped.report.totals,
    warnings: mapped.report.warnings,
  };
}
if (dryRun) {
  const mapped = mapWorld(dump, { gmUserId: opts.user ?? null });
  const worldInfo = {
    path: input, form: dump.__form ?? null,
    title: dump.worldJson?.title ?? null, id: dump.worldJson?.id ?? null,
    system: worldSystem, coreVersion: version.coreVersion, systemVersion: fromSystem,
  };
  const result = {
    ok: true, dryRun: true,
    world: worldInfo,
    migration: migrationInfo,
    assets: assetInfo,
    ...mapSummary(mapped),
    campaign: opts.create ? { mode: "create", name: opts.create } : (opts.campaign ? { mode: "existing", id: opts.campaign } : { mode: "unset" }),
    base,
    durationMs: Date.now() - startedAt,
  };
  writeReport(result);
  out(result);
  log("--dry-run：未写云端，结束。");
  process.exit(0);
}

// ---------- 云端：鉴权 ----------
const TOKEN_URL = `${base}/auth/realms/MythicTable/protocol/openid-connect/token`;
async function login(username, password) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "mythictable", username, password }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const cause = e?.cause?.code ?? e?.name ?? e?.message ?? "unknown";
    fail("UNREACHABLE",
      `无法连接 MythicTable 云端（${base}，${cause}）。请检查网络连接与服务器地址；若在弱网环境可稍后重试。`,
      { world: { path: input } }, 2);
  }
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("Account is not fully set up")) {
      fail("AUTH_PROFILE_INCOMPLETE",
        "登录被拒：该账号在服务器 Keycloak 中资料不全（缺 firstName/lastName），密码登录被禁用。需要服务器管理员在用户管理里补全该账号资料后重试。",
        { world: { path: input } }, 2);
    }
    if (/invalid_grant|Invalid user credentials|invalid_credentials/i.test(text)) {
      fail("AUTH_BAD_CREDENTIALS",
        "账号或密码错误（401 invalid_grant）。请与用户核对 MythicTable 账号密码后重试；连续失败请先在网页端确认能否登录。",
        { world: { path: input } }, 2);
    }
    fail("AUTH_FAILED", `登录失败 ${res.status}：${text.slice(0, 200)}`, { world: { path: input } }, 2);
  }
  const json = JSON.parse(text);
  if (!json?.access_token) fail("AUTH_FAILED", "登录响应缺少 access_token（服务器返回形状异常）", { world: { path: input } }, 2);
  return json.access_token;
}
const apiCall = async (token, method, path, body) => {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const cause = e?.cause?.code ?? e?.name ?? e?.message ?? "unknown";
    throw Object.assign(new Error(`网络错误（${cause}）`), { code: "NETWORK" });
  }
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`), { status: res.status, code: res.status === 401 ? "AUTH_EXPIRED" : "HTTP" });
  return text ? JSON.parse(text) : null;
};

log(`云端：${base}（账号 ${opts.user}）`);
const token = await login(opts.user, pass);

// ---------- 云端：战役 ----------
let campaign;
try {
  await apiCall(token, "GET", "/api/profiles/me"); // profile 只在此接口自动补建（其余 404）
  if (opts.campaign) {
    campaign = await apiCall(token, "GET", `/api/campaigns/${opts.campaign}`);
  } else {
    campaign = await apiCall(token, "POST", "/api/campaigns", { name: String(opts.create) }); // --create 恒新建，绝不按名字复用既有战役（避免重复导入叠数据）
  }
} catch (e) {
  if (e.status === 404) fail("CAMPAIGN_NOT_FOUND", `战役不存在或不可访问（${opts.campaign}）：确认 id 与账号所属，或改用 --create 新建。`, { world: { path: input } }, 2);
  if (e.code === "NETWORK") fail("UNREACHABLE", `云端操作网络失败：${e.message}`, { world: { path: input } }, 2);
  if (e.code === "AUTH_EXPIRED") fail("AUTH_EXPIRED", "云端会话已过期（401）：token 失效，请重新提供账号密码后再试。", { world: { path: input } }, 2);
  fail("CLOUD_FAILED", `战役准备失败：${e.message}`, { world: { path: input } }, 2);
}
const campaignId = campaign.id ?? campaign._id;
log(`目标战役：${campaign.name}（${campaignId}，${opts.campaign ? "既有" : "新建"}）`);

// ---------- 云端：资产上传 + 重写 ----------
if (!opts["skip-assets"]) {
  const plan = assetPlan;
  const urlMap = new Map();
  if (plan.toUpload.size > 0) {
    const libQuery = opts["lib-path"] ? `?path=${encodeURIComponent(String(opts["lib-path"]))}` : "";
    const uploadOne = async ({ bytes, filename, contentType }) => {
      const form = new FormData();
      form.append("files", new Blob([bytes], { type: contentType }), filename);
      let res;
      try {
        res = await fetch(`${base}/api/files${libQuery}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
        });
      } catch (e) {
        const cause = e?.cause?.code ?? e?.name ?? e?.message ?? "unknown";
        throw Object.assign(new Error(`上传网络错误（${cause}）`), { code: "NETWORK" });
      }
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`POST /api/files → ${res.status}: ${text.slice(0, 160)}`), { status: res.status });
      const url = JSON.parse(text)?.files?.[0]?.url;
      if (!url) throw new Error("上传响应缺少 files[0].url");
      return url;
    };
    log(`上传资产：${plan.toUpload.size} 条（并发 4）…`);
    let up;
    try {
      up = await uploadPlannedAssets(plan, uploadOne, { concurrency: 4 });
    } catch (e) {
      if (e.code === "NETWORK") fail("UNREACHABLE", `资产上传网络失败：${e.message}`, { campaign: { id: campaignId, name: campaign.name } }, 2);
      if (e.status === 401) fail("AUTH_EXPIRED", "资产上传时云端会话已过期（401）。战役已创建但未写入文档；建议删除本次战役后带新凭据重来。", { campaign: { id: campaignId, name: campaign.name } }, 2);
      fail("UPLOAD_FAILED", `资产上传失败：${e.message}`, { campaign: { id: campaignId, name: campaign.name } }, 2);
    }
    assetInfo.uploaded = up.uploads.length;
    assetInfo.uploadBytes = up.uploads.reduce((n, u) => n + u.size, 0);
    assetInfo.failures = up.failures.slice(0, 10);
    for (const [k, v] of up.urlMap) urlMap.set(k, v);
    log(`资产上传完成：成功 ${up.uploads.length} / 失败 ${up.failures.length}`);
  } else {
    log("资产：无可上传条目（引用全为外链/builtin/missing）");
  }
  for (const b of plan.builtin) urlMap.set(b.url, b.newUrl);
  if (urlMap.size > 0) {
    rewritten = rewriteAssetUrls(dump, urlMap);
    const st = rewritten.__assetRewrite;
    assetInfo.rewrittenFields = st.rewrittenFields;
    assetInfo.htmlRewrites = st.htmlRewrites;
    log(`URL 重写：${st.rewrittenFields} 处字段（HTML ${st.htmlRewrites}）`);
  }
}

// ---------- 映射 + 批量写入 ----------
const mapped = mapWorld(rewritten, { gmUserId: opts.user });
const docTotal = Object.values(mapped.collections).reduce((n, l) => n + l.length, 0);
log(`写入：${docTotal} 文档（并发 6，退避重试 3）…`);
const CONCURRENCY = 6;
const RETRIES = 3;
let written = 0;
const writeErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function postDoc(coll, doc) {
  const body = JSON.stringify({ _name: doc.name ?? `imported ${coll}`, foundry: doc });
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${base}/api/collections/${coll}/campaign/${campaignId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    } catch (e) {
      const cause = e?.cause?.code ?? e?.name ?? e?.message ?? "unknown";
      lastErr = Object.assign(new Error(`网络错误（${cause}）`), { code: "NETWORK" });
      await sleep(300 * attempt);
      continue;
    }
    if (res.ok) { written++; return; }
    const text = await res.text().catch(() => "");
    lastErr = Object.assign(new Error(`${res.status}: ${text.slice(0, 160)}`), { status: res.status, code: res.status === 401 ? "AUTH_EXPIRED" : "HTTP" });
    if (res.status < 500 && res.status !== 429) break;
    await sleep(300 * attempt);
  }
  writeErrors.push({ coll, id: doc._id ?? null, name: doc.name ?? null, error: lastErr?.message ?? String(lastErr), code: lastErr?.code ?? null });
}
{
  let idx = 0;
  const jobs = [];
  for (const [coll, docs] of Object.entries(mapped.collections)) {
    if (!docs?.length) continue;
    for (const doc of docs) jobs.push(() => postDoc(coll, doc));
  }
  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, jobs.length)) }, async () => {
    while (idx < jobs.length) { const job = jobs[idx++]; await job(); }
  });
  await Promise.all(workers);
}
const failed = writeErrors.length;
const authExpired = writeErrors.some((e) => e.code === "AUTH_EXPIRED");
const networkFailed = writeErrors.some((e) => e.code === "NETWORK");
log(`写入完成：成功 ${written} / 失败 ${failed} → 战役 ${campaignId}`);

const result = {
  ok: failed === 0,
  world: {
    path: input, form: dump.__form ?? null,
    title: dump.worldJson?.title ?? null, id: dump.worldJson?.id ?? null,
    system: worldSystem, coreVersion: version.coreVersion, systemVersion: fromSystem,
  },
  migration: migrationInfo,
  assets: assetInfo,
  collections: mapped.report.collections,
  skipped: mapped.report.skipped,
  totals: mapped.report.totals,
  campaign: {
    id: campaignId, name: campaign.name,
    isNew: !opts.campaign,
    playUrl: `${base}/user-files/compat/play.html?campaign=${campaignId}`,
  },
  write: { written, failed, authExpired, errors: writeErrors.slice(0, 10) },
  warnings: mapped.report.warnings,
  base,
  durationMs: Date.now() - startedAt,
};
if (opts.report) writeReport(result);
out(result);
if (failed > 0) {
  if (authExpired) {
    log("✗ 部分写入失败：云端会话过期（401）。战役已部分写入，直接重跑会叠重复文档——建议先删除该战役再带新凭据完整重导。");
  } else if (networkFailed) {
    log("✗ 部分写入失败：网络错误。战役已部分写入，直接重跑会叠重复文档——建议网络恢复后删除该战役重导。");
  } else {
    log("✗ 部分文档写入失败（见 write.errors）。战役数据不完整，建议删除该战役后重导。");
  }
  process.exit(2);
}
process.exit(0);
