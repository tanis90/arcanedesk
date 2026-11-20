import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFoundryImage, readFoundrySceneJson, validateDataImagePath, MAX_FOUNDRY_IMAGE_BYTES, MAX_FOUNDRY_SCENE_JSON_BYTES } from "../src/main/foundry-assets.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII=", "base64");
const decodeImage = bytes => { assert.deepEqual(bytes, png); return { width: 1, height: 1 }; };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundry-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "prep");
  await mkdir(cwd);
  return { directory, cwd };
}

test("Data paths accept relative paths and bare HTTPS URLs but reject unsafe or expiring forms", () => {
  assert.equal(validateDataImagePath("arcanedesk/assets/image.png"), "arcanedesk/assets/image.png");
  assert.equal(validateDataImagePath("worlds/my world/画像.webp"), "worlds/my world/画像.webp");
  const remote = "https://arcanedesk-media.oss-cn-beijing.aliyuncs.com/campaign-test/2026/11/18/church.jpg";
  assert.equal(validateDataImagePath(remote), remote);
  assert.equal(validateDataImagePath("https://media.example.com/maps/%E6%95%99%E5%A0%82.webp"), "https://media.example.com/maps/%E6%95%99%E5%A0%82.webp");
  for (const value of ["http://example.com/a.png", "https://user:pass@example.com/a.png", `${remote}?Signature=secret`, `${remote}#fragment`, "https://example.com/a.svg", "/a.png", "C:/a.png", "../a.png", "a/../b.png", "a\\b.png", "a/%2e%2e/b.png", "a.png?x", "a.svg", "a//b.png", "a/./b.png"])
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

test("scene JSON parses objects inside the prep fence and rejects escapes, oversize and wrong roots", async t => {
  const { directory, cwd } = await fixture(t);
  const scene = { name: "教堂", walls: [{ c: [0, 0, 100, 0] }], background: { src: "https://arcanedesk-media.example.com/church.jpg" } };
  await writeFile(path.join(cwd, "scene.json"), JSON.stringify(scene));
  assert.deepEqual(await readFoundrySceneJson({ cwd, sourcePath: "scene.json" }), scene);
  assert.equal(MAX_FOUNDRY_SCENE_JSON_BYTES, MAX_FOUNDRY_IMAGE_BYTES);

  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "scene.json"), "{}");
  await symlink(outside, path.join(cwd, "escape"), "junction");
  for (const sourcePath of ["../outside/scene.json", path.join(outside, "scene.json"), "escape/scene.json"])
    await assert.rejects(readFoundrySceneJson({ cwd, sourcePath }), /SCENE_PATH_OUTSIDE_CWD/, sourcePath);
  await mkdir(path.join(cwd, "subdir"));
  await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: "" }), /INPUT_INVALID/);
  await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: "subdir" }), /SCENE_NOT_FILE/);

  await writeFile(path.join(cwd, "empty.json"), "");
  await writeFile(path.join(cwd, "large.json"), Buffer.alloc(MAX_FOUNDRY_SCENE_JSON_BYTES + 1));
  await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: "empty.json" }), /SCENE_SIZE_INVALID/);
  await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: "large.json" }), /SCENE_SIZE_INVALID/);

  await writeFile(path.join(cwd, "broken.json"), '{"name": "教堂",}');
  await writeFile(path.join(cwd, "array.json"), "[1, 2]");
  await writeFile(path.join(cwd, "string.json"), '"scene"');
  await writeFile(path.join(cwd, "number.json"), "42");
  await writeFile(path.join(cwd, "null.json"), "null");
  await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: "broken.json" }), /SCENE_JSON_INVALID/);
  for (const name of ["array.json", "string.json", "number.json", "null.json"])
    await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: name }), /SCENE_JSON_ROOT_INVALID/, name);
});

test("missing files report typed not-found codes instead of raw filesystem errno", async t => {
  const { cwd } = await fixture(t);
  await assert.rejects(readFoundryImage({ cwd, sourcePath: "missing.png", decodeImage }), /IMAGE_NOT_FOUND/);
  await assert.rejects(readFoundrySceneJson({ cwd, sourcePath: "missing.json" }), /SCENE_NOT_FOUND/);
});
