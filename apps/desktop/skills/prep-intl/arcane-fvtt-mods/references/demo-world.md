# Arcane Demo world & environment profile

`arcane-demo` is not packaged with the Desktop. The world, the environment profile, and packages are three independent release lines:

- A `worlds` entry only describes the immutable world manifest/ZIP, and picks its environment via `defaultProfile`; a new world version is published only when world content changes.
- A `profiles` entry points to an immutable `foundry-environment-profile`; a profile lists only system/module ids, never versions. A new revision is added only when the system/module id set or the profile's semantic metadata changes.
- `packages` is the current `stable` snapshot accepted into the Arcane index; promoting a package to stable requires neither repacking the world nor modifying the profile.

The skill never pins a world version, Core version, profile revision, system/module ids, or package versions. Every operation must read the same global `index.json` snapshot, find the profile via the world's `defaultProfile`, then recursively resolve the profile id and the manifests' `relationships.requires` to the exact stable packages in that snapshot. "stable" here means the Arcane-validated version, not upstream's latest.

## 1. Read-only inspection

After confirming the Foundry Data directory, run:

```text
mod-manager world-inspect --world-id arcane-demo --data-dir <data-dir>
```

When entering from the `arcane-fvtt-setup` fresh-install flow and the Data directory doesn't exist yet, append `--allow-missing-data-dir` to read-only commands; `dataDirExists: false` in the output means a fresh install — mark that directory as "to be created" in the plan. Never create the directory early just to run read-only checks — the directory structure is created in the write phase after plan confirmation.

If the user asks about updates for all published worlds, you may first run:

```text
mod-manager world-catalog --data-dir <data-dir>
```

When `index.json` has no target world/profile/package, just say the published data is incomplete; never fall back to the Desktop's bundled manifest, and never guess storage paths. Check whether the local Core satisfies the world manifest's compatibility and `coreVersion` requirements; if not, route to `arcane-fvtt-setup` to install or switch Core first — never let Foundry auto-migrate the Demo with a mismatched Core.

Present this change table; when there are many dependencies, fully identical modules may be folded into a count summary:

| Type | id | Local version | Index stable version | Action | Download size | SHA256 |
|---|---|---:|---:|---|---:|---|

Actions include missing, current, upgrade, local-newer, unknown, duplicate. `duplicate` / `unknown` must be dealt with first; `local-newer` is kept by default — never downgrade just to match the profile. After the table, give `plannedArchiveBytes`, the world version and SHA256, the profile id/revision/SHA256, the index's `generated`, and the full resolution set's `resolutionSha256`. Distinguish clearly:

- Packages only: no replacement, no reset, no world backup;
- World change: the old world is backed up whole and then reset; content is not merged;
- A profile revision change only means the package id set changed — it is not an installable directory by itself.

## 2. Install authorization

- When entering from the `arcane-fvtt-setup` fresh-install flow, setup's plan-confirmation gate already covered the full plan for this environment — continue directly, no separate asking.
- When the user directly asks this skill to install/update/reset, the change table itself is the plan notification; when the user then says "install", "upgrade", "reset", or "continue", that authorizes the plan — don't ask again.

Wording conventions:

- Packages missing/upgrade only: explain that these global `<data-dir>/Data/systems` / `<data-dir>/Data/modules` will be backed up and replaced, which may affect other worlds; never claim the Demo world itself will be reset.
- World missing: call it "installing the Arcane Demo".
- World upgrade: call it "backing up and resetting the Arcane Demo to <version>", and state explicitly that Actors, Items, Journals, Scenes, chat, and databases are not automatically merged.
- World or package `local-newer`: never downgrade by default; the user must explicitly request a specific older version separately, and the current profile flow offers no such downgrade.

All downloads can finish staging while Foundry is running; stop the service only once, right before the actual replacement.

## 3. Downloading and verifying staging

`world-stage` / `world-commit` always strictly require the Data directory to exist (they never accept `--allow-missing-data-dir`). On a fresh install, create the standard directory structure (`<data-dir>/Config`, `<data-dir>/Data`, `<data-dir>/Logs`) after plan confirmation, then run staging.

Pass the stable fields returned by `world-inspect` back verbatim to guard against remote pointer drift:

The command must be built from the `world-inspect` result that just completed this time — never copy parameter lists from old sessions, old logs, or memory. Before executing, check the following eight `--expected-*` parameters one by one; even when every other field is identical, `--expected-resolution-sha256` must not be omitted.

```text
mod-manager world-stage --world-id arcane-demo --data-dir <data-dir> --expected-world-version <version> --expected-world-sha256 <world SHA256> --expected-profile-id <profile id> --expected-profile-revision <revision> --expected-profile-sha256 <profile SHA256> --expected-index-generated <generated> --expected-resolution-sha256 <resolutionSha256>
```

`world-stage` re-reads the index, the world manifest, and the profile, re-resolves the current stable packages, and downloads only the systems, modules, and world whose status is missing/upgrade. The external manifest, ZIP, and archive-root manifest pass URL, identity, bytes, SHA256, and safe-path checks in turn; upstream URLs inside the archive may differ — after package identity and ZIP hashes pass, the helper normalizes staging with the verified external manifest. When any check fails, the helper deletes this staging attempt and the existing Foundry content stays unchanged — don't stop the service.

Compare the returned `dependencyReplacements` and the actual staged total against the confirmed plan. `resolutionSha256` covers the index generation, the world/profile hashes, and every resolved package's version, URL, manifest/ZIP bytes, and SHA256; when anything changes, re-inspect — never work around the helper's refusal.

## 4. One service stop, transactional commit

Record the current Core, Data, port, and world id, then precisely stop the Foundry PID listening on the port per `arcane-fvtt-ops`. Then run:

```text
mod-manager world-commit --stage-dir <stageDir> --data-dir <data-dir> --expected-current-version <version-or-none>
```

Pass the literal `none` when the world isn't installed. The helper re-verifies the staging and all local package/world snapshots, and starts replacing only after all incoming content is prepared. Changed modules/systems are backed up to `<data-dir>/Data/.arcane-mod-backups/`; only when the world itself actually changes is it backed up to `<data-dir>/Data/.arcane-world-backups/<id>/`. A mid-flight failure attempts to roll back replacements already started; never delete the reported incoming, backup, or rollback paths.

After committing, the helper writes a receipt at `<data-dir>/Data/.arcane-managed/profiles/<profile-id>.json`, recording this profile, the world, the resolved exact package versions/hashes, and the actually installed versions. The receipt is audit-only: it doesn't lock future stable versions, and it's no substitute for reading the index next time.

## 5. Startup and acceptance

Start with the Core the world requires and the same data directory; when installing/resetting the world, append `--world=arcane-demo`. After waiting for the ready GM page, read back read-only:

- `game.world.id`, `game.world.version`, and `game.version`;
- `game.system.id` and the currently installed version;
- the versions and `active` state of the modules resolved this time;
- whether kept local-newer packages with `matchesResolvedVersion=false` in the receipt match the user's expectations.

The Demo artifact should carry its own module configuration, but modules newly added to the profile aren't necessarily already enabled in an existing world. If one isn't enabled, don't edit the database or internal settings directly; report the difference and let the user confirm in Manage Modules. Finally list the installed or replaced packages/world, the full backup paths, the world/profile/package SHA256s, the receipt path, and whether the Demo started successfully.
