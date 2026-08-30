#!/usr/bin/env node

// electron-builder afterPack hook.
//
// Electron's prebuilt binaries ship with an ad-hoc signature whose identifier
// is `com.github.Electron`. Packaging rewrites Info.plist (bundle identifier,
// product name), which breaks that seal: Gatekeeper then reports the
// quarantined app as "damaged" with no GUI bypass. Re-signing the finished
// bundle ad-hoc keeps the distribution unsigned, but the signature is valid
// again, so Gatekeeper shows the bypassable "unidentified developer" prompt.
//
// This must run at afterPack: electron-builder skips afterSign entirely when
// no real signing occurred (identity: null). Note that @electron/fuses are
// flipped after afterPack, so enabling `electronFuses` would invalidate this
// signature again — verify-package.mjs gates on the final bundle signature.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function shouldAdHocResign({ electronPlatformName, macIdentity }) {
  if (electronPlatformName !== "darwin") return false;
  // `identity: null` is the explicit "do not sign" configuration. Anything
  // else (a real identity, or undefined = keychain auto-discovery) means real
  // signing is intended and must not be overwritten with an ad-hoc signature.
  return macIdentity === null;
}

export function macBundleRoot(appRoot) {
  const contents = path.dirname(path.dirname(appRoot));
  const bundle = path.dirname(contents);
  if (path.basename(contents) !== "Contents" || !bundle.endsWith(".app")) return null;
  return bundle;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

export function resignAdHoc(appPath, { expectAdHoc = true } = {}) {
  let step = run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  if (step.status !== 0) throw new Error(`ad-hoc re-sign failed for ${appPath}: ${step.output}`);

  step = run("codesign", ["--verify", "--deep", "--strict", appPath]);
  if (step.status !== 0) {
    throw new Error(`ad-hoc signature did not verify for ${appPath}: ${step.output}`);
  }

  if (expectAdHoc) {
    // `codesign -dv` reports on stderr.
    step = run("codesign", ["-dv", appPath]);
    if (!/^Signature=adhoc$/m.test(step.output)) {
      throw new Error(`expected an ad-hoc signature for ${appPath}; got: ${step.output}`);
    }
  }
}

export default async function afterPack(context) {
  const macIdentity = context.packager.config.mac?.identity;
  if (!shouldAdHocResign({ electronPlatformName: context.electronPlatformName, macIdentity })) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`expected app bundle is missing: ${appPath}`);
  resignAdHoc(appPath);
  console.log(`[mac-adhoc-sign] applied a valid ad-hoc signature to ${appPath}`);
}
