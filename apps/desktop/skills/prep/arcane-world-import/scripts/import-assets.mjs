// 阶段 9 M2：导入资产管线（import-assets）——浏览器与 Node 双端可跑的单文件 ESM。
// 约束与 import-core 相同：不 import 任何 node builtins、不依赖 node_modules。
//
// 契约（输入输出全部纯数据，认证/IO 一律注入）：
//   collectAssetRefs(dump) → [{coll, docIndex, docId, field, url, html}]
//       扫描 dump.docs（readWorld 的 toJSON 内存形状）里的资产引用字段。
//   planAssets(dump, refs, opts) → {toUpload, external, builtin, missing, skipped, report}
//       把引用解析到 dump.assets 的字节；按内容 sha256 去重成上传计划；
//       超 MAX_UPLOAD_BYTES（服务端 Kestrel 30,000,000B 上限）进 skipped 不阻断。
//   uploadPlannedAssets(plan, upload, opts) → {urlMap, uploads, failures}
//       upload 为注入函数 async ({bytes, filename, contentType}) => url（本文件不做认证）。
//   rewriteAssetUrls(dump, urlMap) → 新 dump（纯函数：docs 深拷贝、bytes 共享不复制）
//       命中 urlMap 的字段原位重写；每个被改写的文档记 flags.import.originalAssets。
//
// play.html 资产解析基址（N1/R3 实证）：相对路径基于 /user-files/compat/；
// data:/绝对 http(s) 可用；systems/、packages/ 软链到我们 web/packages/ 可用；
// 裸 icons/、modules/、worlds/<id>/…（未上传时）会破——归 missing 仅报告不阻断。
// 上传 URL 形态 https://<host>/user-files/<profile-id>/<yyyy>/<MM>/<dd>/<随机>.<ext>，
// 公开可读、与 play.html 同源，静态 MIME 按落盘扩展名。

// ===========================================================================
// sha256（纯 JS，Uint8Array → hex；内容去重的唯一依赖）
// ===========================================================================
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bitLen = b.length * 8;
  const padded = new Uint8Array(((b.length + 8) >> 6 << 6) + 64);
  padded.set(b);
  padded[b.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + bb) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = "";
  for (const x of h) out += x.toString(16).padStart(8, "0");
  return out;
}

// ===========================================================================
// 常量与判定
// ===========================================================================
// 服务端单请求上限（N1 实测：超限返回 400 ProblemDetails「max request body size is
// 30000000 bytes」，multipart 开销含在内；>30MiB 资产必超）。可被 opts.maxBytes 覆盖。
export const MAX_UPLOAD_BYTES = 30_000_000;

// 上传时按扩展名给 contentType（服务端 GET 的 Content-Type 只看落盘扩展名）
export const MIME_BY_EXT = {
  ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
  ".webm": "video/webm", ".mp4": "video/mp4", ".ogv": "video/ogg", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".wav": "audio/wav",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".pdf": "application/pdf",
  ".json": "application/json", ".txt": "text/plain",
};

// 引用字段：叶子键名命中即候选（值还须长得像资产 URL）
const REF_LEAF_KEYS = new Set(["img", "icon", "src", "thumb", "portrait", "subject", "avatar"]);
// v11 老形态：scene.background/foreground 直接是字符串（v13 已是 {src,…} 对象）
const STRING_FORM_KEYS = new Set(["background", "foreground"]);

const MEDIA_EXT_RE = /\.(png|jpe?g|webp|gif|svg|bmp|avif|tiff?|webm|mp4|ogv|mov|m4v|mp3|ogg|oga|wav|flac|m4a|aac|pdf|glb|gltf|fbx|obj|stl|ttf|otf|woff2?|bin)(?:[?#]|$)/i;
const ROOT_PREFIXES = ["data:", "http://", "https://", "blob:", "//", "worlds/", "systems/", "modules/", "packages/", "icons/", "assets/", "vaults/"];

function isAssetLike(v) {
  return typeof v === "string" && v.length > 0
    && (MEDIA_EXT_RE.test(v) || ROOT_PREFIXES.some((p) => v.startsWith(p)));
}

// 富文本 HTML 里的资源标签（<img>/<video>/<audio>/<source>/<embed> 的 src）
const HTML_SRC_RE = /<(img|video|audio|source|embed)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;

const extOf = (name) => { const i = name.lastIndexOf("."); return i >= 0 ? name.slice(i).toLowerCase() : ""; };
const basenameOf = (p) => { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return i >= 0 ? p.slice(i + 1) : p; };
const mimeFor = (filename) => MIME_BY_EXT[extOf(filename)] ?? "application/octet-stream";

// ===========================================================================
// collectAssetRefs：扫描 dump.docs 的资产引用
// ===========================================================================
// → [{coll, docIndex, docId, field, url, html}]
//   field 是主文档内的点路径（数组用数字段，如 items.3.img）；HTML 富文本字段以
//   「路径(html)」标记（如 system.description.value(html)），url 是抽出的 src 值。
//   docId 是主文档 _id（嵌入子文档的引用也记到其顶层父档）。
export function collectAssetRefs(dump) {
  const out = [];
  for (const [coll, list] of Object.entries(dump?.docs ?? {})) {
    (list ?? []).forEach((doc, docIndex) => {
      if (!doc || typeof doc !== "object") return;
      const docInfo = { coll, docIndex, docId: typeof doc._id === "string" ? doc._id : null };
      walkValue(doc, "", docInfo, out);
    });
  }
  return out;
}

function walkValue(value, path, docInfo, out) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkValue(v, `${path}.${i}`, docInfo, out));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "string") {
      if ((REF_LEAF_KEYS.has(k) || STRING_FORM_KEYS.has(k)) && isAssetLike(v)) {
        out.push({ ...docInfo, field: p, url: v, html: false });
      } else if (k !== "command") { // 宏 command 是代码不是富文本
        collectHtmlRefs(v, p, docInfo, out);
      }
    } else if (v && typeof v === "object") {
      walkValue(v, p, docInfo, out);
    }
  }
}

