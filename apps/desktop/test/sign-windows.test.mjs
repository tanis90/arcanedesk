import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CERT_SHA1,
  buildSignArgs,
  buildVerifyArgs,
  collectInstallerExes,
  isInstallerName,
  signtoolSearchPaths,
} from "../scripts/sign-windows.mjs";

test("installer name pattern accepts cn/intl windows installers only", () => {
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-win-x64.exe"), true);
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-win-arm64.exe"), true);
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-win-x64-intl.exe"), true);
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-win-arm64-intl.exe"), true);
  // 非 NSIS 安装器一概不收：zip/dmg/blockmap、mac 产物、任意 exe。
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-win-x64.zip"), false);
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-mac-arm64.dmg"), false);
  assert.equal(isInstallerName("Arcane-Desk-0.4.3-win-x64.exe.blockmap"), false);
  assert.equal(isInstallerName("Setup.exe"), false);
});

test("collectInstallerExes walks nested staging trees and sorts results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sign-windows-"));
  try {
    const make = (relative) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
      return file;
    };
    const cn = make("staging-cn/windows-x64/Arcane-Desk-0.4.3-win-x64.exe");
    const cnArm = make("staging-cn/windows-arm64/Arcane-Desk-0.4.3-win-arm64.exe");
    const intl = make("staging-intl/windows-x64/Arcane-Desk-0.4.3-win-x64-intl.exe");
    make("staging-cn/windows-x64/Arcane-Desk-0.4.3-win-x64.zip");
    make("staging-cn/macos-arm64/Arcane-Desk-0.4.3-mac-arm64.dmg");
    make("staging-cn/windows-x64/SHA256SUMS.txt");
    assert.deepEqual(collectInstallerExes(root), [cnArm, cn, intl].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("signtool search prefers explicit path, then newest Windows Kit, then winCodeSign cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signtool-paths-"));
  try {
    const kits = path.join(root, "Windows Kits", "10", "bin");
    fs.mkdirSync(path.join(kits, "10.0.22621.0", "x64"), { recursive: true });
    fs.mkdirSync(path.join(kits, "10.0.19041.0", "x64"), { recursive: true });
    const cache = path.join(root, "electron-builder", "Cache", "winCodeSign");
    fs.mkdirSync(path.join(cache, "winCodeSign-2.6.0", "windows-10", "x64"), { recursive: true });
    fs.mkdirSync(path.join(cache, "winCodeSign-2.6.0", "windows-6"), { recursive: true });

    const candidates = signtoolSearchPaths({
      explicit: "/explicit/signtool.exe",
      programFilesX86: root,
      localAppData: root,
    });
    assert.equal(candidates[0], "/explicit/signtool.exe");
    // Windows Kit 版本号倒序：最新的排在回落版本之前。
    const kitIndex = candidates.findIndex((c) => c.includes("10.0.22621.0"));
    assert.ok(kitIndex > 0 && candidates[kitIndex + 1].includes("10.0.19041.0"));
    // winCodeSign 缓存：windows-10 优先于 windows-6，最后是 PATH 兜底。
    const cacheIndex = candidates.findIndex((c) => c.includes(path.join("windows-10", "x64", "signtool.exe")));
    assert.ok(cacheIndex > kitIndex);
    assert.ok(candidates[cacheIndex + 1].includes(path.join("windows-6", "signtool.exe")));
    assert.equal(candidates[candidates.length - 1], "signtool.exe");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("signtool search tolerates missing Windows Kits and cache roots", () => {
  const missing = path.join(os.tmpdir(), "definitely-not-a-real-root");
  assert.deepEqual(
    signtoolSearchPaths({ explicit: null, programFilesX86: missing, localAppData: missing }),
    ["signtool.exe"],
  );
});

test("signtool arguments pin SHA-256 digests, the certificate, and the RFC3161 timestamp", () => {
  assert.deepEqual(
    buildSignArgs({ certSha1: "AB".repeat(20), timestampServer: "http://timestamp.example", file: "out/installer.exe" }),
    [
      "sign",
      "/fd", "SHA256",
      "/tr", "http://timestamp.example",
      "/td", "SHA256",
      "/sha1", "AB".repeat(20),
      "out/installer.exe",
    ],
  );
  assert.deepEqual(buildVerifyArgs({ file: "out/installer.exe" }), ["verify", "/pa", "/all", "out/installer.exe"]);
});

test("default certificate thumbprint is a pinned 40-hex SHA-1", () => {
  assert.match(DEFAULT_CERT_SHA1, /^[0-9A-F]{40}$/);
});
