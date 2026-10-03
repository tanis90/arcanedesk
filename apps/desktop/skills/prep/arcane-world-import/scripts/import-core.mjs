// 阶段 9 M1：FVTT 世界导入核心（import-core）——浏览器与 Node 双端可跑的单文件 ESM。
// 约束：不 import 任何 node builtins、不依赖 node_modules；snappy 解压自 snappyjs 0.7.0
// （MIT，Zhipeng Jia）精简内联（见下方 vendored 段，仅保留 Uint8Array 解压路径）。
//
// 覆盖四件事（ADR D9）：
//   1) readWorld(source)：zip（中央目录自解析 + DecompressionStream("deflate-raw")）或
//      目录文件映射（files Map）→ 世界数据。LevelDB 读取层全自写：.ldb SSTable（物理键尾
//      8 字节 InternalKey tag 剥离，同键多代取 seq 最大者，type=0 墓碑）+ .log WAL 回放
//      （pending 写入，键不带 tag）。嵌入文档按键路径重组内联回父文档（toJSON 内存形状：
//      actor.items/effects 全文档数组、scene.tokens/walls/… 数组、token.delta 单对象、
//      actors.items.effects 三层同理）。
//   2) detectVersion(worldJson, docs)：版本探测与拒绝（NeDB ≤v10 / 无 world.json /
//      compatibility 无法解析）。
//   3) mapWorld(dump, {gmUserId})：分层映射（T1 全收 / T2 仅落库 / T3 跳过），纯函数零 IO。
//      安全拍平：users 剥 password/passwordSalt；ownership 拍平 {default:0} 原值入
//      flags.import.originalOwnership；folder 路径入 flags.import.folderPath。
//   4) NeDB 残留：data/ 下 LevelDB 与 .db 并存时以 LevelDB 为准（warning 记录）。
//
// 已钉死的格式事实（R1 spike 实证，两真实世界 28 个 DB 与 classic-level 逐键全等）：
//   键语法 `!<collection>[.<embedded>…]<id>[.<id>]…`（id 为 16 位 [0-9a-zA-Z]，嵌入是
//   独立键、父档数组只存子 id 字符串）；.ldb 物理键 = 逻辑键 + 尾 8B tag（(seq<<8)|type
//   小端）；.log 是 32KB 分块、7B 记录头的 WriteBatch 流。

// ===========================================================================
// vendored：snappy 解压（出自 snappyjs 0.7.0 · MIT · Copyright (c) 2016 Zhipeng Jia）
// https://github.com/zhipeng-jia/snappyjs —— 仅保留解压路径，Buffer 依赖改写为纯 Uint8Array。
// MIT 许可证原文见仓库 LICENSE 或上游 package；此处按 MIT 允许的方式内联分发。
// ===========================================================================
const WORD_MASK = [0, 0xff, 0xffff, 0xffffff, 0xffffffff];

function snappyReadUncompressedLength(array, posRef) {
  let result = 0;
  let shift = 0;
  let pos = posRef.pos;
  while (shift < 32 && pos < array.length) {
    const c = array[pos];
    pos += 1;
    posRef.pos = pos;
    const val = c & 0x7f;
    if (((val << shift) >>> shift) !== val) return -1;
    result |= val << shift;
    if (c < 128) return result;
    shift += 7;
  }
  return -1;
}

function snappyUncompressToBuffer(array, pos, outBuffer) {
  const arrayLength = array.length;
  let outPos = 0;
  while (pos < arrayLength) {
    const c = array[pos];
    pos += 1;
    if ((c & 0x3) === 0) {
      // Literal
      let len = (c >>> 2) + 1;
      if (len > 60) {
        if (pos + 3 >= arrayLength) return false;
        const smallLen = len - 60;
        len = array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
        len = (len & WORD_MASK[smallLen]) + 1;
        pos += smallLen;
      }
      if (pos + len > arrayLength) return false;
      for (let i = 0; i < len; i++) outBuffer[outPos + i] = array[pos + i];
      pos += len;
      outPos += len;
    } else {
      let len;
      let offset;
      switch (c & 0x3) {
        case 1:
          len = ((c >>> 2) & 0x7) + 4;
          offset = array[pos] + ((c >>> 5) << 8);
          pos += 1;
          break;
        case 2:
          if (pos + 1 >= arrayLength) return false;
          len = (c >>> 2) + 1;
          offset = array[pos] + (array[pos + 1] << 8);
          pos += 2;
          break;
        case 3:
          if (pos + 3 >= arrayLength) return false;
          len = (c >>> 2) + 1;
          offset = array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
          pos += 4;
          break;
        default:
          return false;
      }
      if (offset === 0 || offset > outPos) return false;
      for (let i = 0; i < len; i++) outBuffer[outPos + i] = outBuffer[outPos - offset + i];
      outPos += len;
    }
  }
  return true;
}

