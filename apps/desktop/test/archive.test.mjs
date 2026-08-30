import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as tar from "tar";
import {
  extractArchiveFile,
  listZipEntries,
  readZipEntryText,
  safeArchivePath,
} from "../scripts/archive.mjs";

const execFileAsync = promisify(execFile);

test("archive paths reject traversal, absolute, drive, UNC, and ADS forms", () => {
  assert.equal(safeArchivePath("folder/file.txt"), "folder/file.txt");
  for (const candidate of ["../escape", "/absolute", "C:/drive", "//server/share", "folder\\file", "file:stream"]) {
    assert.throws(() => safeArchivePath(candidate), /unsafe path/);
  }
});

test("JS zip inspection, entry reads, and extraction work without a tar process", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-js-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipFile = path.join(root, "safe.zip");
  await execFileAsync("python", [
    "-c",
    "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED); z.writestr('pkg/manifest.json','{\"ok\":true}'); z.writestr('pkg/data/file.txt','hello'); z.close()",
    zipFile,
  ]);
  const entries = await listZipEntries(zipFile);
  assert.deepEqual(entries.map(({ name }) => name), ["pkg/manifest.json", "pkg/data/file.txt"]);
  assert.equal(await readZipEntryText(zipFile, "pkg/manifest.json"), '{"ok":true}');
  const destination = path.join(root, "out");
  await extractArchiveFile(zipFile, destination);
  assert.equal(await readFile(path.join(destination, "pkg", "data", "file.txt"), "utf8"), "hello");
});

test("JS zip validation blocks traversal before writing outside staging", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-js-zip-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipFile = path.join(root, "unsafe.zip");
  await execFileAsync("python", [
    "-c",
    "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escape.txt','blocked'); z.close()",
    zipFile,
  ]);
  await assert.rejects(extractArchiveFile(zipFile, path.join(root, "out")), /unsafe path|invalid relative path/i);
  await assert.rejects(readFile(path.join(root, "escape.txt")), { code: "ENOENT" });
});

test("JS tar.gz extraction preserves ordinary Node-style directory trees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcane-js-tar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "node-v24", "bin"), { recursive: true });
  await writeFile(path.join(source, "node-v24", "bin", "node"), "binary-placeholder");
  const archive = path.join(root, "node.tar.gz");
  await tar.c({ cwd: source, file: archive, gzip: true }, ["node-v24"]);
  const destination = path.join(root, "out");
  await extractArchiveFile(archive, destination);
  assert.equal(await readFile(path.join(destination, "node-v24", "bin", "node"), "utf8"), "binary-placeholder");
});
