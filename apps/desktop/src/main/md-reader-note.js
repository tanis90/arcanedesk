// Markdown 阅读器的路径解析与文件读取(md-reader-spec §7)。
// 这是信任边界 ①(renderer 传来的路径)与 ②(磁盘读)的落点:输入校验只在这里做一次,
// 控制器与阅读器页都消费它的规范化结果,不再各自校验(design-rules R1/R2)。
//
// 本文件只 import node:fs / node:path,不碰 electron,因此可以直接被
// test/md-reader-note.test.mjs 用 node --test 跑(含 Windows 盘符与越界形态)。
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** 只读笔记后缀;其余一律走错误页(§7 围栏第 3 步)。 */
const NOTE_EXTENSION = /\.(?:md|markdown)$/i;

/** 2 MB 上限:超限截断并置 truncated,不拒绝(§5.5"超限截断")。 */
export const NOTE_MAX_BYTES = 2 * 1024 * 1024;

/** 成对包裹字符:反引号、直引号、弯引号、方头/书名号、markdown 自动链接的尖括号。 */
const PAIRED_WRAPPERS = [
  ["`", "`"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["《", "》"],
  ["<", ">"],
];

/** 路径尾部可能粘着的中英标点。 */
const TRAILING_PUNCTUATION = /[.,;:!?、。，；：！？)）\]}>》"'`]+$/;

/**
 * 剥掉包裹字符与尾部行号,得到可 resolve 的路径(§4.2 覆盖形态)。
 * 行号 v1 只剥除、不跳转,但一并返回,便于将来定位。
 * @param {string} raw
 * @returns {{ path: string, line: number | null }}
 */
export function normalizeNotePath(raw) {
  let text = String(raw ?? "").trim();
  // 成对包裹反复剥:兼容 “`notes/a.md`” 这种引号里再套反引号的形态
  for (;;) {
    const wrapper = PAIRED_WRAPPERS.find(
      ([open, close]) => text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close),
    );
    if (!wrapper) break;
    text = text.slice(wrapper[0].length, text.length - wrapper[1].length).trim();
  }
  // 行号必须在剥尾部标点之前处理,否则 ":12" 会被当成标点吃掉
  let line = null;
  const withLine = /^(.*?\.(?:md|markdown)):(\d+)(?::\d+)?$/i.exec(text);
  if (withLine) {
    text = withLine[1];
    line = Number(withLine[2]);
  }
  // 尾部标点只在"剥完才像笔记路径"时剥一次,避免吃掉合法文件名里的 ) 等字符
  if (!NOTE_EXTENSION.test(text)) {
    const stripped = text.replace(TRAILING_PUNCTUATION, "").trim();
    if (NOTE_EXTENSION.test(stripped)) text = stripped;
  }
  return { path: text, line };
}

/** 后缀是否是阅读器认的笔记类型。 */
export function hasNoteExtension(candidate) {
  return NOTE_EXTENSION.test(String(candidate ?? ""));
}