function snappyUncompress(compressed) {
  const posRef = { pos: 0 };
  const length = snappyReadUncompressedLength(compressed, posRef);
  if (length === -1) throw new Error("Invalid Snappy bitstream");
  const out = new Uint8Array(length);
  if (!snappyUncompressToBuffer(compressed, posRef.pos, out)) throw new Error("Invalid Snappy bitstream");
  return out;
}

// ===========================================================================
// 字节工具（仅用标准全局：DataView / TextDecoder / DecompressionStream）
// ===========================================================================
const UTF8 = new TextDecoder("utf-8");
const utf8 = (bytes) => UTF8.decode(bytes);

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError("期望 Uint8Array/ArrayBuffer");
}

function u16(b, pos) { return b[pos] | (b[pos + 1] << 8); }
function u32(b, pos) { return (b[pos] | (b[pos + 1] << 8) | (b[pos + 2] << 16)) + b[pos + 3] * 0x100000000; }
function u64Big(b, pos) { return new DataView(b.buffer, b.byteOffset + pos, 8).getBigUint64(0, true); }

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function varint(b, pos) {
  let shift = 0;
  let result = 0;
  while (pos < b.length) {
    const byte = b[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return [result, pos];
    shift += 7;
  }
  throw new Error("varint 越界");
}

// ===========================================================================
// zip：中央目录自解析 + DecompressionStream("deflate-raw")（STORED 直通）
// ===========================================================================
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_EOCD64_LOCATOR_SIG = 0x07064b50;
const ZIP_EOCD64_SIG = 0x06064b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("运行环境缺少 DecompressionStream（需浏览器或 Node ≥18）");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// 解析 zip → Map<相对路径, Uint8Array>（目录条目与 __MACOSX 跳过）
export async function unzipToMap(zipBytes) {
  const b = asUint8Array(zipBytes);
  if (b.length < 22) throw new Error("zip：文件过小（< EOCD 尺寸）");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // EOCD：从尾部向前扫（注释最长 64KB）
  let eocd = -1;
  const scanFloor = Math.max(0, b.length - 22 - 65536);
  for (let i = b.length - 22; i >= scanFloor; i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip：找不到中央目录（EOCD）");
  let entryCount = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  // zip64：EOCD 字段为 0xFFFF/0xFFFFFFFF 时经 locator 找 zip64 EOCD
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || dv.getUint32(locator, true) !== ZIP_EOCD64_LOCATOR_SIG) {
      throw new Error("zip：zip64 locator 缺失");
    }
    const eocd64 = Number(dv.getBigUint64(locator + 8, true));
    if (eocd64 + 56 > b.length || dv.getUint32(eocd64, true) !== ZIP_EOCD64_SIG) {
      throw new Error("zip：zip64 EOCD 损坏");
    }
    entryCount = Number(dv.getBigUint64(eocd64 + 32, true));
    cdOffset = Number(dv.getBigUint64(eocd64 + 48, true));
  }
  const out = new Map();
  let pos = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > b.length || dv.getUint32(pos, true) !== ZIP_CENTRAL_SIG) {
      throw new Error(`zip：中央目录条目 #${n} 损坏`);
    }
    const method = dv.getUint16(pos + 10, true);
    const uncompSize32 = dv.getUint32(pos + 24, true);
    let compSize = dv.getUint32(pos + 20, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    let localOffset = dv.getUint32(pos + 42, true);
    // zip64 扩展字段（id 0x0001）：8 字节字段按 uncomp → comp → offset → disk 顺序出现，
    // 各字段仅在中央目录里的 32 位原值为 0xFFFFFFFF 时存在
    let extraPos = pos + 46 + nameLen;
    const extraEnd = extraPos + extraLen;
    while (extraPos + 4 <= extraEnd) {
      const id = dv.getUint16(extraPos, true);
      const size = dv.getUint16(extraPos + 2, true);
      if (id === 0x0001) {
        let f = extraPos + 4;
        if (uncompSize32 === 0xffffffff) f += 8;
        if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(f, true)); f += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(dv.getBigUint64(f, true)); f += 8; }
      }
      extraPos += 4 + size;
    }
    const name = utf8(b.subarray(pos + 46, pos + 46 + nameLen));
    pos = extraEnd + commentLen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
    // 本地头：文件名/扩展长度可变，解析后取数据起点
    if (localOffset + 30 > b.length || dv.getUint32(localOffset, true) !== ZIP_LOCAL_SIG) {
      throw new Error(`zip：本地头损坏（${name}）`);
    }
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(dataStart, dataStart + compSize);
    if (method === ZIP_METHOD_STORED) out.set(name, new Uint8Array(raw));
    else if (method === ZIP_METHOD_DEFLATE) out.set(name, await inflateRaw(raw));
    else throw new Error(`zip：不支持的压缩方法 ${method}（${name}）`);
  }
  return out;
}

