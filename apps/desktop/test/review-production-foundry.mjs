// Requires the isolated test001 clone served at loopback port 30219 and a user GM login.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)), "--foundry-scenario"],
  { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let passed = false;
child.stdout.on("data", chunk => { process.stdout.write(chunk); if (String(chunk).includes("PASS production Foundry:")) passed = true; });
child.stderr.pipe(process.stderr);
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code === 0 && passed ? 0 : 1; });
