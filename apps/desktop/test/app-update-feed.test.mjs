// app-update-feed.test.mjs — electron-updater feed 构造与发布门禁的纯函数单测。
// 覆盖 docs/auto-update-design.md §3/§4 的发布侧契约：
// 每 channel 2 个 feed（latest.yml / latest-mac.yml），双架构同文件；
// 相对路径解析不得越出桶前缀；未签名门禁只对「含 Windows .exe 且 === false」生效。
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  buildUpdateFeedObjects,
  feedRelativePath,
  assertFeedGate,
  deriveWindowsSignedFlag,
} from "../scripts/publish-release.mjs";

const TARGET = Object.freeze({
  clientKind: "oss",
  baseUrl: "https://arcane-package.oss-cn-beijing.aliyuncs.com",
  latestKey: "desktop/arcane-desk/latest.json",
  releaseRoot: "desktop/arcane-desk/releases",
});

const FILE = (platform, name, sha512 = `${platform}:${name}:sha512`) => ({
  platform,
  name,
  bytes: name.length * 1000,
  sha256: "ab".repeat(32),
  sha512,
  kind: name.endsWith(".exe") ? "nsis" : name.endsWith(".zip") ? "zip" : "checksums",
  contentType: "application/octet-stream",
  url: `${TARGET.baseUrl}/${TARGET.releaseRoot}/0.4.4-test/${platform}/${name}`,
});

const RELEASE = Object.freeze({
  releaseId: "0.4.4-test",
  channel: "private-beta",
  product: { version: "0.4.4" },
  publishedAt: "2026-09-24T00:00:00Z",
  windowsInstallersSigned: true,
  files: [
    FILE("windows-arm64", "Arcane-Desk-0.4.4-win-arm64.exe", "AAAArm64sha512"),
    FILE("windows-x64", "Arcane-Desk-0.4.4-win-x64.exe", "XXXX64sha512"),
    FILE("macos-arm64", "Arcane-Desk-0.4.4-mac-arm64.zip", "MMAMACarm64"),
    FILE("macos-x64", "Arcane-Desk-0.4.4-mac-x64.zip", "MMMACx64"),
    FILE("windows-x64", "SHA256SUMS.txt"),
    FILE("macos-x64", "SHA256SUMS.txt"),
  ],
});

test("feedRelativePath：从 update/<channel>/ 解析回版本目录", () => {
  const rel = feedRelativePath(TARGET, "private-beta", RELEASE.files[1]);
  assert.equal(rel, "../../releases/0.4.4-test/windows-x64/Arcane-Desk-0.4.4-win-x64.exe");
});

test("feedRelativePath：拒绝桶外地址", () => {
  assert.throws(
    () => feedRelativePath(TARGET, "private-beta", { ...RELEASE.files[1], url: "https://evil.example/x.exe" }),
    /outside bucket base/,
  );
});

test("buildUpdateFeedObjects：每 channel 2 个 feed，双架构同文件，checksums 不入 feed", () => {
  const objects = buildUpdateFeedObjects(RELEASE, TARGET);
  assert.equal(objects.length, 2);
  const win = objects.find((o) => o.key.endsWith("update/private-beta/latest.yml"));
  const mac = objects.find((o) => o.key.endsWith("update/private-beta/latest-mac.yml"));
  assert.ok(win, "latest.yml missing");
  assert.ok(mac, "latest-mac.yml missing");
  assert.equal(win.cache, "no-cache");
  // 两个 exe 都在同一个 feed 里（arm64 不得拆出去）
  assert.match(win.body, /Arcane-Desk-0\.4\.4-win-x64\.exe/);
  assert.match(win.body, /Arcane-Desk-0\.4\.4-win-arm64\.exe/);
  assert.doesNotMatch(win.body, /SHA256SUMS/);
  assert.match(mac.body, /mac-arm64\.zip/);
  assert.match(mac.body, /mac-x64\.zip/);
});

test("buildUpdateFeedObjects：YAML 结构与 electron-updater 契约", () => {
  const [win] = buildUpdateFeedObjects(RELEASE, TARGET).filter((o) => o.key.endsWith("latest.yml"));
  const lines = win.body.split("\n");
  assert.equal(lines[0], 'version: "0.4.4"');
  // 顶层 path/sha512 指向主件（x64 优先于 arm64 的字母序）
  assert.ok(lines[1].startsWith('path: "../../releases/0.4.4-test/windows-x64/'));
  assert.ok(lines[2].startsWith('sha512: "XXXX64sha512"'));
  assert.equal(lines[3], "releaseDate: 2026-09-24T00:00:00Z");
  assert.equal(lines[4], "files:");
  // files[] 每条三行：url / sha512 / size
  assert.equal(lines.filter((l) => l.startsWith("  - url:")).length, 2);
  assert.ok(lines.every((l) => !l.includes("undefined") && !l.includes("NaN")));
  // sha512 按 electron-updater 契约保持发布端原样（base64 由计算侧保证）
  assert.match(win.body, /sha512: "AAAArm64sha512"/);
});