// ===========================================================================
// LevelDB 读取层：SSTable（.ldb）解析 —— 魔数/footer/index block/数据块（前缀压缩键）
// ===========================================================================
const SSTABLE_MAGIC = 0xdb4775248b80fb57n;
const BLOCK_SNAPPY = 1;

// 解析一个数据块（含尾部 restart 数组）→ [[key, value], …]
function parseSSTableBlock(block) {
  if (block.length < 4) return [];
  const numRestarts = u32(block, block.length - 4);
  const dataEnd = block.length - 4 - numRestarts * 4;
  if (dataEnd <= 0 || dataEnd >= block.length) return [];
  const entries = [];
  let pos = 0;
  let key = new Uint8Array(0);
  while (pos < dataEnd) {
    let shared;
    let nonShared;
    let valueLen;
    [shared, pos] = varint(block, pos);
    [nonShared, pos] = varint(block, pos);
    [valueLen, pos] = varint(block, pos);
    if (pos + nonShared + valueLen > dataEnd) break;
    key = concatBytes(key.subarray(0, shared), block.subarray(pos, pos + nonShared));
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    entries.push([key, value]);
  }
  return entries;
}

// 读一个块句柄（两个 varint）→ 解压后的块字节
function readSSTableBlock(file, offset, size) {
  const type = file[offset + size];
  const data = file.subarray(offset, offset + size);
  if (type === 0) return data;
  if (type === BLOCK_SNAPPY) return snappyUncompress(data);
  throw new Error(`LevelDB 块压缩类型未知：${type}`);
}

// 解析整个 .ldb → [[物理键(含 8B tag), value], …]
export function readSSTable(fileBuf) {
  const file = asUint8Array(fileBuf);
  if (file.length < 48) throw new Error("不是 LevelDB SSTable（文件 < 48B）");
  const footer = file.subarray(file.length - 48);
  if (u64Big(footer, 40) !== SSTABLE_MAGIC) throw new Error("不是 LevelDB SSTable（魔数不符）");
  // footer：[metaindex offset,size][index offset,size][padding][magic8]
  let pos = 0;
  let mOff; [mOff, pos] = varint(footer, pos);
  let mSize; [mSize, pos] = varint(footer, pos);
  let iOff; [iOff, pos] = varint(footer, pos);
  let iSize; [iSize, pos] = varint(footer, pos);
  const indexHandle = { offset: Number(iOff), size: Number(iSize) };
  const out = [];
  const indexBlock = readSSTableBlock(file, indexHandle.offset, indexHandle.size);
  for (const [, handleValue] of parseSSTableBlock(indexBlock)) {
    let hp = 0;
    let bOff; [bOff, hp] = varint(handleValue, hp);
    let bSize; [bSize, hp] = varint(handleValue, hp);
    const block = readSSTableBlock(file, Number(bOff), Number(bSize));
    for (const [k, v] of parseSSTableBlock(block)) out.push([k, v]);
  }
  return out;
}

