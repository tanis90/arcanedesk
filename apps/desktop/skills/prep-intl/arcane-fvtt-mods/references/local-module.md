# Local Module Package

Use this when the user provides a complete module ZIP, including a locally assembled Auto 2014. The interaction budget is at most two points: providing the file and confirming the install plan. If the file is already in the session, or an identical, exact plan was already authorized, reuse that. Fold the trust notice — "this package is not vouched for by the package index" — into that same plan; do not ask technical questions about hashes, tooling, or directory structure.

First, run the manager from the current runtime contract:

```text
local-inspect --archive <absolute path to ZIP> --data-dir <absolute path to Foundry data directory>
```

This is a read-only inspection: it does not extract and does not access the network. The tool reads `module.json` inside the package, checks the ZIP path, size, and structure, computes the hash, and returns the version, install target, existing version, and dependencies. The package must contain complete module files; raw data, standalone content JSON, or a `module-assembly-bundle.json` is not an installable ZIP — do not rename extensions or forge a manifest. A prepared module bundle first goes through [prepared-module.md](prepared-module.md) to produce the install package; arbitrary raw content still cannot be compiled directly.

Present the name, old/new versions, size, target, and automatic backup arrangement, and state: "This is a local package you provided. Arcane will verify that the files are complete and back up the old version, but this does not mean the package index has reviewed its contents." Missing dependencies or incompatible versions go into the same plan and are handled per the main skill's index flow. If multiple installed directories declare the same id, stop and locate the conflict — do not guess one and overwrite it. Obtain one confirmation covering only the parts of the plan not yet authorized; do not hand machine verification values to the user for judgment.

Then pass each result of this inspection into:

```text
local-stage --archive <archivePath> --expected-id <id> --expected-version <version> --expected-sha256 <archiveSha256> --expected-bytes <archiveBytes>
```

If the package changed, the tool refuses; re-inspect and present the changed plan — do not force a new hash onto the old authorization. After everything is staged successfully, stop the service precisely per the main skill, then use the existing backup and commit entry point:

```text
commit --stage-dir <stageDir> --data-dir <absolute path to data directory> --expected-current-version <old version found by inspection, or none> --accept-sha256 <same archiveSha256>
```

The verification value only proves that this run used the inspected file; it is not a publisher signature or a redistribution license. There is no need to verify the manifest/download URLs inside the package online; keep those fields as-is — this install does not download from them. Do not upload the user's package, private descriptions, or complete assembly inputs to GitHub, the package index, log attachments, or any other service.

Read back the `module.json` at the final absolute path, and report the version, the source local path, and the actual backup path. Replacing a module does not rewrite world Actors; keep existing entries — do not bulk-overwrite character descriptions with the new package. For newly added modules, remind the user to enable them in the world per the main skill.