test("buildUpdateFeedObjects：缺 sha512 即抛错并指明回补路径", () => {
  const broken = {
    ...RELEASE,
    files: RELEASE.files.map((f) => (f.platform === "windows-arm64" ? { ...f, sha512: undefined } : f)),
  };
  assert.throws(() => buildUpdateFeedObjects(broken, TARGET), /requires sha512.*--backfill-feeds/s);
});

test("buildUpdateFeedObjects：本次无 mac 产物则不生成 mac feed（保留桶上既有）", () => {
  const winOnly = { ...RELEASE, files: RELEASE.files.filter((f) => !f.platform.startsWith("macos")) };
  const objects = buildUpdateFeedObjects(winOnly, TARGET);
  assert.equal(objects.length, 1);
  assert.ok(objects[0].key.endsWith("latest.yml"));
});

test("buildUpdateFeedObjects：缺 version/channel 抛错", () => {
  assert.throws(() => buildUpdateFeedObjects({ ...RELEASE, product: {} }, TARGET), /missing product\.version\/channel/);
});

test("assertFeedGate：含 Windows .exe 且未签名硬失败，应急口可越过", () => {
  const unsigned = { ...RELEASE, windowsInstallersSigned: false };
  assert.throws(() => assertFeedGate(unsigned), /refusing to publish update feeds/);
  assert.doesNotThrow(() => assertFeedGate(unsigned, { allowUnsignedFeed: true }));
});

test("assertFeedGate：已签名 / 无 Windows 件 / 缺字段（pre-feed 存量）均通过", () => {
  assert.doesNotThrow(() => assertFeedGate(RELEASE));
  const macOnly = { ...RELEASE, windowsInstallersSigned: false, files: RELEASE.files.filter((f) => f.platform.startsWith("macos")) };
  assert.doesNotThrow(() => assertFeedGate(macOnly));
  const legacy = { ...RELEASE, windowsInstallersSigned: undefined };
  assert.doesNotThrow(() => assertFeedGate(legacy));
});

test("deriveWindowsSignedFlag：无 exe 恒 true；无 signedDir 含 exe 为 false；exe 全部来自签名目录为 true", () => {
  const winExe = [{ platform: "windows-x64", file: "/sig/Arcane-Desk-0.4.4-win-x64.exe" }];
  assert.equal(deriveWindowsSignedFlag([{ platform: "macos-x64", file: "/dist/a.zip" }], undefined), true);
  assert.equal(deriveWindowsSignedFlag(winExe, undefined), false);
  assert.equal(deriveWindowsSignedFlag(winExe, "/sig"), true);
  assert.equal(
    deriveWindowsSignedFlag([...winExe, { platform: "windows-x64", file: "/dist/other.exe" }], "/sig"),
    false,
  );
});

test("parseArgs：--backfill-feeds 与发布类选项互斥，不触发默认 --from-dist；--assets-dir 可选", () => {
  const args = parseArgs(["--backfill-feeds", "0.4.3-x", "--assets-dir", "/tmp/a", "--region", "cn", "--dry-run"]);
  assert.equal(args.backfillFeeds, "0.4.3-x");
  assert.equal(args.assetsDir, "/tmp/a");
  assert.equal(args.fromDist, undefined);
  // 本地字节缺失时允许纯桶内回填（sha256 锚定）
  const bucketOnly = parseArgs(["--backfill-feeds", "0.4.3-x"]);
  assert.equal(bucketOnly.assetsDir, undefined);
  assert.throws(
    () => parseArgs(["--backfill-feeds", "0.4.3-x", "--staging", "/tmp/s"]),
    /cannot be combined/,
  );
});

test("parseArgs：--allow-unsigned-feed 开关解析", () => {
  const args = parseArgs(["--staging", "/tmp/s", "--allow-unsigned-feed"]);
  assert.equal(args.allowUnsignedFeed, true);
  const plain = parseArgs(["--staging", "/tmp/s"]);
  assert.equal(plain.allowUnsignedFeed, undefined);
});
