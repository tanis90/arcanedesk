// skills-updater — 内置 skills 的自维护通道:启动时从固定 OSS 位置拉取 skill
// bundle 指针,有新 revision 就下载、校验、原子换入 userData,让"改 skill 文本"
// 不再依赖 app 发版。涉及新基础能力的 skill 用 manifest.minAppVersion 门住,
// 能力不足的旧 app 永远停在旧 bundle(fail closed)。
//
// 信任模型:skills 里有可执行脚本(arcane-fvtt-mods/scripts/mod-manager.mjs),
// 所以这条通道等同远程代码下发。URL 全部由本模块常量拼出(latest.json 与
// manifest.json 都不含 URL 字段),下载必须 HTTPS、禁 redirect、限大小,
// tarball 与逐文件 SHA256 以 manifest 为准二次核对,任一步失败保留现状。
//
// OSS 布局(契约见 distribution/oss-release-contract.md):
//   desktop/arcane-desk/skills/latest.json            可变指针 { schemaVersion, revision }
//   desktop/arcane-desk/skills/<revision>/manifest.json   不可变 { revision, minAppVersion?, bundle, files }
//   desktop/arcane-desk/skills/<revision>/bundle.tar.gz   不可变 skills/prep 全量
//
// 本地布局(stateDir 即 userData/skills):
//   state.json                 { schemaVersion, revision, activatedAt }
//   active/                    当前生效 bundle(含 bundle.json 与 .arcane-manifest.json)
//   .staging-<uuid>/ .incoming-<uuid>.tar.gz   刷新过程中的临时文件
//
// 运维遥测:每次 refresh 的结果(含失败)经 onRefreshResult 回调上报一条;
// 回调自身抛错被吞掉,遥测永远不能改变 refresh 的返回值或时序。

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { extractArchiveFile, safeArchivePath } from "../../scripts/archive.mjs";
import { replaceDirectory } from "./fvtt-ops-runtime.mjs";

export const SKILLS_UPDATE_BASE_URL =
  "https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/skills";

/** baseUrl 只允许 HTTPS;HTTP 仅限精确 loopback(与 provider 端点纪律一致),供本地联调。 */
function assertSafeBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`skills update base URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return parsed;
  throw new Error(`skills update base URL must be HTTPS (HTTP only on loopback): ${url}`);
}

const MAX_POINTER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const ACTIVE_DIR_NAME = "active";
const EMBEDDED_MANIFEST_NAME = ".arcane-manifest.json";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 三路数字 semver 比较:a<b 返回负数,a=b 返回 0,a>b 返回正数;非法输入抛错。 */
export function compareSemver(a, b) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ""));
    if (!match) throw new Error(`not a three-part version: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** bundle.json 里的单调版本号;缺失或非法视为 0(= 没有可用基线)。 */
export function bundleRevision(skillsDir) {
  try {
    const meta = readJsonFile(path.join(skillsDir, "bundle.json"));
    return Number.isSafeInteger(meta?.revision) && meta.revision >= 1 ? meta.revision : 0;
  } catch {
    return 0;
  }
}

/** 校验 manifest.files 的键:必须是规整的 POSIX 相对路径,且自带合法 sha256/bytes。 */
function validateManifestFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("skills manifest has no files map");
  }
  const entries = Object.entries(files);
  if (!entries.length) throw new Error("skills manifest files map is empty");
  for (const [name, meta] of entries) {
    if (safeArchivePath(name) !== name) throw new Error(`skills manifest has an unsafe path: ${name}`);
    if (!/^[a-f0-9]{64}$/.test(String(meta?.sha256 ?? ""))) {
      throw new Error(`skills manifest entry lacks a sha256: ${name}`);
    }
    if (!Number.isSafeInteger(meta?.bytes) || meta.bytes < 0) {
      throw new Error(`skills manifest entry lacks a byte size: ${name}`);
    }
  }
  return entries;
}

