// 原生 File 通道：sourcePath 围栏 + 流式 sha256 + 固定 CDP 文件框绑定。
// 模型只提供路径；这里不接受代码、base64 或任意 CDP 方法。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export class LobbyFileError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "LobbyFileError";
    this.code = code;
  }
}

const pathKey = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

/** 目录围栏判定：相等或位于其下（Windows 大小写不敏感）。 */
export function isPathInsideOrEqual(root, target) {
  const relative = path.relative(pathKey(root), pathKey(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileError(error, fallbackCode, fallbackMessage) {
  if (error instanceof LobbyFileError) return error;
  if (error?.code === "ENOENT") return new LobbyFileError("FILE_NOT_FOUND", "The source file does not exist");
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return new LobbyFileError("FILE_NOT_READABLE", "The source file is not readable");
  }
  return new LobbyFileError(fallbackCode, fallbackMessage);
}

/**
 * 校验并读取本地文件身份：只允许当前 prep cwd 与 Desktop 自有镜像缓存；realpath 后
 * 再围栏，普通文件、非空、size/mtime 稳定，流式 sha256。realPath 不进入可枚举字段，
 * 因此 JSON/tool result 不会带出完整路径。
 * @param {string} sourcePath
 * @param {{ roots: string[], signal?: AbortSignal, createReadStream?: typeof createReadStream }} options
 */
export async function prepareLobbySourceFile(sourcePath, { roots, signal, createReadStream: streamFactory = createReadStream } = /** @type {any} */ ({})) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new LobbyFileError("INPUT_INVALID", "sourcePath must be a non-empty string");
  }
  const allowedRoots = (Array.isArray(roots) ? roots : []).filter(root => typeof root === "string" && root.trim() !== "");
  if (allowedRoots.length === 0) {
    throw new LobbyFileError("FILE_OUTSIDE_FENCE", "No allowed source directory is configured for this session");
  }
  if (signal?.aborted) throw new LobbyFileError("ABORTED", "Cancelled before reading the source file");

  const requested = sourcePath.trim();
  const candidate = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(allowedRoots[0], requested);

  let realFile;
  try {
    realFile = await realpath(candidate);
  } catch (error) {
    throw fileError(error, "FILE_INVALID", "The source file could not be resolved");
  }

  let contained = false;
  for (const root of allowedRoots) {
    let realRoot;
    try {
      realRoot = await realpath(root);
    } catch {
      realRoot = path.resolve(root);
    }
    if (isPathInsideOrEqual(realRoot, realFile)) {
      contained = true;
      break;
    }
  }
  if (!contained) {
    throw new LobbyFileError(
      "FILE_OUTSIDE_FENCE",
      "sourcePath is outside the current prep directory and the Arcane mirror staging cache",
    );
  }

  let before;
  try {
    before = await stat(realFile);
  } catch (error) {
    throw fileError(error, "FILE_INVALID", "The source file could not be inspected");
  }
  if (!before.isFile()) throw new LobbyFileError("FILE_NOT_REGULAR", "sourcePath must point to a regular file");
  if (!Number.isFinite(before.size) || before.size <= 0) {
    throw new LobbyFileError("FILE_EMPTY", "The source file is empty");
  }

  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of streamFactory(realFile)) {
      if (signal?.aborted) throw new LobbyFileError("ABORTED", "Cancelled while hashing the source file");
      bytes += chunk.length;
      digest.update(chunk);
    }
  } catch (error) {
    throw fileError(error, "FILE_READ_FAILED", "The source file could not be read");
  }

  let after;
  try {
    after = await stat(realFile);
  } catch (error) {
    throw fileError(error, "FILE_CHANGED", "The source file changed while it was being read");
  }
  if (
    !after.isFile()
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || bytes !== before.size
  ) {
    throw new LobbyFileError("FILE_CHANGED", "The source file changed while it was being read");
  }

  const prepared = {
    filename: path.basename(realFile),
    size: before.size,
    mtimeMs: before.mtimeMs,
    sha256: digest.digest("hex"),
  };
  Object.defineProperty(prepared, "realPath", {
    value: realFile,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return prepared;
}

const DEFAULT_CDP_TIMEOUT_MS = 15_000;

function withTimeout(promise, timeoutMs, code, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LobbyFileError(code, message));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 固定 CDP：Runtime.evaluate 取服务隐藏文件框的 objectId，再用 DOM.setFileInputFiles
 * 交付磁盘 backed File。命令与表达式都由 Desktop 持有，模型无法传入。
 * @param {any} webContents
 * @param {string} realPath
 * @param {{ signal?: AbortSignal, timeoutMs?: number, debuggerFactory?: (webContents: any) => any }} [options]
 */
export async function bindLobbyFileInput(webContents, realPath, { signal, timeoutMs = DEFAULT_CDP_TIMEOUT_MS, debuggerFactory } = {}) {
  if (!webContents || webContents.isDestroyed?.()) {
    throw new LobbyFileError("TARGET_UNAVAILABLE", "The lobby panel is not available");
  }
  if (typeof realPath !== "string" || realPath === "") {
    throw new LobbyFileError("FILE_INVALID", "The prepared file has no resolved path");
  }
  if (signal?.aborted) throw new LobbyFileError("ABORTED", "Cancelled before binding the file");

  const debuggerApi = debuggerFactory ? debuggerFactory(webContents) : webContents.debugger;
  if (!debuggerApi?.sendCommand) {
    throw new LobbyFileError("CAPABILITY_UNAVAILABLE", "The Electron debugger API is unavailable for the lobby panel");
  }

  let attachedHere = false;
  const objectGroup = "arcanedesk-lobby-file";
  const command = (method, params) => withTimeout(
    debuggerApi.sendCommand(method, params),
    timeoutMs,
    "FILE_BIND_TIMEOUT",
    `The native file binding timed out (${method})`,
  );

  try {
    if (typeof debuggerApi.isAttached === "function" && !debuggerApi.isAttached()) {
      try {
        await withTimeout(
          debuggerApi.attach("1.3"),
          timeoutMs,
          "FILE_BIND_FAILED",
          "The panel debugger could not be attached for native file binding",
        );
        attachedHere = true;
      } catch (error) {
        if (error instanceof LobbyFileError) throw error;
        throw new LobbyFileError(
          "CAPABILITY_UNAVAILABLE",
          "Native file binding could not attach to the panel debugger; close DevTools if it is attached and retry",
        );
      }
    }

    const evaluated = await command("Runtime.evaluate", {
      expression: "globalThis.__MT_LOBBY_SERVICE__.getFileInput()",
      objectGroup,
      returnByValue: false,
      awaitPromise: true,
      silent: true,
    });
    if (evaluated?.exceptionDetails) {
      throw new LobbyFileError("CAPABILITY_UNAVAILABLE", "The lobby service did not return its hidden file input");
    }
    const objectId = evaluated?.result?.objectId;
    if (!objectId) {
      throw new LobbyFileError("CAPABILITY_UNAVAILABLE", "The lobby service did not return a hidden file input element");
    }

    await command("DOM.enable", {});
    await command("DOM.setFileInputFiles", { files: [realPath], objectId });
  } catch (error) {
    if (error instanceof LobbyFileError) throw error;
    throw new LobbyFileError("FILE_BIND_FAILED", "The native file binding failed");
  } finally {
    try {
      if (debuggerApi.isAttached?.()) {
        await withTimeout(
          debuggerApi.sendCommand("Runtime.releaseObjectGroup", { objectGroup }),
          2_000,
          "FILE_BIND_TIMEOUT",
          "Releasing the file input reference timed out",
        ).catch(() => {});
      }
    } catch { /* best effort */ }
    if (attachedHere && debuggerApi.isAttached?.()) {
      try { debuggerApi.detach(); } catch { /* the page may already be gone */ }
    }
  }
}
