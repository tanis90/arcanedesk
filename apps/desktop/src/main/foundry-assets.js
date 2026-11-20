import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const MAX_FOUNDRY_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FOUNDRY_SCENE_JSON_BYTES = 10 * 1024 * 1024;

/** Validate a Foundry Data-relative path or a bare HTTPS image URL without normalizing it. */
export function validateDataImagePath(value) {
  const invalid = () => {
    throw new Error("INPUT_INVALID: image must be a PNG/JPEG/WebP Data-relative path or bare HTTPS URL");
  };
  if (typeof value !== "string" || !value || value.length > 4096) invalid();
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || /[\\\x00-\x1f\x7f]/.test(value) || !/\.(png|jpe?g|webp)$/i.test(url.pathname)) invalid();
    return value;
  }
  if (/[\\\\\x00-\x1f\x7f:?#%]/.test(value) || value.startsWith("/")
    || value.split("/").some(part => !part || part === "." || part === "..")
    || !/\.(png|jpe?g|webp)$/i.test(value)) invalid();
  return value;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** realpath() failure is a typed input outcome, not a raw filesystem errno leaking to the model. */
async function typedRealpath(target, notFoundCode) {
  try {
    return await realpath(target);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${notFoundCode}: no such file in the prep directory`);
    throw error;
  }
}

function imageFormat(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR") return { extension: "png", mimeType: "image/png" };
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length)
    return { extension: "webp", mimeType: "image/webp" };
  throw new Error("IMAGE_FORMAT_INVALID: expected PNG, JPEG or WebP bytes");
}

/** Must run under the caller's combined cwd/page lease. Bytes stay internal. */
export async function readFoundryImage({ cwd, sourcePath, decodeImage }) {
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath.length > 4096 || sourcePath.includes("\0"))
    throw new Error("INPUT_INVALID: invalid image sourcePath");
  const root = await typedRealpath(cwd, "IMAGE_NOT_FOUND");
  const resolved = await typedRealpath(path.resolve(root, sourcePath), "IMAGE_NOT_FOUND");
  if (!inside(root, resolved)) throw new Error("IMAGE_PATH_OUTSIDE_CWD: image must be inside the prep directory");
  const file = await open(resolved, "r");
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("IMAGE_NOT_FILE: source must be a regular file");
    if (stat.size <= 0 || stat.size > MAX_FOUNDRY_IMAGE_BYTES) throw new Error("IMAGE_SIZE_INVALID: maximum image size is 10 MiB");
    // Fixed allocation also bounds a file that grows after stat; never use unbounded readFile.
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    let reread = null;
    try { reread = await realpath(path.resolve(root, sourcePath)); } catch { /* vanished mid-read */ }
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || reread !== resolved)
      throw new Error("IMAGE_SOURCE_CHANGED: image changed during reading");
    bytes = bytes.subarray(0, offset);
  } finally { await file.close(); }
  const format = imageFormat(bytes);
  // Requiring a decoder avoids accepting magic bytes alone, including truncated containers.
  const dimensions = await decodeImage(bytes, format.mimeType);
  if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)
    || dimensions.width <= 0 || dimensions.height <= 0)
    throw new Error("IMAGE_DECODE_FAILED: image could not be decoded");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { bytes, hash, ...format, ...dimensions, dataPath: `arcanedesk/assets/${hash}.${format.extension}` };
}

/** Bounded prep-directory scene JSON read. Must run under the caller's cwd/page lease; returns the parsed root object only. */
export async function readFoundrySceneJson({ cwd, sourcePath }) {
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath.length > 4096 || sourcePath.includes("\0"))
    throw new Error("INPUT_INVALID: invalid scene sourcePath");
  const root = await typedRealpath(cwd, "SCENE_NOT_FOUND");
  const resolved = await typedRealpath(path.resolve(root, sourcePath), "SCENE_NOT_FOUND");
  if (!inside(root, resolved)) throw new Error("SCENE_PATH_OUTSIDE_CWD: scene must be inside the prep directory");
  const file = await open(resolved, "r");
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("SCENE_NOT_FILE: source must be a regular file");
    if (stat.size <= 0 || stat.size > MAX_FOUNDRY_SCENE_JSON_BYTES) throw new Error("SCENE_SIZE_INVALID: maximum scene size is 10 MiB");
    // Fixed allocation also bounds a file that grows after stat; never use unbounded readFile.
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    let reread = null;
    try { reread = await realpath(path.resolve(root, sourcePath)); } catch { /* vanished mid-read */ }
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || reread !== resolved)
      throw new Error("SCENE_SOURCE_CHANGED: scene changed during reading");
    bytes = bytes.subarray(0, offset);
  } finally { await file.close(); }
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("SCENE_JSON_INVALID: scene source is not valid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("SCENE_JSON_ROOT_INVALID: scene JSON root must be an object");
  return parsed;
}
