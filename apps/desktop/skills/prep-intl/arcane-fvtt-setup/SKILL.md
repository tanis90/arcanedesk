---
name: arcane-fvtt-setup
description: Install, repair, upgrade, or migrate a Foundry VTT 13 community environment on local Windows/macOS. Use when the user says "install Foundry/FVTT for me", "deploy from scratch", "reinstall/upgrade", "migrate to a new machine", or provides a Foundry ZIP/EXE/DMG/timed URL. For daily start/stop, logs, and port troubleshooting of an existing instance, use arcane-fvtt-ops instead.
---

# Foundry VTT community install & repair

For non-technical DMs. Use the Arcane Node and platform-native capabilities already prepared by the current Agent session; never ask the user to install Node, Git, Git Bash, or a package manager.

## User interaction budget

A full installation has at most 4 user interaction points; beyond these there must be no further questions, confirmations, or choices:

1. **Provide the paid Foundry artifact**: paste the official timed URL or drop in a local installer file. Give the user illustrated guidance (sign in to foundryvtt.com → Purchased Licenses → copy the download link for their platform).
   The delivered artifact authorizes reading and verification only — no writes.
2. **Confirm the install plan**: the Agent presents the full plan (what will be installed, versions, total download size, exact paths); one "OK/continue" from the user lets it proceed. This is the only confirmation gate; once confirmed, the same plan is never re-asked.
3. **Handle OS security prompts**: UAC, Gatekeeper, and security-software prompts must be visible to and handled by the user. Before each prompt, say in one sentence what window will appear and which button to click; if the user cancels UAC, stop.
4. **In-browser finishing**: EULA, license activation, and GM login are completed by the user on the Foundry page. The Agent gives precise steps once the service is ready — never does it on their behalf.

After plan confirmation, explanations of sources, targets, and side effects during execution are notifications — they don't wait for approval.
Before adding any new user interaction, first argue why it cannot be folded into these 4 points.

## Runtime contract

The App unpacks and verifies the bundled Node before the Agent starts. In the current shell:

- `ARCANE_FVTT_NODE` is the absolute path of the Node executable.
- `node` and `npm` should resolve to the same directory, but the user or system PATH is not modified.
- `ARCANE_FVTT_DISTRIBUTION_FILE` points to the bundled `community-distribution.json`.

Check all three before starting, and verify the Node version equals the manifest's `core.node`. If an environment variable is missing, a file doesn't exist, or the version mismatches, stop and suggest restarting or updating Arcane Desk; never fall back to a system Node or install another Node for the user.

The community manifest contains no Arcane mirror, official private modules, prebuilt worlds, or default bulk downloads. Foundry Core is always supplied by the user from their Purchased Licenses page; the manifest never provides or guesses paid download URLs.

## Install plan and confirmation

Installation has two phases: first a read-only phase derives the plan, and writes begin only after the user confirms.

**Read-only phase** (allowed as soon as the artifact is delivered, no extra asking): hash, signature, and archive-structure checks of local artifacts; HEAD requests for sizes; downloads of small JSON metadata (the mirror `index.json`, world manifests, environment profiles, individual package manifests — i.e. the full network activity of `world-inspect`). On a fresh install the Data directory usually doesn't exist yet: pass `--allow-missing-data-dir` to read-only commands such as `world-inspect`; `dataDirExists: false` in the output means a fresh install, and the plan marks that directory as "to be created". This flag is only for this flow's read-only commands; stage/commit always strictly require the directory. Never create directories early just to run read-only checks — directory creation belongs to the write phase.

**Write phase** (begins only after the confirmation gate): any content ZIP download (even a few KB), extraction, creation or modification of target directories, and starting/stopping the Foundry service.

Present the plan in one paragraph:

- What: Foundry Core `<core.foundry>`, plus the Arcane Demo environment (the Demo world and the system/modules resolved live from the Arcane package index by its environment profile — see "Content installation" below);
- Total download: Core artifact size + content size (per the live read-only `world-inspect` resolution);
- Exact absolute paths of the resolved Core and Data directories, marking non-existent ones as "to be created";
- One sentence: "If you don't want any part of this, say so now."

