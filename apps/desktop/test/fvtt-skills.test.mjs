import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setupSkill = path.join(desktopRoot, "skills", "prep", "arcane-fvtt-setup", "SKILL.md");
const setupSkillWindows = path.join(desktopRoot, "skills", "prep", "arcane-fvtt-setup", "references", "windows-install.md");
const setupSkillMacos = path.join(desktopRoot, "skills", "prep", "arcane-fvtt-setup", "references", "macos-install.md");
const opsSkill = path.join(desktopRoot, "skills", "prep", "arcane-fvtt-ops", "SKILL.md");
const distributionFile = path.join(desktopRoot, "distribution", "community-distribution.json");
const moduleReaderSkill = path.join(desktopRoot, "skills", "prep", "arcane-module-reader", "SKILL.md");
const desktopPackage = path.join(desktopRoot, "package.json");

test("distribution pins a verified Node artifact for every supported desktop target", async () => {
  const distribution = JSON.parse(await readFile(distributionFile, "utf8"));
  const artifacts = distribution.core.nodeArtifacts;
  assert.deepEqual(Object.keys(artifacts).sort(), ["darwin-arm64", "darwin-x64", "win-arm64", "win-x64"]);
  for (const artifact of Object.values(artifacts)) {
    assert.match(artifact.file, new RegExp(`^node-v${distribution.core.node}-`));
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
});

test("distribution pins the verified Foundry 13 Windows silent-installer contract", async () => {
  const distribution = JSON.parse(await readFile(distributionFile, "utf8"));
  const installer = distribution.core.windowsInstaller;
  assert.equal(installer.version, "13.351.0");
  assert.equal(installer.bytes, 227580416);
  assert.match(installer.sha256, /^[a-f0-9]{64}$/);
  assert.equal(installer.signaturePublisher, "Foundry Gaming LLC");
  assert.equal(installer.format, "nsis-3-unicode");
  assert.equal(installer.requestedExecutionLevel, "requireAdministrator");
  assert.deepEqual(installer.silent, {
    switch: "/S",
    installDirPrefix: "/D=",
    installDirMustBeLast: true,
    installDirMustNotBeQuoted: true,
    elevation: "runas",
  });
});

test("community distribution has no mirror, world, module, or default third-party install", async () => {
  const distribution = JSON.parse(await readFile(distributionFile, "utf8"));
  assert.equal(distribution.profileId, "arcane-community-foundry13-dnd5e");
  assert.deepEqual(distribution.installDefaults, { systems: [], modules: [], worlds: [] });
  assert.deepEqual(distribution.modules, []);
  assert.deepEqual(distribution.worlds, []);
  assert.equal(distribution.channels, undefined);
  assert.equal(JSON.stringify(distribution).includes("arcane-package"), false);
  assert.equal(JSON.stringify(distribution).includes("proxy"), false);

  const dnd5e = distribution.systems.find((system) => system.id === "dnd5e");
  assert.equal(dnd5e.defaultInstall, false);
  assert.equal(dnd5e.license.software, "MIT");
  assert.equal(dnd5e.license.srdContent, "CC BY 4.0");
  assert.match(dnd5e.sha256, /^[a-f0-9]{64}$/);
});

test("desktop packages generic skills but no demo world or environment profile artifact", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackage, "utf8"));
  assert.equal(packageJson.build.files.includes("skills/**/*"), true);
  assert.equal(packageJson.build.files.includes("scripts/prepare-world-profile.mjs"), false);
  assert.equal(packageJson.build.files.some((entry) => /worlds|arcane-demo|environment-profile/i.test(entry)), false);
  assert.equal(JSON.stringify(packageJson).includes("arcane-demo"), false);
});

test("setup skill routes local ZIP, EXE, and DMG through the bundled Node workflow", async () => {
  const skill = await readFile(setupSkill, "utf8");
  // 平台专属流程拆在 references/ 下:SKILL.md 留共享契约与路由,平台细节在各自文件里。
  assert.match(skill, /ARCANE_FVTT_NODE/);
  assert.match(skill, /ARCANE_FVTT_DISTRIBUTION_FILE/);
  assert.match(skill, /FoundryVTT-<core\.foundry>/);
  assert.match(skill, /本地 `\.zip`、`\.exe` 或 `\.dmg`/);
  assert.match(skill, /Core 目录与 Data 目录必须分开/);
  assert.match(skill, /installDefaults\.systems\/modules\/worlds.*全部为空/s);
  assert.match(skill, /明确同意/);
  assert.match(skill, /逐字节核对 SHA256/);
  assert.match(skill, /Node\.js distribution ZIP/);
  assert.match(skill, /references\/windows-install\.md/);
  assert.match(skill, /references\/macos-install\.md/);
  assert.match(skill, /不使用代理池或第三方镜像/);
  assert.match(skill, /Desktop 不打包 Demo world/);
  assert.match(skill, /只询问一次/);
  assert.match(skill, /arcane-fvtt-mods/);
  assert.match(skill, /world-inspect/);
  assert.match(skill, /references\/demo-world\.md/);
  assert.doesNotMatch(skill, /fvtt_setup/);
  assert.doesNotMatch(skill, /install-node|install-core|doctor/);

  const windowsInstall = await readFile(setupSkillWindows, "utf8");
  assert.match(windowsInstall, /Windows EXE/);
  assert.match(windowsInstall, /Windows Portable Build ZIP/);
  assert.match(windowsInstall, /App\/resources\/app\/main\.js/);
  assert.match(windowsInstall, /core\.windowsInstaller/);
  assert.match(windowsInstall, /Start-Process -Verb RunAs -Wait -PassThru/);

  const macosInstall = await readFile(setupSkillMacos, "utf8");
  assert.match(macosInstall, /macOS DMG/);
  assert.match(macosInstall, /xattr\s+-dr\s+com\.apple\.quarantine/);
  assert.match(macosInstall, /用户明确授权/);
  assert.match(macosInstall, /不得把清 quarantine 当成默认安装步骤/);
});

test("ops skill uses PowerShell on Windows without reviving the Git Bash prerequisite", async () => {
  const skill = await readFile(opsSkill, "utf8");
  assert.match(skill, /ARCANE_FVTT_NODE/);
  assert.doesNotMatch(skill, /fvtt_setup|doctor/);
  assert.match(skill, /Windows PowerShell/);
  assert.match(skill, /Get-NetTCPConnection/);
  assert.match(skill, /Start-Process/);
  assert.match(skill, /taskkill\.exe \/PID/);
  assert.doesNotMatch(skill, /Windows\s*\(Git Bash/);
  assert.doesNotMatch(skill, /netstat -ano \| grep/);
});

test("module reader never pipes network responses to a shell and asks before cloud upload", async () => {
  const skill = await readFile(moduleReaderSkill, "utf8");
  assert.match(skill, /不得把任何网络响应直接送入 shell/);
  assert.match(skill, /先下载到临时目录/);
  assert.match(skill, /SHA256\/发布签名/);
  assert.match(skill, /每个新文档第一次调用 MinerU 前/);
  assert.match(skill, /取得用户明确同意/);
});
