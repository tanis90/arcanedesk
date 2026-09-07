import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFoundryImage, validateDataImagePath, MAX_FOUNDRY_IMAGE_BYTES } from "../src/main/foundry-assets.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=", "base64");
const decodeImage = bytes => { assert.deepEqual(bytes, png); return { width: 1, height: 1 }; };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundry-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "prep");
  await mkdir(cwd);
  return { directory, cwd };
}

test("Data paths reject external, absolute, encoded and traversal paths", () => {
  assert.equal(validateDataImagePath("arcanedesk/assets/image.png"), "arcanedesk/assets/image.png");
  assert.equal(validateDataImagePath("worlds/my world/画像.webp"), "worlds/my world/画像.webp");
  for (const value of ["https://example.com/a.png", "/a.png", "C:/a.png", "../a.png", "a/../b.png", "a\\b.png", "a/%2e%2e/b.png", "a.png?x", "a.svg", "a//b.png", "a/./b.png"])
    assert.throws(() => validateDataImagePath(value), /INPUT_INVALID/, value);
});

test("local images use decoded bytes and stable hash paths, irrespective of filename", async t => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, "misleading.jpg"), png);
  const result = await readFoundryImage({ cwd, sourcePath: "misleading.jpg", decodeImage });
  assert.equal(result.extension, "png");
  assert.match(result.dataPath, /^arcanedesk\/assets\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(result.bytes, png);
  await assert.rejects(readFoundryImage({ cwd, sourcePath: "misleading.jpg", decodeImage: () => null }), /IMAGE_DECODE_FAILED/);
});

test("outside paths and directory junction escapes are rejected before decoding", async t => {
  const { directory, cwd } = await fixture(t);
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "image.png"), png);
  await symlink(outside, path.join(cwd, "escape"), "junction");
  for (const sourcePath of ["../outside/image.png", path.join(outside, "image.png"), "escape/image.png"])
    await assert.rejects(readFoundryImage({ cwd, sourcePath, decodeImage }), /IMAGE_PATH_OUTSIDE_CWD/);
});

test("size and format gates reject invalid sources before invoking decoder", async t => {
  const { cwd } = await fixture(t);
  let decoded = false;
  for (const [name, bytes, error] of [["empty.png", Buffer.alloc(0), /IMAGE_SIZE_INVALID/],
    ["large.png", Buffer.alloc(MAX_FOUNDRY_IMAGE_BYTES + 1), /IMAGE_SIZE_INVALID/],
    ["fake.png", Buffer.from("not an image"), /IMAGE_FORMAT_INVALID/]]) {
    await writeFile(path.join(cwd, name), bytes);
    await assert.rejects(readFoundryImage({ cwd, sourcePath: name, decodeImage: () => { decoded = true; } }), error);
  }
  assert.equal(decoded, false);
});
