# Arcane Desktop OSS release contract

- Bucket: `arcane-package` in `oss-cn-beijing`, public read and anonymous write
  disabled.
- Immutable objects:
  `desktop/arcane-desk/releases/<releaseId>/<platform>/<artifact>` and
  `desktop/arcane-desk/releases/<releaseId>/release.json`.
  The skills channel follows the same rule:
  `desktop/arcane-desk/skills/<revision>/bundle.tar.gz` and
  `desktop/arcane-desk/skills/<revision>/manifest.json`.
- Mutable objects: `desktop/arcane-desk/latest.json`,
  `desktop/arcane-desk/skills/latest.json`, and the auto-update feed pair
  `desktop/arcane-desk/update/<channel>/latest.yml` +
  `desktop/arcane-desk/update/<channel>/latest-mac.yml` only. Feeds are
  electron-updater channel files (see `docs/auto-update-design.md`): derived
  pointers into immutable release directories, rewritten atomically with
  `latest.json` in the same "switch latest" action, `Cache-Control: no-cache`.
  A feed references only relative paths (`../../releases/...`) inside this
  bucket prefix and pins every entry's sha512 (base64) computed from the
  signed bytes. A release carrying unsigned Windows installers must never
  reach a feed (`publish-release.mjs` hard-fails at switch-latest time).
- Supported platform directories: `macos-arm64`, `macos-x64`, `windows-x64`,
  and `windows-arm64`.
- Every immutable object is checked for absence before upload. Existing objects
  cause the publication to fail; every immutable upload also sets
  `x-oss-forbid-overwrite: true` so OSS rejects an overwrite atomically. A
  rebuild must use a new release id.
- Every uploaded object must pass an HTTP HEAD check with status 200 and an
  exact `Content-Length` before a release is complete.
- `latest.json` may be changed only after the referenced immutable manifest and
  every file in that manifest have passed the same verification.
- The publishing RAM identity has Put/Get access only under
  `desktop/arcane-desk/*`, limited bucket metadata/list access, and no Delete.
- Rollback never deletes or overwrites a versioned release. It revalidates an
  existing manifest and changes only `latest.json`.

# Intl flavor release contract (R2)

The intl build flavor (国际化方案 D5) publishes to Cloudflare R2 instead of OSS,
selected by `publish-release.mjs --region intl` (default: the
`generated/region.json` written by the matching build).

- Bucket: `arcane-desk-intl`, served publicly through the custom domain
  `https://dl.arcanedesk.app`; public read, anonymous write disabled.
- Immutable objects:
  `desktop/arcane-desk-intl/releases/<releaseId>/<platform>/<artifact>` and
  `desktop/arcane-desk-intl/releases/<releaseId>/release.json`.
  Intl artifact file names and default release ids carry an `-intl` suffix.
- Mutable objects: `desktop/arcane-desk-intl/latest.json` and the auto-update
  feed pair `desktop/arcane-desk-intl/update/<channel>/latest.yml` +
  `desktop/arcane-desk-intl/update/<channel>/latest-mac.yml` only (same
  semantics as the OSS contract above).
- Same platform directories and the same HEAD-verification discipline as OSS.
- R2 has no `x-oss-forbid-overwrite`; immutability is enforced by the
  pre-upload absence check alone. A rebuild must use a new release id.
- Credentials: `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  (S3-compatible SigV4, region `auto`), scoped to this bucket with no Delete.
- Signed artifacts are overlaid before hashing and upload via `--signed-dir`
  (sign-first-then-publish); overwriting an already published object to inject
  a signature is forbidden.

# Server image contract (OSS cn / R2 intl)

The server deployment track (docs/server-deploy-plan.md §5) ships the
`arcane/arcane-fvtt` docker image as a plain mirror artifact — no registry is
involved anywhere.

- Immutable objects:
  `desktop/arcane-desk[-intl]/server/<revision>/arcane-fvtt-<tag>-<arch>.tar.gz`
  plus `server-release.json`, `docker-compose.yml`, and `README.md` in the
  same revision directory. One tarball per architecture (`amd64`, `arm64`);
  consumers select by `uname -m`.
- Mutable object: `desktop/arcane-desk[-intl]/server/latest.json` only.
- `server-release.json` pins, per architecture: tarball bytes, sha256, and the
  docker image ID. The deploy skill must verify the tarball hash, then
  `docker load`, then assert the loaded image ID before `compose up`.
- Same revision discipline as the skills channel: the image recipe revision
  (`distribution/server-image/image-revision.json`) must be strictly newer than
  the remote pointer; existing revision directories are never re-uploaded.
- Same HEAD-verification-with-cache-bust discipline as releases/skills.
- The image never contains the Foundry VTT application (user-supplied-only);
  the runtime fetches it from the mounted zip or the user-provided timed URL.
