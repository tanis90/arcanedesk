import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/history-smoke.cjs", import.meta.url))],
  { env, stdio: "inherit", windowsHide: true, timeout: 60000 });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