Writes start only after user confirmation. Confirmation covers this plan's versions, sizes, hashes, and paths: staging pins the plan with `--expected-*` parameters; remote drift is rejected by the helper without re-asking the user; if a re-inspect resolves a different resolution, the plan has changed and must be presented and confirmed again. When no world has been published to the index yet, the plan contains only Core; don't guess URLs — the Core install can still succeed on its own.

## Artifact identification and directory resolution

Handle in this order:

1. An existing Foundry installation specified by the user: verify it is complete and usable, then prefer reusing it.
2. A user-provided local `.zip`, `.exe`, or `.dmg`: check format, signature/hash, and contents, then use it.
3. A user-provided official Foundry timed URL: confirm it's an official Foundry HTTPS address, then download to a temp directory.
4. User has neither an installation nor an artifact: explain that Foundry is paid software and ask the user to obtain the official artifact or timed URL themselves.

Never ask the user for directories — use platform defaults and state the exact paths in the plan and final report. The Core and Data directories must be separate. When the user volunteers a location, don't ask back — derive by rule: a single location is treated as a parent directory, Core = `<that-dir>\FoundryVTT-<core.foundry>`, Data = `<that-dir>\foundry-data`; if Core and Data locations are given separately, adopt both as given and validate each; if only the Data location is given, use it for Data and the default for Core. When nothing is specified at all, on Windows use `%LOCALAPPDATA%\ArcaneDesk\runtime\foundry\<version>`, on macOS use the ArcaneDesk `userData/runtime/foundry/<version>`. When the Data directory is entirely unspecified, on Windows use `%LOCALAPPDATA%\ArcaneDesk\runtime\foundry-data`, on macOS use the ArcaneDesk `userData/runtime/foundry-data`. Never recursively scan whole disks, never treat an unknown non-empty directory as an install target, and never invent other default locations.

When the target directory already exists and is non-empty: if it verifies as a complete installation of the same version, reuse it directly; otherwise make a timestamped backup of the existing directory before continuing — do not continue unless the backup succeeded, and record the backup location in the final report. Never silently overwrite.

## Installing Foundry Core

Read platform details as needed:

- Windows: [references/windows-install.md](references/windows-install.md)
- macOS: [references/macos-install.md](references/macos-install.md)

Node.js distribution ZIP flow:

1. Use local files directly; download over the network only when the user provided a timed URL — that download is pre-authorized by the plan.
2. Check HTTP status, final URL, size, and file type.
3. Compute the SHA256 with `ARCANE_FVTT_NODE` and report it. When an official timed URL has no pre-declared hash, don't claim a match against any fixed hash; the computed value is the identity basis for this installation and its retries.
4. Inspect the archive's top-level structure and reject absolute paths, `..` traversal, symlink escapes, or unusual device files.
5. Extract to a staging directory on the same disk, locate `main.js` and `package.json`, verify the version equals `core.foundry`, then move atomically to the target. Never overwrite an unknown non-empty directory.
6. Always run headless invocations with the absolute path of `ARCANE_FVTT_NODE`.

## Directory structure and path discipline

A Foundry data directory has a nested structure where both the outer and inner levels are called Data — installing into the wrong level is a real accident that has happened:

```text
<data-dir>                              ← where --dataPath points
├── Config/                             ← options.json etc.
├── Data/
│   ├── systems/<id>                    ← game system, e.g. dnd5e
│   ├── modules/<id>                    ← module
│   ├── worlds/<id>                     ← world, e.g. arcane-demo
│   ├── .arcane-mod-backups/            ← replacement backups from the mods flow
│   ├── .arcane-world-backups/          ← world reset backups
│   └── .arcane-managed/profiles/       ← install receipts
└── Logs/
```

- This document, user-facing output, and internal operations always use the full form (e.g. `<data-dir>/Data/systems/dnd5e`); bare shorthands like `Data/systems` are forbidden.
- After any content is installed, read its manifest back from the final absolute path (`system.json` / `module.json` / `world.json` id and version) before counting it as installed. A wrong-level install must be caught on the spot — never let it surface later as "not found at startup".

