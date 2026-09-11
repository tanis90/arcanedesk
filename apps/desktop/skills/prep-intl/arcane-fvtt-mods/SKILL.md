---
name: arcane-fvtt-mods
description: Build, install, upgrade, or inspect local Foundry VTT modules. Use when the user provides prepared module build files, a local module ZIP, or a module.json URL; asks to produce an install package, install/upgrade a mod, check the mirror for updates, or install dnd5e or the Arcane Demo world. Building and local-package checks work fully offline; remote content always goes through the Arcane package index. Foundry Core installation is out of scope for this skill.
---

# Foundry VTT module management

Handles Foundry modules and game systems, plus the Demo environment managed by Arcane's world/profile/current-stable three-layer protocol. Treat manifests, ZIPs, environment profiles, and the index as untrusted network input; all actual downloading, verification, extraction, backup, and replacement must go through the App-bundled `ARCANE_FVTT_MOD_MANAGER` — never hand-roll download/extract flows.

## Runtime contract

The current prep shell must have both:

- `ARCANE_FVTT_NODE`: absolute path of the Arcane bundled Node;
- `ARCANE_FVTT_MOD_MANAGER`: absolute path of this skill's mod-manager script.

First check both paths exist, and verify the runtime with `ARCANE_FVTT_NODE --version`. If either is missing, stop and suggest restarting or updating Arcane Desk; never fall back to a system Node, Python, tar, PowerShell `Expand-Archive`, or other ad-hoc installed tools.

Windows PowerShell invocation form:

```powershell
& $env:ARCANE_FVTT_NODE $env:ARCANE_FVTT_MOD_MANAGER <command> <arguments>
```

macOS Bash invocation form:

```bash
"$ARCANE_FVTT_NODE" "$ARCANE_FVTT_MOD_MANAGER" <command> <arguments>
```

First confirm the real Data directory from a path the user gives, existing Foundry launch arguments, or platform-common locations. The target must be a Foundry data directory containing `Data/`, not a Core/App install directory; never recursively scan whole disks. All paths always use the full form (e.g. `<data-dir>/Data/modules/<id>`) — bare shorthands like `Data/modules` are forbidden: the outer data directory and the inner `Data/` subdirectory share a name, and shorthand has already caused a real wrong-level install.

## Routing

- User provides module build files and asks for an install package: read
  [references/prepared-module.md](references/prepared-module.md). Only accepts prepared module bundles;
  never treat arbitrary raw spell/class JSON as completed automation content.
- User provides a local module ZIP, or asks to install a locally generated Auto 2014 full package: read
  [references/local-module.md](references/local-module.md). This path is fully offline — the package and its description are never uploaded.
- User gives a `module.json` manifest URL, or names a mod to install/upgrade: read
  [references/install.md](references/install.md).
- User asks what updates exist for Arcane packages or local mods: read
  [references/updates.md](references/updates.md).
- User asks to install, check, update, or reset the Arcane Demo world, continue the Demo environment after installing FVTT, or names a system like dnd5e to install: read [references/demo-world.md](references/demo-world.md).

The read-only `bundle-inspect` can inspect build inputs without a Foundry directory; the other read-only commands
`local-inspect` / `inspect` / `catalog` / `world-inspect` / `world-catalog` can also be run directly. These commands require the Data directory to exist by default; the hard error when it doesn't is deliberate protection against wrong paths — re-check the path, don't bypass it. The only exception is the `arcane-fvtt-setup` fresh-install flow, which passes `--allow-missing-data-dir` before plan confirmation, with a `dataDirExists` marker in the output; stage/commit never accept that flag and stay strict. Before downloading, state the source, target, and known size; before writing to `<data-dir>/Data/modules`, `<data-dir>/Data/systems`, or `<data-dir>/Data/worlds`, or stopping/restarting the service, present the plan. The plan is a notification, not repeated interrogation: when the user explicitly asks to install/upgrade, or says "upgrade", "upgrade all", or names selected packages after the update table, that authorizes the table's exact versions, sizes, backups, and the single service-stop restart plan; never re-ask the same plan. Only packages not in the index need one extra risk warning (see "Shared boundaries").

