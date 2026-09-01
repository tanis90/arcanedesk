// skill-usage — skill.loaded 的目录归属判定:从 read 工具的目标路径反解出
// 一方 skill 名与文件类别。纯函数、无 IO;输出只含白名单字段(skill 名受
// SKILL_NAME_RE 约束,即我们自己在 bundle 里发布的目录名),路径本身绝不下发。
import path from "node:path";

import { SKILL_NAME_RE } from "./telemetry-events.js";

/**
 * 仅用于比较的路径规整:统一分隔符;大小写不敏感平台(win32/darwin)
 * 统一小写后再比。返回的平台无关字符串不做任何持久化。
 */
function normalizeForCompare(p) {
  const resolved = path.resolve(String(p)).split(path.sep).join("/");
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

/**
 * 判断 filePath 是否落在 rootDir(skills 生效目录)的某个 skill 子目录内。
 * @returns {{ skillName: string, fileKind: "skill_doc" | "reference" | "asset" } | null}
 */
export function matchSkillFile(rootDir, filePath) {
  if (!rootDir || typeof filePath !== "string" || !filePath) return null;
  const targetResolved = path.resolve(String(filePath)).split(path.sep).join("/");
  const root = normalizeForCompare(rootDir);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const target = process.platform === "linux" ? targetResolved : targetResolved.toLowerCase();
  if (!target.startsWith(prefix)) return null;
  // skill 文件必然在 <root>/<skill-name>/ 之下;直接挂在根下的(bundle.json 等)不算。
  // 归属段从原始大小写的路径切出,只有比较用小写副本。
  const rel = targetResolved.slice(prefix.length);
  const segments = rel.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const skillName = segments[0];
  if (!SKILL_NAME_RE.test(skillName)) return null;
  const base = segments[segments.length - 1].toLowerCase();
  const fileKind = base === "skill.md" ? "skill_doc" : base.endsWith(".md") ? "reference" : "asset";
  return { skillName, fileKind };
}
