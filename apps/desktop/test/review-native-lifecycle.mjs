// Interactive Windows acceptance. A reviewer must operate the real window/dialog.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)), "--native-review"],
  { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let passed = false;
child.stdout.on("data", chunk => { process.stdout.write(chunk); if (String(chunk).includes("PASS native review:")) passed = true; });
child.stderr.pipe(process.stderr);
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code === 0 && passed ? 0 : 1; });
