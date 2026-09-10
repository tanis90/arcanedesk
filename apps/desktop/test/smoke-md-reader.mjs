// 右屏阅读器 smoke(md-reader-spec §9):起真窗口跑生产 main + 生产 renderer,
// 验 ② 打开、③ 两个分支、④ 顶掉与保活唤回、错误页与 F5 的 surface 感知。
// 手动跑:`node test/smoke-md-reader.mjs`(与其余 smoke-*.mjs 同款,不进 npm test)。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require("electron"), [fileURLToPath(new URL("./fixtures/production-main-smoke.cjs", import.meta.url)), "--md-reader"],
  { env, encoding: "utf8", windowsHide: true, timeout: 180000 });
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 && result.stdout?.includes("PASS md reader:") ? 0 : 1;
