# `@arcanedesk/fvtt-cli`

`arcane-fvtt` is the open-source Chrome DevTools Protocol adapter for the Arcane Desk Foundry SDK. It connects to a Foundry Virtual Tabletop browser page that the user already opened and authenticated, then exposes explicit, JSON-oriented commands backed by `@arcanedesk/foundry-sdk`.

This is an unofficial integration and is not affiliated with or endorsed by Foundry Gaming LLC. The package does not include Foundry Virtual Tabletop, a license key, game content, or a browser profile. Users must provide and activate their own licensed Foundry installation.

## Dependency direction

```text
arcane-fvtt CLI
  -> CDP transport
  -> @arcanedesk/foundry-sdk contracts and in-page runtime
  -> an already open Foundry browser page
```

The CLI owns CDP connection, target selection, command parsing, and JSON output. The SDK is the sole source of the injected runtime and its protocol contracts.

## Install

```bash
npm install --global @arcanedesk/fvtt-cli
arcane-fvtt --help
```

This is intentionally a command-line-only package and has no supported
JavaScript library entry point. Programmatic integrations should use
`@arcanedesk/foundry-sdk` and supply their own transport.

For repository development:

```bash
npm install
npm run build --workspace @arcanedesk/fvtt-cli
node packages/fvtt-cli/dist/cli.js --help
```

## Connect to a browser

Start Chrome or another Chromium-based browser with a dedicated profile and a loopback-only debugging port:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9230
```

Then open and sign in to the Foundry page directly in that browser. Credentials are entered in Foundry, not passed to ordinary CLI commands.

```bash
arcane-fvtt --port 9230 tabs
arcane-fvtt --port 9230 --target-url http://127.0.0.1:30000 doctor
arcane-fvtt --port 9230 --target-url http://127.0.0.1:30000 world-info
arcane-fvtt --port 9230 --target-url http://127.0.0.1:30000 combat-snapshot
```

`--target-url` accepts an absolute Foundry origin (for example,
`http://127.0.0.1:30000`) or one complete tab URL. Origin matching compares the
parsed origin exactly; complete-URL matching compares the entire normalized URL.
It never performs substring matching. If more than one `/game` tab still matches,
the CLI fails closed instead of choosing the first tab. Run `tabs` and pass the
chosen tab's exact CDP id with `--target-id <id>` to disambiguate identical URLs.
When both selectors are present, both must match. The equivalent environment
variables are `ARCANE_FVTT_TARGET_URL` and `ARCANE_FVTT_TARGET_ID`.

## JSON input

Commands with `--json` accept a JSON literal, `@file.json`, or `@-` for stdin. Prefer stdin for dynamic values so the shell cannot rewrite quotes:

```bash
arcane-fvtt --port 9230 execute-turn --json @turn.json
```

PowerShell treats an unquoted `@` specially, so quote file inputs there:

```powershell
arcane-fvtt --port 9230 execute-turn --json '@turn.json'
```

## Command groups

Connection and diagnostics:

```text
tabs
login
doctor
wait-ready
page-reload
screenshot
bring-front
```

Read-oriented operations include world, scene, actor, token, item, activity, combat, catalog, and turn-context inspection. Explicit write operations include token state changes, action execution, combat advancement, asset upload, and actor maintenance. Run `arcane-fvtt --help` and `arcane-fvtt <command> --help` for the authoritative list.

## Security model

- Normal commands call a fixed SDK action allowlist; they do not accept runtime JavaScript.
- `debug-eval` is a maintainer escape hatch and remains disabled unless `ARCANE_FVTT_DEBUG_EVAL=1` is set explicitly.
- Password-bearing login requires an exact expected origin. Use `ARCANE_FVTT_PASSWORD` or `--password-file`; there is intentionally no plaintext `--password` flag.
- Write operations are non-idempotent after dispatch. An interrupted generic write fails with `FOUNDRY_SDK_RUNTIME_INTERRUPTED` and machine-readable `status: "indeterminate"` / `retry: false` details; `execute-turn` returns the equivalent typed receipt. Reconcile from fresh state rather than blindly retrying.
- Do not expose the CLI debugging escape hatch directly to an autonomous agent.

## Development

```bash
npm run typecheck --workspace @arcanedesk/fvtt-cli
npm test --workspace @arcanedesk/fvtt-cli
npm run build --workspace @arcanedesk/fvtt-cli
```

Real Foundry integration tests require a user-provided licensed installation and are not part of the default public CI. Unit and contract tests use controlled fixtures and mocked page state.

## License

Apache-2.0. See the repository root `LICENSE` and `NOTICE` files.
