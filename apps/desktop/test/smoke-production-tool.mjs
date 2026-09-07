import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
if (process.platform !== "win32") throw new Error("This native PowerShell scenario requires Windows");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)), "--long-tool"],
  { env, encoding: "utf8", windowsHide: true, timeout: 120000 });
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 && result.stdout?.includes("PASS production long tool:") ? 0 : 1;
