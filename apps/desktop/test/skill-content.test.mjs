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
  ["skills/prep/arcane-fvtt-mods/SKILL.md", [
    "ARCANE_FVTT_MOD_MANAGER",
    "index.json",
    "Data/.arcane-mod-backups/modules/",
    "--accept-sha256",
    "Manage Modules",
    "references/install.md",
    "references/updates.md",
    "references/demo-world.md",
    "Data/.arcane-world-backups/<id>/",
    "--expected-resolution-sha256 <resolutionSha256>",
    "不得复用旧会话",
  ]],
  ["skills/prep/arcane-fvtt-mods/references/demo-world.md", [
    "world-inspect",
    "world-stage",
    "world-commit",
    "foundry-environment-profile",
    "Data/.arcane-managed/profiles/",
    "--world=arcane-demo",
    "--expected-resolution-sha256 <resolutionSha256>",
    "不得照抄旧会话",
  ]],
]);

for (const [file, markers] of REQUIRED_MARKERS) {
  test(`${file} keeps its hard-won operational rules`, () => {
    const content = readFileSync(path.join(appRoot, file), "utf8");
    const missing = markers.filter((marker) => !content.includes(marker));
    assert.deepEqual(missing, [], `${file} is missing required markers: ${missing.join(", ")}`);
  });
}