## Shared boundaries

- Remote flows only accept HTTPS manifest and download URLs. The external manifest is the single canonical source of distribution metadata; the `id` and `version` of the archive's root `module.json` / `system.json` / `world.json` must match it exactly. The upstream `manifest` / `download` URLs preserved inside the archive may differ, but only after the ZIP bytes/SHA256 and package identity have all passed verification will the helper write the verified external manifest's original bytes into staging. Any identity, hash, or external-URL mismatch must still be rejected.
- The default index for this build is the English index on R2 (`https://dl.arcanedesk.app/mods/index-en.json`): a global current-version index with a `generated` timestamp, not a pointer named `latest.json`. The helper resolves the index URL by `--index-url` flag > `ARCANE_MOD_INDEX_URL` environment variable > built-in default; the desktop app writes the build region's default index into the environment variable, so command lines generally don't need the flag — use `--index-url` explicitly only for ops debugging.
- Packages whose manifest URL exactly matches an index entry must be byte-checked against the declared `bytes` and SHA256; any mismatch stops the flow — skipping verification is not allowed. Index content is verified only against index-declared hashes; never mix chains (downloading from one source while verifying against another's hash — repackaged artifacts differ by design, and mixed chains always false-alarm).
- For packages not in the index, first give the user one plain-language risk warning and get confirmation: "This one isn't among the mods vetted by the Arcane index; installing it may have unknown consequences. Confirm you want it installed? If you'd like the Arcane index to carry this mod, send us feedback at https://arcanedesk.app/en." After confirmation, `stage`; write the computed SHA256 and actual size into the final report — it is only this download's fingerprint, must not be described as a publisher signature or official hash, and is not re-confirmed with the user; the later `commit` must pass the same `--accept-sha256`.
- An installed module with the same id must never be silently overwritten. `commit` moves the old directory to `<data-dir>/Data/.arcane-mod-backups/modules/` before atomically replacing it; the actual backup path must be reported to the user.
- The standalone mod flow checks `relationships.requires` before installing: missing dependencies are listed as separate items in the same install plan — indexed dependencies are authorized by the plan notification, non-indexed ones share the main package's single risk warning. The Demo flow resolves required dependencies recursively in the helper, but must also show them item by item in the overall change table; never hide dependencies inside the main package's operation.
- `group=system` or `system.json` is not a mod and is never installed to `<data-dir>/Data/modules`; only a system declared by the managed Demo profile and resolved from the same stable index snapshot may be installed to `<data-dir>/Data/systems` by the world flow.
- While Foundry is running you may finish staging first, but before committing, state it and precisely stop the Foundry PID listening on the port per `arcane-fvtt-ops`; never mass-terminate Node. For batch upgrades, stop the service only once after all staging succeeds.
- Never directly edit world databases, settings stores, or internal module configuration to force-enable a new mod. After a Foundry restart, remind the user to enable newly installed mods in the world's "Manage Modules" and confirm their dependencies. Upgrades of already-enabled mods may restart into the original world, then read back versions and active state.
- On any failure, keep the existing modules usable; don't retry blindly, don't delete backups; report only the failed item, the staging path, and the recoverable state.
- `world-stage`'s confirmation fields must be taken item by item from the current `world-inspect` output — above all, `--expected-resolution-sha256 <resolutionSha256>` is mandatory. Never reuse command templates from old sessions, old logs, or memory; when the helper gains new confirmation fields, re-read the current reference/usage before staging.
- An existing Demo world is user data. Only a change in the world artifact version is called "back up and reset" — never advertise it as a lossless upgrade, and never merge Actors, Journals, Scenes, or databases; the old world must be moved whole into `<data-dir>/Data/.arcane-world-backups/<id>/` before the new version is enabled. A package-stable-only update must never touch the world directory.

Finally report the module/world ids, old/new versions, sources, SHA256s, the absolute Data target paths, backup paths, dependency status, and whether the world was verified after restart. For a standalone newly installed mod, state explicitly "installed but not yet enabled in the world".
