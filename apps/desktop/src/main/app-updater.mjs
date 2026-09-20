// app-updater.mjs — 应用内自动更新通道（设计见 docs/auto-update-design.md）。
//
// 与 skills-updater（skill 下发通道）平级但独立：本通道替换的是 app 本体。
// 纪律（§5.1/§6）：
// - 不自动下载（autoDownload=false）、退出不顺手装（autoInstallOnAppQuit=false）、
//   不降级（allowDowngrade=false）、不差分（disableDifferentialDownload=true）。
// - feed URL 只来自 region 默认值 / ARCANE_UPDATE_FEED_BASE_URL 显式覆盖，
//   channel 构建期烘进 generated/desktop-release.json，运行期只读。
// - 状态机对渲染层单向推送：update:state（经 main.js 的 arcane:event 总线）。
//   状态不落盘：重启后例行 check 重新发现同一更新，ready 靠 pending 缓存秒回。
// - 下载/安装全部显式：check 的唯一副作用是点亮标记；feed 404（如无此 channel
//   或 dev 包）按「无更新」处理，不进 error。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import updaterPkg from "electron-updater";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// electron-updater 是 CJS：autoUpdater 为其 module.exports 上的懒加载 getter。
// 再包一层惰性求值：单测注入 mock updater 时完全不触碰 electron-updater/electron。
let cachedDefaultUpdater = null;
function defaultUpdater() {
  if (!cachedDefaultUpdater) cachedDefaultUpdater = updaterPkg.autoUpdater;
  return cachedDefaultUpdater;
}

export const UPDATE_CHECK_DELAY_MS = 30_000;
export const UPDATE_CHECK_JITTER_MS = 15_000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 读取构建期烘进包里的发布 channel（prepare-desktop-release.mjs 写入）。 */
export function readReleaseChannel(desktopReleaseJson = path.join(__dirname, "..", "..", "generated", "desktop-release.json")) {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopReleaseJson, "utf8"));
    const channel = String(parsed?.channel ?? "").trim();
    if (channel) return channel;
  } catch {
    // dev 未跑 prepare 时文件不存在：回落默认 channel，feed 404 即静默无更新。
  }
  return "private-beta";
}

/** feed 基址 + channel → feed URL（纯函数：两侧去斜杠后拼接）。 */
export function buildFeedUrl(baseUrl, channel) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const ch = String(channel ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!base) throw new Error("update feed base url is empty");
  if (!ch) throw new Error("update feed channel is empty");
  return `${base}/${ch}`;
}

// feed 不存在 = 「无更新」，不是错误（dev 包 channel、尚未回填的 channel 都走这里）。
function isChannelMissingError(error) {
  return error?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
}

function normalizeProgress(progress) {
  return {
    percent: Math.round((progress?.percent ?? 0) * 10) / 10,
    transferred: Math.round(progress?.transferred ?? 0),
    total: Math.round(progress?.total ?? 0),
    bytesPerSecond: Math.round(progress?.bytesPerSecond ?? 0),
  };
}

/**
 * 应用更新状态机。electron 相关依赖全部经构造注入，node --test 可直测。
 * 状态：idle（无更新/初始）→ checking → available → downloading → ready；
 * error 为旁路状态（可从任意状态进入，check/download 成功即退出）。
 */
export class AppUpdater {
  constructor({
    feedUrl,
    currentVersion,
    updater = defaultUpdater(),
    logger = console,
    onState = null,
    checkDelayMs = UPDATE_CHECK_DELAY_MS,
    checkJitterMs = UPDATE_CHECK_JITTER_MS,
    checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  }) {
    if (!feedUrl) throw new Error("AppUpdater requires feedUrl");
    this.currentVersion = currentVersion;
    this.updater = updater;
    this.logger = logger;
    this.onState = onState;
    this.checkDelayMs = checkDelayMs;
    this.checkJitterMs = checkJitterMs;
    this.checkIntervalMs = checkIntervalMs;

    this.state = { status: "idle", currentVersion };
    this.checkTimer = null;
    this.intervalTimer = null;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.allowDowngrade = false;
    updater.setFeedURL({ provider: "generic", url: feedUrl });

    // electron-updater 对无人监听的 error 事件会打日志；统一归并进状态机。
    updater.on("checking-for-update", () => this.#setState({ status: "checking" }));
    updater.on("update-available", (info) => {
      this.#setState({ status: "available", version: info?.version ?? null });
    });
    updater.on("update-not-available", () => this.#setState({ status: "idle", version: null }));
    updater.on("download-progress", (progress) => {
      this.#setState({ status: "downloading", progress: normalizeProgress(progress) });
    });
    updater.on("update-downloaded", (info) => {
      this.#setState({ status: "ready", version: info?.version ?? this.state.version ?? null, progress: null });
    });
    updater.on("error", (error) => {
      if (isChannelMissingError(error)) {
        this.#setState({ status: "idle", version: null });
        return;
      }
      this.logger.warn?.("[app-update] updater error:", error?.message ?? error);
      this.#setState({
        status: "error",
        error: String(error?.message ?? error).slice(0, 300),
        progress: null,
      });
    });
  }

  #setState(patch) {
    this.state = { ...this.state, ...patch, currentVersion: this.currentVersion };
    try {
      this.onState?.(this.state);
    } catch (error) {
      this.logger.error?.("[app-update] onState listener failed:", error);
    }
  }

  snapshot() {
    return { ...this.state };
  }

  /** 手动或定时触发检查。已在检查中则返回当前状态（幂等）。 */
  async check() {
    if (this.state.status === "checking" || this.state.status === "downloading") return this.snapshot();
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      if (isChannelMissingError(error)) {
        this.#setState({ status: "idle", version: null });
      } else {
        this.#setState({ status: "error", error: String(error?.message ?? error).slice(0, 300) });
      }
    }
    return this.snapshot();
  }

  /** 显式下载。仅 available / error 可进入；downloading 幂等返回；ready 原样返回。 */
  async download() {
    if (this.state.status === "ready" || this.state.status === "downloading") return this.snapshot();
    if (this.state.status !== "available" && this.state.status !== "error") return this.snapshot();
    try {
      // pending 缓存命中（version+sha512 一致）时 electron-updater 直接发 update-downloaded。
      await this.updater.downloadUpdate();
    } catch (error) {
      this.#setState({ status: "error", error: String(error?.message ?? error).slice(0, 300) });
    }
    return this.snapshot();
  }

  /** 显式安装。仅 ready 生效；quitAndInstall 未完成下载时本会抛，守卫在此。 */
  install() {
    if (this.state.status !== "ready") return this.snapshot();
    this.updater.quitAndInstall();
    return this.snapshot();
  }

  /** 启动例行检查：首检延迟 + 随机抖动（避免发布瞬间所有客户端齐刷），之后每 24h。 */
  start() {
    this.stop();
    const delay = this.checkDelayMs + Math.floor(Math.random() * (this.checkJitterMs + 1));
    this.checkTimer = setTimeout(() => {
      this.check().catch((error) => this.logger.warn?.("[app-update] scheduled check failed:", error?.message ?? error));
      this.intervalTimer = setInterval(() => {
        this.check().catch((error) => this.logger.warn?.("[app-update] scheduled check failed:", error?.message ?? error));
      }, this.checkIntervalMs);
      this.intervalTimer.unref?.();
    }, delay);
    this.checkTimer.unref?.();
    return this;
  }

  stop() {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.checkTimer = null;
    this.intervalTimer = null;
  }
}
