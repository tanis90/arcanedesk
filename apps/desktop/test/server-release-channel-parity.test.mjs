// 服务器镜像通道地址的单一事实来源回归锁：部署 skill 文案里的根前缀字面量必须与
// region.mjs 默认值表逐字节一致（与 skill-mirror-index-parity 同一纪律）。运行期
// 取址永远走 ARCANE_SERVER_RELEASE_BASE（main.js 按 region 注入），字面量只是
// env 缺失时的回落散文事实——一旦与表漂移，agent 按 §4 通道下载就是 404。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { regionDefaults } from "../src/main/region.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_MAP = path.join(
  desktopRoot, "skills", "prep", "arcane-fvtt-setup", "references", "server-vendor-map.md",
);

test("vendor-map.md 的 cn/intl 通道根前缀与 region 默认值表逐字节一致", () => {
  const text = fs.readFileSync(VENDOR_MAP, "utf8");
  assert.equal(
    text.includes(`\`${regionDefaults("cn").serverDeployBaseUrl}\``),
    true,
    "vendor-map.md must quote the cn serverDeployBaseUrl exactly as registered in region.mjs",
  );
  assert.equal(
    text.includes(`\`${regionDefaults("intl").serverDeployBaseUrl}\``),
    true,
    "vendor-map.md must quote the intl serverDeployBaseUrl exactly as registered in region.mjs",
  );
});

test("main.js 按 region 注入 ARCANE_SERVER_RELEASE_BASE（接线模式与 modIndexUrl 一致）", () => {
  const main = fs.readFileSync(path.join(desktopRoot, "src", "main", "main.js"), "utf8");
  assert.equal(
    main.includes("process.env.ARCANE_SERVER_RELEASE_BASE = REGION.serverDeployBaseUrl"),
    true,
    "main.js must inject ARCANE_SERVER_RELEASE_BASE from the region defaults table",
  );
});
