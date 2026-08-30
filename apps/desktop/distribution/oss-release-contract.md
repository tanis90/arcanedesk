# Arcane Desktop OSS release contract

- Bucket: `arcane-package` in `oss-cn-beijing`, public read and anonymous write
  disabled.
- Immutable objects:
  `desktop/arcane-desk/releases/<releaseId>/<platform>/<artifact>` and
  `desktop/arcane-desk/releases/<releaseId>/release.json`.
- Mutable object: `desktop/arcane-desk/latest.json` only.
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
