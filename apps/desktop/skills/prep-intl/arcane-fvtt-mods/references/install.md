# Installing or upgrading a single mod

## 1. Read-only inspection

After confirming the real Foundry Data directory, run:

```text
mod-manager inspect --manifest-url <HTTPS module.json URL> --data-dir <data-dir>
```

Parse the JSON result and present to the user: id, title, target version, download URL, known size, SHA256 source, existing version and directory, Foundry compatibility, and any missing or under-version dependencies in `requiredModules`. If `kind` is not `module`, the URL is not HTTPS, a manifest field is invalid, or a duplicate id exists locally, stop.

If a dependency is also in the Arcane index, `inspect` it separately and add it to the same install plan; non-indexed dependencies share the main package's single risk warning in section 2. Never auto-install recommended or optional items.

## 2. Stating the plan (notification) and one risk warning

Before downloading or committing, tell the user:

- the domains of the manifest and the ZIP;
- the module id, current version → target version;
- the target `<data-dir>/Data/modules/<id>` or the existing same-id directory;
- the size and SHA256 given by the index (if absent, say plainly "publisher hash unavailable");
- that any existing directory will be backed up first;
- that a running Foundry will be stopped after staging succeeds, and the original world restored after committing;
- that a newly installed mod still needs to be enabled manually in the world.

The plan is a pre-execution notification — it doesn't wait for approval: the user's explicit install request is the authorization. The only case to stop and get confirmation: the main package or any dependency is not in the Arcane index — give one plain-language risk warning: "This one isn't among the mods vetted by the Arcane index; installing it may have unknown consequences. Confirm you want it installed? If you'd like the Arcane index to carry this mod, send us feedback at https://arcanedesk.app/en." Continue after the user confirms; no second confirmation in later steps.

## 3. Downloading and verifying into staging

Pass the stable fields returned by `inspect` back verbatim to guard against remote content drift:

```text
mod-manager stage --manifest-url <URL> --expected-id <id> --expected-version <version> --expected-download-url <URL>
```

`stage` writes only to the OS temp directory. It re-reads the external manifest, downloads the ZIP, computes the SHA256, extracts safely, and checks the id/version of the archive-root `module.json`. The upstream manifest/download URLs inside the archive are just build-provenance metadata and may differ from the mirror's; after the ZIP and identity pass, the helper replaces the `module.json` in staging with the verified external manifest's original bytes. Check the returned `id`, `version`, `manifestSha256`, `archiveSha256`, `archiveBytes`, `trustedByMirrorIndex`, `stageDir`, and `requiresSecondConfirmation`.

- Index packages: bytes and SHA256 must match; on match, continue per the stated plan.
- Non-index packages: the single risk warning in section 2 already covered this install — `requiresSecondConfirmation` triggers no new user confirmation; write the computed SHA256 and actual size into the final report, clearly noting it is only this download's fingerprint.

## 4. Stop the service and commit

If Foundry is running, first record the current world id and the target mod's active state, then stop it precisely per `arcane-fvtt-ops`. Call:

```text
mod-manager commit --stage-dir <stageDir> --data-dir <data-dir> --expected-current-version <version-or-none>
```

Non-index packages must additionally pass:

```text
--accept-sha256 <full SHA256 returned by stage>
```

`expected-current-version` must come from `inspect`; pass the literal `none` when not installed. If the local version changed before committing, the helper refuses — re-inspect instead of forcing an overwrite.

After a successful commit, save the JSON result — especially `target` and `backup`. On failure, never manually delete the incoming, staging, or backup paths; report the helper's exact error first.

## 5. Restart and acceptance

If Foundry was running before, start it with the same Core, Data, and world id. When upgrading an already-enabled mod, read back in the ready GM world with read-only `browser_evaluate`:

```js
(() => {
  const mod = game.modules.get("<id>");
  return mod ? { id: mod.id, version: mod.version, active: mod.active } : null;
})()
```

Even when a newly installed mod is discovered by Foundry after a restart, never call internal APIs to change its enablement; remind the user to open the world's "Manage Modules", enable the target and its required dependencies, then refresh/restart the world. If the user asks for a check after finishing, then read back `version` and `active`.
