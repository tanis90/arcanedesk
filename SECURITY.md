# Security policy

Arcane Desk bridges an AI-assisted desktop application with a privileged
Foundry Virtual Tabletop session. Reports involving command execution, page
injection, credential storage, permission bypass, unsafe write retries, update
integrity, or exposure of world/player data are especially important.

## Supported versions

Before the first public release, security fixes target the `main` branch. Once
releases exist, the latest release line and `main` are supported; older release
lines receive fixes only when maintainers announce otherwise.

| Version | Supported |
| --- | --- |
| `main` / unreleased | Yes |
| Latest public release | Yes |
| Older releases | No by default |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature from the repository's
**Security** tab. Include:

- the affected component and version or commit;
- prerequisites and a minimal reproduction;
- expected and observed security boundaries;
- impact, including whether a write may have reached Foundry;
- logs or screenshots with all secrets and personal data removed; and
- any proposed mitigation, if known.

Do not open a public issue, discussion, or pull request for an undisclosed
vulnerability. Do not include API keys, Foundry license keys, session cookies,
private server addresses, world data, or commercial assets in a report. If
GitHub private vulnerability reporting is unavailable, contact a repository
maintainer privately to request a secure channel without disclosing the issue
details in public.

Maintainers aim to acknowledge a complete report within five business days and
will coordinate validation, remediation, credit, and disclosure. Complex or
third-party issues may take longer. Please allow a reasonable remediation
window before public disclosure.

## Safe research

Only test systems and data you own or are explicitly authorized to test. Use a
lawfully licensed Foundry installation. Do not access other users' worlds,
degrade shared services, retain personal data, or distribute Foundry software
or commercial content. Good-faith research that follows these rules will be
handled constructively, but this policy cannot authorize activity prohibited by
law or third-party terms.

## Operational security

The public repository and release artifacts must never contain production
credentials. Official signing, package publishing, hosting, and mirror
promotion are separate controlled operations. GitHub Actions in this repository
build candidate artifacts without embedding secret values or publishing them to
npm, GitHub Releases, or external hosts.

Community defaults must not embed private infrastructure or silently send data
to an Arcane-operated service. Download profiles and third-party cloud features
need explicit provenance, integrity checks, informed user consent, and a review
of the data and license boundary before they are enabled.
