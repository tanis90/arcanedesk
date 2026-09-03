# WebMCP validation evidence

These records were captured from the isolated `arcane-webmcp-mvp` spike before
its source moved into the Arcane Desk monorepo. The historical module ID,
version, install path, and standalone-repository wording are intentionally
preserved as evidence of what was actually tested on 2026-09-03.

The maintained module now lives in `foundry-modules/arcane-webmcp`, uses the
module ID `arcane-webmcp`, and resolves `@arcanedesk/foundry-sdk` from the
workspace. See the parent [`README`](../README.md) for current build and
installation commands.

- [`validation-matrix.md`](validation-matrix.md): go/no-go coverage.
- [`mvp-run-2026-09-03.md`](mvp-run-2026-09-03.md): initial discovery and read path.
- [`p1-write-safety-run-2026-09-03.md`](p1-write-safety-run-2026-09-03.md): write review and interruption recovery.
- [`p2-execute-turn-run-2026-09-03.md`](p2-execute-turn-run-2026-09-03.md): real guarded turn execution.
