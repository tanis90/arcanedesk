# Arcane Desk — Foundry VTT MCP, WebMCP, SDK, CLI and Desktop

Arcane Desk is an open-source, agent-native desktop companion and developer
toolkit for lawfully licensed Foundry Virtual Tabletop installations. It
includes an **FVTT MCP / Foundry VTT MCP integration for Codex**: the Arcane
WebMCP module registers tools directly in Foundry's authenticated `/game` page,
where Codex can discover and invoke them through its **built-in browser**.

If you are looking for **Foundry MCP**, **FVTT MCP**, or **Foundry VTT WebMCP**,
see [`@arcanedesk/foundry-webmcp`](foundry-modules/arcane-webmcp/README.md). Unlike a
separate Chrome automation bridge, it runs inside the visible Foundry page, so
the Agent and user operate the same browser view and signed-in session.

This repository is an SDK-first npm workspace:

```text
@arcanedesk/foundry-sdk
├── @arcanedesk/fvtt-cli   (Chrome DevTools Protocol transport)
├── @arcanedesk/foundry-webmcp (Codex built-in browser / WebMCP transport)
└── arcane-desktop             (Electron WebContents transport)
```

The SDK owns the typed safe-action contracts, complete action registry, exact
in-page runtime, runtime client, and failure semantics. The CLI, WebMCP module,
and Desktop own only their transports and product-specific policy. This keeps
one protocol implementation shared by all consumers.

## Packages

- [`@arcanedesk/foundry-sdk`](packages/foundry-sdk/README.md) — a
  transport-neutral TypeScript SDK with no runtime dependencies.
- [`@arcanedesk/fvtt-cli`](packages/fvtt-cli/README.md) — a typed direct-CDP
  command-line adapter for automation, diagnostics, and authorized QA.
- [`@arcanedesk/foundry-webmcp`](foundry-modules/arcane-webmcp/README.md) — a Foundry VTT
  module that exposes guarded Arcane SDK tools to Codex in the built-in browser.
- [`arcane-desktop`](apps/desktop/README.md) — the Electron application for
  Windows and macOS.

The project is pre-release. Public APIs and package names may change before
`1.0.0`.

## Requirements

- Node.js 24
- npm 11
- a Foundry VTT installation and content you are legally entitled to use
- Codex with built-in-browser WebMCP Site tool support for the WebMCP module
- Windows or macOS when building the Desktop application

Foundry VTT itself, license keys, commercial content, private worlds, and
hosted mirrors are not included in this repository or its release artifacts.

## Get started

From the repository root:

```shell
npm ci
npm run verify
```

The verification gate scans the repository boundary, type-checks and tests all
workspaces, builds the SDK, CLI, and Foundry WebMCP module, and performs dry-run
npm package checks.

Common focused commands:

```shell
npm test --workspace @arcanedesk/foundry-sdk
npm test --workspace @arcanedesk/fvtt-cli
npm run check --workspace @arcanedesk/foundry-webmcp
npm test --workspace arcane-desktop
npm run dist:dir --workspace arcane-desktop
```

The Desktop candidate build downloads the pinned official Node.js runtime used
to operate a user-provided Foundry installation. Optional third-party systems
are never installed without an explicit user choice; the checked-in community
profile has no default modules or worlds.

## Security model

Foundry sessions can contain privileged game and player data. Treat every
runtime write as a real side effect:

- the SDK defaults to a narrow safe action allowlist;
- the CLI exposes broader operations for explicitly authorized automation and
  QA;
- the WebMCP module binds writes to the current page, world, battle, turn, and
  durable request ID instead of exposing a generic raw SDK call;
- Desktop retains its own IPC, permission, and tool allowlists; and
- Desktop API keys are protected with the operating system's Electron
  `safeStorage` facility and are masked before reaching the renderer.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Project policies

See [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The repository migration and
its reproducible acceptance evidence are tracked in
[MIGRATION_PLAN.md](MIGRATION_PLAN.md).

## License and trademarks

Code is licensed under the [Apache License 2.0](LICENSE). The Arcane Desk name,
logo, and official product branding are not granted by that license; see
[TRADEMARKS.md](TRADEMARKS.md).

Arcane Desk is an independent, unofficial integration. It is not affiliated
with, endorsed by, or sponsored by Foundry Gaming LLC. Foundry Virtual Tabletop
and related marks belong to their respective owners.
