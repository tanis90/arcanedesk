import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require=createRequire(import.meta.url);
if(!process.argv[2] || !process.argv[3])throw Error("Usage: node smoke-real-model.mjs <configured-userData> <report.json>");
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require("electron"),[fileURLToPath(new URL("./fixtures/real-model-smoke.cjs",import.meta.url)),`--profile=${path.resolve(process.argv[2])}`,`--report=${path.resolve(process.argv[3])}`],
 {env,encoding:"utf8",windowsHide:true,timeout:240000});
process.stdout.write(result.stdout??"");process.stderr.write(result.stderr??"");
if(result.error)console.error(result.error);
process.exitCode=result.status===0 && result.stdout?.includes("PASS real qwen3.7-plus:")?0:1;