// ===========================================================================
// LevelDB 读取层：WAL（.log）解析 —— 32KB 分块、7B 记录头、分片记录拼装、WriteBatch 载荷
// ===========================================================================
const WAL_BLOCK = 32768;
const WAL_HEADER = 7;
const WAL_FULL = 1;
const WAL_FIRST = 2;
const WAL_MIDDLE = 3;
const WAL_LAST = 4;

// → [{index, payload:Uint8Array}]（拼装完成的逻辑记录）
export function parseWalLog(buf) {
  const b = asUint8Array(buf);
  let blockStart = 0;
  let logical = 0;
  let payload = new Uint8Array(0);
  const records = [];
  while (blockStart < b.length) {
    const blockEnd = Math.min(blockStart + WAL_BLOCK, b.length);
    let pos = blockStart;
    if (blockEnd - pos < WAL_HEADER) break; // 块尾 trailer 填充
    while (pos + WAL_HEADER <= blockEnd) {
      const len = u16(b, pos + 4);
      const type = b[pos + 6];
      if (len === 0 && type === 0) break; // 零填充
      if (pos + WAL_HEADER + len > blockEnd) throw new Error(`WAL 记录越过块边界（@${pos}）`);
      const data = b.subarray(pos + WAL_HEADER, pos + WAL_HEADER + len);
      pos += WAL_HEADER + len;
      if (type === WAL_FULL || type === WAL_FIRST) payload = new Uint8Array(data);
      else payload = concatBytes(payload, data); // MIDDLE / LAST
      if (type === WAL_FULL || type === WAL_LAST) {
        records.push({ index: logical++, payload });
        payload = new Uint8Array(0);
      }
    }
    blockStart = blockEnd;
  }
  return records;
}

// WriteBatch 载荷：seq(8) count(4) 后跟 [tag(1) varint klen key varint vlen value]，tag 0=删除
export function parseWriteBatch(payload) {
  const b = asUint8Array(payload);
  const seq = Number(u64Big(b, 0));
  const count = u32(b, 8);
  let pos = 12;
  const ops = [];
  for (let i = 0; i < count; i++) {
    const tag = b[pos++];
    let klen; [klen, pos] = varint(b, pos);
    const key = b.subarray(pos, pos + klen);
    pos += klen;
    if (tag === 0) { ops.push({ op: "del", key }); continue; }
    if (tag !== 1) throw new Error(`WriteBatch 未知 tag ${tag}`);
    let vlen; [vlen, pos] = varint(b, pos);
    const value = b.subarray(pos, pos + vlen);
    pos += vlen;
    ops.push({ op: "put", key, value });
  }
  return { seq, count, ops };
}

// ===========================================================================
// 单集合目录读取：.ldb 多代合并 + .log 回放 → Map<逻辑键, JSON 字符串>
// ===========================================================================
// .log 写入永远晚于已落盘的 .ldb（seq 偏移 1e12 保证）；同一 batch 内按 op 顺延 seq
const LOG_SEQ_BASE = 1e12;

export function readLevelDbDir(files, { onWarning } = {}) {
  // files: [{name, bytes}] —— 集合目录内全部文件
  const byName = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const map = new Map(); // 逻辑键 → {seq, type, value}
  let pendingLogEntries = 0;
  for (const f of byName) {
    if (!f.name.endsWith(".ldb")) continue;
    let entries;
    try {
      entries = readSSTable(f.bytes);
    } catch (e) {
      const msg = `SSTable 解析失败 ${f.name}：${e.message}`;
      if (onWarning) onWarning(msg); else throw e;
      continue;
    }
    for (const [ik, v] of entries) {
      if (ik.length <= 8) continue;
      const tag = ik.subarray(ik.length - 8);
      const type = tag[0]; // 1=put 0=墓碑
      const seq = Number(u64Big(tag, 0) >> 8n);
      const key = utf8(ik.subarray(0, ik.length - 8));
      const prev = map.get(key);
      if (!prev || seq > prev.seq) map.set(key, { seq, type, value: v });
    }
  }
  for (const f of byName) {
    if (!/^\d+\.log$/.test(f.name) || f.bytes.length === 0) continue;
    for (const record of parseWalLog(f.bytes)) {
      const batch = parseWriteBatch(record.payload);
      batch.ops.forEach((op, i) => {
        const key = utf8(op.key);
        const seq = LOG_SEQ_BASE + batch.seq + i;
        const prev = map.get(key);
        if (!prev || seq >= prev.seq) {
          map.set(key, { seq, type: op.op === "del" ? 0 : 1, value: op.value ?? new Uint8Array(0) });
          pendingLogEntries++;
        }
      });
    }
  }
  const docs = new Map(); // 逻辑键 → JSON 字符串（墓碑即删除，不复活）
  for (const [k, e] of map) if (e.type === 1) docs.set(k, utf8(e.value));
  return { docs, pendingLogEntries };
}

