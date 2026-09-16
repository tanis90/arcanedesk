# Arcane Desktop OSS release contract

- Bucket: `arcane-package` in `oss-cn-beijing`, public read and anonymous write
  disabled.
- Immutable objects:
  `desktop/arcane-desk/releases/<releaseId>/<platform>/<artifact>` and
  `desktop/arcane-desk/releases/<releaseId>/release.json`.
  The skills channel follows the same rule:
  `desktop/arcane-desk/skills/<revision>/bundle.tar.gz` and
  `desktop/arcane-desk/skills/<revision>/manifest.json`.
- Mutable objects: `desktop/arcane-desk/latest.json` and
  `desktop/arcane-desk/skills/latest.json` only.
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
- Mutable object: `desktop/arcane-desk-intl/latest.json` only.
- Same platform directories and the same HEAD-verification discipline as OSS.
- R2 has no `x-oss-forbid-overwrite`; immutability is enforced by the
  pre-upload absence check alone. A rebuild must use a new release id.
- Credentials: `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  (S3-compatible SigV4, region `auto`), scoped to this bucket with no Delete.
- Signed artifacts are overlaid before hashing and upload via `--signed-dir`
  (sign-first-then-publish); overwriting an already published object to inject
  a signature is forbidden.