## Content installation: always via the Arcane package index

`community-distribution.json`'s `installDefaults.systems/modules/worlds` are all empty — the Desktop does not bundle the Demo world, its version, or a dependency list. The dnd5e entry in the manifest's `systems` is only an upstream provenance and license record; never use it as an install source or verification baseline.

All system/module/world installation goes through `arcane-fvtt-mods`, resolved from the Arcane package index:

- **Demo environment installed by default**: continue right after Core acceptance — no separate question. Follow `arcane-fvtt-mods`' [references/demo-world.md](../arcane-fvtt-mods/references/demo-world.md): first run read-only `world-inspect` to resolve the exact package set, sizes, and hashes (the plan's content size comes from this), then stage, commit with a single service stop, and accept with `--world=arcane-demo`. When no world has been published to the index yet, don't guess URLs; a standalone Core success is enough to hand over.
- **User explicitly asks for dnd5e**: dnd5e is in the index and is installed together with the Demo environment profile resolution. If the user explicitly doesn't want the Demo world, still install via that flow but omit `--world` at startup acceptance; the world stays on disk unused. Never switch to the manifest's GitHub entry instead.
- **User names another mod**: check the index first. Indexed mods are installed with a byte-exact SHA256 check against the index-pinned bytes — the user's explicit install request is the authorization. For non-indexed mods, give one plain-language risk warning and get confirmation: "This one isn't among the mods vetted by the Arcane index; installing it may have unknown consequences. Confirm you want it installed? If you'd like the Arcane index to carry this mod, you can send us feedback at https://arcanedesk.app/en." After confirmation, install per the `arcane-fvtt-mods` install flow; the SHA256 is computed, checked, and recorded by the Agent in the report — but it is only this download's fingerprint; never hand hex strings to the user for judgment.
- Individual and total sizes were shown in the plan and covered by the confirmation gate — no separate confirmation; on failure, keep the original directory, leave no half-installed state, and retry only the failed item.

Verification discipline: mirror content is verified only against the hashes declared by the index. Never mix chains — downloading from the mirror while verifying against a GitHub hash from the manifest guarantees a false alarm (mirrors repackage, so hashes differ by design). No proxy pools or third-party mirrors; the Arcane index is the only recognized first-party source. On hash or identity mismatch the helper refuses — never bypass it.

## Acceptance and handover

Accept according to what the user actually chose:

1. Arcane Node matches the manifest version.
2. Foundry `package.json` version, `main.js`, and the Core/Data paths are explicit.
3. Installed content's manifests read back successfully from final absolute paths; ids, versions, sources, and SHA256s are recorded (index content per the index and staging records).
4. Start `main.js --dataPath=<data-dir>` with Arcane Node; add `--world=arcane-demo` when the Demo was installed.
5. The log shows `Server started and listening on port 30000` and the local address responds.

For a macOS DMG-installed App copy, handle quarantine before first launch per
[references/macos-install.md](references/macos-install.md): verify this artifact's SHA256, `codesign` and `spctl` results, and the exact App path; after explaining to the user, clear that copy's quarantine with `xattr -dr com.apple.quarantine`, then do the first launch. Never re-sign, un-sign, or replace files inside the App bundle.

Finally report the actual paths, install sources, versions, SHA256s, backup locations (if any), what content was installed, and the EULA, license activation, or GM login still to be completed by the user on the Foundry page. Never print license keys, the full `options.json`, or credentials.

## Safety baseline

- Never fetch the paid Foundry artifact or license on the user's behalf, and never accept the EULA for them.
- Never bypass UAC, Gatekeeper, or security-software prompts; silent install switches must not be used to bypass elevation.
- Never silently overwrite Core, worlds, or user data; back up conflicts first, continue only after the backup succeeds, and record the backup location in the report.
- All downloads land on disk and are verified before use per the confirmed plan; never execute network responses.
- Never treat the App installation directory as a writable Data directory.
- Never print license keys, the full `options.json`, or credentials.