export class SkillsUpdater {
  /**
   * @param {{
   *   bundledSkillsDir: string,
   *   stateDir: string,
   *   appVersion: string,
   *   fetchImpl?: typeof fetch,
   *   extractArchive?: (archive: string, destination: string) => Promise<unknown>,
   *   onActivated?: (dir: string, revision: number) => void,
   *   onRefreshResult?: (report: {
   *     outcome: "updated" | "up_to_date" | "min_app_version_blocked" | "error",
   *     fromRevision: number,
   *     toRevision: number,
   *     error: unknown,
   *     durationMs: number,
   *   }) => void,
   *   log?: (message: string) => void,
   *   requestTimeoutMs?: number,
   *   maxBundleBytes?: number,
   *   baseUrl?: string,
   * }} options
   */
  constructor({
    bundledSkillsDir,
    stateDir,
    appVersion,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    extractArchive = extractArchiveFile,
    onActivated = null,
    onRefreshResult = null,
    log = (message) => console.log(message),
    requestTimeoutMs = 15_000,
    maxBundleBytes = MAX_BUNDLE_BYTES,
    baseUrl = SKILLS_UPDATE_BASE_URL,
  }) {
    if (!bundledSkillsDir || !stateDir) {
      throw new TypeError("SkillsUpdater requires bundledSkillsDir and stateDir");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("SkillsUpdater requires a fetch implementation");
    this.bundledSkillsDir = path.resolve(bundledSkillsDir);
    this.stateDir = path.resolve(stateDir);
    this.appVersion = appVersion;
    this.fetchImpl = fetchImpl;
    this.extractArchive = extractArchive;
    this.onActivated = onActivated;
    this.onRefreshResult = onRefreshResult;
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxBundleBytes = maxBundleBytes;
    this.baseUrl = assertSafeBaseUrl(baseUrl).href.replace(/\/+$/, "");
    /** 本次进程内的解析结论;refresh 成功换入新 bundle 后会更新。 */
    this.resolved = null;
  }

  get activeDir() {
    return path.join(this.stateDir, ACTIVE_DIR_NAME);
  }

  /**
   * 当前 session 应该使用的 skills 目录:userData 激活副本完整且 revision 不低于
   * 包内基线时用它,否则回退包内。首次调用同步做全量逐文件 SHA256 核对(文件
   * 少而小,毫秒级),结论在进程内缓存;损坏副本会被清除并回退包内基线。
   */
  resolveSkillsDir() {
    if (this.resolved) return this.resolved;
    this.resolved = this.computeResolvedDir();
    return this.resolved;
  }

  computeResolvedDir() {
    const bundledRevision = bundleRevision(this.bundledSkillsDir);
    try {
      const state = readJsonFile(path.join(this.stateDir, "state.json"));
      const revision = state?.schemaVersion === 1 && Number.isSafeInteger(state?.revision) && state.revision >= 1
        ? state.revision
        : 0;
      if (!revision) throw new Error("no valid skills state");
      if (revision < bundledRevision) {
        throw new Error(`activated skills revision ${revision} is older than the bundled baseline ${bundledRevision}`);
      }
      if (bundleRevision(this.activeDir) !== revision) {
        throw new Error("activated skills bundle.json does not match the recorded revision");
      }
      const manifest = readJsonFile(path.join(this.activeDir, EMBEDDED_MANIFEST_NAME));
      if (manifest?.revision !== revision) throw new Error("activated skills manifest does not match the recorded revision");
      for (const [name, meta] of validateManifestFiles(manifest.files)) {
        const file = path.join(this.activeDir, ...name.split("/"));
        const content = fs.readFileSync(file);
        if (content.length !== meta.bytes || sha256Hex(content) !== meta.sha256) {
          throw new Error(`activated skills file failed integrity check: ${name}`);
        }
      }
      return this.activeDir;
    } catch (error) {
      this.quarantineActive(error);
      return this.bundledSkillsDir;
    }
  }

  /** 损坏/不一致的激活副本立即作废:删掉激活态,后续 session 一律回退包内基线。 */
  quarantineActive(error) {
    if (!fs.existsSync(this.activeDir) && !fs.existsSync(path.join(this.stateDir, "state.json"))) return;
    this.log(`[skills] discarded the activated skills copy (${errorMessage(error)}); bundled baseline is in effect`);
    fs.rmSync(this.activeDir, { recursive: true, force: true });
    fs.rmSync(path.join(this.stateDir, "state.json"), { force: true });
  }

  async fetchJson(url, maxBytes) {
    const response = await this.fetchImpl(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: { accept: "application/json", "accept-encoding": "identity" },
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "no response"} for ${url}`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes: ${url}`);
    return JSON.parse(text);
  }

