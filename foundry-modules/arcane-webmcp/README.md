# Arcane WebMCP for Foundry VTT (FVTT MCP)

Arcane WebMCP is an open-source **Foundry VTT MCP / FVTT MCP integration for
Codex**. It runs as a Foundry VTT 13 module and registers WebMCP Site tools in
the top-level `/game` page, so Codex can discover and invoke Arcane Foundry SDK
capabilities through the **Codex built-in browser** and its existing,
authenticated Foundry session.

Unlike a separate Chrome or CDP bridge, the WebMCP tools and the visible
Foundry UI share one browser page and one login. This package is not a generic
stdio or HTTP MCP server: its tools exist only while the enabled module is
loaded in a supported WebMCP browser client.

## Architecture

```text
Codex built-in browser
  -> Foundry VTT /game page
    -> Arcane WebMCP Site tools
      -> @arcanedesk/foundry-sdk runtime
        -> current world, combat, actors, and actions
```

The module consumes the same transport-neutral SDK runtime as Arcane Desktop
and `@arcanedesk/fvtt-cli`; it does not maintain a second Foundry protocol
implementation.

## Current tools

The play-facing surface (mirror of the Desktop 跑团/combat mode tool set) is
the primary family:

- `arcane_static_context`: read the full static manual (all focused Tokens and
  their supported abilities as stable actionRefs) once per combat or Scene.
- `arcane_play_context`: lightweight dynamic HP/resources/conditions and
  available actionRefs; `view=turn` is the mandatory read before and after
  every combat action; `view=operation` inspects one prior write receipt.
- `arcane_execute_action`: execute discovered abilities by actionRef (single
  or combat sequence) with GM gating, module-enforced read-turn-first, a
  durable requestId ledger, and non-replayable partial/indeterminate receipts.
- `arcane_conditions_set`: set or remove named conditions (Chinese aliases
  accepted), including explicitly ending concentration, on token/name/selected
  play targets.

The Turn Protocol v2 trio stays registered as a validated transitional
surface; new clients should prefer the play family:

- `arcane_probe`: report the WebMCP page, bridge, SDK, and Foundry identity.
- `arcane_world_info`: read the current world, system, GM, and module status.
- `arcane_battle_context` / `arcane_turn_context` / `arcane_execute_turn`
  (plus `arcane_execute_turn_receipts`): the pre-play combat surface from the
  2026-09-03 spike.

The pre-release build also includes `arcane_write_probe_state` and
`arcane_write_probe`. They only exercise module-owned test state and exist to
validate WebMCP write review, idempotency, and interrupted-call recovery. They
do not modify actors, scenes, items, chat, or combat.

New write tools are added individually with explicit schemas, GM gating,
stale-state checks, durable request IDs, and recovery receipts — never as a
generic pass-through of the SDK's maintenance actions.

## Threat model and safety posture

The tool surface is **not an access-control boundary**: a GM session already
carries full Foundry power, and a fully-controlling browser client can operate
the Foundry UI directly. What the narrow, guarded surface buys is different:

- **Injection containment.** World content (chat, journals) is untrusted text
  a browsing agent will read. A hijacked agent can at worst take valid combat
  actions and set conditions through bounded, receipted tools instead of
  arbitrary world mutations.
- **Agent-error containment.** A small, precisely-shaped action space keeps a
  hallucinating model from finding destructive affordances.
- **Execution reliability.** Read-turn-first enforcement, requestId
  idempotency, fingerprint-checked replay, and durable receipts make
  interrupted calls recoverable without duplicate execution.

All tools except `arcane_probe` require the active Foundry user to be a GM,
checked live on every call. Play writes additionally require a current
`arcane_static_context` in the page session and, in combat, a fresh
`view=turn` read before every execution; the SDK runtime re-validates stale
manuals, turn drift, and world identity as a second layer. WebMCP annotations
are descriptive metadata; the module enforces its own authorization,
validation, serialization, and idempotency rules.

## Build and verify

From the repository root:

```powershell
npm ci --workspaces --include-workspace-root
npm run check --workspace @arcanedesk/foundry-webmcp
```

The build produces a Foundry module directory at
`foundry-modules/arcane-webmcp/dist`. Generated files are not the source of
truth.

For a local Foundry installation:

```powershell
npm run install:local --workspace @arcanedesk/foundry-webmcp
```

The installer defaults to `D:\FVTT_DATA\Data\modules\arcane-webmcp`. Set
`FVTT_DATA_PATH` to select another Foundry data directory. Enable **Arcane
WebMCP for Foundry VTT** in a test world, open that world's `/game` page in the
Codex built-in browser, and inspect the page's Site tools. Runtime diagnostics
are also available as `globalThis.arcaneWebMcp` in page developer tools.

## Legacy turn-tool boundary

The Turn Protocol v2 execution tool (`arcane_execute_turn`) binds each request
to the exact bridge session, module/runtime versions, runtime hash, world,
battle, round, turn, source token, action, and a durable request ID, and never
advances the turn. The play family instead binds identity in module state
(static/turn snapshots) so the model never echoes possibly-stale values; see
[`docs/play-tools-design-2026-09-21.md`](docs/play-tools-design-2026-09-21.md).

## Validation status

The original standalone spike established the end-to-end path on 2026-09-03:
Codex WebMCP -> SDK runtime -> Foundry `executeTurn`. It also verified a real
resource-consuming action, same-request replay protection, and state cleanup.
The preserved evidence is indexed in [`docs`](docs/README.md).

The SDK currently publishes its validated in-page runtime as a source string
for CDP and Electron transports. This module compiles that trusted, bundled
source once inside the Foundry page. The approach has passed the current
Foundry CSP test; a future additive SDK helper may formalize it without
changing the existing CLI or Desktop execution paths.
