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
    macBundleRoot("/tmp/dist/mac-arm64/Arcane Desk.app/Contents/Resources/app"),
    "/tmp/dist/mac-arm64/Arcane Desk.app",
  );
  assert.equal(macBundleRoot("/tmp/dist/win-unpacked/resources/app"), null);
  assert.equal(macBundleRoot("/tmp/plain-dir"), null);
});

test("electron-builder wires the ad-hoc re-sign hook for unsigned macOS builds", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // afterSign is skipped when no signing occurred (identity: null); afterPack
  // is the hook that actually runs for unsigned builds.
  assert.equal(pkg.build.afterPack, "scripts/mac-adhoc-sign.mjs");
  assert.equal(pkg.build.mac.identity, null);
});
