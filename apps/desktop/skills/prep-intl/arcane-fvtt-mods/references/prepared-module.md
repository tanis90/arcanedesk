# Generating an Install Package from a Module Build File

Use the bundled Node and the manager already verified by the main skill. The builder and its native dependencies ship with the skill; do not install npm, download compilers, look for developer repositories, or copy or rewrite the generator.

Interaction budget: generating an install package requires at most the user providing the file; an explicit generation request is authorization to create the new local artifact — do not ask about technical parameters. Installing after generation follows the single plan of the local install flow; the build authorization does not carry over as install authorization.

```text
bundle-inspect --input <absolute path to build file>
```

This inspection only reads the file and returns the id, version, input size, and SHA256; it only checks the input type and identity — full content validation is performed by the shared builder. Prepared inputs with format `arcane-module-bundle` and schemaVersion 1 are supported. When an ordinary spell JSON, a raw third-party package, or descriptive material does not conform to this protocol, say so clearly — do not fake it by changing fields.

Choose a fresh directory unique to this task in the system temp directory, tell the user where output will be generated, then run:

```text
bundle-build --input <same inputPath> --out <new directory/module> --zip <new directory/module.zip> --expected-sha256 <inputSha256>
```

Use the hash from this inspection; if the input changed, stop and re-inspect. The tool validates content and file paths, generates the compendium and manifest, then packs the ZIP; it does not execute content scripts, does not go online, and does not modify an existing Foundry. The output directory must be newly created or empty, and the ZIP must not overwrite an existing file. A directory left behind by a failure is for troubleshooting — do not treat it as a successful install package.

On success, report the module version and ZIP path. When the user asks to install, take the returned archive path into [local-module.md](local-module.md), reconcile the ZIP hash from local-inspect against the build receipt's archive.sha256, and then prepare the install plan. Do not treat the input JSON's hash as the ZIP hash.

Full descriptions, assets, and compendia remain the user's content — do not upload them to GitHub, the package index, or log attachments. A successful build does not mean the content is licensed for public distribution, nor that new spells/classes have passed in-game QA.
