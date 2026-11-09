// Included by the opt-in benchmark harness with --scenarios=true, after its
// QA-A identity/ownership checks. Never runs during the timing comparison.
module.exports = async function scenarios({ evaluate, sourceId, targetId, combatId, sceneId, fixtureNames,
  fixture, report, save, root, runId, store, page, origin, revision, setHost }) {
  const path = require("node:path");
  const { mkdirSync, writeFileSync } = require("node:fs");
  const assert = require("node:assert/strict");
  const workDir = path.join(root, runId, "scenarios"); mkdirSync(workDir, { recursive: true });
  const image = await evaluate('(()=>{const c=document.createElement("canvas");c.width=96;c.height=96;const ctx=c.getContext("2d");ctx.fillStyle="#527f99";ctx.fillRect(0,0,96,96);return c.toDataURL("image/png").split(",")[1];})()');
  writeFileSync(path.join(workDir, "portrait.png"), Buffer.from(image, "base64"));
  report.scenarios = [];
  let host;
  const start = async mode => {
    host?.dispose();
    const runtime = new revision.DirectFoundryRuntime({ getWebContents: () => page, runtimeSource: revision.runtimeSource,
      allowedActions: revision.allowedActions, log() {} });
    host = new revision.AgentHost({ foundryRuntime: runtime, getFoundryView: () => ({ webContents: page }),
      openFoundry: async url => { if (url && new URL(url).origin !== origin) throw Error("Only QA-A may be opened"); return { ok: true, summary: "QA-A connected", url: `${origin}/game` }; },
      sendToRenderer() {}, providerStore: store, runtimeReady: Promise.resolve({ nodeBinary: process.env.ARCANE_QA_NODE }),
      profile: { mode, getCwd: () => workDir, ...(mode === "prep" ? { builtinTools: true, systemPrompt: "append", fence: true, getSkillPaths: () => [] } : {}) },
      getLocale: () => "zh-CN", log() {}, operationStorageDir: path.join(workDir, mode, "operations"),
      taskStorageDir: path.join(workDir, mode, "tasks"),
      scheduler: new revision.ExecutionScheduler({ capacity: 1 }) });
    mkdirSync(path.join(workDir, mode, "tasks"), { recursive: true });
    setHost(host); await host.start({ fresh: true });
    report[`${mode}ActiveTools`] = host.session.getActiveToolNames(); save();
  };
  const prompt = async (name, text) => {
    const row = { name, tools: [], status: "submitted" }; report.scenarios.push(row); save();
    const unsubscribe = host.session.subscribe(event => {
      if (event.type === "tool_execution_end") row.tools.push({ name: event.toolName, isError: event.isError,
        status: event.result?.details?.status, code: event.result?.details?.code });
    });
    const timer = setTimeout(() => host.stop(), 180000);
    try { await host.prompt(text); } finally { clearTimeout(timer); unsubscribe(); row.status = host.task?.state; save(); }
    assert.equal(row.status, "completed", `${name}: model task must complete`);
    assert.ok(!row.tools.some(t => ["browser_evaluate", "shell"].includes(t.name)), `${name}: structured flow required`);
    return row;
  };
  await start("prep");
  const npcName = `${runId} Model Wolf`;
  await prompt("create-npc", `QA-A 世界已连接且 GM 就绪。从 dnd5e.monsters 合集导入名称精确为 Wolf 的怪物，命名为 ${npcName}。只创建一个。`);
  const actorUuid = await evaluate(`(()=>{const list=game.actors.contents.filter(a=>a.name===${JSON.stringify(npcName)});if(list.length!==1)throw Error("Expected exactly one imported Actor");return list[0].uuid;})()`);
  report.scenarioActorUuid = actorUuid; save();
  await prompt("grant-image", `给刚创建的 ${npcName} 一把 arcane-dnd5e-2014-automation.basicweapons 合集中的 Rapier，装备上；已有同来源就跳过。把头像和 prototype Token 图片换成当前备团目录的 portrait.png。`);
  report.imageVerification = await evaluate(`(async()=>{const a=await fromUuid(${JSON.stringify(actorUuid)});return {img:a.img,tokenImg:a.prototypeToken.texture.src,rapiers:a.items.contents.filter(i=>/rapier/i.test(i.name)).length};})()`);
  assert.ok(report.imageVerification.img.startsWith("arcanedesk/assets/"));
  assert.equal(report.imageVerification.img, report.imageVerification.tokenImg); assert.equal(report.imageVerification.rapiers, 1); save();
  const newSceneName = `${runId} Model Scene`;
  await prompt("create-scene", `创建名为 ${newSceneName} 的场景，宽 2000 高 1500 像素，方格大小 100 像素，每格 5 ft，用 portrait.png 做背景。放两个刚创建的 ${npcName} Token，位置分别为 (200,200) 和 (400,200)。不要激活或切换场景。`);
  report.sceneVerification = await evaluate(`(()=>{const list=game.scenes.contents.filter(s=>s.name===${JSON.stringify(newSceneName)});if(list.length!==1)throw Error("Expected exactly one Scene");const s=list[0];return {uuid:s.uuid,background:s.background.src,grid:s.toObject().grid,tokens:s.tokens.contents.map(t=>({actorId:t.actorId,x:t.x,y:t.y})),active:s.active};})()`);
  assert.equal(report.sceneVerification.tokens.length, 2); assert.equal(report.sceneVerification.active, false);
  assert.equal(report.sceneVerification.background, report.imageVerification.img);
  assert.deepEqual(report.sceneVerification.tokens.map(t=>[t.x,t.y]).sort(), [[200,200],[400,200]]); save();
  await prompt("grant-idempotent", `再给 ${npcName} 一把同一合集来源的 Rapier，已有就跳过。`);
  assert.equal(await evaluate(`game.actors.get(${JSON.stringify(actorUuid.split(".")[1])}).items.contents.filter(i=>/rapier/i.test(i.name)).length`), 1);
  // Native QA setup only: end this fixture's running round and replenish known
  // test slots. This is not a product rest action or an Actor-only play path.
  await evaluate(`(async()=>{const c=game.combats.get(${JSON.stringify(combatId)});if(c.flags.arcanedesk?.requestId!==${JSON.stringify(fixture.runId)})throw Error("Combat ownership mismatch");await c.update({round:0,turn:null});await game.actors.get(${JSON.stringify(sourceId)}).update({"system.spells.spell1.value":4,"system.spells.spell2.value":3});canvas.tokens.releaseAll();for(const t of canvas.tokens.placeables)if([${JSON.stringify(sourceId)},${JSON.stringify(targetId)}].includes(t.document.actorId)&&!t.document.hidden)t.control({releaseOthers:false});return true;})()`);
  await start("combat");
  const on = await prompt("selected-prone", "QA-A 已连接。把我选中的两个人都标为倒地。");
  assert.deepEqual(on.tools.map(t=>t.name), ["foundry_conditions_set"]);
  assert.equal(await evaluate(`[${JSON.stringify(sourceId)},${JSON.stringify(targetId)}].every(id=>game.actors.get(id).statuses.has("prone"))`), true);
  const off = await prompt("selected-prone-remove", "把刚才选中的两个人的倒地去掉。");
  assert.deepEqual(off.tools.map(t=>t.name), ["foundry_conditions_set"]);
  assert.equal(await evaluate(`[${JSON.stringify(sourceId)},${JSON.stringify(targetId)}].every(id=>!game.actors.get(id).statuses.has("prone"))`), true);
  const sourceTokenName = await evaluate(`canvas.scene.tokens.contents.find(t=>t.actorId===${JSON.stringify(sourceId)}&&!t.hidden).name`);
  const first = await prompt("noncombat-disguise", `让场景中名称为 ${sourceTokenName} 的 Token 施放易容术（Disguise Self），用一环法术位，只记录施法消耗，外貌和效果我来描述。`);
  assert.equal(first.tools.filter(t=>t.name==="foundry_static_context").length, 1);
  assert.equal(first.tools.filter(t=>t.name==="foundry_execute_action").length, 1);
  assert.equal(await evaluate(`game.actors.get(${JSON.stringify(sourceId)}).system.spells.spell1.value`), 3);
  const second = await prompt("noncombat-knock", `同一个角色再施放敲击术（Knock），用二环法术位打开故事里的门，只记录施法消耗，门的结果我来裁定。`);
  assert.deepEqual(second.tools.map(t=>t.name), ["foundry_execute_action"]);
  assert.equal(await evaluate(`game.actors.get(${JSON.stringify(sourceId)}).system.spells.spell2.value`), 2);
  const effectUuid = await evaluate(`(async()=>{const a=game.actors.get(${JSON.stringify(sourceId)});const spell=a.items.find(i=>i.name.includes("Disguise Self"));const [e]=await a.createEmbeddedDocuments("ActiveEffect",[{name:${JSON.stringify(runId + " source-managed fixture")},origin:spell.uuid,statuses:["prone"],flags:{arcanedesk:{qaFixture:${JSON.stringify(runId)}}}}]);return e.uuid;})()`);
  const protectedResult = await prompt("source-managed-protection", `去掉 ${sourceTokenName} 的倒地状态。`);
  assert.deepEqual(protectedResult.tools.map(t=>t.name), ["foundry_conditions_set"]);
  assert.ok(protectedResult.tools.some(t=>t.status === "rejected"));
  assert.equal(await evaluate(`(async()=>{const e=await fromUuid(${JSON.stringify(effectUuid)});if(e?.flags.arcanedesk?.qaFixture!==${JSON.stringify(runId)})throw Error("Expected intact source effect");return true;})()`), true);
  await evaluate(`(async()=>{const e=await fromUuid(${JSON.stringify(effectUuid)});if(e?.flags.arcanedesk?.qaFixture!==${JSON.stringify(runId)})throw Error("Effect cleanup ownership mismatch");await e.delete();return true;})()`);
  report.status = "scenarios-passed"; save(); host.dispose(); setHost(null);
};
