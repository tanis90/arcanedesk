// intl-world-policy — intl demo world 的内容纪律:词表与文本扫描(纯 node builtin)。
//
// 内容分发口径(2026-09-21 拍板):法术/特性名字与机制可以进 intl 产物——机制不受
// 版权保护,社区通行;**描述性文本(法术描述/风味文本)不分发**。arcane-spells-2014
// 的架构天然满足:contentRef 只引用用户本地 dnd5e 系统的展示数据,模块自身
// description 字段默认空串。因此词表不拦非 SRD 法术名。
// 仍拦截的三类:
//   1. CoS 专有名称——付费冒险的表达性内容(角色/地名),一个都不能漏;
//   2. cn 侧专属/出海剔除模块的 id 引用(arcane-dnd5e-2014-automation、汉化系、Patreon 素材);
//   3. CJK——intl 世界 0 中文字符(产品口径,与 cn 版世界审计同一基线)。
//
// 本模块禁止 import 任何非 builtin 依赖:prepare-intl-index.mjs 在 CI 里按
// 「只依赖 node 内置模块」的约定运行(workflow 不装依赖),它要复用这里的扫描;
// 解包级扫描在 intl-world-gate.mjs(仅本地/测试运行)。

export const COS_TERMS = Object.freeze([
  "strahd",
  "barovia",
  "ravenloft",
  "ireena",
  "vallaki",
]);

export const FORBIDDEN_MODULE_IDS = Object.freeze([
  "arcane-dnd5e-2014-automation",
  "zzzz_arcane_dnd5e_cn",
  "5e_chn",
  "foundry_chn",
  "babele",
  "zzz_mod_chn",
  "jb2a_patreon",
  "dnd5e-animations",
]);

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function lower(text) {
  return String(text ?? "").toLowerCase();
}

/**
 * 单段文本扫描:返回违规列表([{ kind, term }]),不抛错。
 * binary:true 用于 LevelDB 等二进制快照的宽松 utf8 解码结果:CJK 只认
 * 「≥2 连续汉字」或「紧贴引号/字母数字的单字」——真实内容(JSON 字符串里的
 * 名字/文案)永远是这两种形态;孤立单字且邻居是空格/控制字节的是 LevelDB
 * 块尾 CRC 等随机字节的解码噪音(纯 JSON 重写后仍存在,搭建实测)。
 */
export function scanText(text, { binary = false } = {}) {
  const raw = String(text ?? "");
  const haystack = lower(raw);
  const violations = [];
  for (const term of COS_TERMS) {
    if (haystack.includes(term)) violations.push({ kind: "cos-term", term });
  }
  for (const id of FORBIDDEN_MODULE_IDS) {
    if (haystack.includes(lower(id))) violations.push({ kind: "forbidden-module", term: id });
  }
  if (binary) {
    let flagged = false;
    for (const match of raw.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)) {
      const index = match.index ?? 0;
      const before = raw[index - 1] ?? "";
      const after = raw[index + 1] ?? "";
      if (CJK_PATTERN.test(before) || CJK_PATTERN.test(after)) { flagged = true; break; }
      if (/["A-Za-z0-9]/.test(before) || /["A-Za-z0-9]/.test(after)) { flagged = true; break; }
    }
    if (flagged) violations.push({ kind: "cjk", term: "CJK character" });
  } else if (CJK_PATTERN.test(raw)) {
    violations.push({ kind: "cjk", term: "CJK character" });
  }
  return violations;
}

/** utf8 解码后的二进制兜底扫描:词表命中或可解码 CJK 序列即违规(LevelDB 快照)。 */
export function scanBinaryText(text) {
  return scanText(text);
}