// ===========================================================================
// 键语法与嵌入重组
// ===========================================================================
// `!<coll>[.<embedded>…]<id>[.<id>]…`；嵌入文档名字母全小写，id 为 [0-9a-zA-Z]
const KEY_RE = /^!([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*)!([0-9a-zA-Z]+(?:\.[0-9a-zA-Z]+)*)$/;
// 单对象嵌入（父档字段存子 id 字符串而非 id 数组）——已知仅 ActorDelta（scenes.tokens.delta）
const SINGLE_EMBEDDED = new Set(["delta"]);

function parseCollectionKey(key) {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { collPath: m[1].split("."), ids: m[2].split(".") };
}

// 把一个集合的 (逻辑键→JSON) 重组为：主文档数组（嵌入按 toJSON 内存形状内联）+ 计数
function recombineCollection(collName, rawDocs) {
  const primaries = new Map(); // id → doc
  const embedded = []; // {embeddedPath, ids, id, doc}
  let other = 0;
  for (const [key, json] of rawDocs) {
    const parsed = parseCollectionKey(key);
    let doc;
    try { doc = JSON.parse(json); } catch { other++; continue; }
    if (!doc || typeof doc !== "object") { other++; continue; }
    if (!parsed) { other++; continue; }
    if (parsed.collPath[0] !== collName) { other++; continue; } // 键前缀与目录不符
    if (parsed.collPath.length === 1 && parsed.ids.length === 1) primaries.set(parsed.ids[0], doc);
    else embedded.push({ embeddedPath: parsed.collPath.slice(1), ids: parsed.ids, id: parsed.ids[parsed.ids.length - 1], doc });
  }
  // 嵌入按 id 路径深度排序（父先于子，三层嵌套内联正确）
  embedded.sort((a, b) => a.ids.length - b.ids.length);
  const byFullPath = new Map(); // "<id>.<id>[.<id>]" → embedded
  for (const e of embedded) byFullPath.set(e.ids.join("."), e);
  const orphanSamples = [];
  for (const e of embedded) {
    const parentIds = e.ids.slice(0, -1);
    let owner;
    if (parentIds.length === 1) owner = primaries.get(parentIds[0]);
    else owner = byFullPath.get(parentIds.join("."))?.doc;
    if (!owner || typeof owner !== "object") {
      other++;
      if (orphanSamples.length < 3) orphanSamples.push(e.ids.join("."));
      continue;
    }
    const field = e.embeddedPath[e.embeddedPath.length - 1];
    const slot = owner[field];
    if (Array.isArray(slot)) {
      // 父档存子 id 数组：原位替换（保持顺序），缺失则追加
      const idx = slot.indexOf(e.id);
      if (idx >= 0) slot[idx] = e.doc;
      else slot.push(e.doc);
    } else if (typeof slot === "string" || SINGLE_EMBEDDED.has(field)) {
      owner[field] = e.doc; // 单对象嵌入（如 token.delta）
    } else if (slot === undefined || slot === null) {
      owner[field] = SINGLE_EMBEDDED.has(field) ? e.doc : [e.doc];
    } else {
      other++; // 字段形状未预期（已内联/非数组非 id）
    }
  }
  return {
    docs: [...primaries.values()],
    counts: { primaries: primaries.size, embedded: embedded.length, other },
    orphanSamples,
  };
}

// ===========================================================================
// readWorld：世界读取入口
// ===========================================================================
// source 二选一：{kind:"zip", bytes} 或 {kind:"files", files:Map<相对路径, Uint8Array>}
// （目录形态由适配层把文件喂成 files 映射；路径一律世界根相对、正斜杠）。
// → { worldJson, docs, counts, assets, version, warnings }
//   docs: Record<集合名, 主文档数组>（嵌入已内联为 toJSON 内存形状）
//   counts: Record<集合名, {primaries, embedded, pendingLog, other}>
//   assets: [{path, bytes}]（path 为世界根相对路径，M1 只携带不落库）
export async function readWorld(source) {
  const warnings = [];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  let files;
  if (source?.kind === "zip") files = await unzipToMap(source.bytes);
  else if (source?.kind === "files") files = normalizeFilesMap(source.files);
  else throw new Error("readWorld：source 需为 {kind:\"zip\", bytes} 或 {kind:\"files\", files}");
  if (files.size === 0) throw new Error("世界包为空（无文件）");

  // world.json 定位：根，或唯一公共前缀目录下
  let root = "";
  let worldJson = null;
  let worldJsonRaw = files.get("world.json");
  if (worldJsonRaw === undefined) {
    const candidates = [...files.keys()].filter((k) => k.endsWith("/world.json"));
    const dirs = new Set(candidates.map((k) => k.slice(0, -"world.json".length)));
    if (dirs.size === 1) {
      root = [...dirs][0];
      worldJsonRaw = files.get(`${root}world.json`);
    }
  }
  if (worldJsonRaw !== undefined) {
    try { worldJson = JSON.parse(utf8(worldJsonRaw)); } catch (e) { warn(`world.json 解析失败：${e.message}`); }
  } else {
    warn("缺少 world.json");
  }

  // data/ 分组：<coll>/<file> vs <coll>.db NeDB 残留（键已去掉 "data/" 前缀）
  const dirFiles = new Map(); // coll → [{name, bytes}]
  const nedbFiles = []; // "actors" 等（data/<coll>.db）
  for (const [path, bytes] of files) {
    const rel = root ? (path.startsWith(root) ? path.slice(root.length) : null) : path;
    if (!rel?.startsWith("data/")) continue;
    const seg = rel.slice("data/".length).split("/");
    if (seg.length === 1 && seg[0].endsWith(".db")) { nedbFiles.push(seg[0].replace(/\.db$/, "")); continue; }
    if (seg.length !== 2) continue; // data/<coll>/<file> 之外的形状忽略
    const coll = seg[0];
    if (!dirFiles.has(coll)) dirFiles.set(coll, []);
    dirFiles.get(coll).push({ name: seg[1], bytes });
  }

  // NeDB 检测：① data/ 下无任何 LevelDB 目录（有 .ldb 或非空 .log 才算）只有 .db；
  // ② world.json compatibility 老格式 + coreVersion ≤ 10
  const hasLevelDb = [...dirFiles.values()].some((fl) =>
    fl.some((f) => f.name.endsWith(".ldb") || (/^\d+\.log$/.test(f.name) && f.bytes.length > 0)));
  const coreMajor = majorOf(worldJson?.coreVersion);
  const oldCompat = !!worldJson && worldJson.compatibility === undefined
    && (worldJson.minimumCoreVersion !== undefined || worldJson.compatibleCoreVersion !== undefined);
  const nedb = (nedbFiles.length > 0 && !hasLevelDb)
    || (oldCompat && (coreMajor === null || coreMajor <= 10));
  for (const coll of nedbFiles) {
    if (dirFiles.has(coll)) warn(`NeDB 残留 data/${coll}.db（v10→v11 迁移残留，以 LevelDB 为准）`);
    else warn(`data/${coll}.db 为 NeDB 且无 LevelDB 目录`);
  }

  // 逐集合读取 + 重组
  const docs = {};
  const counts = {};
  for (const [coll, fl] of dirFiles) {
    if (fl.length === 0) { docs[coll] = []; counts[coll] = { primaries: 0, embedded: 0, pendingLog: 0, other: 0 }; continue; }
    const { docs: rawDocs, pendingLogEntries } = readLevelDbDir(fl, { onWarning: warn });
    const { docs: combined, counts: c, orphanSamples } = recombineCollection(coll, rawDocs);
    docs[coll] = combined;
    counts[coll] = { ...c, pendingLog: pendingLogEntries };
    for (const s of orphanSamples) warn(`集合 ${coll} 嵌入文档孤儿（父不存在）：${s}`);
  }

  // assets/：只携带路径与字节（M1 不上传不重写）
  const assets = [];
  for (const [path, bytes] of files) {
    const rel = root ? (path.startsWith(root) ? path.slice(root.length) : null) : path;
    if (rel?.startsWith("assets/") && !rel.endsWith("/")) assets.push({ path: rel, bytes });
  }
  assets.sort((a, b) => (a.path < b.path ? -1 : 1));

  const version = {
    coreVersion: worldJson?.coreVersion ?? null,
    systemVersion: worldJson?.systemVersion ?? null,
    system: worldJson?.system ?? null,
    id: worldJson?.id ?? null,
    title: worldJson?.title ?? null,
    nedb,
  };
  return { worldJson, docs, counts, assets, version, warnings };
}

function normalizeFilesMap(files) {
  const out = new Map();
  const put = (k, v) => out.set(k.replace(/^\.\//, "").replace(/\\/g, "/"), asUint8Array(v));
  if (files instanceof Map) { for (const [k, v] of files) put(k, v); }
  else if (files && typeof files === "object") { for (const [k, v] of Object.entries(files)) put(k, v); }
  else throw new Error("readWorld：files 需为 Map<路径, Uint8Array>");
  return out;
}

// ===========================================================================
// detectVersion：版本探测与拒绝
// ===========================================================================
function majorOf(version) {
  if (version === null || version === undefined) return null;
  const m = /^(\d+)/.exec(String(version));
  return m ? Number(m[1]) : null;
}

function parseableVersion(v) {
  return v === undefined || v === null || typeof v === "string" || typeof v === "number";
}

// → {coreVersion, systemVersion, ok, reason}；ok=false：NeDB（≤v10 / 老格式）、无 world.json、
// compatibility 无法解析。coreVersion 缺失时回退取文档 _stats 的最大 coreVersion。
export function detectVersion(worldJson, docs = {}) {
  if (!worldJson || typeof worldJson !== "object") {
    return { coreVersion: null, systemVersion: null, ok: false, reason: "缺少 world.json：不是有效的 FVTT 世界包" };
  }
  let coreVersion = worldJson.coreVersion ?? null;
  if (coreVersion === null) {
    // 回退源：文档 _stats.coreVersion（world.json 缺字段的世界）
    let best = null;
    for (const list of Object.values(docs ?? {})) {
      for (const doc of list ?? []) {
        const cv = doc?._stats?.coreVersion;
        const mj = majorOf(cv);
        if (mj !== null && (best === null || mj > best)) best = mj;
      }
    }
    if (best !== null) coreVersion = String(best);
  }
  const systemVersion = worldJson.systemVersion ?? null;
  const major = majorOf(coreVersion);
  const oldFormat = worldJson.compatibility === undefined
    && (worldJson.minimumCoreVersion !== undefined || worldJson.compatibleCoreVersion !== undefined);
  if ((major !== null && major <= 10) || (oldFormat && (major === null || major <= 10))) {
    return {
      coreVersion, systemVersion, ok: false,
      reason: `NeDB 旧格式世界（core ${coreVersion ?? "?"}）：请先在 FVTT 中把世界升级到 v11+ 再导出导入`,
    };
  }
  if (coreVersion === null) {
    return { coreVersion: null, systemVersion, ok: false, reason: "无法解析 coreVersion（world.json 与文档 _stats 均缺失）" };
  }
  const compat = worldJson.compatibility;
  if (compat !== undefined) {
    if (compat === null || typeof compat !== "object" || Array.isArray(compat)
      || !parseableVersion(compat.minimum) || !parseableVersion(compat.verified)) {
      return { coreVersion, systemVersion, ok: false, reason: "world.json 的 compatibility 字段无法解析" };
    }
  }
  return { coreVersion, systemVersion, ok: true, reason: null };
}

// ===========================================================================
// mapWorld：分层映射（纯函数，零 IO）
// ===========================================================================
export const TIERS = {
  T1: ["actors", "items", "scenes", "journal", "combats"],
  T2: ["macros", "tables", "playlists", "cards", "folders", "users"],
  T3: ["messages", "settings"],
};

// MT 集合名：foundry-<coll>；journal 例外——shim（web/bootstrap.mjs mtCollection）消费的是
// foundry-journalentrys（JournalEntry.documentName 小写复数），按现有 shim 消费形状对齐。
export function mtCollectionName(coll) {
  if (coll === "journal") return "foundry-journalentrys";
  if (coll === "messages") return "foundry-chatmessages";
  return `foundry-${coll}`;
}

// folders 集合 → id → 完整路径字符串（“根目录/子目录”）
function folderPaths(foldersDocs, warn) {
  const byId = new Map();
  for (const f of foldersDocs ?? []) if (f?._id) byId.set(f._id, f);
  const cache = new Map();
  const pathOf = (id, seen = new Set()) => {
    if (cache.has(id)) return cache.get(id);
    if (seen.has(id)) return "(folder-cycle)";
    seen.add(id);
    const f = byId.get(id);
    if (!f) return null;
    let p;
    if (!f.folder || typeof f.folder !== "string") p = String(f.name ?? f._id);
    else {
      const parentPath = pathOf(f.folder, seen);
      p = parentPath === null ? String(f.name ?? f._id) : `${parentPath}/${f.name ?? f._id}`;
    }
    cache.set(id, p);
    return p;
  };
  return pathOf;
}

// mapWorld(dump, {gmUserId}) → { collections: Record<MT集合名, 文档数组>, report }
//   - payload = FVTT 原文档本体（保留原 _id），由适配层再包 {foundry: doc} 信封
//   - users 剥离 password/passwordSalt；ownership 拍平 {default:0}、原值入 flags.import
//   - T1 全收 / T2 仅落库 / T3 跳过计入 report
export function mapWorld(dump, { gmUserId = null, importedAt = null } = {}) {
  const warnings = [...(dump?.warnings ?? [])];
  const warn = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const imported = importedAt ?? new Date().toISOString();
  const sourceWorld = dump?.worldJson?.id ?? dump?.version?.id ?? null;
  const version = detectVersion(dump?.worldJson ?? null, dump?.docs ?? {});
  const docsIn = dump?.docs ?? {};
  const pathOf = folderPaths(docsIn.folders, warn);

  const collections = {};
  const collectionCounts = {};
  let mappedTotal = 0;
  for (const coll of [...TIERS.T1, ...TIERS.T2]) {
    const list = docsIn[coll];
    if (!list) continue;
    const mapped = list.map((doc) => {
      const out = { ...doc };
      if (coll === "users") {
        delete out.password;
        delete out.passwordSalt;
      }
      const flags = { ...(out.flags ?? {}) };
      const mark = { sourceWorld, importedAt: imported, importedBy: gmUserId };
      // 拍平归导入 GM：ownership 恒定 {default:0}（玩家 NONE、GM 越权检查）。原文档缺 ownership
      // 字段时也必须显式落 0——shim 构造侧 ownership ??= {default:3} 兜底会让全员 OWNER
      if (out.ownership !== undefined) mark.originalOwnership = out.ownership;
      out.ownership = { default: 0 };
      if (typeof out.folder === "string" && out.folder) {
        const p = pathOf(out.folder);
        if (p === null) warn(`folder 悬空引用：${coll}/${out._id} → ${out.folder}`);
        mark.folderPath = p ?? `(missing:${out.folder})`;
      }
      flags.import = { ...(flags.import ?? {}), ...mark };
      out.flags = flags;
      return out;
    });
    collections[mtCollectionName(coll)] = mapped;
    collectionCounts[mtCollectionName(coll)] = mapped.length;
    mappedTotal += mapped.length;
  }
  const skipped = {};
  let skippedTotal = 0;
  for (const coll of TIERS.T3) {
    const n = (docsIn[coll] ?? []).length;
    if (n > 0) { skipped[mtCollectionName(coll)] = n; skippedTotal += n; }
  }
  let embeddedTotal = 0;
  for (const c of Object.values(dump?.counts ?? {})) embeddedTotal += c.embedded ?? 0;

  const report = {
    world: {
      id: dump?.worldJson?.id ?? null,
      title: dump?.worldJson?.title ?? null,
      system: dump?.version?.system ?? dump?.worldJson?.system ?? null,
    },
    version: { ...version, nedb: dump?.version?.nedb ?? false },
    tiers: { T1: [...TIERS.T1], T2: [...TIERS.T2], T3: [...TIERS.T3] },
    collections: collectionCounts,
    skipped,
    totals: { mapped: mappedTotal, skipped: skippedTotal, embedded: embeddedTotal, assets: (dump?.assets ?? []).length },
    warnings,
  };
  return { collections, report };
}
