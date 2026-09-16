# Foundry pack builder

Offline Item, Actor and JournalEntry compendium serialization, extracted from the Arcane Auto 2014
generator. Its complete internal build uses this same writer for all 17 packs. This package contains
no rule text, character data or compendium content; documents and assets come from the caller.

```js
import {writeCompendium, writeModule} from '@arcanedesk/foundry-pack-builder';
await writeCompendium('./output/spells', 'Item', callerItems);

await writeModule({
  directory: './output/my-module',
  manifest: {
    id: 'my-module', title: 'My module', version: '1.0.0',
    compatibility: {minimum: '13', verified: '13'},
    scripts: ['scripts/main.js'],
    packs: [{name: 'spells', path: 'packs/spells', type: 'Item', system: 'dnd5e'}],
  },
  documents: {spells: callerItems},
  files: {'scripts/main.js': callerRuntimeSource},
});
```

Outputs must be new or empty directories. Duplicate storage keys, invalid IDs, undeclared packs,
missing manifest assets and paths outside the module are rejected. The builder never opens an existing
database for modification. Use a temporary output directory, validate it, then promote the finished
artifact through your release process. A failed write can leave a partial temporary directory; it must
not be installed. The manifest is written last after all declared files and packs have been generated.

Descriptions and IDs are preserved. Foundry embedded Effects, Actor Items and Journal pages are written
to their expected records while parent records hold ID arrays. Inputs are not modified. Tables are
compacted and databases closed before returning. Logical records are reproducible; LevelDB's physical
files are not promised to be byte-identical across platforms or engine versions.

This is a Node 24 build-time package, not browser code. It uses classic-level 3.0.0 (a separately licensed
dependency installed by npm). It does not execute runtime scripts, fetch licensed content, install modules
into Foundry, update player Actors, or certify compatibility of caller-provided automation. For Auto 2014,
the full class/content provider and release manifest migration remain separate from this generic builder.

## Prepared JSON input and CLI

From a repository checkout after `npm ci`:

```sh
node packages/foundry-pack-builder/src/cli.mjs --input ./module-bundle.json --out ./output/my-module
```

The package also exposes the `arcane-build-module` npm bin. No npm registry publication is implied.
`--help` shows usage. Both input and output are explicit local paths; existing nonempty output is rejected.
This builds a directory for subsequent validation and installation. It does not install or activate it.

Prepare input with the same file bytes and documents you would pass to `writeModule`:

```js
import {createModuleBundle, writeModuleBundle} from '@arcanedesk/foundry-pack-builder';
const bundle = createModuleBundle({manifest, documents, files});
// Serialize bundle as JSON, then pass the parsed data to the CLI or this API:
await writeModuleBundle({directory: './output/my-module', bundle});
```

The top-level fields are exactly `format: "arcane-module-bundle"`, `schemaVersion: 1`, `manifest`,
`documents`, and `files`. Files map relative paths to canonical base64 strings. Document data is
normalized using JSON serialization, as with compendium records. Invalid encoding, unsupported versions,
traversal, missing assets, duplicate IDs and occupied output remain errors. Scripts are stored as bytes
and never evaluated during assembly. Failed writes may leave partial output; do not install that output.

A bundle contains actual descriptions, documents and assets supplied by its producer. It is not a
license-free metadata file or an automatic public export. Keep it within the same authorization and
distribution scope as its content. This format assembles prepared documents; it does not obtain rules
text or compile arbitrary third-party spell/class entries into Arcane automation.

The complete internal Auto 2014 build serializes this format, then reads it back through the shared API.
Internal CI separately runs this public CLI on the complete prepared bundle and compares all 17 packs
and 720 other artifacts with the reviewed migration baseline. Public tests use only original fixtures.

## Installable ZIP output

Add `--zip` to package the completed directory without a manual archive step:

```sh
arcane-build-module --input ./module-bundle.json --out ./output/my-module --zip ./output/my-module.zip
```

The JSON result includes `archive` with its absolute path, module identity, file count, compressed and
uncompressed byte counts, and SHA256. The ZIP has `module.json` at its root. It can be handed to Desktop's
local module installer; this command itself does not install, upload, enable a module or modify Actors.

The API is `writeModuleArchive({directory, archive})`. Use a completed directory whose databases are
closed and files are no longer being changed. It preserves every file byte and uses fixed ZIP timestamps
and sorted paths. Repacking unchanged directory bytes yields the same ZIP; separate LevelDB rebuilds
can still produce different physical database files and therefore different archive hashes.

Archive output must be a new file outside the module directory, with an existing destination parent.
Symlinks, case collisions, unsafe paths and self-inclusion are rejected. This in-memory ZIP writer is
limited to 512 MiB of uncompressed source and 60,000 files; larger inputs require a future streaming
implementation. Packaging uses the npm dependency fflate 0.8.3. A packaging failure can leave the completed
module directory for inspection, but no successfully returned ZIP receipt; do not treat a failed command
as a release. This is packaging, not a source-content validator or permission to redistribute a bundle.
