// Skill 内容回归网:平台安装流程拆在 skills/prep/arcane-fvtt-setup/references/ 下,
// 以下安全与运行规则在重构时不允许静默丢失。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_MARKERS = new Map([
  ["skills/prep/arcane-fvtt-setup/SKILL.md", [
    "ARCANE_FVTT_NODE",
    "installDefaults.systems/modules/worlds",
    "references/windows-install.md",
    "references/macos-install.md",
  ]],
  ["skills/prep/arcane-fvtt-setup/references/macos-install.md", [
    "xattr -dr com.apple.quarantine",
    "library load disallowed by system policy",
    "ELECTRON_RUN_AS_NODE",
  ]],
  ["skills/prep/arcane-fvtt-setup/references/windows-install.md", [
    "Start-Process -Verb RunAs -Wait -PassThru",
    "/D=",
    "UAC",
  ]],
  ["skills/prep/arcane-fvtt-ops/SKILL.md", [
    "EPIPE",
    "用户明确授权",
  ]],
  ["skills/prep/arcane-actor-images/SKILL.md", [
    "prototypeToken.texture.src",
    "ring.subject.texture",
    "已在场景里的存量 token",
  ]],
]);

for (const [file, markers] of REQUIRED_MARKERS) {
  test(`${file} keeps its hard-won operational rules`, () => {
    const content = readFileSync(path.join(appRoot, file), "utf8");
    const missing = markers.filter((marker) => !content.includes(marker));
    assert.deepEqual(missing, [], `${file} is missing required markers: ${missing.join(", ")}`);
  });
}
