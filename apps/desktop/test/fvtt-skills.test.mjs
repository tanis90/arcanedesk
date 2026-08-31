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

  // dnd5e 条目已降级为出处/许可证记录：mirror 有的内容全部走 mirror，
  // 清单不得再充当安装来源或校验基准。
  const dnd5e = distribution.systems.find((system) => system.id === "dnd5e");
  assert.equal(dnd5e.license.software, "MIT");
  assert.equal(dnd5e.license.srdContent, "CC BY 4.0");
  assert.equal(dnd5e.download, undefined);
  assert.equal(dnd5e.manifest, undefined);
  assert.equal(dnd5e.sha256, undefined);
  assert.equal(dnd5e.defaultInstall, undefined);
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
  assert.match(skill, /Core 目录与\s*Data 目录必须分开/s);
  assert.match(skill, /installDefaults\.systems\/modules\/worlds.*全部为空/s);
  assert.match(skill, /逐字节核对\s*SHA256/s);
  // 交互预算与计划确认门：4 个交互点，交付物料只授权读取与验证，确认门之后才有写入
  assert.match(skill, /用户交互预算/);
  assert.match(skill, /交互点最多 4 个/);
  assert.match(skill, /交付物料只授权读取与验证/);
  assert.match(skill, /安装计划与确认/);
  assert.match(skill, /--allow-missing-data-dir/);
  // Demo 环境默认安装，内容统一走 arcane mirror，禁止混链校验
  assert.match(skill, /Demo 环境默认安装/);
  assert.match(skill, /不在 arcane mirror 选过的 mod\s+之内/s);
  assert.match(skill, /arcanedesk\.bitterbebop\.cn/);
  assert.match(skill, /禁止混链校验/);
  // 路径纪律：完整形态路径与装后回读
  assert.match(skill, /<数据目录>\/Data\/systems\/dnd5e/);
  assert.match(skill, /回读/);
  assert.match(skill, /Node\.js distribution ZIP/);
  assert.match(skill, /references\/windows-install\.md/);
  assert.match(skill, /references\/macos-install\.md/);
  assert.match(skill, /不使用\s*代理池或第三方镜像/s);
  assert.match(skill, /Desktop 不打包 Demo world/);
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
  assert.match(macosInstall, /向用户说明/);
  assert.match(macosInstall, /必须清掉拷贝带来的隔离属性/);
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
  assert.match(skill, /无条件计算脚本与二进制的\s+SHA256/s);
  assert.match(skill, /CDN 不提供发布方校验值/);
  assert.match(skill, /未取得用户明确同意前不得上传/);
  assert.match(skill, /不视为同意第三方云上传/);
});

test("module reader keeps a constant 1-question budget and persists the token for the user", async () => {
  const skill = await readFile(moduleReaderSkill, "utf8");
  assert.match(skill, /交互预算恒定 1 次/);
  // 预算单位是"上下文里有没有回答记录"，不是"每份文档"
  assert.match(skill, /已经有用户回答过「那一次提问」的记录/);
  assert.match(skill, /之后的文档沿用这次回答/);
  assert.doesNotMatch(skill, /每个新文档第一次调用/);
  assert.match(skill, /auth --show/);
  // 注册后由 agent 持久化 token（stdin 管道 + 备份既有配置 + 回读验证），不靠临时环境变量交付
  assert.match(skill, /printf '<Token>\\n' \| mineru-open-api auth/);
  assert.match(skill, /下次新对话直接用，不用再注册/);
  assert.doesNotMatch(skill, /用户明确要求长期保存时/);
});

test("mods skill covers non-index packages with one plain-language risk warning", async () => {
  const skill = await readFile(
    path.join(desktopRoot, "skills", "prep", "arcane-fvtt-mods", "SKILL.md"),
    "utf8",
  );
  // 未收录包：一次大白话风险提示 + 官网反馈渠道；不再有"展示哈希再次确认"的二次交互
  assert.match(skill, /不在 arcane mirror 选过的 mod\s+之内/s);
  assert.match(skill, /arcanedesk\.bitterbebop\.cn/);
  assert.match(skill, /--accept-sha256/);
  assert.match(skill, /禁止混链校验/);
  assert.doesNotMatch(skill, /再次确认/);
});
