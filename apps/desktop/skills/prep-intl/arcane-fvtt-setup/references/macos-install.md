# macOS Install Flow

Referenced by "Install Foundry Core" in `../SKILL.md`; covers only the macOS desktop artifact (DMG). The shared interaction budget, runtime contract, artifact identification, content installation, acceptance, and safety baseline are all in `../SKILL.md`; the Windows flow is in `windows-install.md`.

## macOS DMG

The DMG is the official desktop application install path; do not push the user to switch to a ZIP.

1. Use a local DMG directly; record the SHA256 with Arcane Node.
2. Mount with `hdiutil attach -readonly -nobrowse` and locate `Foundry Virtual Tabletop.app`; check signature/Gatekeeper results with `codesign --verify --deep --strict` and `spctl --assess --type execute`.
3. Copy the App to the user-chosen `/Applications`, `~/Applications`, or another explicit target; if system authorization or a security confirmation pops up, hand it to the user. Unmount the image after copying.
4. Verify the version and entry point from `.app/Contents/Resources/app/package.json` and `main.js`. For interactive use, `open` the App; when the Agent operates a server, it can run the `main.js` inside it with Arcane Node.
5. After the copy completes and before the first `open` or headless launch, the quarantine attribute carried by the copy must be cleared: first tell the user you are clearing quarantine on this installed copy and why (one sentence of notice, not waiting for approval), then run `xattr -dr com.apple.quarantine "<App path>"`. If you skip this, native modules inside the package (`classic_level.node`, etc.) are blocked from loading for any process, headless launch will fail with `library load disallowed by system policy` / `ERR_DLOPEN_FAILED`, and the first GUI launch will be intercepted by a Gatekeeper dialog (clicking "Move to Trash" in that dialog deletes the freshly installed App). This is not a Node or macOS version issue. Do not re-sign, de-sign, or replace any file inside the App bundle, and do not run the bundled Electron with `ELECTRON_RUN_AS_NODE`.

Only clear quarantine on the App copy from this installation whose SHA256 has been recorded and whose `codesign` and `spctl` results have been checked; do not disable Gatekeeper, do not replace the user-provided App with an unsigned copy, and do not approve other untrusted software on the user's behalf.
