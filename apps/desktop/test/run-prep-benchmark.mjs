// Stable launcher. Electron is required for the real ProviderStore/safeStorage.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(`Usage: npm run benchmark:prep -- --qa-root=<private profile> --qa-report=<QA fixture report> [--samples=10]
Requires a logged-in target world, built SDK and an encrypted provider in the private profile.
For local COS (30000/9230), pass --target=local-cos; character tasks also use --character-suite --comparison=build-query --cases=A1,A2,A3,B1,B2,B3.
Character benchmark guide: apps/desktop/docs/prep-character-benchmark-manual.md.
Set ARCANE_QA_ELECTRON to an Electron executable if it is not installed locally.
Reports are written beneath qa-root. See apps/desktop/docs/prep-benchmark.md.`);
} else {
  if (!args.some(a => a.startsWith("--qa-root=")) || !args.some(a => a.startsWith("--qa-report="))) throw Error("--qa-root and --qa-report are required; use --help");
  const require = createRequire(import.meta.url);
  const electron = process.env.ARCANE_QA_ELECTRON || require("electron");
  const env = { ...process.env, ARCANE_QA_NODE: process.env.ARCANE_QA_NODE || process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/prep-play-model-benchmark.cjs", import.meta.url)), "--prep-benchmark=true", ...args], { env, stdio: "inherit", windowsHide: true });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
}
