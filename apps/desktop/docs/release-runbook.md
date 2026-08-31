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

## Build-only verification

Dispatch `Release Arcane Desktop` with:

- `skip_oss=true`
- `update_latest=false`
- `create_github_release=false`

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

A formal release uses the same workflow with `create_github_release=true` and,
only after every object is verified, `update_latest=true`. Non-`stable` channels
create a GitHub prerelease. Do not enable either option merely to test CI.

Current Desktop artifacts are unsigned. Windows can trigger SmartScreen, and
macOS builds are only ad-hoc signed (re-signed after packaging so the signature
is valid): Gatekeeper shows a bypassable "developer cannot be verified" prompt
instead of the dead-end "damaged" dialog. Users open the app via right-click >
Open (macOS 13/14) or System Settings > Privacy & Security > Open Anyway
(macOS 15+); clearing the quarantine attribute with `xattr -dr
com.apple.quarantine` remains the documented fallback. This must remain visible
in release notes until Developer ID signing and notarization are implemented.

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
  skills must increment it. The publisher refuses a revision that is not newer
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
profile.

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
