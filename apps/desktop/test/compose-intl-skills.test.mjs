import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { composeIntlSkills } from "../scripts/compose-intl-skills.mjs";

async function makeTree(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body);
  }
}

async function scaffold(t, { cn, intl }) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "intl-skills-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const cnDir = path.join(directory, "cn");
  const intlDir = path.join(directory, "intl");
  const outDir = path.join(directory, "out");
  await makeTree(cnDir, cn);
  await makeTree(intlDir, intl);
  return { cnDir, intlDir, outDir };
}

const CN_BASE = {
  "bundle.json": JSON.stringify({ schemaVersion: 1, revision: 10 }),
  "arcane-demo/SKILL.md": "# 演示技能\n\n中文正文。\n",
  "arcane-demo/references/usage.md": "## 用法\n\n中文参考。\n",
  "arcane-demo/scripts/tool.mjs": "console.log('english-only code');\n",
  // vendored 第三方英文文档：本来就是英文，不要求翻译。
  "arcane-demo/scripts/node_modules/some-pkg/README.md": "# some-pkg\n\nUpstream English readme.\n",
};

const INTL_BASE = {
  "bundle.json": JSON.stringify({ schemaVersion: 1, revision: 3 }),
  "arcane-demo/SKILL.md": "# Demo Skill\n\nEnglish body.\n",
  "arcane-demo/references/usage.md": "## Usage\n\nEnglish reference.\n",
};

test("intl skills composer overlays translations and keeps cn code single-sourced", async (t) => {
  const { cnDir, intlDir, outDir } = await scaffold(t, { cn: CN_BASE, intl: INTL_BASE });
  const { files, overrides } = await composeIntlSkills({ cnDir, intlDir, outDir });

  assert.deepEqual(files.sort(), Object.keys(CN_BASE).sort());
  assert.deepEqual(overrides.sort(), Object.keys(INTL_BASE).sort());

  const skill = await fsp.readFile(path.join(outDir, "arcane-demo", "SKILL.md"), "utf8");
  assert.equal(skill, INTL_BASE["arcane-demo/SKILL.md"]);
  const reference = await fsp.readFile(path.join(outDir, "arcane-demo", "references", "usage.md"), "utf8");
  assert.equal(reference, INTL_BASE["arcane-demo/references/usage.md"]);
  const code = await fsp.readFile(path.join(outDir, "arcane-demo", "scripts", "tool.mjs"), "utf8");
  assert.equal(code, CN_BASE["arcane-demo/scripts/tool.mjs"]);
  const vendored = await fsp.readFile(path.join(outDir, "arcane-demo", "scripts", "node_modules", "some-pkg", "README.md"), "utf8");
  assert.equal(vendored, CN_BASE["arcane-demo/scripts/node_modules/some-pkg/README.md"]);

  // intl 独立 revision 计数器生效：组合输出用 intl 的 bundle.json。
  const bundle = JSON.parse(await fsp.readFile(path.join(outDir, "bundle.json"), "utf8"));
  assert.equal(bundle.revision, 3);
});

test("intl skills composer rejects orphan files with no cn counterpart", async (t) => {
  const { cnDir, intlDir, outDir } = await scaffold(t, {
    cn: CN_BASE,
    intl: { ...INTL_BASE, "arcane-demo/references/extra.md": "# Stray\n" },
  });
  await assert.rejects(
    composeIntlSkills({ cnDir, intlDir, outDir }),
    /files the cn tree does not[\s\S]*arcane-demo\/references\/extra\.md/,
  );
});

test("intl skills composer rejects CJK leakage in translated prose", async (t) => {
  const { cnDir, intlDir, outDir } = await scaffold(t, {
    cn: CN_BASE,
    intl: { ...INTL_BASE, "arcane-demo/SKILL.md": "# Demo Skill\n\n混入了中文。\n" },
  });
  await assert.rejects(
    composeIntlSkills({ cnDir, intlDir, outDir }),
    /CJK characters[\s\S]*arcane-demo\/SKILL\.md/,
  );
});

test("intl skills composer requires full coverage of cn authored prose", async (t) => {
  const { cnDir, intlDir, outDir } = await scaffold(t, {
    cn: CN_BASE,
    intl: { "bundle.json": INTL_BASE["bundle.json"], "arcane-demo/SKILL.md": "# Demo Skill\n" },
  });
  await assert.rejects(
    composeIntlSkills({ cnDir, intlDir, outDir }),
    /missing intl translations[\s\S]*arcane-demo\/references\/usage\.md/,
  );
});

test("intl skills composer requires an intl bundle.json with a valid revision", async (t) => {
  const withoutBundle = await scaffold(t, {
    cn: CN_BASE,
    intl: { "arcane-demo/SKILL.md": "# Demo Skill\n", "arcane-demo/references/usage.md": "## Usage\n" },
  });
  await assert.rejects(
    composeIntlSkills({ cnDir: withoutBundle.cnDir, intlDir: withoutBundle.intlDir, outDir: withoutBundle.outDir }),
    /missing bundle\.json/,
  );

  const badRevision = await scaffold(t, {
    cn: CN_BASE,
    intl: { ...INTL_BASE, "bundle.json": JSON.stringify({ schemaVersion: 1, revision: 0 }) },
  });
  await assert.rejects(
    composeIntlSkills({ cnDir: badRevision.cnDir, intlDir: badRevision.intlDir, outDir: badRevision.outDir }),
    /valid monotonic revision/,
  );
});
