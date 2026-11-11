#!/usr/bin/env node
// Real tool + native CDP E2E harness for mt-compat lobby actions.
//
// Fixture mode (default; no cloud or login required):
//   node test/e2e-lobby-actions.mjs
//   - starts Electron, serves a fixture lobby page, attaches CDP, and calls the
//     real createLobbyTools implementations: import_start/job, campaigns, packs,
//     delete, path fence, mirror staging cache and approval denial.
//   - asserts a disk-backed File was bound, the model never saw preparationId
//     or server paths, and Page.fileChooserOpened stayed zero.
//
// Real lobby mode (requires an already signed-in Electron user data dir):
//   node test/e2e-lobby-actions.mjs --url=https://arcanemap.com/user-files/compat/lobby.html \
//     --source=D:\prep\world.zip [--wait-auth-ms=180000] [--user-data-dir=<dir>]
//   The fixture window uses that session; if Keycloak login is still pending it
//   exits with status needs-login and writes the report for inspection.
//
// Options: --report=<path> (default temp), --keep (keep temp source dirs),
//          --electron=<path> to override the Electron binary, and --mutate to run
//          the write path against a real lobby (dedicated test account only).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const report = option("report") ?? path.join(mkdtempSync(path.join(os.tmpdir(), "arcane-lobby-e2e-report-")), "report.json");
const electronArgs = ["--no-sandbox", "--disable-gpu", fixture, `--report=${report}`];
for (const name of ["url", "source", "wait-auth-ms", "user-data-dir"]) {
  const value = option(name);
  if (value !== undefined) electronArgs.push(`--${name}=${value}`);
}
if (args.includes("--keep")) electronArgs.push("--keep");
if (args.includes("--mutate")) electronArgs.push("--mutate");

console.log(`[lobby-e2e] electron ${electron}`);
console.log(`[lobby-e2e] report ${report}`);
const child = spawn(electron, electronArgs, { stdio: "inherit", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" } });
const code = await new Promise(resolve => child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 2 : 1))));

let result = null;
try { result = JSON.parse(readFileSync(report, "utf8")); } catch (error) {
  console.error(`[lobby-e2e] report missing/unreadable: ${error.message}`);
}
if (result) {
  console.log(JSON.stringify({ status: result.status, checks: result.checks, fileEvidence: result.fileEvidence, errors: result.errors }, null, 2));
}
if (code !== 0 || result?.status !== "completed") {
  console.error(`[lobby-e2e] FAILED (exit ${code}, status ${result?.status ?? "unknown"})`);
  process.exit(1);
}
console.log("[lobby-e2e] PASS");
