import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertSkillsSelfContained, collectSkillFiles } from "../scripts/publish-skills.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const SKILLS_DIR = path.join(desktopRoot, "skills", "prep");
const MOD_MANAGER = "arcane-fvtt-mods/scripts/mod-manager.mjs";

async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "arcane-skills-selfcontained-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 在 tmpdir 里造一棵合成 skills 树,返回 { dir, files }(files 为 POSIX 相对路径)。 */
async function makeSkillsFixture(t, contents) {
  const dir = await makeTempDir(t);
  for (const [name, body] of Object.entries(contents)) {
    const absolute = path.join(dir, ...name.split("/"));
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, body, "utf8");
  }
  return { dir, files: Object.keys(contents).sort() };
}

test("self-contained gate accepts builtins, sibling files, and vendored dependencies", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/run.mjs": [
      'import fs from "node:fs";',
      'import path from "path";',
      'import { helper } from "./helper.mjs";',
      'import yauzl from "yauzl";',
      "export { fs, path, helper, yauzl };",
    ].join("\n"),
    "demo/scripts/helper.mjs": "export const helper = 1;\n",
    "demo/scripts/node_modules/yauzl/package.json": '{"name":"yauzl","version":"3.4.0"}\n',
  });
  await assertSkillsSelfContained(dir, files);
});

test("self-contained gate rejects relative imports escaping the skills directory", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/run.mjs": 'import { x } from "../../../../scripts/archive.mjs";\nexport { x };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dir, files), /escapes the skills directory/);
});

test("self-contained gate rejects dynamic imports escaping the skills directory", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/run.mjs": 'const x = await import("../../../outside.mjs");\nexport { x };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dir, files), /escapes the skills directory/);
});

test("self-contained gate rejects absolute import paths", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/run.mjs": 'import x from "/etc/passwd";\nexport { x };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dir, files), /absolute import path/);
});

test("self-contained gate rejects bare imports that are neither builtins nor vendored", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/run.mjs": 'import _ from "lodash";\nexport { _ };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dir, files), /not self-contained/);
});

test("self-contained gate rejects non-vendored bare imports, static or dynamic", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/static.mjs": 'import tar from "tar";\nexport { tar };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dir, files), /not self-contained/);
  const dynamicFixture = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/dynamic.mjs": 'const tar = await import("tar");\nexport { tar };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dynamicFixture.dir, dynamicFixture.files), /not self-contained/);
});

test("self-contained gate rejects relative imports missing from the bundle", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": "# demo\n",
    "demo/scripts/run.mjs": 'import { x } from "./missing.mjs";\nexport { x };\n',
  });
  await assert.rejects(assertSkillsSelfContained(dir, files), /not part of the skills bundle/);
});

test("self-contained gate ignores non-script files", async (t) => {
  const { dir, files } = await makeSkillsFixture(t, {
    "demo/SKILL.md": 'text mentioning import x from "../../escape.mjs" in prose\n',
    "demo/notes.json": '{"import": "../../escape.mjs"}\n',
  });
  await assertSkillsSelfContained(dir, files);
});

test("the real skills bundle passes the self-contained gate", async () => {
  const files = await collectSkillFiles(SKILLS_DIR);
  await assertSkillsSelfContained(SKILLS_DIR, files);
});

test("materialized bundle passes syntax check and its entry script imports standalone", async (t) => {
  // 模拟 userData 里的激活副本:bundle 脱离 app 树,不设任何环境变量。
  const files = await collectSkillFiles(SKILLS_DIR);
  const tree = path.join(await makeTempDir(t), "tree");
  for (const name of files) {
    const source = path.join(SKILLS_DIR, ...name.split("/"));
    const target = path.join(tree, ...name.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  }
  const scripts = files.filter((name) => name.endsWith(".mjs"));
  assert.ok(scripts.length > 0, "expected at least one script in the skills bundle");
  for (const name of scripts) {
    await execFileAsync(process.execPath, ["--check", path.join(tree, ...name.split("/"))]);
  }
  const modManager = await import(pathToFileURL(path.join(tree, ...MOD_MANAGER.split("/"))).href);
  assert.equal(typeof modManager.buildCatalog, "function");
});

test("vendored archive-zip.mjs stays byte-identical to scripts/archive-zip.mjs", async () => {
  const vendored = await fsp.readFile(path.join(SKILLS_DIR, "arcane-fvtt-mods", "scripts", "archive-zip.mjs"));
  const source = await fsp.readFile(path.join(desktopRoot, "scripts", "archive-zip.mjs"));
  assert.deepEqual(vendored, source);
});

test("vendored dependency versions stay in sync with the repository lockfile", async () => {
  const lockfile = JSON.parse(await fsp.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  for (const name of ["yauzl", "pend"]) {
    const vendored = JSON.parse(
      await fsp.readFile(
        path.join(SKILLS_DIR, "arcane-fvtt-mods", "scripts", "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    const locked = lockfile.packages?.[`node_modules/${name}`]?.version;
    assert.ok(locked, `lockfile has no entry for ${name}`);
    assert.equal(vendored.version, locked, `vendored ${name} diverged from the lockfile`);
  }
});