function collectHtmlRefs(text, path, docInfo, out) {
  if (!text.includes("<") || !/\bsrc\s*=/i.test(text)) return;
  HTML_SRC_RE.lastIndex = 0;
  let m;
  while ((m = HTML_SRC_RE.exec(text)) !== null) {
    const url = m[2] ?? m[3] ?? m[4];
    if (isAssetLike(url)) out.push({ ...docInfo, field: `${path}(html)`, url, html: true });
  }
}

// ===========================================================================
// planAssets：引用 → 上传计划（按内容 sha256 去重）+ 分类清单
// ===========================================================================
// opts:
//   maxBytes       超限阈值（默认 MAX_UPLOAD_BYTES；>阈值进 skipped 不上传）
//   compatBase     builtin 重写基址（默认 "/user-files/compat" 同源根相对；可传
//                  "https://<host>/user-files/compat" 得绝对 URL）
//   builtinExists  注入的存在性谓词 (localPath) => boolean，localPath 形如
//                  "dnd5e/icons/svg/x.svg"（相对 web/packages/）。注入时按真实存在
//                  分类（缺失归 missing）；不注入时 systems/**、packages/** 一律按
//                  builtin 处理（report.assumedBuiltin 计数提示调用方自行核实）。
// 返回：
//   toUpload: Map<sha256, {hash, bytes, filename, contentType, worldPaths[], refs[]}>
//   external: [{url, refs[]}]   —— data:/http(s)/blob，不动
//   builtin:  [{url, newUrl, localPath, refs[]}] —— 重写成 compatBase 下同源路径
//   missing:  [{url, reason, refs[]}] —— 找不到字节/根不在 compat 层，report-only 不阻断
//   skipped:  [{url, worldPath, size, reason, refs[]}] —— 超限等不可上传，report-only
//   report:   {totals, suspicious, assumedBuiltin, fields, notes}
export function planAssets(dump, refs, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const compatBase = String(opts.compatBase ?? "/user-files/compat").replace(/\/+$/, "");
  const builtinExists = typeof opts.builtinExists === "function" ? opts.builtinExists : null;

  const assets = dump?.assets ?? [];
  const byPath = new Map(assets.map((a) => [a.path, a]));
  const byPathLower = new Map(assets.map((a) => [a.path.toLowerCase(), a]));
  const findAsset = (p) => byPath.get(p) ?? byPathLower.get(p.toLowerCase())
    ?? byPath.get(safeDecode(p)) ?? byPathLower.get(safeDecode(p).toLowerCase()) ?? null;

  const toUpload = new Map();
  const buckets = { external: [], builtin: [], missing: [], skipped: [] };
  const classified = new Map(); // url → bucket 条目（refs 聚合用）
  const suspicious = [];
  let assumedBuiltin = 0;
  const fieldKinds = new Map(); // 覆盖面统计：field 形状 → 引用数

  const classify = (url) => {
    if (/^(data:|https?:|blob:|\/\/)/i.test(url)) {
      return { bucket: "external", entry: { url, refs: [] } };
    }
    // systems/<pkg>/<rest>、packages/<pkg>/<rest> → 我们 web/packages/<pkg>/<rest>
    const sysMatch = /^(systems|packages)\/([^/]+)\/(.+)$/.exec(url);
    if (sysMatch) {
      const localPath = `${sysMatch[2]}/${sysMatch[3]}`;
      const known = builtinExists ? builtinExists(localPath) : true;
      if (!known) {
        return { bucket: "missing", entry: { url, reason: `builtin 文件缺失：web/packages/${localPath} 不存在`, refs: [] } };
      }
      if (!builtinExists) assumedBuiltin++;
      return { bucket: "builtin", entry: { url, newUrl: `${compatBase}/${url}`, localPath, refs: [] } };
    }
    // 世界资产：worlds/<id>/<rest>（剥前两段）或裸相对路径（assets/… 等）都查 dump.assets
    const candidates = [];
    if (url.startsWith("worlds/")) {
      const segs = url.split("/");
      if (segs.length >= 3) candidates.push(segs.slice(2).join("/"));
    }
    candidates.push(url);
    let asset = null;
    for (const c of candidates) { asset = findAsset(c); if (asset) break; }
    if (asset) {
      if (asset.bytes.length > maxBytes) {
        return { bucket: "skipped", entry: { url, worldPath: asset.path, size: asset.bytes.length, reason: `over-limit：${asset.bytes.length}B > ${maxBytes}B（服务端 30,000,000B 上限）`, refs: [] } };
      }
      return { bucket: "upload", asset };
    }
    const reason = url.startsWith("modules/")
      ? "modules/ 模块资产：compat 层未安装对应模块"
      : url.startsWith("icons/")
        ? "icons/ Foundry 核心图标：compat 层无此根"
        : "引用的世界资产未随包携带字节（dump.assets 无此路径）";
    return { bucket: "missing", entry: { url, reason, refs: [] } };
  };

  for (const ref of refs) {
    if (!isAssetLike(ref.url)) continue;
    fieldKinds.set(ref.field, (fieldKinds.get(ref.field) ?? 0) + 1);
    let cls = classified.get(ref.url);
    if (!cls) { cls = classify(ref.url); classified.set(ref.url, cls); }
    if (cls.bucket === "upload") {
      const { asset } = cls;
      const hash = sha256Hex(asset.bytes);
      let entry = toUpload.get(hash);
      if (!entry) {
        entry = { hash, bytes: asset.bytes, filename: basenameOf(asset.path), contentType: mimeFor(basenameOf(asset.path)), worldPaths: [asset.path], refs: [] };
        toUpload.set(hash, entry);
        const sus = sniffMismatch(asset.bytes, entry.filename);
        if (sus) suspicious.push({ url: ref.url, worldPath: asset.path, ...sus });
      } else if (!entry.worldPaths.includes(asset.path)) {
        entry.worldPaths.push(asset.path);
      }
      entry.refs.push(ref);
    } else {
      cls.entry.refs.push(ref);
      if (!buckets[cls.bucket].includes(cls.entry)) buckets[cls.bucket].push(cls.entry);
    }
  }

  const uploadRefs = [...toUpload.values()].reduce((n, e) => n + e.refs.length, 0);
  const uploadBytes = [...toUpload.values()].reduce((n, e) => n + e.bytes.length, 0);
  const report = {
    totals: {
      refs: refs.length,
      uploadRefs, uploadEntries: toUpload.size, uploadBytes,
      external: buckets.external.length, builtin: buckets.builtin.length,
      missing: buckets.missing.length, skipped: buckets.skipped.length,
    },
    dedup: { refsCollapsed: uploadRefs - toUpload.size },
    suspicious,
    assumedBuiltin,
    fields: [...fieldKinds.entries()].map(([field, n]) => ({ field, refs: n }))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
    notes: [
      "字段覆盖：任意嵌套层级的 img/icon/src/thumb/portrait/subject/avatar 叶子键 + scene.background/foreground 字符串老形态 + 富文本 <img|video|audio|source|embed src>",
      "未覆盖：world.json 的 background/manifest 等非文档字段；playlist sound 的 v11 老 path 键；CSS url()；宏 command 内字符串",
    ],
  };
  return { toUpload, external: buckets.external, builtin: buckets.builtin, missing: buckets.missing, skipped: buckets.skipped, suspicious, report };
}

