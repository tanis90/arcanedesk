// intl-world-policy — intl demo world 的内容纪律:词表与文本扫描(纯 node builtin)。
//
// 世界由我们自己从 SRD 5.1(dnd5e SRD compendium + arcane-spells-2014)搭建,词表是
// 安全网不是主控制。三类拦截:
//   1. CoS 专有名称——cn demo 是施特拉德世界,重建时一个都不能漏(付费冒险内容);
//   2. 常见非 SRD 法术名——防误从 PHB 全量 compendium 导入;
//   3. cn 侧专属/出海剔除模块的 id 引用(arcane-dnd5e-2014-automation、汉化系、Patreon 素材)。
// 加一条 CJK 检查(intl 世界必须 0 中文字符,与 cn 版世界审计同一基线)。
//
// 本模块禁止 import 任何非 builtin 依赖:prepare-intl-index.mjs 在 CI 里按
// 「只依赖 node 内置模块」的约定运行(worldflow 不装依赖),它要复用这里的扫描;
// 解包级扫描在 intl-world-gate.mjs(仅本地/测试运行)。

export const COS_TERMS = Object.freeze([
  "strahd",
  "barovia",
  "ravenloft",
  "ireena",
  "vallaki",
]);

export const NON_SRD_TEXT_TERMS = Object.freeze([
  // 只收录确证非 SRD 5.1 的名字;拿不准的不进词表(误报比漏报更伤 demo 流水线)。
  "vicious mockery",
  "misty step",
  "thorn whip",
  "absorb elements",
  "toll the dead",
  "sword burst",
  "lightning lure",
  "word of radiance",
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

/** 单段文本扫描:返回违规列表([{ kind, term }]),不抛错。 */
export function scanText(text) {
  const haystack = lower(text);
  const violations = [];
  for (const term of COS_TERMS) {
    if (haystack.includes(term)) violations.push({ kind: "cos-term", term });
  }
  for (const term of NON_SRD_TEXT_TERMS) {
    if (haystack.includes(term)) violations.push({ kind: "non-srd-term", term });
  }
  for (const id of FORBIDDEN_MODULE_IDS) {
    if (haystack.includes(lower(id))) violations.push({ kind: "forbidden-module", term: id });
  }
  if (CJK_PATTERN.test(String(text ?? ""))) violations.push({ kind: "cjk", term: "CJK character" });
  return violations;
}

/** utf8 解码后的二进制兜底扫描:词表命中或可解码 CJK 序列即违规(LevelDB 快照)。 */
export function scanBinaryText(text) {
  return scanText(text);
}
