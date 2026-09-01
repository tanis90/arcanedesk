// skill.loaded 的目录归属判定回归网:只认 skills 生效目录内的一方 skill 文件;
// 输出永远只有白名单 skill 名 + 文件类别,路径本身不进入遥测。
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { matchSkillFile } from "../src/main/telemetry/skill-usage.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(desktopRoot, "skills", "prep");

test("a SKILL.md read resolves to its skill as skill_doc", () => {
  assert.deepEqual(matchSkillFile(ROOT, path.join(ROOT, "arcane-fvtt-setup", "SKILL.md")), {
    skillName: "arcane-fvtt-setup",
    fileKind: "skill_doc",
  });
});

test("bundled reference and script files resolve to the owning skill", () => {
  assert.deepEqual(
    matchSkillFile(ROOT, path.join(ROOT, "arcane-fvtt-setup", "references", "windows-install.md")),
    { skillName: "arcane-fvtt-setup", fileKind: "reference" },
  );
  assert.deepEqual(
    matchSkillFile(ROOT, path.join(ROOT, "arcane-fvtt-mods", "scripts", "mod-manager.mjs")),
    { skillName: "arcane-fvtt-mods", fileKind: "asset" },
  );
});

test("files outside the skills root, or directly at its top level, are not skill reads", () => {
  assert.equal(matchSkillFile(ROOT, path.join(desktopRoot, "package.json")), null);
  assert.equal(matchSkillFile(ROOT, path.join(ROOT, "bundle.json")), null);
  assert.equal(matchSkillFile(ROOT, ROOT), null);
  // 前缀陷阱:prep-evil 共享字符串前缀但不是同一个目录。
  assert.equal(matchSkillFile(ROOT, path.join(ROOT, "..", "prep-evil", "x", "SKILL.md")), null);
});

test("directory names outside the Agent Skills naming contract are rejected", () => {
  assert.equal(matchSkillFile(ROOT, path.join(ROOT, "Bad_Skill", "SKILL.md")), null);
  assert.equal(matchSkillFile(ROOT, path.join(ROOT, "..", "SKILL.md")), null);
});

test("junk input never matches and never throws", () => {
  for (const junk of ["", null, undefined, 42, {}]) {
    assert.equal(matchSkillFile(ROOT, junk), null);
  }
  assert.equal(matchSkillFile("", path.join(ROOT, "arcane-fvtt-ops", "SKILL.md")), null);
  assert.equal(matchSkillFile(null, path.join(ROOT, "arcane-fvtt-ops", "SKILL.md")), null);
});

test("case and separator normalization follow the platform", () => {
  const target = path.join(ROOT, "arcane-fvtt-ops", "SKILL.md");
  if (process.platform === "linux") {
    // 大小写敏感:不同大小写是另一个路径,不匹配。
    assert.equal(matchSkillFile(ROOT.toUpperCase(), target), null);
  } else {
    // win32/darwin 大小写不敏感:模型给出的大小写偏差仍能归因。
    assert.deepEqual(matchSkillFile(ROOT.toUpperCase(), target.toLowerCase()), {
      skillName: "arcane-fvtt-ops",
      fileKind: "skill_doc",
    });
  }
});
