import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeSha256Sums } from "../scripts/write-sha256sums.mjs";

test("writeSha256Sums writes portable sorted checksum lines", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-sha256-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const zip = path.join(dir, "Arcane-Desk.zip");
  const exe = path.join(dir, "Arcane-Desk.exe");
  const output = path.join(dir, "SHA256SUMS.txt");
  await fsp.writeFile(zip, "zip-body");
  await fsp.writeFile(exe, "exe-body");

  await writeSha256Sums(output, [zip, exe]);

  const hash = (body) => createHash("sha256").update(body).digest("hex");
  assert.equal(
    await fsp.readFile(output, "utf8"),
    `${hash("exe-body")}  Arcane-Desk.exe\n${hash("zip-body")}  Arcane-Desk.zip\n`,
  );
});
