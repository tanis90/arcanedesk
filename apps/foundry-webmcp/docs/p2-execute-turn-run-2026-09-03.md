# P2 guarded execute-turn run — 2026-09-03

## Scope

Module `0.4.0` exposes the SDK's Arcane Turn Protocol v2 through four tools:

- `arcane_battle_context`
- `arcane_turn_context`
- `arcane_execute_turn_receipts`
- `arcane_execute_turn`

The execution tool permits one action for the exact active combatant. It fixes
`advance` to `false` and intentionally excludes arbitrary action input,
multi-action sequences, direct actor updates, token creation/deletion, and any
other SDK maintenance action.

Before execution, the caller must echo all of these live values:

- bridge page session ID;
- module version;
- SDK runtime version, protocol version, and runtime hash;
- world and battle IDs;
- round, turn index, and source token ID.

A module-owned world setting stores `started` before the SDK call and a terminal
receipt afterward. An interrupted `started` request is non-retryable. A terminal
request can be queried and replayed by its original request ID without invoking
the SDK again.

## Environment

- Repository branch: `codex/p1-write-safety`
- Implementation commits: `c177415`, `641b1a7`
- Foundry: `13.351`
- System: `dnd5e 5.3.3`
- World: `testclean`
- Battle: `QYtyT0tNYtnFmmR4`
- Browser page: `http://localhost:30001/game`
- Installed module: `D:\FVTT_DATA\Data\modules\arcane-webmcp-mvp`
- Built JavaScript SHA-256:
  `3FBFA4CA57DDA8EB48FEAF2F5286DC9C5D1E24018E68595DC9D03B919D28C0DB`
- SDK runtime: `0.1.0`, protocol `2`
- SDK runtime hash:
  `827e008b48d07962d587fd0e97d8292bc454c47437c79a6f1a82e9680ad3a8fb`

## Preflight result

The active turn was round `1`, index `0`, token `D2fVvfhkwL4JCA3D`
(`测试圣武士 Lv2`). `battleContext` exposed four callable actions. A request with
an intentionally stale bridge session failed with `BRIDGE_SESSION_MISMATCH`.
The execution ledger remained empty and a before/after `turnContext` comparison
was identical.

## Executed action

- Action: `Lay on Hands (Midi治疗)`
- Action ID: `a2_b38a86b52c0c218a`
- Source and target: `D2fVvfhkwL4JCA3D`
- Request ID: `turn-20260903-lay-on-hands`
- Advance: `false`
- SDK result: `{ "status": "completed" }`
- End-to-end WebMCP call: about `6.4s`
- Page execution receipt: started `04:15:22.960Z`, settled `04:15:23.516Z`

Concrete verification:

- Active actor HP changed from `10` to `11`.
- The action chat card reported healing `1` HP.
- Round stayed `1` and turn index stayed `0`.
- The receipt ledger contained one completed record with the exact world,
  battle, source, action, and target fingerprint.
- Repeating the exact request returned `replayed: true`; HP stayed `11` and the
  ledger count stayed `1`.
- No action-specific Foundry dialog opened. An unrelated Actor Studio welcome
  window was already present after reload and did not block execution.

## Cleanup

The generated Midi-QOL damage card's supported **Undo** control restored HP from
`11` to `10`. The Lay on Hands card's supported **Refund resource** control
restored the consumed resource; its controls returned to `Consume resource`
visible and `Refund resource` hidden. No token was created, no condition was
added, and the combat round/turn was not advanced.

The two generated chat messages and the completed module receipt remain in this
local test world as run evidence. No online Foundry state was accessed or
changed.

## Automated verification

`npm run check` passed 24 tests with zero failures and built module `0.4.0`.
The tests cover identity negotiation, world/turn/action/target preflight,
durable start/terminal receipts, idempotent replay, runtime interruption,
non-GM rejection, and the restricted input surface.

## Remaining production blocker

The architectural path is proven, including a real SDK-backed gameplay write.
The vendored SDK still distributes its in-page runtime as `runtimeFunction`
source, so this MVP compiles it with `Function()`. Production packaging should
first add a supported callable runtime export to the SDK and consume that export
here. The standalone MVP does not patch or modify the user's Arcane-Desk checkout.
