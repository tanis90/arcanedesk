#!/usr/bin/env node
// Launcher for the real Electron/CDP play -> lobby -> play acceptance (plan B).
//
//   node test/e2e-lobby-return.mjs [--electron=<path>] [--compat-root=<repo>]
//     [--rounds=3] [--keep]
//
// The Electron fixture starts a local HTTP origin, loads the mt-foundry-compat
// working tree's real agent-runtime.js/play-exit.mjs, then drives the real
// DirectFoundryRuntime + MtLobbyClient + createLobbyTools. It writes a bounded
// JSON report to a temp directory; this launcher prints the result, removes the
// temp directory (use --keep to retain the report), and exits non-zero on failure.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(appRoot, "test", "fixtures", "lobby-return-e2e-app.mjs");

const args = process.argv.slice(2);
function option(name) {
  const prefix = `--${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const electron = option("electron") ?? require("electron");
if (typeof electron !== "string") {
  console.error("Electron binary not found; install dev dependencies or pass --electron=<path>.");
  process.exit(2);
}

const keep = args.includes("--keep");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-return-e2e-"));
const report = path.join(tempRoot, "report.json");
const userData = path.join(tempRoot, "user-data");
mkdirSync(userData, { recursive: true });
const electronArgs = [
  "--no-sandbox",
  "--disable-gpu",
  fixture,
  `--report=${report}`,
  `--user-data-dir=${userData}`,
  `--rounds=${option("rounds") ?? "3"}`,
  `--watchdog-ms=${option("watchdog-ms") ?? "600000"}`,
];
const compatRoot = option("compat-root") ?? process.env.MT_FOUNDRY_COMPAT_ROOT
  ?? path.resolve(appRoot, "../../../mt-foundry-compat");
electronArgs.push(`--compat-root=${compatRoot}`);

console.log(`[lobby-return-e2e] electron ${electron}`);
console.log(`[lobby-return-e2e] report ${report}`);

const child = spawn(electron, electronArgs, {
  stdio: "inherit",
  cwd: appRoot,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING ?? "0" },
});
const timeout = setTimeout(() => {
  console.error("[lobby-return-e2e] timeout; terminating Electron");
  child.kill("SIGTERM");
}, 720_000);
const code = await new Promise(resolve => child.on("exit", (exitCode, signal) => {
  resolve(exitCode ?? (signal ? 2 : 1));
}));
clearTimeout(timeout);

let result = null;
try {
  result = JSON.parse(readFileSync(report, "utf8"));
} catch (error) {
  console.error(`[lobby-return-e2e] report missing/unreadable: ${error.message}`);
}

if (result) {
  console.log(JSON.stringify({
    status: result.status,
    mode: result.mode,
    checks: result.checks,
    failures: result.failures,
    coverage: result.coverage,
    notCovered: result.notCovered,
    compat: result.compat,
    rounds: (result.rounds ?? []).map(item => ({
      round: item.round,
      status: item.status,
      returnMs: item.timings?.returnMs,
      receipt: item.evidence?.receipt,
      lobbyServiceDelayMs: item.evidence?.lobby
        ? item.evidence.lobby.serviceInstalledAt - item.evidence.lobby.loadedAt
        : null,
      teardownEntries: item.evidence?.teardownLog?.length ?? null,
      listenersOnLobby: item.evidence?.lobby?.listeners ?? null,
      listenersAfterReturn: item.evidence?.afterPlay?.listeners ?? null,
      worldWrites: item.evidence?.afterPlay?.worldWrites ?? null,
    })),
    cdpNavigationCount: result.cdpNavigations?.length ?? 0,
    runtimeCalls: result.runtimeCalls,
    console: result.console,
    errors: result.errors,
  }, null, 2));
  if (keep) console.log(`[lobby-return-e2e] kept report ${report}`);
}

if (code !== 0 || result?.status !== "completed") {
  if (!keep) console.error("[lobby-return-e2e] FAILED (report removed; rerun with --keep to retain it)");
  else console.error(`[lobby-return-e2e] FAILED (report kept at ${report})`);
  cleanup();
  process.exit(1);
}

console.log(`[lobby-return-e2e] PASS (${result.rounds?.length ?? 0} round-trips)`);
cleanup();

function cleanup() {
  if (keep) return;
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
