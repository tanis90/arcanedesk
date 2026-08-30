# Third-party notices

Arcane Desk depends on third-party open-source packages. Those packages remain
under their own licenses; the Apache License 2.0 for Arcane Desk does not
replace their terms. This document is an initial direct-dependency inventory,
not a substitute for the complete license texts shipped by each dependency.

## Runtime dependencies at the migration baseline

| Package | License | Project |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | MIT | <https://github.com/earendil-works/pi> |
| `@highlightjs/cdn-assets` | BSD-3-Clause | <https://highlightjs.org/> |
| `commander` | MIT | <https://github.com/tj/commander.js> |
| `katex` | MIT | <https://katex.org/> |
| `marked` | MIT | <https://marked.js.org/> |
| `mermaid` | MIT | <https://github.com/mermaid-js/mermaid> |
| `tar` | BlueOak-1.0.0 | <https://github.com/isaacs/node-tar> |
| `typebox` | MIT | <https://github.com/sinclairzx81/typebox> |
| `yauzl` | MIT | <https://github.com/thejoshwolfe/yauzl> |

## Direct development and build dependencies at the migration baseline

| Package | License | Project |
| --- | --- | --- |
| `@types/node` | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| `@types/yauzl` | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| `ali-oss` | MIT | <https://github.com/ali-sdk/ali-oss> |
| `electron` | MIT | <https://github.com/electron/electron> |
| `electron-builder` | MIT | <https://github.com/electron-userland/electron-builder> |
| `typescript` | Apache-2.0 | <https://www.typescriptlang.org/> |
| `vitest` | MIT | <https://vitest.dev/> |

Exact versions are authoritative in `package-lock.json`. Package manifests may
change during the SDK-first migration, so this baseline must be updated with
every dependency change.

## Generation and release policy

The checked-in lockfile is the source for a reproducible license inventory. The
release process must eventually generate a machine-derived report after:

```shell
npm ci --workspaces --include-workspace-root
```

The generator should walk every installed production package reachable from
all workspaces, resolve SPDX identifiers and bundled license files, retain all
required attribution and notice text, and fail on any missing, unknown, or
policy-incompatible license. It should also emit the license component of the
release SBOM. A reviewed generated artifact belongs beside each release; this
human-readable file remains the concise direct-dependency index.

Until that generator and its CI drift check are implemented, maintainers must
manually compare every workspace manifest and `package-lock.json` against this
file before producing a public binary. A successful `npm audit` is not a
license review.

## Foundry Virtual Tabletop boundary

Foundry Virtual Tabletop is commercial third-party software and is not a
dependency distributed by this repository. Arcane Desk does not include,
download, mirror, or license the Foundry application or commercial game
content. Users must provide their own lawfully licensed Foundry installation
and comply with its license and applicable content licenses.
