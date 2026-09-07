import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const scratch = mkdtempSync(path.join(tmpdir(), "arcane-crash-smoke-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
async function run(phase) {
  const child = spawn(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)),
    `--crash-phase=${phase}`, `--smoke-root=${scratch}`], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", killed = false, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120000);
  child.stdout.on("data", data => {
    const text = data.toString(); output += text; process.stdout.write(text);
    if (phase === "seed" && !killed && output.includes("READY FOR FORCED TERMINATION")) {
      killed = child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", data => process.stderr.write(data));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(timedOut, false, `${phase} timed out`);
  if (phase === "seed") assert.ok(killed, "runner must force-terminate its own live fixture process");
  else { assert.equal(code, 0); assert.ok(output.includes("PASS crash recovery:")); }
}
await run("seed");
await run("recover");
