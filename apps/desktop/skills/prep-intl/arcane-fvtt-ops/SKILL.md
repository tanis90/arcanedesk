---
name: arcane-fvtt-ops
description: Operate the local Foundry VTT (FVTT) server. Use when the user asks to start/stop/restart local Foundry, view FVTT logs, troubleshoot port 30000 conflicts, switch or enter a world, handle options.json.lock lock files, or asks "is Foundry running / can I connect". For fresh installs, upgrades, machine migration, or world backups use arcane-fvtt-setup instead; this skill only covers starting, stopping, and troubleshooting an existing instance.
---

# Arcane FVTT local operations

**Probe first, assume nothing.** Every machine has different install locations, data directories, and world lists. Use the current platform shell to check Arcane Node, the Foundry installation in user-specified or common locations, port 30000, and the data directory; never recursively scan whole disks. Probe results are valid for this session only — re-probe after changing machines or reinstalling.

The App installs and verifies the bundled FVTT Ops Node before the Agent session starts. In the current session, `ARCANE_FVTT_NODE` is its absolute path, and Node's directory is first on the session `PATH`, so plain `node`/`npm` resolve to the same version; this does not modify the user or system PATH. To diagnose, check:

Windows PowerShell:

```powershell
$env:ARCANE_FVTT_NODE
& $env:ARCANE_FVTT_NODE --version
(Get-Command node -ErrorAction Stop).Source
```

macOS / Linux Bash:

```bash
printf '%s\n' "$ARCANE_FVTT_NODE"
"$ARCANE_FVTT_NODE" --version
command -v node
```

Never switch to a system Node, nvm, or a self-installed Node. When actually starting Foundry, use the absolute path of `ARCANE_FVTT_NODE` — don't rely on command-name resolution. If the environment variable is missing, the path doesn't exist, or the version isn't the one the App release manifest requires, stop and suggest restarting or updating Arcane Desk; do not repair Node yourself.

## Probing (do this first, get everything at once)

macOS / Linux Bash:

```bash
# Is the server up: 200/302 = up
curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:30000; echo

# PID of the process on 30000 (kill only this PID when stopping — never mass-kill node; the MCP bridge and this app are node too)
lsof -iTCP:30000 -sTCP:LISTEN

# Default data directory and existing worlds
ls -d ~/Library/Application\ Support/FoundryVTT 2>/dev/null
ls "<data-dir>/Data/worlds"
```

Windows PowerShell:

```powershell
# Is the server up: 200/302 = up
try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:30000).StatusCode } catch { "unreachable" }

# PID of the process on 30000; only ever touch OwningProcess — never mass-kill node
Get-NetTCPConnection -LocalPort 30000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess

# Default data directory and existing worlds
$arcaneDataDir = Join-Path $env:LOCALAPPDATA "FoundryVTT"
Test-Path -LiteralPath $arcaneDataDir
Get-ChildItem -LiteralPath (Join-Path $arcaneDataDir "Data\worlds") -Directory -ErrorAction SilentlyContinue |
  Select-Object Name, FullName
```

The default address is `http://127.0.0.1:30000`. The key subdirectories under the data directory are `Config` (`options.json`), `Data/modules`, `Data/worlds`, and `Logs`.

The headless entry point is `resources/app/main.js` in an actual installation, or `main.js` in a Node distribution package. Check the exact install location the user gives first, then platform-common locations and parent directories the user explicitly mentioned; verify the Foundry version from the neighboring `package.json`. Take the Node path from `ARCANE_FVTT_NODE`; never reverse-engineer the App install directory from the skill's location.

## Starting

**Start headless by default** — bring up the server only, for use with Arcane Desk's right-side panel; no separate window. Before starting, you must already have the real Node, `main.js`, data directory, and world id from probing.

macOS / Linux Bash:

```bash
rm -f "<data-dir>/Config/options.json.lock"
cd "<main.js directory>" && nohup "<Node-absolute-path>" main.js --dataPath="<data-dir>" --world=<world-id> > /tmp/fvtt.log 2>&1 &
```

Windows PowerShell:

```powershell
$arcaneNode = $env:ARCANE_FVTT_NODE
$arcaneMain = "<main.js absolute path>"
$arcaneDataDir = "<data-dir>"
$arcaneWorld = "<world-id>"
$arcaneLogOut = Join-Path $env:TEMP "arcane-fvtt.out.log"
$arcaneLogErr = Join-Path $env:TEMP "arcane-fvtt.err.log"
$arcaneArgs = @(
  ('"{0}"' -f $arcaneMain)
  ('--dataPath="{0}"' -f $arcaneDataDir)
  ('--world="{0}"' -f $arcaneWorld)
)

Remove-Item -LiteralPath (Join-Path $arcaneDataDir "Config\options.json.lock") -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $arcaneNode `
  -ArgumentList $arcaneArgs `
  -WorkingDirectory (Split-Path -Parent $arcaneMain) `
  -RedirectStandardOutput $arcaneLogOut `
  -RedirectStandardError $arcaneLogErr `
  -WindowStyle Hidden `
  -PassThru | Select-Object Id, Path
```

- `--world` is optional: without it the server stops at the Setup page; with it, the world loads directly after startup.
- After a first launch or a world switch, wait 25-30 seconds (migration + world load) before checking HTTP and the port.
- A DMG-installed GUI copy can also run headless: `main.js` is at `.app/Contents/Resources/app/main.js`; run it with `ARCANE_FVTT_NODE`. If a quarantine-related native-module error appears (copies installed via the setup flow had quarantine cleared before first launch, so this error can only appear on pre-existing copies that never went through setup), verify the signature and confirm the exact App path first; only with the user's explicit authorization, clear quarantine at that spot per the setup skill's macOS flow. Never re-sign/un-sign files inside the bundle, and never use `ELECTRON_RUN_AS_NODE`.
- When `ARCANE_FVTT_NODE` is unavailable, do not fall back to a system Node. For ad-hoc interactive use you may `open "/Applications/Foundry Virtual Tabletop.app"`, but report the Arcane runtime anomaly at the same time.
- Never execute the binary inside a `.app` directly for a version check. Electron would launch the whole app in the foreground and may crash with EPIPE once the stdout pipe closes; read `Contents/Resources/app/package.json` for version checks instead.

## Stopping / restarting

macOS / Linux Bash:

```bash
# Stop gracefully once you have the PID — no -9
kill <PID>
```

Windows PowerShell:

```powershell
# Verify the PID with Get-NetTCPConnection first
taskkill.exe /PID <PID> /T
# Force only if the process won't exit
taskkill.exe /PID <PID> /T /F
```

Restart = stop → confirm the port is released → clear the lock → start.

## Reading logs

macOS / Linux Bash:

```bash
ls -t "<data-dir>/Logs"/debug*.log | head -1 | xargs tail -80
ls -t "<data-dir>/Logs"/error*.log | head -1 | xargs tail -80
```

Windows PowerShell:

```powershell
$arcaneLogs = Join-Path "<data-dir>" "Logs"
Get-ChildItem -LiteralPath $arcaneLogs -Filter "debug*.log" -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Tail 80
Get-ChildItem -LiteralPath $arcaneLogs -Filter "error*.log" -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Tail 80
```

The signature line of a healthy startup is `Server started and listening on port 30000`.

## Visual page diagnostics

Probe port, HTTP, and logs first; only when that evidence can't explain what the user sees on the page, call `foundry_open` to open or reuse the right-side Foundry panel, then call `foundry_screenshot` once to view the currently visible viewport. Good for confirming:

- Setup, Join, License, migration, Critical Failure pages, or loading overlays that won't go away;
- dialogs, character sheets, target pickers, or template-placement UIs blocking an operation;
- visual anomalies like black screen, missing textures, unrendered Canvas, token positions, walls/lighting;
- whether a page shows the expected visible change after an ops change or a reload.

Screenshots provide visual evidence only. Precise URLs, `game.ready`, world ids, Document contents, and logs still come from `foundry_open`, `browser_evaluate`, or shell read-back; never guess hidden state or exact values from pixels. Don't poll screenshots, and don't call one mechanically after every step; usually one shot of the problem scene and one after the fix are enough.

When the current model doesn't support images, don't call screenshots repeatedly — diagnose via page state, DOM, and logs instead. Never take a screenshot while the user is entering a password or other credentials, and never use the screenshot tool to request, read, or relay credentials.

## Discipline

- Treat local data as user data; back up before overwriting or deleting, and never print licenses or the full `options.json` in chat.
- Before any side-effecting operation (stopping the service, clearing locks, changing config), state in one sentence what you're about to do.
- Only terminate the Foundry PID confirmed to be listening on 30000 — never mass-terminate Node, Electron, or PowerShell processes.
