// 大厅本地文件通道的镜像缓存根解析。
//
// Desktop 没有 userData/lobby-mirror 这种长期下载缓存的生产者；仓内真实的镜像下载
// 产物由 skills/prep/arcane-fvtt-mods 的 mod-manager 生成：world-stage / stage 在
// 系统临时目录留下 arcane-fvtt-world-* / arcane-fvtt-mod-* 暂存目录，内有 stage.json
// 与已校验的 ZIP。这里只读取这些**已有**产物，不下载、不访问网络、不新开工具。
// 只有可信镜像标记（world: mirrorGenerated；module: trustedByMirrorIndex）且 archive
// 真实位于暂存目录内的记录才作为允许根。
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const WORLD_STAGE_PREFIX = "arcane-fvtt-world-";
const MODULE_STAGE_PREFIX = "arcane-fvtt-mod-";
const SHA256 = /^[a-f0-9]{64}$/i;

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function archiveFiles(record) {
  if (record?.kind === "foundry-world-profile-stage") {
    return (Array.isArray(record.artifacts) ? record.artifacts : [])
      .map(artifact => artifact?.archive)
      .filter(value => typeof value === "string" && value.trim() !== "");
  }
  if (record?.schemaVersion === 2) {
    return typeof record.archive === "string" && record.archive.trim() !== "" ? [record.archive] : [];
  }
  return [];
}

function trustedMirrorStage(record, name) {
  if (name.startsWith(WORLD_STAGE_PREFIX)) {
    return record?.kind === "foundry-world-profile-stage"
      && typeof record.mirrorGenerated === "string" && record.mirrorGenerated.trim() !== ""
      && SHA256.test(String(record.world?.sha256 ?? ""));
  }
  if (name.startsWith(MODULE_STAGE_PREFIX)) {
    return record?.schemaVersion === 2
      && record.trustedByMirrorIndex === true
      && SHA256.test(String(record.archiveSha256 ?? ""));
  }
  return false;
}

/**
 * 返回可被大厅文件通道接受的已有镜像暂存根。目录必须带 stage.json 且至少有一个
 * 仍存在的 ZIP 产物；任何解析失败都静默跳过（不是错误，只是没有可复用缓存）。
 * @param {{ tmpdir?: string }} [options]
 * @returns {string[]}
 */
export function findMirrorStageRoots({ tmpdir = os.tmpdir() } = {}) {
  let entries;
  try {
    entries = readdirSync(tmpdir, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(WORLD_STAGE_PREFIX) && !entry.name.startsWith(MODULE_STAGE_PREFIX)) continue;
    const directory = path.join(tmpdir, entry.name);
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(directory, "stage.json"), "utf8"));
    } catch {
      continue;
    }
    if (!trustedMirrorStage(record, entry.name)) continue;
    let realDirectory;
    try {
      realDirectory = realpathSync(directory);
    } catch {
      continue;
    }
    const archives = archiveFiles(record);
    if (archives.length === 0) continue;
    let valid = true;
    for (const archive of archives) {
      try {
        const resolved = realpathSync(path.resolve(realDirectory, archive));
        if (!isInside(realDirectory, resolved) || !/\.zip$/i.test(resolved) || !statSync(resolved).isFile()) {
          valid = false;
          break;
        }
      } catch {
        valid = false;
        break;
      }
    }
    if (valid) roots.push(realDirectory);
  }
  return roots;
}
