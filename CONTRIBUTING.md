# Contributing to Arcane Desk

Thank you for helping improve Arcane Desk. This repository is organized around
the Foundry SDK: the CLI and Desktop application consume the SDK and must not
maintain divergent copies of its contracts or in-page runtime.

## Project layout

- `packages/foundry-sdk`: transport-independent contracts, client behavior,
  and the in-page Foundry runtime.
- `packages/fvtt-cli`: CLI and Chrome DevTools Protocol transport.
- `apps/desktop`: Electron transport, application policy, and user interface.

Changes to a shared action, receipt, error, or runtime behavior belong in the
SDK first. Product-specific permissions and UI behavior stay in the relevant
consumer.

## Development setup

Install Node.js 24 and the npm version declared in the root `package.json`.
From a clean checkout, install the entire workspace exactly from the lockfile:

```shell
npm ci --workspaces --include-workspace-root
```

Run the repository gates before opening a pull request:

```shell
npm run typecheck
npm test
npm run build
npm run verify
```

Use workspace commands when iterating on one component, for example:

```shell
npm test --workspace packages/foundry-sdk
npm run build --workspace packages/fvtt-cli
```

Do not edit generated runtime bundles directly. Change their TypeScript source
in the SDK and regenerate through the workspace build.

## Pull requests

1. Open an issue first for broad protocol changes, new privileged actions, or
   architectural changes.
2. Keep changes focused and explain observable behavior and compatibility
   impact.
3. Add or update tests. Protocol changes need contract tests; write actions
   also need failure and indeterminate-result coverage.
4. Update public documentation, schemas, and third-party notices when affected.
5. Confirm that no credentials, private endpoints, commercial assets, customer
   data, local worlds, or Foundry software were added.
6. Sign off every commit with `git commit -s` to certify the Developer
   Certificate of Origin below.

The project uses review and CI rather than accepting generated build output as
evidence by itself. Maintainers may ask for a smaller change or additional
tests when a patch crosses SDK, CLI, and Desktop security boundaries.

## Developer Certificate of Origin

By signing off a contribution, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you
created the contribution or have the right to submit it under this project's
license, and you understand the contribution and sign-off are public records.
Use your real or established project identity in the sign-off.

## Foundry integration and test data

This is an independent, unofficial Foundry Virtual Tabletop integration. It is
not affiliated with or endorsed by Foundry Gaming LLC.

- Do not commit, upload, mirror, or attach the Foundry application, license
  keys, commercial game content, private worlds, or copyrighted package data.
- Contributors running integration tests must supply their own lawfully
  licensed Foundry installation.
- Public CI and repository fixtures must use mocks or original, freely
  redistributable test data.
- Screenshots and bug reports must remove license keys, player information,
  access URLs, API keys, and non-redistributable content.
- Compatibility statements must be factual and must not imply sponsorship or
  certification by Foundry Gaming LLC.

## Security and privacy

Never report a vulnerability or leaked credential in a public issue. Follow
[SECURITY.md](SECURITY.md). New runtime capabilities must use structured input,
least privilege, explicit write boundaries, and safe handling of uncertain
write results. Arbitrary page evaluation must not be exposed to an agent as a
general-purpose tool.

## Network and distribution boundaries

Community builds must be useful without silently contacting an Arcane-operated
relay, mirror, telemetry service, or update channel. Any such integration must
be separately configured, documented, and explicitly enabled by the user.

- Every downloadable artifact needs an identified upstream, reviewable license
  or redistribution basis, expected version, cryptographic digest, and bounded
  install destination.
- Do not add commercial software, hosted worlds, translated content, or package
  mirrors to a default profile without documented distribution rights.
- Do not pipe a newly downloaded script directly into a shell. Download to a
  temporary file, verify its origin and integrity, and make the execution
  visible to the user.
- Before sending a user's document, world data, image, audio, or other content
  to a third-party cloud service, identify the service and obtain explicit
  consent for that transfer.
- Large optional downloads require an accurate size warning and an affirmative
  choice; they must not be silently included because a profile marks them as a
  default.

## Licensing and trademarks

Unless explicitly stated otherwise, contributions are accepted under the
[Apache License 2.0](LICENSE). The license does not grant rights to project or
third-party trademarks. See [TRADEMARKS.md](TRADEMARKS.md).

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
