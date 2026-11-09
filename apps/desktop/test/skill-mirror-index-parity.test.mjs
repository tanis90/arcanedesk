// 镜像索引地址的单一事实来源回归锁：mod-manager 的内置常量与 SKILL.md 文案里的
// 索引字面量必须与 region.mjs 默认值表逐字节一致。运行期取址永远走
// ARCANE_MOD_INDEX_URL（main.js 按 region 注入），字面量只是散文事实——它们一旦
// 与表漂移，agent 按文案查索引就会连错区域的镜像。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MIRROR_INDEX_URL } from "../skills/prep/arcane-fvtt-mods/scripts/mod-manager.mjs";
import { regionDefaults } from "../src/main/region.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = path.join(desktopRoot, "skills", "prep", "arcane-fvtt-mods", "SKILL.md");

test("mod-manager 内置镜像地址就是 region.mjs 的 cn modIndexUrl", () => {
  assert.equal(MIRROR_INDEX_URL, regionDefaults("cn").modIndexUrl);
});

test("SKILL.md 的 cn/intl 索引字面量与 region 默认值表逐字节一致", () => {
  const text = fs.readFileSync(SKILL_MD, "utf8");
  assert.equal(
    text.includes(`\`${regionDefaults("cn").modIndexUrl}\``),
    true,
    "SKILL.md must quote the cn mirror index URL exactly as registered in region.mjs",
  );
  assert.equal(
    text.includes(`\`${regionDefaults("intl").modIndexUrl}\``),
    true,
    "SKILL.md must quote the intl mirror index URL exactly as registered in region.mjs",
  );
});
