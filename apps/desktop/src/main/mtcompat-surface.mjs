// mtcompat-surface — A2 蒸馏产物的运行期读法（PRD agent-api §2.4/§2.5 Tier 0）。
//
// 构建期由 scripts/prepare-mtcompat-surface.mjs 拉 api-surface.json（钉 revision）蒸馏出
// 「坑位 Top-N + 扩展动词 + §2.5 三规则逐字」整段，写 generated/mtcompat-surface.json 随包
// 分发；本模块只读出段落文本并做档位过滤，不二次加工——段落内容与排序属构建期产物。
//
// 与 region.mjs 同一套读法：产物缺席（dev 未跑 prepare）返回 null，档位不符返回 null，
// 文件在位但格式坏则抛错（包内数据损坏必须暴露）。不缓存：重跑 prepare 后新建的会话
// 立即吃到新段落（老会话保持建会话时的快照，与 skills 热更新同规矩）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MTCOMPAT_POLICY_PROFILE, normalizePolicyProfile } from "./foundry-tool-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 蒸馏产物路径（generated/ 是 .gitignore 的构建产物目录，由 prepare 链生成）。 */
export function mtcompatSurfaceFile() {
  return path.join(__dirname, "..", "..", "generated", "mtcompat-surface.json");
}

/**
 * 读出蒸馏产物。返回 null 只表示「没有产物」（未跑 prepare 的 dev 树）；产物在位但缺
 * 段落或缺 revision 钉一律抛错——那是产物损坏或换过 schema，不能静默降级成"没声明"。
 * @param {string} [surfaceFile]
 */
export function readMtcompatSurfaceDistill(surfaceFile = mtcompatSurfaceFile()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(surfaceFile, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`generated/mtcompat-surface.json is not valid JSON: ${error.message}`);
  }
  if (typeof parsed?.segment !== "string" || parsed.segment === "") {
    throw new Error("generated/mtcompat-surface.json carries no distilled segment");
  }
  if (parsed.revision === undefined || parsed.revision === null || parsed.revision === "") {
    throw new Error("generated/mtcompat-surface.json lost the revision pin");
  }
  return parsed;
}

/**
 * 档位过滤的文本出口：只有 mtcompat 档拿到蒸馏段，其余档（foundry 开放默认档）返回
 * null —— foundry 档的工具描述与 prompt 逐字节不变。
 * @param {string | null | undefined} profileId 页面档位 id（page-profiles.js 词汇表）
 * @param {string} [surfaceFile]
 * @returns {string | null}
 */
export function mtcompatSurfaceSegment(profileId, surfaceFile = mtcompatSurfaceFile()) {
  if (normalizePolicyProfile(profileId) !== MTCOMPAT_POLICY_PROFILE) return null;
  return readMtcompatSurfaceDistill(surfaceFile)?.segment ?? null;
}

/**
 * 把蒸馏段并到基底文本之后（段落/基底任一缺席时原样返回基底）。prompt 与工具描述
 * 共用同一份段落文本，避免第二份措辞漂移。
 * @param {string | null | undefined} base
 * @param {string | null | undefined} segment
 * @returns {string | null | undefined}
 */
export function withMtcompatSurfaceSegment(base, segment) {
  if (typeof base !== "string" || base === "") return base;
  if (typeof segment !== "string" || segment === "") return base;
  return `${base}\n\n${segment}`;
}
