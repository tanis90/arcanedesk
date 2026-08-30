## Summary

Describe the user-visible change and why it belongs in this component.

## Verification

List the commands, fixtures, and environments used to verify the change.

## Security and compatibility

Describe changes to SDK contracts, permissions, Foundry writes, uncertain-result
handling, supported versions, or stored/transmitted data. Write “None” when they
do not apply.

## Checklist

- [ ] I ran `npm run verify` from a clean, lockfile-based workspace install.
- [ ] Shared contracts and runtime behavior live in the SDK, not a duplicated
      CLI or Desktop implementation.
- [ ] Tests and public documentation cover the change.
- [ ] Dependency changes are reflected in `package-lock.json` and
      `THIRD_PARTY_NOTICES.md`.
- [ ] No credentials, private endpoints, user data, Foundry license keys,
      Foundry binaries, private worlds, or commercial assets are included.
- [ ] Foundry compatibility wording is factual and does not imply endorsement.
- [ ] All commits include a DCO sign-off (`Signed-off-by:`).
