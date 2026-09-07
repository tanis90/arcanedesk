import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/conversation-smoke.cjs", import.meta.url)), "--layout-review"],
  { env, encoding: "utf8", windowsHide: true, timeout: 60000 });
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 && result.stdout?.includes("PASS layout:") ? 0 : 1;
