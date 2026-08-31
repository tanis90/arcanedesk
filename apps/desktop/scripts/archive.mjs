// archive.mjs — zip + tar.gz 归档的统一入口,仅供 app 主进程与仓库脚本使用。
// zip 能力在 archive-zip.mjs(零 tar 依赖,skills bundle 的 vendored 副本与它同源);
// tar 只在 app 内可用——skills 通道的脚本永远不该走到 tar.gz 分支。

import fsp from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";

import {
  extractZip,
  MAX_ENTRIES,
  MAX_TOTAL_BYTES,
  safeArchivePath,
} from "./archive-zip.mjs";

export { extractZip, listZipEntries, readZipEntryText, safeArchivePath } from "./archive-zip.mjs";

function assertContainedLink(entryPath, linkPath, symbolic) {
  if (!linkPath || linkPath.includes("\\") || linkPath.startsWith("/") || /^[A-Za-z]:/.test(linkPath)) {
    throw new Error(`archive contains an unsafe link: ${entryPath} -> ${linkPath}`);
  }
  const base = symbolic ? path.posix.dirname(entryPath) : ".";
  const resolved = path.posix.normalize(path.posix.join(base, linkPath));
  if (resolved === ".." || resolved.startsWith("../") || /^[A-Za-z]:/.test(resolved)) {
    throw new Error(`archive link escapes its root: ${entryPath} -> ${linkPath}`);
  }
}

async function listTarEntries(file) {
  const entries = [];
  let total = 0;
  await tar.t({
    file,
    gzip: true,
    strict: true,
    onReadEntry: (entry) => {
      const name = safeArchivePath(entry.path);
      total += entry.size ?? 0;
      if (entries.length >= MAX_ENTRIES || total > MAX_TOTAL_BYTES) throw new Error("archive expansion limit exceeded");
      if (!["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(entry.type)) {
        throw new Error(`unsupported tar entry type ${entry.type}: ${name}`);
      }
      if (entry.type === "SymbolicLink" || entry.type === "Link") {
        assertContainedLink(name, entry.linkpath, entry.type === "SymbolicLink");
      }
      entries.push({ name, type: entry.type });
    },
  });
  const symbolicLinks = entries.filter((entry) => entry.type === "SymbolicLink").map((entry) => entry.name);
  for (const link of symbolicLinks) {
    if (entries.some((entry) => entry.name !== link && entry.name.startsWith(`${link}/`))) {
      throw new Error(`tar entry traverses a symbolic-link directory: ${link}`);
    }
  }
  return entries;
}

export async function extractTarGz(file, destination) {
  await listTarEntries(file);
  await fsp.mkdir(destination, { recursive: true });
  await tar.x({
    file,
    cwd: destination,
    gzip: true,
    strict: true,
    preservePaths: false,
    noChmod: process.platform === "win32",
  });
}

export async function extractArchiveFile(file, destination) {
  await fsp.rm(destination, { recursive: true, force: true });
  const lower = file.toLowerCase();
  if (lower.endsWith(".zip")) return extractZip(file, destination);
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return extractTarGz(file, destination);
  throw new Error(`unsupported archive type: ${path.basename(file)}`);
}
