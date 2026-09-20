# Arcane Desktop release runbook

The public repository has two manual release surfaces:

- `Build release candidates` builds short-lived SDK, CLI, and two-host Desktop
  candidates without publishing them.
- `Release Arcane Desktop` is the official four-platform Desktop pipeline. It
  can run build-only, publish an immutable OSS release, optionally create a
  GitHub prerelease/release, and optionally promote the verified release to the
  public `latest.json` pointer.

## Release topology

- GitHub repository: `tanis90/arcanedesk`.
- OSS bucket: `arcane-package`, Beijing region, public read and anonymous write
  disabled.
- Immutable root:
  `desktop/arcane-desk/releases/<releaseId>/<platform>/`.
- Platforms: `macos-arm64`, `macos-x64`, `windows-x64`, and `windows-arm64`.
- Mutable pointer: `desktop/arcane-desk/latest.json`, always uploaded with
  `Cache-Control: no-cache`.
- Default release id: `<desktop-version>-<source-commit8>`.

Versioned release objects must never be overwritten. A rebuilt artifact uses a
new source commit or an explicit new release id. The publisher uses the OSS
`x-oss-forbid-overwrite` request header in addition to its preflight existence
check. Rollback revalidates an existing release and changes only `latest.json`.

## GitHub credentials

The `desktop-release` GitHub Environment owns these secrets:

- `OSS_RELEASE_KEY_ID`
- `OSS_RELEASE_KEY_SECRET`

They belong to the dedicated RAM user `ArcaneDeskGithubRelease`, which has only
the custom `ArcaneDeskReleasePublish` policy. That policy grants bucket metadata
and list access plus Put/Get under `desktop/arcane-desk/*`; it grants no Delete
permission. Secrets must never be printed, persisted in repository files, or
shared with the legacy release identity.

## macOS signing and notarization

macOS builds are signed with a Developer ID Application certificate (team
`2VQK9HQ5AZ`) and notarized by Apple. Configuration lives in
`apps/desktop/package.json` under `build.mac`:

- `identity` pins the certificate by SHA-1
  (`AE4865DBC4A663E90902131977AC43B79321B7A2`) so electron-builder never picks
  an unrelated identity from the keychain.
- `hardenedRuntime` is on, with `build/entitlements.mac.plist` for the main
  process and `build/entitlements.mac.inherit.plist` for helpers. The main
  process adds only `com.apple.security.device.audio-input` to the
  electron-builder defaults. There is deliberately no camera entitlement: the
  app does not use the camera, and a hardened-runtime process without that
  entitlement is killed by the system on camera access, so
  `web-permission-policy.js` denies `video` media requests before they reach
  the system prompt.
- `notarize: true` makes electron-builder notarize the `.app` itself (this
  covers the zip artifact). The DMG container is notarized and stapled by a
  separate workflow step; both DMGs are stapled and validated before checksums
  are computed.

The build job reads five repository secrets (not the `desktop-release`
Environment, which only the publish job uses):

- `ARCANE_MAC_CERT_P12`: base64 of a p12 containing only the Developer ID
  identity (leaf + private key + Apple Developer ID G2 intermediate). Never
  export the login keychain wholesale: unrelated corporate identities in the
  same p12 break or confuse signing.
