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

The `Stage Arcane Desktop Release` workflow publishes to both regions from CI
and reads these repository-level secrets:

- `OSS_RELEASE_KEY_ID` / `OSS_RELEASE_KEY_SECRET` (cn, Aliyun OSS)
- `CF_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (intl, R2)

Their values are the same credentials the local ops file
`~/.ossutil/arcane-release.conf` carries (`[ArcaneDeskRelease]` for cn,
`[ArcaneDeskIntlRelease]` for the R2 token scoped to Object Read & Write on
`arcane-desk-intl`). Set them with `gh secret set`, never printing values.
The original plan of a dedicated `desktop-release` GitHub Environment with a
least-privilege RAM user (`ArcaneDeskGithubRelease`, no Delete permission)
was never created; migrating these five secrets into that environment is the
intended tightening. Secrets must never be printed, persisted in repository
files, or shared with the legacy release identity.

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
   The `prepare:desktop-release` call in step 4 is mandatory, not optional:
   `--finalize` merges the local `generated/desktop-release.json` base, and a
   stale base silently ships the previous version's `product.version` /
   `source.commit` into `release.json` and the update feeds (this happened to
   cn on 0.5.0 and had to be patched in place). A guard now hard-fails when
   the base `product.version` disagrees with the `<version>-` prefix of the
   release id; rerun prepare with the matching `ARCANE_BUILD_REGION`.
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

## Auto-update feeds (electron-updater)

Installed clients update in-app via electron-updater against per-channel feed
files (design: `docs/auto-update-design.md`):

- Mutable objects, rewritten atomically with `latest.json` in the same
  "switch latest" action (all publish paths: full publish, `--finalize`,
  `--promote-release`): `update/<channel>/latest.yml` (Windows, lists every
  architecture's `.exe` in one file) and `update/<channel>/latest-mac.yml`
  (macOS zips). `latest-arm64.yml` variants do not exist — the client picks
  per-arch files from `files[]` at download time.
- Feeds carry only relative paths (`../../releases/...`) and base64 sha512
  values computed from the signed bytes. Every feed upload is HEAD-verified;
  any failure aborts the release announcement, same as `latest.json`.
- Unsigned gate: a release containing Windows `.exe` artifacts with
  `windowsInstallersSigned: false` hard-fails at switch-latest time.
  `--allow-unsigned-feed` overrides for emergencies only.
- `--skip-latest` staging uploads never touch feeds.
- Rollback = `--promote-release <old-id>`: feeds are regenerated from the
  promoted manifest (pre-feed manifests missing sha512 are filled by
  downloading the published bytes and hashing them; the immutable manifest is
  never rewritten).
- Backfill for the pre-feed 0.4.3 release (no sha512 in its manifest):
  `node apps/desktop/scripts/publish-release.mjs --backfill-feeds 0.4.3-1b1e90da --region cn`
  (`0.4.3-1b1e90da-intl` for intl). sha512 is anchored either on local signed
  bytes (`--assets-dir`, sha256 must match the manifest) or on bytes
  downloaded back from the bucket (same sha256 anchor). Backfill only writes
  the feed objects — it never touches `latest.json` or immutable objects.
- Client behavior: packaged instances check ~30 s after launch (plus jitter)
  and then every 24 h; the only visible effect is a badge in the top-left
  header. Downloads and installs are always explicit user clicks;
  `ARCANE_UPDATE_FEED_BASE_URL` can point a test build at a loopback feed
  server, and `ARCANE_DISABLE_UPDATE_CHECK=1` silences the channel.
- Feed contract smoke (after any backfill/publish, both regions):
  `node apps/desktop/scripts/verify-update-feed.mjs --region cn` (and
  `--region intl`). Fetches feeds the way electron-updater does (noCache
  query, js-yaml parse), resolves relative URLs, applies per-arch file
  selection, and HEAD-verifies size for every entry.
- Local full-flow E2E (packaged app, zero production touch):
  1. Build two versions locally (e.g. `ARCANE_RELEASE_ID=0.4.90-e2e npm run
     prepare:desktop-release && npm run dist` then package; bump to 0.4.91 and
     repeat), keeping both installers plus the 0.4.91 `generated/` tree.
  2. `node apps/desktop/scripts/e2e-local-feed-server.mjs --port 8788`
  3. Generate the 0.4.91 feed and stage the installer bytes:
     `node apps/desktop/scripts/e2e-make-feed.mjs --exe dist/Arcane-Desk-0.4.91-win-x64.exe --root generated/e2e-feed --channel private-beta --version 0.4.91`,
     then copy the installer to `generated/e2e-feed/files/`.
     (Production feeds are always generated by publish-release.mjs; this helper
     exists only for the local E2E "new version" side.)
  4. Install the 0.4.90 package, launch it with
     `ARCANE_UPDATE_FEED_BASE_URL=http://127.0.0.1:8788/update`.
  5. Walk the checklist: badge appears (available) → popover → Download →
     progress → ready → Restart and update → app relaunches on 0.4.91. Then:
     relaunch 0.4.91 before installing (ready must survive restart via the
     pending cache), install guard (call install before ready — no-op), and an
     arm64 machine must receive the arm64 artifact, never the x64 fallback.

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
