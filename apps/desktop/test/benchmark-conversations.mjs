import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv[2]) env.ARCANE_BENCHMARK_OUTPUT = path.resolve(process.argv[2]);
const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/conversation-benchmark.cjs", import.meta.url))],
  { env, stdio: "inherit", windowsHide: true, timeout: 120000 });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
