import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const scratch = process.argv.find(arg => arg.startsWith("--smoke-root="))?.slice("--smoke-root=".length) ?? mkdtempSync(path.join(tmpdir(), "arcane-sidebar-acceptance-"));
for (const phase of (process.argv.includes("--restart-only") ? ["sidebar-restart"] : ["sidebar-scenario", "sidebar-restart"])) {
  const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)), "--" + phase, "--smoke-root=" + scratch],
    { env, encoding: "utf8", windowsHide: true, timeout: 180000 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  if (result.error) console.error(result.error);
  const marker = phase === "sidebar-scenario" ? "PASS production sidebar:" : "PASS sidebar restart:";
  if (result.status !== 0 || !result.stdout?.includes(marker)) { process.exitCode = 1; break; }
}
