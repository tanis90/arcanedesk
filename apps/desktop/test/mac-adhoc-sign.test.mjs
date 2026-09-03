import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { macBundleRoot, shouldAdHocResign } from "../scripts/mac-adhoc-sign.mjs";

test("ad-hoc re-sign applies only to intentionally unsigned macOS builds", () => {
  assert.equal(shouldAdHocResign({ electronPlatformName: "darwin", macIdentity: null }), true);
  assert.equal(shouldAdHocResign({ electronPlatformName: "darwin", macIdentity: "Developer ID Application" }), false);
  assert.equal(shouldAdHocResign({ electronPlatformName: "darwin", macIdentity: undefined }), false);
  assert.equal(shouldAdHocResign({ electronPlatformName: "win32", macIdentity: null }), false);
  assert.equal(shouldAdHocResign({ electronPlatformName: "linux", macIdentity: null }), false);
});

test("packaged app root resolves to its macOS bundle", () => {
  assert.equal(
    macBundleRoot("/tmp/dist/mac-arm64/ArcaneDesk.app/Contents/Resources/app"),
    "/tmp/dist/mac-arm64/ArcaneDesk.app",
  );
  assert.equal(macBundleRoot("/tmp/dist/win-unpacked/resources/app"), null);
  assert.equal(macBundleRoot("/tmp/plain-dir"), null);
});

test("ad-hoc re-sign hook stays wired but self-skips for signed macOS builds", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // afterSign is skipped when no signing occurred (identity: null); afterPack
  // is the hook that actually runs for unsigned builds. Release builds now sign
  // with a real Developer ID identity, so the hook must refuse to overwrite it.
  assert.equal(pkg.build.afterPack, "scripts/mac-adhoc-sign.mjs");
  // identity 用证书的 SHA-1(electron-builder 不接受 "Developer ID Application:" 前缀)
  assert.equal(pkg.build.mac.identity, "AE4865DBC4A663E90902131977AC43B79321B7A2");
  assert.equal(shouldAdHocResign({ electronPlatformName: "darwin", macIdentity: pkg.build.mac.identity }), false);
});
