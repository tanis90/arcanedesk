# MVP validation matrix

## P0: prove or kill the architecture

- [x] The Foundry VTT module appears in local Foundry 13 and can be enabled.
- [x] The module runs in `/game`, not the join/setup page or an iframe.
- [x] `document.modelContext.registerTool` exists in Codex's built-in Browser.
- [x] Codex discovers `arcane_probe` while the Foundry page is open.
- [x] Codex invokes `arcane_probe` and receives the same world/user session visible in Foundry.
- [x] The SDK `runtimeFunction` can be compiled under Foundry's page CSP.
- [x] Codex invokes `arcane_world_info` and receives an SDK-backed result.
- [x] A reload re-registers exactly the expected tools without stale definitions.
- [x] Navigating away removes the tools from the active page.

## P1: write-safety harness before gameplay tools

- [x] Measure safety review/confirmation behavior for a module-owned write probe.
- [x] Verify errors and interrupted responses are returned without automatic duplicate commits.
- [x] Verify the probe leaves the Foundry page responsive and does not open or deadlock dialogs/templates.
- [x] Define multi-tab/world selection behavior: tools are page-bound, every write is bound to an expected world ID, and revisions reject stale cross-tab writes.
- [x] Add page-session, runtime, protocol, hash, module, world, battle, round, turn, and source-token negotiation plus reload diagnostics.
- [ ] Refactor the SDK to export a callable in-page runtime so production does not require `Function()`.

The P1 write probe is intentionally not a gameplay tool. It persists only a hidden
`idle`/`armed` marker, a monotonic revision, and up to 20 idempotency receipts in
the module's own world setting. Actor, scene, item, chat, and combat documents are
out of scope until these gates pass.

The P0 run was completed on 2026-09-03. See `mvp-run-2026-09-03.md` for evidence and environment notes.
The P1 write-safety run was completed on 2026-09-03. See `p1-write-safety-run-2026-09-03.md` for evidence and remaining gates.

## P2: guarded Turn Protocol execution

- [x] Discover live `battleContext` and `turnContext` through WebMCP.
- [x] Reject a stale page session before writing a receipt or changing combat state.
- [x] Execute one existing action for the exact active combatant with `advance: false`.
- [x] Persist a terminal receipt and replay the same request without executing twice.
- [x] Verify concrete state change, chat output, and unchanged round/turn.
- [x] Restore fixture HP and refund the consumed resource through supported Foundry UI.

The P2 run was completed on 2026-09-03. See
`p2-execute-turn-run-2026-09-03.md` for the exact action, receipts, and cleanup.
