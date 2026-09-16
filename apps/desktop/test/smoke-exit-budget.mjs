import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const scenario of ["timeout", "tray-failure", "stop-failure", "unload"]) {
  const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)), `--quit-probe=${scenario}`],
    { env, encoding: "utf8", windowsHide: true, timeout: 60000 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  if (result.error) console.error(result.error);
  if (result.status !== 0 || !result.stdout?.includes(`PASS exit ${scenario}:`)) { process.exitCode = 1; break; }
}
