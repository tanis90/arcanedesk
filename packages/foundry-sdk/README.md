# `@arcanedesk/foundry-sdk`

Transport-neutral contracts, trusted in-page runtime, and a serialized client
for Arcane Desk's Foundry VTT integration.

```shell
npm install @arcanedesk/foundry-sdk
```

The SDK has no Electron, Chrome DevTools Protocol, or WebSocket runtime
dependency. Consumers supply a `FoundryTransport`; the SDK owns argument
serialization, `/game`/ready/GM preflight, action allowlisting, timeouts,
cancellation, serialized execution, and the `executeTurn` dispatch boundary.

```ts
import {
  FoundryRuntimeClient,
  type FoundryTransport,
} from "@arcanedesk/foundry-sdk";

const transport: FoundryTransport<MyPage> = {
  acquire: () => currentPage,
  isAvailable: page => !page.destroyed,
  inspect: (page, options) => inspectFoundry(page, options),
  evaluate: (page, expression, options) => evaluateSafely(page, expression, options),
};

const foundry = new FoundryRuntimeClient({ transport });
const world = await foundry.call("worldInfo", {});
```

The default allowlist contains only `worldInfo`, `battleContext`,
`turnContext`, and `executeTurn`. A CLI that intentionally exposes more of the
runtime must opt in with `allowedActions: ALL_DIRECT_ACTIONS` and apply its own
command-level authorization.

Those four safe actions have stable input/output TypeScript contracts in
`FoundryActionMap`. `ALL_DIRECT_ACTIONS` also enumerates the broader maintenance
runtime used by the CLI; actions outside the safe four currently use generic
arguments/results until their public contracts are promoted into the SDK.
`DIRECT_ACTION_EFFECTS`, `READ_DIRECT_ACTIONS`, and `WRITE_DIRECT_ACTIONS`
provide an exhaustive conservative read/write classification for all actions.

The exact runtime and integrity metadata are available from the stable subpath:

```ts
import {
  runtimeFunction,
  runtimeHash,
  protocolVersion,
} from "@arcanedesk/foundry-sdk/runtime";
```

Pure helpers that adapters or tests need outside the injected closure are
available from `@arcanedesk/foundry-sdk/runtime-helpers`. The SDK test suite
requires their compiled function bodies to remain exactly equal to the copies
inside `runtimeFunction`.

`runtimeFunction` is a frozen v0.1.0 baseline kept byte-identical to the
previously validated runtime, so the helpers above exist in two synchronized
copies enforced by that drift gate. The intended end state is a single source
of truth: build the injected runtime string from the `runtime-helpers` sources
at compile time and update `runtimeHash` in the same change, then retire the
drift gate. New runtime behavior should be written in a way that moves toward
that structure instead of extending the duplicated copies.

If any write action is interrupted after evaluation begins, the client never
reports a retryable failure. `executeTurn` retains its typed `indeterminate`
receipt; other writes reject with `FOUNDRY_SDK_RUNTIME_INTERRUPTED` and
machine-readable `status: "indeterminate"` / `retry: false` details. Callers
must inspect live state before any further action.

This is an unofficial integration and does not include Foundry Virtual
Tabletop, a license key, or game content. Consumers must provide a lawfully
licensed Foundry installation. The package is licensed under Apache-2.0; see
the included `LICENSE` and `NOTICE` files.