  async downloadBundle(url, expected, destination) {
    const response = await this.fetchImpl(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: { "accept-encoding": "identity" },
    });
    if (!response?.ok || !response.body) throw new Error(`HTTP ${response?.status ?? "no response"} for ${url}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > this.maxBundleBytes || total > expected.bytes) {
        throw new Error(`skills bundle exceeds the expected ${expected.bytes} bytes`);
      }
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (content.length !== expected.bytes || sha256Hex(content) !== expected.sha256) {
      throw new Error("skills bundle SHA256/size mismatch against the verified manifest");
    }
    await fsp.writeFile(destination, content);
  }

  /** 解压结果必须与 manifest.files 完全一致:不多一个文件,不少一个文件,逐文件 SHA256 核对。 */
  async verifyExtractedTree(treeDir, manifest) {
    const expected = new Map(validateManifestFiles(manifest.files));
    const actual = new Set();
    const walk = async (directory) => {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) actual.add(path.relative(treeDir, absolute).split(path.sep).join("/"));
      }
    };
    await walk(treeDir);
    actual.delete(EMBEDDED_MANIFEST_NAME);
    for (const name of actual) {
      if (!expected.has(name)) throw new Error(`skills bundle contains an unlisted file: ${name}`);
    }
    for (const [name, meta] of expected) {
      if (!actual.has(name)) throw new Error(`skills bundle is missing a listed file: ${name}`);
      const content = await fsp.readFile(path.join(treeDir, ...name.split("/")));
      if (content.length !== meta.bytes || sha256Hex(content) !== meta.sha256) {
        throw new Error(`skills bundle file failed integrity check: ${name}`);
      }
    }
    if (bundleRevision(treeDir) !== manifest.revision) {
      throw new Error("skills bundle.json revision does not match the manifest");
    }
  }

  /** 清掉上次刷新可能残留的临时文件(尽力而为,失败不影响本次刷新)。 */
  async sweepTempEntries() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.stateDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(".staging-") && !entry.name.startsWith(".incoming-")) continue;
      await fsp.rm(path.join(this.stateDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 启动时跑一次的后台刷新。永不抛出:任何失败都记录日志并保留现状。
   * 每次刷新(含失败)在 finally 里经 onRefreshResult 报一条运维遥测。
   * @returns {Promise<{ updated: boolean, revision?: number, reason?: string }>}
   */
  async refresh() {
    const report = {
      outcome: "error",
      fromRevision: this.peekCurrentRevision(),
      toRevision: 0,
      error: null,
      startedAt: performance.now(),
    };
    try {
      const outcome = await this.refreshUnsafe(report);
      report.error = null;
      if (outcome.updated) {
        report.outcome = "updated";
        report.toRevision = outcome.revision;
      } else if (outcome.reason === "up-to-date") {
        report.outcome = "up_to_date";
        report.toRevision = outcome.revision;
      } else if (outcome.reason === "min-app-version") {
        report.outcome = "min_app_version_blocked";
        // toRevision 已由 refreshUnsafe 填成被门住的目标 revision。
      }
      // 未识别的 reason 保持 "error":让看板大声暴露遥测接线滞后,而不是静默丢信号。
      return outcome;
    } catch (error) {
      report.error = error;
      this.log(`[skills] skills refresh failed; keeping current skills: ${errorMessage(error)}`);
      return { updated: false, reason: "error" };
    } finally {
      this.reportRefreshResult(report);
    }
  }

  /** 与 refreshUnsafe 相同的当前 revision 口径;resolveSkillsDir 内部 fail closed,永不抛出。 */
  peekCurrentRevision() {
    const currentDir = this.resolveSkillsDir();
    return Math.max(
      bundleRevision(this.bundledSkillsDir),
      currentDir === this.activeDir ? bundleRevision(this.activeDir) : 0,
    );
  }

  /** 遥测回调同属外部边界:回调抛错只丢这条遥测,不得改变 refresh 语义。 */
  reportRefreshResult(report) {
    if (!this.onRefreshResult) return;
    try {
      this.onRefreshResult({
        outcome: report.outcome,
        fromRevision: report.fromRevision,
        toRevision: report.toRevision,
        error: report.error,
        durationMs: Math.max(0, performance.now() - report.startedAt),
      });
    } catch { /* 遥测通道静默失败,与 skills 通道的 fail-closed 语义无关 */ }
  }

  async refreshUnsafe(report = null) {
    const currentDir = this.resolveSkillsDir();
    const currentRevision = Math.max(
      bundleRevision(this.bundledSkillsDir),
      currentDir === this.activeDir ? bundleRevision(this.activeDir) : 0,
    );

    const pointer = await this.fetchJson(`${this.baseUrl}/latest.json`, MAX_POINTER_BYTES);
    const revision = pointer?.schemaVersion === 1 && Number.isSafeInteger(pointer?.revision) && pointer.revision >= 1
      ? pointer.revision
      : null;
    if (!revision) throw new Error("skills latest.json is malformed");
    if (report) report.toRevision = revision;
    if (revision <= currentRevision) {
      this.log(`[skills] skills check OK: r${currentRevision} is current`);
      return { updated: false, reason: "up-to-date", revision: currentRevision };
    }

    const manifest = await this.fetchJson(`${this.baseUrl}/${revision}/manifest.json`, MAX_MANIFEST_BYTES);
    if (manifest?.schemaVersion !== 1 || manifest?.revision !== revision) {
      throw new Error("skills manifest does not match the latest pointer");
    }
    if (manifest.minAppVersion != null && compareSemver(this.appVersion, manifest.minAppVersion) < 0) {
      this.log(`[skills] skills bundle r${revision} requires app >= ${manifest.minAppVersion}; staying on r${currentRevision}`);
      return { updated: false, reason: "min-app-version", revision: currentRevision };
    }
    const bundle = manifest.bundle;
    if (
      !/^[a-f0-9]{64}$/.test(String(bundle?.sha256 ?? ""))
      || !Number.isSafeInteger(bundle?.bytes) || bundle.bytes < 1 || bundle.bytes > this.maxBundleBytes
    ) {
      throw new Error("skills manifest has an invalid bundle descriptor");
    }
    validateManifestFiles(manifest.files);

    await fsp.mkdir(this.stateDir, { recursive: true });
    await this.sweepTempEntries();
    const token = randomUUID();
    const archiveFile = path.join(this.stateDir, `.incoming-${token}.tar.gz`);
    const staging = path.join(this.stateDir, `.staging-${token}`);
    const tree = path.join(staging, "tree");
    try {
      await this.downloadBundle(`${this.baseUrl}/${revision}/bundle.tar.gz`, bundle, archiveFile);
      await this.extractArchive(archiveFile, tree);
      await this.verifyExtractedTree(tree, manifest);
      // manifest 随激活目录一起走,激活后每次解析都按它重新核对逐文件完整性。
      await fsp.writeFile(
        path.join(tree, EMBEDDED_MANIFEST_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await replaceDirectory(tree, this.activeDir);
      await fsp.writeFile(
        path.join(this.stateDir, "state.json"),
        `${JSON.stringify({ schemaVersion: 1, revision, activatedAt: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    } finally {
      await fsp.rm(archiveFile, { force: true }).catch(() => {});
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    this.resolved = this.activeDir;
    this.log(`[skills] skills updated to r${revision}; new agent sessions pick it up automatically`);
    this.onActivated?.(this.activeDir, revision);
    return { updated: true, revision };
  }
}