function safeDecode(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

// 扩展名宣称是图片但魔数不符 → 上传仍照常（服务端不校验内容，N1 实证），report 提示
function sniffMismatch(bytes, filename) {
  const ext = extOf(filename);
  const startsWith = (sig, off = 0) => sig.every((b, i) => bytes[off + i] === b);
  const checks = {
    ".jpg": () => startsWith([0xff, 0xd8, 0xff]), ".jpeg": () => startsWith([0xff, 0xd8, 0xff]),
    ".png": () => startsWith([0x89, 0x50, 0x4e, 0x47]),
    ".webp": () => startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8),
    ".gif": () => startsWith([0x47, 0x49, 0x46, 0x38]),
    ".svg": () => { let i = 0; while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++; return bytes[i] === 0x3c; },
  };
  const check = checks[ext];
  if (!check) return null;
  return check() ? null : { kind: "content-mismatch", detail: `扩展名 ${ext} 与内容魔数不符（服务端不校验，仍上传）` };
}

// ===========================================================================
// uploadPlannedAssets：注入上传函数驱动（本文件不做认证）
// ===========================================================================
// upload: async ({bytes, filename, contentType}) => url（失败抛错即记 failures，
// 对应引用保持原值不重写，不阻断整体）。urlMap 键是引用原串，值是上传返回 URL。
export async function uploadPlannedAssets(plan, upload, { concurrency = 4 } = {}) {
  const urlMap = new Map();
  const uploads = [];
  const failures = [];
  const entries = [...(plan?.toUpload?.values?.() ?? [])];
  let idx = 0;
  const worker = async () => {
    while (idx < entries.length) {
      const entry = entries[idx++];
      try {
        const url = await upload({ bytes: entry.bytes, filename: entry.filename, contentType: entry.contentType });
        uploads.push({ url, hash: entry.hash, filename: entry.filename, size: entry.bytes.length, worldPaths: [...entry.worldPaths], refCount: entry.refs.length });
        for (const ref of entry.refs) urlMap.set(ref.url, url);
      } catch (err) {
        failures.push({ hash: entry.hash, filename: entry.filename, error: String(err?.message ?? err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker));
  return { urlMap, uploads, failures };
}

// ===========================================================================
// rewriteAssetUrls：按 urlMap 重写（纯函数，docs 深拷贝、资产字节共享）
// ===========================================================================
// 返回新 dump；命中 urlMap 的字段原位替换，未命中的（external/missing/skipped）原样。
// 每个发生改写的主文档记 flags.import.originalAssets = { 原url: 新url, … }（HTML 字段
// 的改写同样入账；mapWorld 的 flags.import 合并逻辑会保真携带该标记）。
export function rewriteAssetUrls(dump, urlMap) {
  if (!urlMap || typeof urlMap.get !== "function") throw new Error("rewriteAssetUrls：urlMap 需为 Map<原url, 新url>");
  const docsOut = {};
  const stats = { rewrittenFields: 0, htmlRewrites: 0, docsTouched: 0 };
  for (const [coll, list] of Object.entries(dump?.docs ?? {})) {
    docsOut[coll] = (list ?? []).map((doc) => rewriteDoc(doc, urlMap, stats));
  }
  return { ...dump, docs: docsOut, __assetRewrite: stats };
}

function rewriteDoc(doc, urlMap, stats) {
  const clone = deepCloneJson(doc);
  if (!clone || typeof clone !== "object") return clone;
  const originals = {}; // 原url → 新url
  for (const ref of collectAssetRefs({ docs: { c: [clone] } })) {
    const segs = ref.html ? ref.field.replace(/\(html\)$/, "").split(".") : ref.field.split(".");
    let node = clone;
    let ok = true;
    for (const s of segs) {
      if (node == null || typeof node !== "object") { ok = false; break; }
      node = node[s];
    }
    if (!ok || typeof node !== "string") continue; // 形状变化导致路径失效：跳过不阻断
    if (ref.html) {
      const rewritten = rewriteHtmlField(node, urlMap, originals);
      if (rewritten !== node) {
        setAtPath(clone, segs, rewritten);
        stats.rewrittenFields++;
        stats.htmlRewrites++;
      }
    } else if (urlMap.has(node)) {
      const next = urlMap.get(node);
      originals[node] = next;
      setAtPath(clone, segs, next);
      stats.rewrittenFields++;
    }
  }
  if (Object.keys(originals).length > 0) {
    const flags = { ...(clone.flags ?? {}) };
    flags.import = { ...(flags.import ?? {}), originalAssets: { ...(flags.import?.originalAssets ?? {}), ...originals } };
    clone.flags = flags;
    stats.docsTouched++;
  }
  return clone;
}

function rewriteHtmlField(html, urlMap, originals) {
  let out = "";
  let pos = 0;
  HTML_SRC_RE.lastIndex = 0;
  let m;
  while ((m = HTML_SRC_RE.exec(html)) !== null) {
    const url = m[2] ?? m[3] ?? m[4];
    if (urlMap.has(url)) {
      const next = urlMap.get(url);
      out += html.slice(pos, m.index) + m[0].split(url).join(next);
      pos = m.index + m[0].length;
      originals[url] = next;
    }
  }
  return pos === 0 ? html : out + html.slice(pos);
}

function setAtPath(root, segs, value) {
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    if (node == null || typeof node !== "object") return;
    node = node[segs[i]];
  }
  if (node != null && typeof node === "object") node[segs[segs.length - 1]] = value;
}

// 纯数据深拷贝（dump.docs 来自 JSON.parse，无 TypedArray；TypedArray 一律共享引用不复制）
function deepCloneJson(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deepCloneJson);
  if (ArrayBuffer.isView(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = deepCloneJson(val);
  return out;
}
