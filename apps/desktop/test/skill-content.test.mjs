// Skill 内容回归网:平台安装流程拆在 skills/prep/arcane-fvtt-setup/references/ 下,
// 以下安全与运行规则在重构时不允许静默丢失。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

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
    "arcane-assets",
    "foundry_module_prepare",
    "map_api_search({ prefix: \"game.actors\" })",
    "prototypeToken.texture.src",
    "ring.subject.texture",
    "保持 `img`、原型和存量 Token 图像不变",
    "本身不下载或安装",
    "https://github.com/tanis90/arcanedesk-fvtt-mods",
    "镜像未收录不等于画库不存在",
    "type/style/attrs/tags/name/name_zh/desc/desc_zh",
    "原始 `.svg` 不传给 `foundry_image`",
    "advance 与授予前必须",
  ]],
  ["skills/prep/arcane-item-update/SKILL.md", [
    "map_api_search({ prefix: \"game.items\" })",
    "touched/missing",
    "JSON.parse(JSON.stringify(doc))",
    "CONFIG.Item.documentClass.create",
    "arcane-journal-update",
  ]],
  ["skills/prep/arcane-journal-update/SKILL.md", [
    "JournalEntryPage",
    "`text.content` 是 HTML 字符串",
    "<h2>教堂调查</h2>",
    "map_api_search({ prefix: \"game.journal\" })",
    "map_page_eval",
    "browser_evaluate",
    "多页必须循环单页创建",
    "ownership: { default: 2 }",
    "page.update({ \"text.content\": updatedHtml })",
    "不等于已经在玩家屏幕弹窗展示",
    "foundry_image",
  ]],
  ["skills/prep/arcane-mt-lobby/SKILL.md", [
    "大厅写入前必读",
    "activatedTools",
    "action/workflow/job",
    "arcane-world-create",
    "arcane-world-import",
    "arcane-mt-packs",
    "OPERATION_KIND_UNSUPPORTED",
  ]],
  ["skills/prep/arcane-world-create/SKILL.md", [
    "lobbyCampaignCreate",
    "lobbyRulesetsList",
    "map_api_search",
    "map_api_call",
    "kind: \"action\"",
    "不走 `map_api_call`",
    "先用原生 `read` 读取 `arcane-mt-lobby/SKILL.md`",
    "复用当前 URL 的 origin",
  ]],
  ["skills/prep/arcane-world-import/SKILL.md", [
    "先用原生 `read` 读取 `arcane-mt-lobby/SKILL.md`",
    "复用当前 URL 的 origin",
  ]],
  ["skills/prep/arcane-mt-packs/SKILL.md", [
    "先用原生 `read` 读取 `arcane-mt-lobby/SKILL.md`",
    "复用当前 URL 的 origin",
  ]],
  ["skills/prep/arcane-module-to-fvtt/SKILL.md", [
    "arcane-assets",
    "格式受支持",
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
    const missing = markers.filter(marker => !content.includes(marker));
    assert.deepEqual(missing, [], `${file} is missing required markers: ${missing.join(", ")}`);
  });
}

function toolExample(source, toolName) {
  const match = source.match(new RegExp(`\`\`\`js\\n(${toolName}\\(\\{[\\s\\S]*?\\n\\}\\))\\n\`\`\``));
  assert.ok(match, `Missing ${toolName} example`);
  return match[1];
}

test("journal examples execute native writes with HTML on both runtimes", async () => {
  const source = readFileSync(path.join(appRoot, "skills/prep/arcane-journal-update/SKILL.md"), "utf8");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const toolName of ["map_page_eval", "browser_evaluate"]) {
    const writes = [];
    const creates = [];
    const context = vm.createContext({
      CONFIG: { JournalEntry: { documentClass: { create: async data => {
        creates.push(data);
        return {
          ...data,
          uuid: `Journal.j${writes.length + 1}`,
          createEmbeddedDocuments: async (type, pages) => {
            writes.push({ type, pages });
            return pages.map((page, index) => ({
              ...page,
              uuid: `Journal.j1.JournalEntryPage.p${index + 1}`,
              text: { ...page.text },
            }));
          },
        };
      } } } },
    });
    context.map_page_eval = ({ code }) => new AsyncFunction("CONFIG", code)(context.CONFIG);
    context.browser_evaluate = ({ code }) => vm.runInContext(code, context);
    const result = await vm.runInContext(toolExample(source, toolName), context);
    assert.equal(creates.length, 1, toolName);
    assert.equal(creates[0].ownership.default, 0, toolName);
    assert.equal(writes.length, 1, toolName);
    assert.equal(writes[0].type, "JournalEntryPage", toolName);
    assert.equal(writes[0].pages.length, 1, toolName);
    assert.match(writes[0].pages[0].text.content, /<h2>调查发现<\/h2>/, toolName);
    assert.match(writes[0].pages[0].text.content, /<strong>被移动过的暗门<\/strong>/, toolName);
    assert.equal(result.pageUuid, "Journal.j1.JournalEntryPage.p1", toolName);
  }
});
