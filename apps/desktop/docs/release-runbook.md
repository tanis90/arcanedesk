# Arcane Desktop release runbook

The public repository has three manual release surfaces:

- `Build release candidates` builds short-lived SDK, CLI, and two-host Desktop
  candidates without publishing them.
- `Release Arcane Desktop` is the official four-platform Desktop build
  pipeline — build only, it never publishes.
- `Stage Arcane Desktop Release` is phase 1 of a signed release: it relays the
  build's mac and windows-zip objects into the immutable release directories
  and opens the draft GitHub releases. Phase 2 (signing, `release.json`,
  promotion) always runs locally, because CI cannot hold the Windows
  certificate.

A signed release therefore has three phases: build (CI) → stage (CI) →
sign + finalize (local). Design and idempotency contract:
`phased-release-design.md` in this directory.

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

## Windows code signing (phased: CI stages, local finalizes)

Windows installers are signed locally, never in CI. The certificate is a
Certum OV code signing certificate (`CN=Qi Yang`, thumbprint pinned in
`scripts/sign-windows.mjs`, valid until 2027-09-07) whose private key lives in
Certum's SimplySign cloud and is non-exportable — the certificate store
reports `SimplySign CSP` / `私钥不能导出` — so it cannot become a p12 GitHub
secret. Signing runs on a machine with SimplySign Desktop installed and logged
in; a signing session may ask for an OTP confirmation in the SimplySign mobile
app.

The phased sequence is build in CI, sign locally BEFORE anything touches the
cloud, stage from CI, finalize locally:

1. Dispatch `Release Arcane Desktop` at the commit to ship. All eight matrix
   legs must pass; macOS artifacts come out signed and notarized, Windows
   installers unsigned. The workflow produces `-exe` (installer-only) and
   `-pkg` (zip) artifacts for Windows so the local machine never downloads
   what it will not transform.
2. Download only the four installers (about 820MB) and sign them:

   ```bash
   run_id=<run-id>
   for artifact in $(gh api repos/tanis90/arcanedesk/actions/runs/$run_id/artifacts --paginate -q '.artifacts[].name' | grep -- '-exe-'); do
     platform=$(echo "$artifact" | sed -E 's/^arcane-desk-(.+)-(cn|intl)-exe-[0-9a-f]{40}$/\1/')
     region=$(echo "$artifact" | sed -E 's/^arcane-desk-(.+)-(cn|intl)-exe-[0-9a-f]{40}$/\2/')
     gh run download "$run_id" -n "$artifact" -D "staging-wexe/$region/$platform"
   done
   node apps/desktop/scripts/sign-windows.mjs --in staging-wexe/cn --in staging-wexe/intl
   ```

   If SimplySign died (black window, `certutil` hangs), restart the app and
   log in again — nothing cloud-side has happened yet, so re-running this step
   is free. Do NOT delete `apps/desktop/dist-signed` or pass `--force` on a
   release id already being finalized: re-signing changes bytes, and the
   finalize journal hard-rejects changed bytes for that release id.
3. Dispatch `Stage Arcane Desktop Release` with `build_run_id` (and the same
   explicit `release_id`, if any). It uploads every object the signer never
   touches (mac dmg/zip/SHA256SUMS + windows zips) into
   `releases/<id>/<platform>/`, emits `release-fragment-<region>` artifacts,
   and opens the draft GitHub releases with the staged assets.
4. Download the fragments and finalize each region (cn shown; intl mirrors
   with the `-intl` release id and `--region intl`):

   ```bash
   gh run download <stage-run-id> -n release-fragment-cn-<id> -D fragments
   ARCANE_SOURCE_COMMIT=<sha> ARCANE_BUILD_REGION=cn \
     npm run prepare:desktop-release --workspace arcane-desktop
   node apps/desktop/scripts/publish-release.mjs --finalize \
     --staging staging-wexe/cn --signed-dir apps/desktop/dist-signed \
     --fragment fragments/fragment-cn.json \
     --region cn --release-id <id> --channel private-beta --skip-latest
   ```

   `--finalize` rebuilds the windows SHA256SUMS from the signed installers,
   merges the fragment into a full `release.json`, cross-checks mac hashes
   against the published CI sums, uploads, and HEAD-verifies every object.
   Rerun-after-crash is safe: already-uploaded objects are skipped, an
   already-finalized release id is refused (`--promote-release` instead), and
   a re-signed installer is rejected outright.
5. Promote each region after verification, then complete the GitHub releases:

   ```bash
   node apps/desktop/scripts/publish-release.mjs --promote-release <id> --region cn
   node apps/desktop/scripts/publish-release.mjs --promote-release <id>-intl --region intl

   base=https://arcane-package.oss-cn-beijing.aliyuncs.com/desktop/arcane-desk/releases/<id>
   curl -s "$base/windows-x64/SHA256SUMS.txt" -o SHA256SUMS-windows-x64.txt
   curl -s "$base/windows-arm64/SHA256SUMS.txt" -o SHA256SUMS-windows-arm64.txt
   gh release upload <id> \
     apps/desktop/dist-signed/Arcane-Desk-<version>-win-x64.exe \
     apps/desktop/dist-signed/Arcane-Desk-<version>-win-arm64.exe \
     SHA256SUMS-windows-x64.txt SHA256SUMS-windows-arm64.txt
   gh release edit <id> --draft=false --notes-file notes.txt
   # the intl leg mirrors with -intl asset names, its release id, and the R2 base
   ```

6. Commit the repo metadata the publisher wrote
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
  (`Windows Kits`10`bin` with a version and arch segment), electron-builder's
  winCodeSign cache, then `PATH`. Installing the SDK "Signing Tools for
  Windows" component is the stable option.

## Build-only verification

Dispatch `Release Arcane Desktop` — it is always build-only (the workflow no
longer has any publishing mode). All eight matrix jobs must pass source
typechecking, Electron packaging, package-resource verification, checksum
generation, provenance attestation, and artifact upload. No OSS credential is
read.

## Immutable gray release

Run the phased sequence with `--skip-latest` on the finalize step (as written
above): both regions' objects are uploaded and verified, the manifests are
complete, but the public download pointers stay on the previous release. This
is the default posture for a new release until it has been spot-checked.

## Formal release

A formal release is the same phased sequence plus promotion: run
`--promote-release` per region and flip the draft GitHub releases (step 5
above). Non-`stable` channels publish GitHub prereleases. There is no longer
any CI path that publishes a release by itself — an unsigned Windows installer
can no longer reach a bucket from a workflow.

Current Desktop artifacts: macOS builds are Developer ID signed and notarized,
so Gatekeeper opens them without any prompt. Windows installers are
Authenticode-signed with a Certum OV certificate — SmartScreen may still warn
until reputation builds, and the `.zip` artifact contains an unsigned
unpacked binary.

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
