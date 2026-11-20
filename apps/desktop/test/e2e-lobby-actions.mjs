#!/usr/bin/env node
// Real tool + native CDP E2E harness for mt-compat lobby actions.
//
// Fixture mode (default; no cloud or login required):
//   node test/e2e-lobby-actions.mjs [--report=<path>] [--keep]
//   - starts Electron, serves a fixture lobby page, attaches CDP, and calls the
//     real createLobbyTools implementations: import_start/job, campaigns, packs,
//     delete, path fence, mirror staging cache and approval denial.
//   - asserts a disk-backed File was bound, the model never saw preparationId
//     or server paths, and Page.fileChooserOpened stayed zero.
//
// Real lobby mode (real Electron + the deployed mt-compat lobby on a local
// ArcaneVTT backend; the test account must be provided through the environment):
//   MT_ACCEPT_USER=<user> MT_ACCEPT_PASSWORD=<password> \
//   node test/e2e-lobby-actions.mjs \
//     --url=https://mtlocal.internal:30002/user-files/compat-fix-agent-runtime-integration/lobby.html \
//     --mutate --insecure-tls --compat-root=/path/to/mt-foundry-compat-worktree \
//     [--report=<path>] [--keep]
//   - credentials/tokens are read only from MT_ACCEPT_USER / MT_ACCEPT_PASSWORD;
//     they are never placed in argv and are scrubbed from the report.
//   - --insecure-tls is a harness-only Electron switch for the self-signed local
//     stack; it does not change production configuration.
//   - --mutate runs the full real contract: isolated REST campaign (ruleset 2024),
//     campaigns_list, module import through the native File channel, packs read,
//     campaign packs get/update with expectedRevision, stale + approval-denial
//     zero-write checks, pack delete preview/delete, play-page rejection and
//     foundry_lobby_return alreadyInLobby. Only objects created by the run are
//     deleted again.
//   - without --mutate only the three read tools run (campaigns/ packs/ rulesets)
//     against the real deployment.
//
// --compat-root points at a read-only mt-foundry-compat worktree whose
// tools/fixtures/make-t7-module-zip.mjs generates the import fixture. It is only
// imported, never modified.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(appRoot, "test", "fixtures", "lobby-e2e-app.mjs");

const args = process.argv.slice(2);
const option = name => {
  const prefix = `--${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const electron = option("electron") ?? require("electron");
if (typeof electron !== "string") {
  console.error("Electron binary not found; install dev dependencies or pass --electron=<path>.");
  process.exit(2);
}

const realUrl = option("url");
const keep = args.includes("--keep");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-e2e-"));
const report = option("report") ?? path.join(tempRoot, "report.json");
mkdirSync(path.dirname(path.resolve(report)), { recursive: true });
// Always isolate Electron's profile: real mode must not rely on (or pollute) any
// pre-existing signed-in user data directory.
const userDataDir = option("user-data-dir") ?? path.join(tempRoot, "user-data");
mkdirSync(userDataDir, { recursive: true });

const electronArgs = ["--no-sandbox", "--disable-gpu", fixture, `--report=${report}`, `--user-data-dir=${userDataDir}`];
for (const name of ["url", "source", "wait-auth-ms", "compat-root", "campaign-prefix"]) {
  const value = option(name);
  if (value !== undefined) electronArgs.push(`--${name}=${value}`);
}
if (args.includes("--insecure-tls")) electronArgs.push("--insecure-tls");
if (args.includes("--keep")) electronArgs.push("--keep");
if (args.includes("--mutate")) electronArgs.push("--mutate");

if (realUrl) {
  console.log("[lobby-e2e] real-lobby mode; credentials come from MT_ACCEPT_USER / MT_ACCEPT_PASSWORD env only");
}
console.log(`[lobby-e2e] electron ${electron}`);
console.log(`[lobby-e2e] report ${report}`);
const child = spawn(electron, electronArgs, { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" } });
const exitCode = await new Promise(resolve => child.on("exit", (code, signal) => resolve(code ?? (signal ? 2 : 1))));

let result = null;
try { result = JSON.parse(readFileSync(report, "utf8")); } catch (error) {
  console.error(`[lobby-e2e] report missing/unreadable: ${error.message}`);
}
if (result) {
  console.log(JSON.stringify({
    mode: result.mode,
    status: result.status,
    checks: result.checks,
    real: result.real,
    fileEvidence: result.fileEvidence,
    session: result.session,
    notCovered: result.notCovered,
    errors: result.errors,
  }, null, 2));
}
if (!keep) {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
if (exitCode !== 0 || result?.status !== "completed") {
  console.error(`[lobby-e2e] FAILED (exit ${exitCode}, status ${result?.status ?? "unknown"})`);
  process.exit(1);
}
console.log("[lobby-e2e] PASS");
