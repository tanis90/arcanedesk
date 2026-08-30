import path from "node:path";

/**
 * Normalize environment defaults inherited by Arcane-owned child processes.
 *
 * Windows Python otherwise follows the active legacy code page, while Pi
 * decodes piped tool output as UTF-8. Keep the override process-scoped and
 * preserve an explicit user choice.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {NodeJS.Platform | string} platform
 */
export function applyArcaneSubprocessEnvironment(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    env.PYTHONUTF8 ??= "1";
    env.PYTHONIOENCODING ??= "utf-8";
  }
  return env;
}

/**
 * Make the Arcane-managed FVTT runtime the Node selected by every Agent shell.
 *
 * This is deliberately process-scoped: it neither edits the user's system PATH
 * nor changes Electron's embedded Node. Formal FVTT tools can use
 * ARCANE_FVTT_NODE directly, while a plain `node`/`npm` entered through Pi's
 * PowerShell or Bash resolves from the same runtime directory first.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} nodeBinary
 * @param {NodeJS.Platform | string} platform
 */
export function applyArcaneFvttOpsEnvironment(
  env = process.env,
  nodeBinary,
  platform = process.platform,
) {
  if (!nodeBinary || typeof nodeBinary !== "string") {
    throw new TypeError("Arcane FVTT Node requires an absolute executable path");
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(nodeBinary)) {
    throw new TypeError("Arcane FVTT Node requires an absolute executable path");
  }

  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  const pathKey = pathKeys[0] ?? (platform === "win32" ? "Path" : "PATH");
  const delimiter = platform === "win32" ? ";" : ":";
  const nodeDir = pathApi.dirname(nodeBinary);
  const samePath = (left, right) => platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  const inherited = pathKeys
    .flatMap((key) => String(env[key] ?? "").split(delimiter))
    .filter(Boolean)
    .filter((entry, index, entries) => entries.findIndex((candidate) => samePath(candidate, entry)) === index)
    .filter((entry) => !samePath(entry, nodeDir));

  for (const duplicate of pathKeys.slice(1)) delete env[duplicate];
  env[pathKey] = [nodeDir, ...inherited].join(delimiter);
  env.ARCANE_FVTT_NODE = nodeBinary;
  return env;
}
