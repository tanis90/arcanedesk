// archive-zip.mjs — zip 归档的安全读取与解压,零 tar 依赖。
// 这是共享内核:app 侧 scripts/archive.mjs 在此基础上叠加 tar.gz 支持;
// skills bundle 里的 vendored 副本(arcane-fvtt-mods/scripts/archive-zip.mjs)
// 必须与本文件保持字节一致(由 skills-self-contained.test.mjs 强制)。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;

export { MAX_ENTRIES, MAX_TOTAL_BYTES };

export function safeArchivePath(original) {
  const entry = String(original);
  if (
    !entry
    || entry.includes("\0")
    || entry.includes("\\")
    || entry.startsWith("/")
    || entry.startsWith("//")
    || /^[A-Za-z]:/.test(entry)
  ) {
    throw new Error(`archive contains an unsafe path: ${original}`);
  }
  const normalized = path.posix.normalize(entry.replace(/^\.\//, "")).replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized || normalized === "." || parts.includes("..") || parts.some((part) => part.includes(":"))) {
    throw new Error(`archive contains an unsafe path: ${original}`);
  }
  return normalized;
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zip) => (error || !zip ? reject(error ?? new Error("could not open zip")) : resolve(zip)));
  });
}

export async function listZipEntries(file) {
  const zip = /** @type {import("yauzl").ZipFile} */ (await openZip(file));
  return new Promise((resolve, reject) => {
    const entries = [];
    let total = 0;
    const fail = (error) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry) => {
      try {
        const name = safeArchivePath(entry.fileName);
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error(`encrypted zip entries are not supported: ${name}`);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) throw new Error(`zip symbolic links are not supported: ${name}`);
        total += entry.uncompressedSize;
        if (entries.length >= MAX_ENTRIES || total > MAX_TOTAL_BYTES) throw new Error("archive expansion limit exceeded");
        entries.push({ entry, name, mode, directory: entry.fileName.endsWith("/") || (mode & 0o170000) === 0o040000 });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

export async function readZipEntryText(file, wanted, maxBytes = 16 * 1024 * 1024) {
  const safeWanted = safeArchivePath(wanted);
  const zip = /** @type {import("yauzl").ZipFile} */ (await openZip(file));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      zip.close();
      callback(value);
    };
    zip.on("error", (error) => finish(reject, error));
    zip.on("entry", (entry) => {
      let name;
      try {
        name = safeArchivePath(entry.fileName);
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (name !== safeWanted) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > maxBytes) {
        finish(reject, new Error(`zip entry exceeds ${maxBytes} bytes: ${name}`));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          finish(reject, error ?? new Error(`could not read zip entry: ${name}`));
          return;
        }
        const chunks = [];
        let size = 0;
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) stream.destroy(new Error(`zip entry exceeds ${maxBytes} bytes: ${name}`));
          else chunks.push(chunk);
        });
        stream.on("error", (streamError) => finish(reject, streamError));
        stream.on("end", () => finish(resolve, Buffer.concat(chunks).toString("utf8")));
      });
    });
    zip.on("end", () => finish(reject, new Error(`zip entry not found: ${safeWanted}`)));
    zip.readEntry();
  });
}

export async function extractZip(file, destination) {
  const entries = await listZipEntries(file);
  await fsp.mkdir(destination, { recursive: true });
  const zip = /** @type {import("yauzl").ZipFile} */ (await openZip(file));
  const byName = new Map(entries.map((record) => [record.entry.fileName, record]));
  const seen = new Set();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      zip.close();
      callback(value);
    };
    zip.on("error", (error) => finish(reject, error));
    zip.on("entry", async (entry) => {
      try {
        const record = byName.get(entry.fileName);
        if (!record) throw new Error(`zip changed between validation and extraction: ${entry.fileName}`);
        if (seen.has(record.name)) throw new Error(`duplicate zip entry: ${record.name}`);
        seen.add(record.name);
        const output = path.join(destination, ...record.name.split("/"));
        if (record.directory) {
          await fsp.mkdir(output, { recursive: true });
          zip.readEntry();
          return;
        }
        await fsp.mkdir(path.dirname(output), { recursive: true });
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            finish(reject, error ?? new Error(`could not read zip entry: ${record.name}`));
            return;
          }
          pipeline(stream, fs.createWriteStream(output, { flags: "wx" }))
            .then(async () => {
              if (process.platform !== "win32" && record.mode) await fsp.chmod(output, record.mode & 0o777);
              zip.readEntry();
            })
            .catch((streamError) => finish(reject, streamError));
        });
      } catch (error) {
        finish(reject, error);
      }
    });
    zip.on("end", () => finish(resolve));
    zip.readEntry();
  });
}
