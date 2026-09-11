# Checking Arcane index mod updates

## 1. Fetch the global current index and compare against local

After confirming the Foundry Data directory, run:

```text
mod-manager catalog --data-dir <Foundry Data directory>
```

The helper reads the fixed `index.json` without caching, selects only `module.json` packages, and scans `<data-dir>/Data/modules/*/module.json`. It never treats a `group=system` system as a mod.

`rows` contains only modules that are installed locally AND found in the Arcane index by exact id. Status meanings:

- `update`: the index version is higher than local;
- `current`: versions are identical;
- `local-newer`: the local version is higher — never downgraded;
- `unknown`: the version format can't be safely ordered — show the difference only, never auto-upgrade.

`notInMirror` lists modules that exist locally but not in the index; never claim from this that they have no official updates.

## 2. Give the user the change table

Show at least:

| mod | local version | Arcane index version | status | download size | SHA256 |
|---|---:|---:|---|---:|---|

State the index's `generated` time before the table. SHA256 may be displayed truncated to 12 characters, but the actual stage/commit must use the full value. Highlight `update` rows by default; `current` rows may fold into a one-line summary. Explain that `notInMirror` simply means the index doesn't track them.

After the table, ask whether to upgrade all `update` items or a named selection. In that question, state the estimated total download, the backup-directory rules, and that a running Foundry will be stopped once after all downloads verify, then restored. Never upgrade `local-newer` or `unknown` items unless the user, after seeing the differences, explicitly requests an exact target version.

## 3. Upgrade after user confirmation

For each selected entry, first run `inspect` to check the manifest and required dependencies; then download per the `stage` flow in [install.md](install.md). After all selected items stage successfully with matching SHA256:

1. Record the current world id, the target mods' active states, and the launch arguments;
2. Stop Foundry precisely, once;
3. `commit` item by item, each with its own `expected-current-version`;
4. Restart once with the original world id;
5. Read back the version of every upgraded item; for originally active ones, also verify `active` is still true.

When one item's staging fails, don't stop the service and don't commit the others — present the failure table first. When a commit fails, stop further commits, keep the succeeded items and each item's backup, and report the current on-disk state; never downgrade or delete backups on your own.