- `ARCANE_MAC_CERT_PASSWORD`: password of that p12.
- `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: App Store
  Connect API key used by `notarytool` (electron-builder also accepts these
  exact variable names).

The workflow imports the p12 into a temporary keychain, runs
`set-key-partition-list`, and appends it to the user search list so headless
`codesign` never blocks on a keychain prompt.

For a local signed build, the certificate must be in the login keychain and
the three `APPLE_API_*` variables exported, then:

```bash
npm run dist:mac --workspace arcane-desktop -- --arm64
```

Verify the result before shipping anything built by hand:

```bash
codesign --verify --deep --strict dist/mac-arm64/ArcaneDesk.app
spctl -a -vv dist/mac-arm64/ArcaneDesk.app      # accepted, Notarized Developer ID
xcrun stapler validate dist/Arcane-Desk-*-mac-arm64.dmg
```

When the certificate or API key is rotated, re-export a clean p12 (Developer
ID identity only) and update the five secrets; no workflow change is needed.

## Windows code signing (local sign-first publish)

Windows installers are signed locally, never in CI. The certificate is a
Certum OV code signing certificate (`CN=Qi Yang`, thumbprint pinned in
`scripts/sign-windows.mjs`, valid until 2027-09-07) whose private key lives in
Certum's SimplySign cloud and is non-exportable — the certificate store
reports `SimplySign CSP` / `私钥不能导出` — so it cannot become a p12 GitHub
secret. Signing therefore runs on a machine with SimplySign Desktop installed
and logged in; a signing session may ask for an OTP confirmation in the
SimplySign mobile app.

The signed-release sequence is build in CI, sign and publish locally:

1. Dispatch `Release Arcane Desktop` at the commit to ship with the defaults
   (`skip_oss=true`, `update_latest=false`, `create_github_release=false`).
   All eight matrix legs must pass; macOS artifacts come out signed and
   notarized, Windows artifacts unsigned.
2. Download the run's artifacts (named `arcane-desk-<platform>-<region>-<sha>`)
   into per-region staging trees:

   ```bash
   run_id=<run-id>
   for artifact in $(gh run view "$run_id" --json artifacts -q '.artifacts[].name' | grep '^arcane-desk-'); do
     platform=$(echo "$artifact" | sed -E 's/^arcane-desk-(.+)-(cn|intl)-[0-9a-f]{40}$/\1/')
     region=$(echo "$artifact" | sed -E 's/^arcane-desk-(.+)-(cn|intl)-[0-9a-f]{40}$/\2/')
     gh run download "$run_id" -n "$artifact" -D "staging-$region/$platform"
   done
   ```

3. Sign every Windows installer (both regions in one pass; already-valid
   signatures are skipped, `--force` re-signs):

   ```bash
   node apps/desktop/scripts/sign-windows.mjs --in staging-cn --in staging-intl
   ```

   The script Authenticode-signs each `Arcane-Desk-*-win-*.exe` (SHA-256,
   RFC3161 Sectigo timestamp), then verifies the signature, the pinned
   thumbprint, and the presence of a timestamp — a signature without a
   timestamp dies with the certificate, so it is an error, not a warning.
   Signed copies land flat in `apps/desktop/dist-signed`.
4. Regenerate the release manifest per region at the pinned commit (the same
   rules the CI publish job uses; an explicit intl release id gets the
   `-intl` suffix):

   ```bash
   ARCANE_SOURCE_COMMIT=<sha> ARCANE_BUILD_REGION=cn \
     npm run prepare:desktop-release --workspace arcane-desktop
   ARCANE_SOURCE_COMMIT=<sha> ARCANE_BUILD_REGION=intl ARCANE_RELEASE_ID=<id>-intl \
     npm run prepare:desktop-release --workspace arcane-desktop
   ```

5. Publish each region with the signed overlay, without moving `latest`:

   ```bash
   node apps/desktop/scripts/publish-release.mjs \
     --staging staging-cn --signed-dir apps/desktop/dist-signed \
     --region cn --channel private-beta --skip-latest
   # intl credentials: CF_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY env, or the
   # [ArcaneDeskIntlRelease] section of ~/.ossutil/arcane-release.conf (local ops profile)
   node apps/desktop/scripts/publish-release.mjs \
     --staging staging-intl --signed-dir apps/desktop/dist-signed \
     --region intl --channel private-beta --skip-latest
   ```

   `--signed-dir` replaces every staged `.exe` with its signed copy and fails
   if one is missing, so an unsigned installer cannot slip through.
   SHA256SUMS and `release.json` are computed from the actual (signed) files,
   and the publisher still refuses to touch an existing version directory —
   the release is immutable and self-consistent from birth, which is why the
   sign-before-publish overlay replaces the 2026-09-08 one-off that overwrote
   published objects.
6. After both regions verify, promote them and create the GitHub Releases
   (per region: 12 assets, `SHA256SUMS.txt` renamed per platform as CI does):

   ```bash
   node apps/desktop/scripts/publish-release.mjs --promote-release <id> --region cn
   node apps/desktop/scripts/publish-release.mjs --promote-release <id>-intl --region intl

   mkdir -p github-release-assets-cn
   for platform_dir in staging-cn/*; do
     platform=$(basename "$platform_dir")
     for source in "$platform_dir"/*; do
       name=$(basename "$source")
       [[ "$name" == SHA256SUMS* ]] && name="SHA256SUMS-$platform.txt"
       cp "$source" "github-release-assets-cn/$name"
     done
   done
   # repeat for staging-intl with SHA256SUMS-<platform>-intl.txt, then:
   gh release create <id> --title "Arcane Desk <id>" --target <sha> --prerelease \
     --notes "macOS: signed with a Developer ID certificate and notarized by Apple.
   Windows: signed with a Certum OV certificate; SmartScreen may still warn
   until reputation builds." \
     github-release-assets-cn/*
   ```

7. Commit the repo metadata the publisher wrote
   (`distribution/desktop-latest*.json`) and delete the transient
   `distribution/releases/` audit directory — `verify-source.mjs` forbids it
   in the source tree, so leaving it behind breaks local
   `npm test`/`typecheck`/`start`.

Operational notes:

- Only the NSIS `.exe` installer is signed; the `.zip` artifact keeps an
  unsigned unpacked binary inside (same scope as the 0.4.3 first signing).
- SmartScreen: an OV certificate builds reputation per file over time. Early
  downloads may still see "Windows protected your PC"; the signature plus
  timestamp keeps the installer valid and attributable after the certificate
  expires.
- signtool discovery order: `--signtool`/`ARCANE_SIGNTOOL`, the Windows SDK
  (`Windows Kits\10\bin\<ver>\x64`), electron-builder's winCodeSign cache,
  then `PATH`. Installing the SDK "Signing Tools for Windows" component is
  the stable option; the cache path appears after any local Windows build.

## Build-only verification

Dispatch `Release Arcane Desktop` with:

- `skip_oss=true`
- `update_latest=false`
- `create_github_release=false`

(`skip_oss` defaults to `true`, so an unmodified dispatch is always build-only;
the flags are listed explicitly for clarity. Turn `skip_oss` off only for a real
signed release, per the sign-first rule.)

All four matrix jobs must pass source typechecking, Electron packaging,
package-resource verification, checksum generation, provenance attestation,
and artifact upload. The publish job is intentionally skipped and no OSS
credential is read.

## Immutable gray release

After build-only succeeds, dispatch the same pinned commit with:

- `channel=private-beta`
- `skip_oss=false`
- `update_latest=false`
- `create_github_release=false`

The publish job uploads a new immutable release, then sends an identity-encoded
HEAD request for every object and requires HTTP 200 with the exact byte length.
Because `update_latest` is false, the public download pointer remains unchanged.

## Formal release

A release with signed Windows installers is published through the local
sign-first procedure above ("Windows code signing (local sign-first
publish)"), because CI cannot hold the Windows certificate. The CI publish
path below (`skip_oss=false`, then `create_github_release=true` and
`update_latest=true`) publishes everything the build produced — its Windows
installers are unsigned; use it knowingly. Non-`stable` channels create a
GitHub prerelease. Do not enable either option merely to test CI.

Current Desktop artifacts: macOS builds are Developer ID signed and notarized,
so Gatekeeper opens them without any prompt. Windows installers from the local
sign-first path are Authenticode-signed with a Certum OV certificate —
SmartScreen may still warn until reputation builds, and the `.zip` artifact
contains an unsigned unpacked binary. Windows installers published straight
from CI are unsigned; the documented path for those is
More info > Run anyway.

## Skills bundle publish

Bundled skills are part of the system, but their text can ship independently of
an app release through the `Publish Arcane Skills` workflow. It packs
`apps/desktop/skills/prep` into an immutable versioned bundle:

- Immutable objects:
  `desktop/arcane-desk/skills/<revision>/bundle.tar.gz` and
  `.../manifest.json` (per-file SHA256 list).
- Mutable pointer: `desktop/arcane-desk/skills/latest.json`, uploaded with
  `Cache-Control: no-cache` only after every immutable object passes the HEAD
  verification. `skip_latest=true` uploads without moving the pointer.
- `skills/prep/bundle.json` owns the monotonic `revision`; any PR that changes
  skills must increment it, and CI enforces the bump on pull requests
  (`skills-revision` job, `apps/desktop/scripts/check-skills-revision.mjs`).
  The publisher refuses a revision that is not newer
  than the published pointer, so a bundle is never overwritten or rolled back.
- `bundle.json` may carry `minAppVersion` when a skill depends on an app
  capability that has not shipped yet; older apps then keep their current
  bundle (fail closed) until they update.

The desktop app checks the pointer in the background on every launch, verifies
the tarball and every extracted file against the manifest, swaps the bundle
atomically into `userData/skills/active`, and falls back to the packaged
baseline on any failure. New agent sessions pick up an activated bundle
immediately; running sessions keep their snapshot.

```powershell
node apps/desktop/scripts/publish-skills.mjs --dry-run
```

## Local Windows emergency path

The local path is only for an urgent Windows-only hotfix or read-only release
diagnosis. A hotfix still requires a committed source state and a new release
id:

```powershell
npm run dist:win --workspace arcane-desktop -- --x64
node apps/desktop/scripts/verify-package.mjs `
  apps/desktop/dist/win-unpacked/resources/app `
  --expected-node-platform win-x64
npm run publish:release --workspace arcane-desktop -- --from-dist dist `
  --release-id <new-hotfix-id> --channel private-beta --skip-latest
```

Local credentials may be supplied with `OSS_RELEASE_KEY_ID` and
`OSS_RELEASE_KEY_SECRET`, or through the `ArcaneDeskRelease` section of
`~/.ossutil/arcane-release.conf`. The GitHub CI key is not copied to the local
profile. The intl leg resolves the same way: `CF_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` env first, then the
`[ArcaneDeskIntlRelease]` section of the same conf file (fields:
`accountId`/`accessKeyID`/`accessKeySecret`). That R2 token is an
Object-Read-&-Write account API token scoped to the `arcane-desk-intl` bucket
only, created 2026-09; rotate it from the Cloudflare R2 API tokens page.

## Completion checks

For a release that updates latest, verify:

```powershell
Invoke-RestMethod `
  https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/latest.json
```

The returned release id, version, and manifest must match the intended release;
the manifest must contain all four platforms, and every URL must return HTTP
200 with the recorded nonzero content length. Upload success alone is not a
release-completion signal.
