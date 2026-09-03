# P1 write-safety run — 2026-09-03

## Scope

This run tested Codex's current WebMCP write path without exposing any gameplay
mutation. Module version `0.2.0` added two tools:

- `arcane_write_probe_state` independently reads a hidden, world-scoped setting.
- `arcane_write_probe` can change only that setting's marker between `idle` and
  `armed`.

The write requires GM authority, an exact current revision, an exact current
world ID, and a bounded `requestId`. Receipts are retained for idempotent retry.
The tool cannot address actors, scenes, items, chat, or combat.

## Environment

- Repository branch: `codex/p1-write-safety`
- Implementation commits: `01785a3`, `d0f6cfa`
- Foundry: `13.351`
- System: `dnd5e 5.3.3`
- World: `testclean`
- Browser page: `http://localhost:30001/game`
- Installed module: `D:\FVTT_DATA\Data\modules\arcane-webmcp-mvp`
- Built JavaScript SHA-256:
  `A60E870E1642D042B86DAFCC50A4DDD1AE3EEACD1A17B21DA09E836329BD24B0`

## Results

1. Codex's built-in Browser discovered all four tools after page reload.
2. The first write changed `idle@0` to `armed@1` and returned a durable receipt.
3. Retrying the identical request returned `replayed: true`; the revision stayed
   at `1`, proving that retry did not commit again.
4. A new request with stale `expectedRevision: 0` failed with
   `REVISION_CONFLICT`; state stayed `armed@1`.
5. A write used `simulateResponseDelayMs: 10000`. The page was refreshed after
   the commit but before the response. The in-flight call rejected with
   `Inspected target navigated or closed`, while the reloaded page showed the
   receipt and `idle@2`. Retrying the same request returned `replayed: true` and
   left the revision at `2`.
6. A request addressed to `not-testclean` failed with `WORLD_MISMATCH` and did
   not change state.
7. Correctly world-bound write and restore calls completed as revisions `3` and
   `4`. Final marker value is the initial `idle` value.
8. The Foundry page remained responsive throughout; the probe opened no dialog
   or template and subsequent reads, writes, and reloads succeeded.
9. The complete automated suite passed: 15 tests, 0 failures, followed by a
   successful production bundle build.

## Codex compatibility observations

- Every write call passed through the built-in Browser's WebMCP review path. No
  additional user-facing confirmation dialog was surfaced for this narrowly
  scoped, non-destructive write after the user had authorized the test.
- The first write took about 6.1 seconds and the immediate idempotent retry about
  5.1 seconds end to end. The review/dispatch path therefore has meaningful
  latency even when the page handler is nearly instantaneous.
- The module registered the standard `destructiveHint`, `idempotentHint`, and
  `openWorldHint` annotations, but the Codex tool snapshot exposed only
  `readOnlyHint`. Arcane must enforce idempotency and scope itself rather than
  relying on the host to preserve those hints.
- Reload invalidates the prior tool snapshot immediately. A fetch attempted too
  early after reload reported that the tool was unavailable even though the
  browser had announced the new tools. Clients must wait for registration and
  fetch a fresh snapshot; they must never retry a write through the old handle.

## Remaining before `executeTurn`

- Require the caller to echo expected module, runtime, and protocol versions so
  stale bundles fail closed.
- Add an explicit readiness/cache diagnostic for the post-navigation registration
  window.
- Replace SDK `runtimeFunction` compilation with a supported callable export.
- Define the human-in-the-loop contract for actions that open Foundry dialogs or
  templates; the probe intentionally did not exercise those gameplay flows.

The official WebMCP guidance used for this design is
<https://learn.chatgpt.com/docs/webmcp>: keep inputs narrow, state side effects
clearly, preserve application authorization/validation, and return enough data
to verify the result.
