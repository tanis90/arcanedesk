// make-fake-foundry-zip 的往返单测:手写 STORED zip 必须能被容器内同一套
// yauzl 读取器消费(listZipEntries/readZipEntryText),否则 CI 冒烟的假本体
// 根本进不了入口脚本的校验路径。
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listZipEntries, readZipEntryText } from "../scripts/archive-zip.mjs";
import { buildStoredZip, makeFakeFoundryZip } from "../scripts/make-fake-foundry-zip.mjs";

test("buildStoredZip round-trips through the yauzl reader", async () => {
  const zip = buildStoredZip({
    "package.json": Buffer.from(`${JSON.stringify({ version: "13.351" })}\n`, "utf8"),
    "main.js": Buffer.from("console.log('ok');\n", "utf8"),
  });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-fake-zip-"));
  const file = path.join(dir, "foundryvtt-13.351.zip");
  await fsp.writeFile(file, zip);
  const entries = await listZipEntries(file);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["main.js", "package.json"]);
  const pkg = JSON.parse(await readZipEntryText(file, "package.json"));
  assert.equal(pkg.version, "13.351");
  await fsp.rm(dir, { recursive: true, force: true });
});

test("buildStoredZip output is deterministic for identical entries", () => {
  const one = buildStoredZip({ "a.txt": Buffer.from("same") });
  const two = buildStoredZip({ "a.txt": Buffer.from("same") });
  assert.deepEqual(one, two);
});

test("makeFakeFoundryZip writes the pinned version into the zip the entrypoint reads", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-fake-foundry-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const outFile = path.join(dir, "foundryvtt-13.351.zip");
  await makeFakeFoundryZip({ outFile, version: "13.351" });
  const pkg = JSON.parse(await readZipEntryText(outFile, "package.json"));
  assert.equal(pkg.version, "13.351");
  const mainJs = await readZipEntryText(outFile, "main.js");
  assert.match(mainJs, /Server started and listening/);
  assert.match(mainJs, /api\/status/);
});
