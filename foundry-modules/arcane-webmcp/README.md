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

The combat-facing surface contains:

- `arcane_probe`: report the WebMCP page, bridge, SDK, and Foundry identity.
- `arcane_world_info`: read the current world, system, GM, and module status.
- `arcane_battle_context`: read the active combat and callable action catalog.
- `arcane_turn_context`: read the active actor, resources, actions, and targets.
- `arcane_execute_turn_receipts`: inspect durable execution receipts after an
  interrupted response.
- `arcane_execute_turn`: execute one currently available action without
  automatically advancing the turn.

The pre-release build also includes `arcane_write_probe_state` and
`arcane_write_probe`. They only exercise module-owned test state and exist to
validate WebMCP write review, idempotency, and interrupted-call recovery. They
do not modify actors, scenes, items, chat, or combat.

The module intentionally does not expose the SDK's broad maintenance actions
as a generic pass-through tool. New write tools require explicit schemas,
authorization, stale-state checks, durable request IDs, and recovery receipts.

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

## Security boundary

All current tools require the active Foundry user to be a GM. The execution
tool binds each request to the exact bridge session, module/runtime versions,
runtime hash, world, battle, round, turn, source token, action, and a durable
request ID. It rejects stale or mismatched state and never advances the turn.
WebMCP annotations are descriptive metadata; the module enforces its own
authorization, validation, serialization, and idempotency rules.

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
