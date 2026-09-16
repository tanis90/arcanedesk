# Windows Install Flow

Referenced by "Install Foundry Core" in `../SKILL.md`; covers only Windows desktop artifacts (EXE / portable ZIP). The shared interaction budget, runtime contract, artifact identification, content installation, acceptance, and safety baseline are all in `../SKILL.md`; the macOS flow is in `macos-install.md`.

## Windows Portable Build ZIP

This is the no-install desktop distribution officially provided for Windows V13, suitable for the Agent to deploy fully automatically into any directory; do not misidentify it as a Node.js distribution.

1. First inspect the archive structure without extracting into the target directory. A Portable Build should contain `App/Foundry Virtual Tabletop.exe`, `App/resources/app/package.json`, and `App/resources/app/main.js`; a Node.js distribution uses its own `main.js` and `package.json` as entry points. If the structure does not match, stop — do not guess the type.
2. Compute and record the SHA256 with Arcane Node. Download only when the user provides a timed URL; download checks are the same as for the Node.js distribution.
3. Extract into a staging directory next to the target; reject absolute paths, `..` traversal, and links or archive entries that would escape staging. After verifying the Foundry version in `App/resources/app/package.json`, atomically move the complete portable root directory into the resolved Core directory.
4. When the target is non-empty, never merge-extract or silently overwrite. A valid same-version Portable Build is reused directly; otherwise make a timestamped backup of the existing directory before continuing — do not continue if the backup did not succeed, and write the backup location into the final report.
5. For normal desktop launching, use `App/Foundry Virtual Tabletop.exe`. For headless operations, the Agent uses `ARCANE_FVTT_NODE` to run `App/resources/app/main.js --dataPath=<dedicated data directory>`.
6. On first desktop launch, the official Portable Build creates `Config`, `Data`, and `Logs` in the portable root directory. Arcane still explicitly passes the dedicated data directory from the plan by default; only adopt these adjacent directories when the user explicitly asks for "fully portable, self-contained".

## Windows EXE

The EXE is the official desktop application install path; do not unpack it with Node or simulate an installer.

1. Check the signature status and publisher with PowerShell `Get-AuthenticodeSignature`, and record the SHA256 with Arcane Node. If the signature is invalid, missing, or the publisher is unexpected, stop and have the user confirm the source.
2. Silent installation may only use a parameter combination from the release manifest `core.windowsInstaller` that matches the current file's SHA256, byte count, and signature publisher exactly, and that combination must support both specifying the exact install directory and waiting for final exit. Do not guess switches like `/S`, `/quiet`, or `/D` based merely on the installer framework, the file name, or parameters commonly seen online. When no scheme matches, switch to a foreground install or suggest the Windows Portable Build.
3. When a known silent scheme exists and the target directory does not exist or is empty, the user's confirmation of the install plan authorizes the installation itself; it can then run silently without asking again for the same directory. For the NSIS installer registered in the manifest, launch it with PowerShell `Start-Process -Verb RunAs -Wait -PassThru`: the raw arguments are `/S /D=<exact Core directory>`; `/S` is case-sensitive, `/D=` must be the last item, and even if the path contains spaces the `/D` value must not be quoted. First verify the target is an absolute path containing no newlines or NUL; do not build the command through shell string concatenation. UAC and security software prompts must remain visible and be handled by the user; if the user cancels UAC, stop. Silent mode must not be used to bypass elevation, to accept the Foundry EULA on the user's behalf, or to fill in a license.
4. Foreground installation is the compatibility path: show the installer window and let the user handle the install options. When the user explicitly chose silent, do not fall back to foreground without reason; only explain why and fall back when parameters are unverified, the target conflicts, or the silent attempt failed.
5. Whatever exit code the silent process returns, re-probe the actual install location; success requires `resources/app/package.json`, `resources/app/main.js`, the version, and the entry point in the target all passing verification. Do not treat the installer parent process exiting early as a successful install.
6. For interactive use, launch the desktop EXE from the install result; when the Agent operates a server, it can run the `main.js` inside it with Arcane Node.

When launch fails, first report the actual process error, the signature result, and Windows event evidence. Without corresponding evidence, do not attribute the failure to Defender or other antivirus software.