/** target 是否严格落在 base 内部(不含 base 自身)。win32 下 path.relative 不区分大小写。 */
function isInsideBase(target, base) {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** realpath 失败(目标不存在/读不动)返回 null:是否存在交给下游的 missing 流程判断。 */
function realpathOrNull(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * 词法围栏之外的符号链接复检(N1):cwd 里的 junction/symlink 指向外部时,
 * path.resolve 的结果在词法上仍"在 base 内",必须对真实路径再跑一次 isInsideBase。
 * base 自身也可能经由 junction 到达,所以两边都取 realpath。
 * 任一侧 realpath 失败(文件/目录不存在)返回 null,交回词法结果走 missing 流程,不在这里崩。
 * @returns {boolean | null} null = 无法判定(目标不存在)
 */
function realpathInsideBase(absolute, base) {
  const realBase = realpathOrNull(base);
  const realTarget = realpathOrNull(absolute);
  if (!realBase || !realTarget) return null;
  return isInsideBase(realTarget, realBase);
}

/**
 * 原始路径 → 可读绝对路径,并过 §7 围栏。
 * 绝对路径不用 baseDir 参与 resolve,但同样必须落在 baseDir 内(§4.2):
 * 阅读器的授权范围就是"当前工作目录里的文件",不是"磁盘上任何 .md"。
 * baseDir 缺失时不降级为放行——没有工作目录就没有可授权的范围。
 *
 * @param {string} rawPath
 * @param {string | undefined} baseDir
 * @returns {{ ok: true, absolute: string, baseDir: string, line: number | null } | { ok: false, reason: string, path?: string }}
 */
export function resolveNote(rawPath, baseDir) {
  const normalized = normalizeNotePath(rawPath);
  if (!normalized.path) return { ok: false, reason: "empty" };
  if (!hasNoteExtension(normalized.path)) return { ok: false, reason: "extension", path: normalized.path };
  const base = baseDir ? path.resolve(baseDir) : null;
  if (!base) return { ok: false, reason: "no-base", path: normalized.path };
  const absolute = path.isAbsolute(normalized.path)
    ? path.resolve(normalized.path)
    : path.resolve(base, normalized.path);
  if (!isInsideBase(absolute, base)) return { ok: false, reason: "outside", path: normalized.path };
  // 词法通过之后再过真实路径围栏:null(文件不存在)放行,由 readNote 报 missing
  const realInside = realpathInsideBase(absolute, base);
  if (realInside === false) return { ok: false, reason: "outside", path: normalized.path };
  return { ok: true, absolute, baseDir: base, line: normalized.line };
}

/**
 * 二进制/非 UTF-8 判据。保守:宁可判成读不了,也不把乱码当笔记渲染(§5.5"非 UTF-8")。
 * NUL 字节 = 二进制;替换字符占比过高 = 编码不是 UTF-8。
 */
function isProbablyUtf8(buffer, text) {
  if (buffer.includes(0)) return false;
  if (!text) return true;
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  return replacements / text.length <= 0.01;
}

/**
 * 读一份笔记:UTF-8,最多 maxBytes,超限截断。
 * 失败返回 reason 而不是抛异常,让调用方映射成 §5.5 的用户文案。
 * reason:missing(不存在/是目录/读不动) | encoding(不是 UTF-8 文本)
 *
 * 权限错误(EACCES 等)并入 missing:用户自己的项目目录里读不动笔记几乎不发生,
 * 而"找不到这份笔记 + 让 agent 重新生成"对两种情况的下一步都是可行动的(design-rules R3/R4)。
 *
 * @param {string} absolute
 * @param {number} [maxBytes]
 */
export function readNote(absolute, maxBytes = NOTE_MAX_BYTES) {
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!stats.isFile()) return { ok: false, reason: "missing" };

  let buffer;
  try {
    const length = Math.min(stats.size, maxBytes);
    buffer = Buffer.allocUnsafe(length);
    const fd = openSync(absolute, "r");
    try {
      // readSync 允许短读,循环补齐;文件在两次 stat 之间被截短时按实际读到的长度收口
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
      if (offset < length) buffer = buffer.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "missing" };
  }

  const truncated = stats.size > maxBytes;
  let text = buffer.toString("utf8");
  // UTF-8 BOM 剥掉:留给 marked 的话首个 ATX 标题解析不出来(N10)
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  // 截断点可能正好劈开一个多字节字符,尾部会留下替换字符:去掉,别让用户看见半个字
  if (truncated) text = text.replace(/\uFFFD+$/, "");
  if (!isProbablyUtf8(buffer, text)) return { ok: false, reason: "encoding" };
  return { ok: true, name: path.basename(absolute), text, truncated };
}

/**
 * §7 的完整读链:规范化 → 围栏 → 读文件。
 * ②(点路径)、F5(重读)、①(重开面板恢复笔记)共用这一条,不写三份(design-rules R2)。
 *
 * 失败同样返回 payload 而不是抛错:围栏失败也要开阅读器显示错误页,
 * 用户的点击意图必须得到响应(design-rules R5)。
 * error 取值与 §5.5 的文案键一一对应:outside | missing | encoding。
 *
 * @param {string} rawPath
 * @param {string | undefined} baseDir
 * @returns {{ name: string, text: string, truncated: boolean, absolute: string, baseDir: string } | { error: string }}
 */
export function loadNotePayload(rawPath, baseDir) {
  const resolved = resolveNote(rawPath, baseDir);
  // empty / extension / no-base / outside 都归到 outside:"阅读器只读取工作目录里的文件"
  // 对这四种情况是同一句人话,不值得为不可达的形态多写一条文案(R3/R4)。
  if (!resolved.ok) return { error: "outside" };
  const note = readNote(resolved.absolute);
  if (!note.ok) return { error: note.reason };
  // absolute/baseDir 给 main 侧的控制器快照用(N4):F5 与 ① 恢复按"打开时的工作目录"复检,
  // 不随会话切换漂到新的 cwd;下发给页面的 payload 由控制器剥掉这两个字段。
  return { name: note.name, text: note.text, truncated: note.truncated, absolute: resolved.absolute, baseDir: resolved.baseDir };
}

/**
 * F5 / ① 恢复的重读:按打开时快照的 absolute + baseDir 复检后再读(N4)。
 * 授权范围是"它当初被打开的那个目录",不是"现在活跃的 cwd"——会话/项目切换后
 * cwd 已变,重新 resolve 原始路径会静默读到另一个项目的同名文件。
 * 校验失败一律落成普通错误 payload,由阅读器错误页呈现。
 *
 * @param {string} absolute 打开时 resolveNote 给出的绝对路径
 * @param {string} baseDir 打开时的工作目录
 * @returns {{ name: string, text: string, truncated: boolean } | { error: string }}
 */
export function reloadNotePayload(absolute, baseDir) {
  const realBase = baseDir ? realpathOrNull(path.resolve(baseDir)) : null;
  const realTarget = absolute ? realpathOrNull(absolute) : null;
  // 文件已不在 = missing;基准目录已不在 = 无法重建授权范围,按 outside 处理
  if (!realTarget) return { error: "missing" };
  if (!realBase || !isInsideBase(realTarget, realBase)) return { error: "outside" };
  const note = readNote(realTarget);
  if (!note.ok) return { error: note.reason };
  return { name: note.name, text: note.text, truncated: note.truncated };
}
