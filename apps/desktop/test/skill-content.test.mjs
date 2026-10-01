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
    "私钥材料永不进入对话",
    "references/local-install.md",
    "references/server-deploy.md",
    "references/windows-install.md",
    "references/macos-install.md",
  ]],
  ["skills/prep/arcane-fvtt-setup/references/local-install.md", [
    "installDefaults.systems/modules/worlds",
    "--allow-missing-data-dir",
    "交付物料只授权读取与验证",
  ]],
  ["skills/prep/arcane-fvtt-setup/references/server-deploy.md", [
    "ARCANE_SERVER_RELEASE_BASE",
    "docker load",
    "不要比较 imageId",
    "hostname: arcane-fvtt",
    "coreVersion ≤13.351",
  ]],
  ["skills/prep/arcane-fvtt-setup/references/server-ssh.md", [
    "永不进入 agent 上下文",
    "authorized_keys",
    "arcane-server",
  ]],
  ["skills/prep/arcane-fvtt-setup/references/server-vendor-map.md", [
    "30000/TCP",
    "下载源",
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
  ["skills/prep/arcane-actor-update/SKILL.md", [
    "arcane-dnd5e-2014-automation",
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
