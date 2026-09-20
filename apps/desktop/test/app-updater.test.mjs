// app-updater.test.mjs — 应用更新状态机与 feed URL 映射单测。
// AppUpdater 的 electron-updater 依赖全部注入 mock，node --test 直测状态流转。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AppUpdater, buildFeedUrl, readReleaseChannel } from "../src/main/app-updater.mjs";

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: { version: "0.4.4" } });
  updater.downloadUpdate = async () => ({});
  updater.quitAndInstall = () => { updater.quitCalled = (updater.quitCalled ?? 0) + 1; };
  updater.setFeedURL = (opts) => { updater.feedUrl = opts?.url; };
  return updater;
}

const BASE_OPTS = { feedUrl: "https://example.com/update/private-beta", currentVersion: "0.4.3" };

test("buildFeedUrl：两侧去斜杠拼接，空值抛错", () => {
  assert.equal(buildFeedUrl("https://example.com/update/", "/private-beta/"), "https://example.com/update/private-beta");
  assert.throws(() => buildFeedUrl("", "x"), /base url is empty/);
  assert.throws(() => buildFeedUrl("https://x", " "), /channel is empty/);
});

test("readReleaseChannel：读包内 manifest，缺文件回落 private-beta", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-channel-"));
  const file = path.join(dir, "desktop-release.json");
  assert.equal(readReleaseChannel(file), "private-beta");
  await fsp.writeFile(file, JSON.stringify({ channel: "beta-1" }), "utf8");
  assert.equal(readReleaseChannel(file), "beta-1");
  await fsp.writeFile(file, "not json", "utf8");
  assert.equal(readReleaseChannel(file), "private-beta");
});

test("AppUpdater：构造时钉死四个纪律参数并设置 feed URL", () => {
  const updater = fakeUpdater();
  new AppUpdater({ ...BASE_OPTS, updater });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableDifferentialDownload, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.feedUrl, BASE_OPTS.feedUrl);
});

test("AppUpdater：check 幂等，update-available → available，not-available → idle", async () => {
  const updater = fakeUpdater();
  const states = [];
  const app = new AppUpdater({ ...BASE_OPTS, updater, onState: (s) => states.push(s.status) });
  updater.emit("checking-for-update");
  assert.equal(app.snapshot().status, "checking");
  updater.emit("update-available", { version: "0.4.4" });
  assert.equal(app.snapshot().status, "available");
  assert.equal(app.snapshot().version, "0.4.4");
  updater.emit("update-not-available");
  assert.equal(app.snapshot().status, "idle");
  assert.ok(states.includes("available"));
});

test("AppUpdater：feed 404（channel 缺失）按无更新处理，不进 error", async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => {
    const error = new Error("Cannot find channel");
    error.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
    throw error;
  };
  const app = new AppUpdater({ ...BASE_OPTS, updater });
  await app.check();
  assert.equal(app.snapshot().status, "idle");
  assert.equal(app.snapshot().error, undefined);
});

test("AppUpdater：下载进度 → downloading → ready；install 仅 ready 生效", async () => {
  const updater = fakeUpdater();
  const app = new AppUpdater({ ...BASE_OPTS, updater });
  // 未 available 时 download 不改变状态
  await app.download();
  assert.equal(app.snapshot().status, "idle");
  updater.emit("update-available", { version: "0.4.4" });
  const downloading = app.download();
  updater.emit("download-progress", { percent: 47.04, transferred: 68200000, total: 145300000, bytesPerSecond: 7900000 });
  assert.equal(app.snapshot().status, "downloading");
  assert.equal(app.snapshot().progress.percent, 47);
  updater.emit("update-downloaded", { version: "0.4.4" });
  await downloading;
  assert.equal(app.snapshot().status, "ready");
  // ready 后再 download 幂等返回；install 触发 quitAndInstall
  await app.download();
  assert.equal(app.snapshot().status, "ready");
  app.install();
  assert.equal(updater.quitCalled, 1);
});

test("AppUpdater：未 ready 时 install 是空操作", () => {
  const updater = fakeUpdater();
  const app = new AppUpdater({ ...BASE_OPTS, updater });
  app.install();
  updater.emit("update-available", { version: "0.4.4" });
  app.install();
  assert.equal(updater.quitCalled ?? 0, 0);
});

test("AppUpdater：updater 抛错进 error 态并携带消息；重试可退出 error", async () => {
  const updater = fakeUpdater();
  updater.downloadUpdate = async () => { throw new Error("sha512 mismatch"); };
  const app = new AppUpdater({ ...BASE_OPTS, updater });
  updater.emit("update-available", { version: "0.4.4" });
  await app.download();
  assert.equal(app.snapshot().status, "error");
  assert.match(app.snapshot().error, /sha512 mismatch/);
  updater.downloadUpdate = async () => ({});
  updater.emit("update-available", { version: "0.4.4" });
  const retry = app.download();
  updater.emit("download-progress", { percent: 1, transferred: 0, total: 100, bytesPerSecond: 1 });
  assert.equal(app.snapshot().status, "downloading");
  await retry;
});
