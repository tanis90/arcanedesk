// Same-revision tool ablation. Both arms run the real Prep AgentHost/Pi/model.
// Only the exposed tools and their matching routing instructions differ.
module.exports = async function benchmark({ evaluate, report, save, root, runId, store, page, origin, revision, samples, setHost, resumePath, promptMode = "production", baselineRevision, baselinePath, comparison = "js", caseFilter }) {
  const assert=require("node:assert/strict"), path=require("node:path"), fs=require("node:fs"), crypto=require("node:crypto");
  const productionPrep=fs.readFileSync(path.resolve(__dirname,"../../system-prompts/prep.md"),"utf8").trim();
  const common="你是 ArcaneDesk 备团助手。遵循 DM 的明确要求。测试世界已经连接且 GM 就绪。使用精确世界对象和合集来源，避免重复创建。只用公开 Foundry Document API，等待每次写入完成，返回紧凑结果并确认实际变化。不确定写入不能重放。只操作用户指定的测试对象，不修改模块文件或包。缺少必要信息才提问。成功回复简洁，用中文。";
  const newTools=new Set(["world_status","foundry_play_context","foundry_conditions_set","foundry_content_search","foundry_actor_get","foundry_actor_create","foundry_actor_update","foundry_actor_grant_items","foundry_scene_get","foundry_scene_apply","foundry_image"]);
  const imageFile=path.join(__dirname,"prep-benchmark-assets/benchmark20260508180804.jpg");
  const imageHash=crypto.createHash("sha256").update(fs.readFileSync(imageFile)).digest("hex");
  assert.equal(imageHash,"b95e5064ce3d221ff17615e9caeea76ff285a87d25da9d6d7dfec27f1ace6785");
  const characterSuite=process.argv.includes("--character-suite");
  const character=characterSuite?(comparison==="catalog"?require("../character-benchmark/catalog-model-adapter.cjs"):require("../character-benchmark/model-adapter.cjs"))(evaluate):null;
  if(characterSuite)assert.ok(["build-query","catalog"].includes(comparison));
  const npcCases=[...(character?.ids||[]),"npc_wizard","npc_werewolf","npc_priest"];
  const allCases=[...npcCases,"create_npc","grant_items","edit_image","scene_layout","conditions","upload_image"];
  const cases=caseFilter?caseFilter.split(","):allCases.filter(c=>!npcCases.includes(c));
  assert.ok(cases.length&&new Set(cases).size===cases.length&&cases.every(c=>allCases.includes(c)));
  assert.ok(["js","revision","native-skill","skill-revision","pack-skill","rules-ablation","build-query","catalog"].includes(comparison));
  if(["native-skill","skill-revision","pack-skill","rules-ablation","build-query","catalog"].includes(comparison))assert.ok(cases.every(c=>npcCases.includes(c)));
  const nativeRevision=process.argv.includes("--native-npc");
  const withRulesSkill=process.argv.includes("--rules-skill");
  if(withRulesSkill)assert.equal(comparison,"pack-skill","Rules skill pilot uses the production pack-skill candidate");
  if(nativeRevision)assert.ok(comparison==="revision"&&cases.every(c=>npcCases.includes(c)));
  const baselineSkill=process.argv.find(a=>a.startsWith("--baseline-skill="))?.slice(17);
  if(comparison==="skill-revision")assert.ok(baselineSkill&&fs.existsSync(baselineSkill));
  const arms=comparison==="build-query"?["native_skill_build_js","native_skill_build_tool"]:comparison==="catalog"?["native_skill_catalog_js","native_skill_catalog_tool"]:comparison==="rules-ablation"?["native_skill_pack","native_skill_rules"]:comparison==="pack-skill"?["native_skill","native_skill_pack"]:comparison==="skill-revision"?["native_skill_baseline","native_skill"]:comparison==="native-skill"?["tools","native_skill"]:comparison==="revision"?["baseline","tools"]:["js","tools"];
  if(process.argv.includes("--reverse-first"))arms.reverse();
  const armOnly=process.argv.find(a=>a.startsWith("--arm-only="))?.slice(11);
  if(armOnly){assert.ok(arms.includes(armOnly));assert.ok(!resumePath,"Separate arm runs cannot resume an ambiguous report");arms.splice(0,arms.length,armOnly);}
  report.experiment={arms,comparison,kind:"same-code tool ablation",cases,samplesPerCase:samples,model:report.model,
    promptPolicy:"same neutral Prep instructions; arm-specific route; Pi generates the matching active-tool preamble",newTools:[...newTools],connection:"warm authenticated target world",humanWait:"recorded; no automatic answers"};
  report.experiment.candidateCommit=require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{cwd:path.resolve(__dirname,"../../../.."),encoding:"utf8"}).trim();
  assert.ok(["production","neutral"].includes(promptMode));
  report.experiment.promptMode=promptMode;
  report.experiment.kind=promptMode==="production"?"same-code production tools versus native JS":"same-code tool ablation";
  report.experiment.promptPolicy=promptMode==="production"?"Production Prep prompt for tools; neutral native-JS instructions for control":"Same neutral instructions with arm-specific routing";
  if(comparison==="revision"){assert.equal(promptMode,"production");assert.ok(baselineRevision);assert.equal(fs.readFileSync(path.join(baselinePath,"apps/desktop/system-prompts/prep.md"),"utf8").trim(),productionPrep,"Revision experiments freeze the production prompt");report.experiment.kind="paired tool revisions, fixed production prompt";report.experiment.baselineCommit=require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{cwd:baselinePath,encoding:"utf8"}).trim();}
  if(comparison==="native-skill"){report.experiment.kind="current tools versus native NPC skill without actor create/update";report.experiment.promptPolicy="Production prompt control; native skill workflow routing for candidate";}
  if(comparison==="skill-revision"){report.experiment.kind="paired skill revisions; identical exposed tools and native routing";report.experiment.promptPolicy="Same native skill routing; only skill body differs";}
  if(comparison==="pack-skill"){report.experiment.kind="native NPC guide versus same guide plus production actor skill";report.experiment.promptPolicy="Same tools and native NPC guide; candidate additionally exposes the unchanged production arcane-actor-update skill and asks the model to read it for source discovery";}
  if(comparison==="rules-ablation"){report.experiment.kind="paired SRD rules skill ablation";report.experiment.promptPolicy="Same native NPC guide, production pack guide and tools; only candidate receives SRD rules skill and read instruction";}
  if(nativeRevision){report.experiment.kind="paired tool revisions with frozen native NPC skill and mode tools";report.experiment.nativeNpc=true;report.experiment.promptPolicy="Same native NPC routing and skill; tool revision differs";}
  if(comparison==="build-query"){report.experiment.kind="source progression query tool ablation";report.experiment.promptPolicy="Same native, pack and build-query guides; candidate additionally exposes one read-only query tool; no SRD rules skill";}
  report.experiment.suiteVersion=cases.includes("npc_priest")?"prep-npc-priest-transfer-draft2":cases.includes("npc_werewolf")?"prep-npc-transfer-draft2":cases.includes("npc_wizard")?"prep-npc-intent-draft2":"prep-v1-draft2";
  if(characterSuite){report.experiment.suiteVersion="character-v7-reviewed-growth";report.experiment.characterVerifier=character.verifier;}
  report.experiment.taskTimeoutMs=Number(process.argv.find(a=>a.startsWith("--task-timeout-ms="))?.slice(18)??(characterSuite?300000:180000));
  report.experiment.experienceTargetMs=120000;

  const thinkingOverride=process.argv.find(a=>a.startsWith("--thinking="))?.slice(11);
  if(thinkingOverride)assert.ok(["off","low","medium","high"].includes(thinkingOverride));
  report.experiment.thinkingOverride=thinkingOverride??null;
  report.experiment.rulesSkill=withRulesSkill||comparison==="rules-ablation";
  assert.ok(Number.isInteger(report.experiment.taskTimeoutMs)&&report.experiment.taskTimeoutMs>=120000&&report.experiment.taskTimeoutMs<=300000);
  report.experiment.imageSha256=imageHash;
  report.prepTrials=[];
  if(resumePath){
    const previous=JSON.parse(fs.readFileSync(resumePath,"utf8"));
    assert.equal(previous.status,"failed");assert.ok(["Ambiguous run retained for inspection; no automatic retry/cleanup","InvalidStateError: The source image could not be decoded."].includes(previous.error));
    assert.equal(previous.experiment.candidateCommit,report.experiment.candidateCommit);
    assert.equal(previous.experiment.comparison,comparison);assert.equal(previous.experiment.baselineCommit,report.experiment.baselineCommit);assert.deepEqual(previous.experiment.cases,cases);
    assert.ok(!["pack-skill","rules-ablation","build-query"].includes(comparison),"Skill injection experiments start fresh blocks; do not resume unfrozen sources");
    assert.equal(previous.experiment.promptMode,promptMode);assert.equal(previous.experiment.suiteVersion,report.experiment.suiteVersion);assert.equal(previous.experiment.imageSha256,imageHash);
    assert.equal(previous.fixtureRun,report.fixtureRun);assert.equal(previous.experiment.samplesPerCase,samples);
    report.prepTrials=previous.prepTrials;report.experiment=previous.experiment;
    report.continuations=[...(previous.continuations??[]),{sourceReport:resumePath,reason:"Explicit continuation after read-only QA inspection; prior tasks are not replayed",at:new Date().toISOString()}];
    runId=previous.fixtureLabelRun??previous.runId;report.fixtureLabelRun=runId;
  }
  const source=await evaluate('(async()=>{const p=game.packs.get("dnd5e.monsters");const wolf=(await p.getIndex()).find(e=>e.name==="Wolf");const w=game.packs.get("arcane-dnd5e-2014-automation.basicweapons");const index=await w.getIndex();return {wolf:wolf._id,rapier:index.find(e=>/Rapier/.test(e.name))._id,bow:index.find(e=>/Longbow/.test(e.name))._id};})()');
  // Evaluator-only reference snapshot; never included in the model prompt or skill.
  const werewolfSources=cases.includes("npc_werewolf")?await evaluate('(async()=>{const refs={werewolf:"Compendium.dnd5e.monsters.Actor.7tRhrxuknTpHpYcA",werewolf24:"Compendium.dnd5e.actors24.Actor.mmWerewolf000000",surge:"Compendium.arcane-dnd5e-2014-automation.classfeatures.Item.YdtxSgV9hbHLx416",longbow:"Compendium.arcane-dnd5e-2014-automation.basicweapons.Item.3EE9A77945B5824F"};return Object.fromEntries(await Promise.all(Object.entries(refs).map(async([key,ref])=>{const d=await fromUuid(ref);if(!d)throw Error("Missing transfer source "+ref);return [key,d.toObject()];})));})()'):null;
  const setup=async label=>evaluate(`(async()=>{
    const actors=[];for(let i=0;i<3;i++)actors.push(await Actor.create({name:${JSON.stringify(label)}+" 角色"+(i+1),type:"npc",flags:{arcanedesk:{prepBenchmark:${JSON.stringify(runId)}}},prototypeToken:{name:${JSON.stringify(label)}+" Token"+(i+1),actorLink:true},system:{attributes:{hp:{value:10,max:10},ac:{calc:"flat",flat:12}}}}));
    const protectedEffects=[];
    if(${JSON.stringify(label)}.endsWith("-conditions")){for(const actor of actors){const [effect]=await actor.createEmbeddedDocuments("ActiveEffect",[{name:"Benchmark unrelated effect",img:"icons/svg/shield.svg",disabled:false,changes:[],flags:{arcanedesk:{prepBenchmark:${JSON.stringify(runId)}}}}]);protectedEffects.push({actorId:actor.id,effectId:effect.id,name:effect.name});}}
    const rapier=await game.packs.get("arcane-dnd5e-2014-automation.basicweapons").getDocument(${JSON.stringify(source.rapier)});const data=rapier.toObject();delete data._id;data.system.equipped=false;data._stats??={};data._stats.compendiumSource=rapier.uuid;data.flags??={};data.flags.arcanedesk={sourceUuid:rapier.uuid};await actors[0].createEmbeddedDocuments("Item",[data]);
    const s=await Scene.create({name:${JSON.stringify(label)}+" 场景",width:2000,height:1500,grid:{type:1,size:100,distance:5,units:"ft"},active:false,flags:{arcanedesk:{prepBenchmark:${JSON.stringify(runId)}}}});
    const tokens=[];for(let i=0;i<3;i++)tokens.push((await actors[i].getTokenDocument({x:200+i*200,y:200,actorLink:true})).toObject());await s.createEmbeddedDocuments("Token",tokens);
    return {protectedEffects,actorIds:actors.map(a=>a.id),sceneId:s.id,label:${JSON.stringify(label)},newName:${JSON.stringify(label)}+" 霜牙",originalSceneId:canvas.scene.id};})()`);
  const prompts=(id,label)=>({
    npc_priest:`按2014版规则，创建一个三级的精灵牧师 NPC，感知16，其他分配要合理，法术保证有祝福术，装备一把轻锤。命名为“${label} 霜牙”。其他未指定选项自行合理决定；只创建这个 NPC，不修改已有角色。`,
    npc_werewolf:`创建一个狼人，给它动作如潮，把它的武器里加上长弓。命名为“${label} 霜牙”。只创建这个 NPC，不修改已有角色。`,
    npc_wizard:`按2014版规则，创建一个五级的人类法师 NPC，18智力，其他分配要合理，法术保证有火球术。给他装备上一根长棍。命名为“${label} 霜牙”。其他未指定选项自行合理决定；只创建这个 NPC，不修改已有角色。`,
    create_npc:`在 dnd5e.monsters 合集中找到名字精确为 Wolf 的怪物，创建一个名为“${label} 霜牙”的 NPC，并把它的原型 Token 名称也设成“${label} 霜牙”。已有同名则不要重复创建。`,
    grant_items:`给“${label} 角色1”授予 arcane-dnd5e-2014-automation.basicweapons 合集的 Rapier 和 Longbow，各一件。已有同来源的物品原样跳过，不叠加数量；新授予的物品装备上。`,
    edit_image:`把“${label} 角色1”改名为“${label} 队长”，HP 设为当前8、最大18，AC设为固定14。头像、原型Token和所有已放置Token的图片统一换成已有Data路径 systems/dnd5e/tokens/beast/Wolf.webp。不要改变已放置Token的名称、位置或尺寸。`,
    scene_layout:`修改非当前场景“${label} 场景”：把“${label} Token1”移到(300,400)，“${label} Token2”移到(500,400)，删除“${label} Token3”；再放两个“${label} 角色1”的Token，分别叫“新守卫A”和“新守卫B”，位置(700,400)和(900,400)。不切换或激活场景。`,
    conditions:`给世界角色“${label} 角色1”和“${label} 角色2”都加上倒地和中毒状态，不影响“${label} 角色3”。`
  })[id];
  const baseVerify=require("./prep-benchmark-verifier.cjs")(evaluate,imageHash);
  const verify=(id,f)=>characterSuite?character.verify(id,f):id==="npc_priest"?require("./prep-npc-priest-verifier.cjs")(evaluate,f):id==="npc_werewolf"?require("./prep-werewolf-verifier.cjs")(evaluate,f):id==="npc_wizard"?require("./prep-npc-wizard-verifier.cjs")(evaluate,f):baseVerify(id,f);
  const cleanup=async f=>evaluate(`(async()=>{const f=${JSON.stringify(f)};const s=game.scenes.get(f.sceneId);if(s?.flags.arcanedesk?.prepBenchmark!==${JSON.stringify(runId)})throw Error("Scene ownership mismatch");await s.delete();for(const id of f.actorIds){const a=game.actors.get(id);if(a.flags.arcanedesk?.prepBenchmark!==${JSON.stringify(runId)})throw Error("Actor ownership mismatch");await a.delete();}const extra=game.actors.filter(a=>a.name===f.newName);for(const a of extra){if(a.type!=="npc"||!a.items.some(i=>i.name==="Bite"))throw Error("Created Actor fixture mismatch");await a.delete();}return true;})()`);
  for(const trial of report.prepTrials.filter(t=>!t.cleaned)){
    assert.equal(trial.state,"returned");assert.equal(trial.taskState,"completed");assert.ok(!trial.timedOut&&trial.tools.every(t=>Number.isFinite(t.ms)));
    trial.verification=await verify(trial.caseId,trial.fixture);trial.success=trial.verification.ok;
    if(trial.tools.some(t=>t.status==="indeterminate"))trial.uncertainReceiptReviewed=true;
    else trial.verifierFailureReviewed=true;
    trial.jsFallback=trial.arm==="tools"&&trial.tools.some(t=>t.name==="browser_evaluate");save();
    await cleanup(trial.fixture);trial.cleaned=true;save();
  }
  for(let sample=0;sample<samples;sample++)for(const caseId of cases)for(const arm of sample%2?[...arms].reverse():arms){
    const nativeSkillArm=nativeRevision||arm.startsWith("native_skill");
    const implementation=arm==="baseline"?baselineRevision:revision;
    if(report.prepTrials.some(t=>t.sample===sample&&t.caseId===caseId&&t.arm===arm))continue;
    const label=`PB${runId.split("-").at(-1)}-${sample}-${caseId}${npcCases.includes(caseId)?"-"+arm:""}`;const f=characterSuite?await character.setup(caseId,label):await setup(label);if(caseId==="npc_werewolf")f.werewolfSources={...werewolfSources,werewolves:[werewolfSources.werewolf,werewolfSources.werewolf24]};
    const trial={sample,caseId,arm,fixture:f,prompt:characterSuite?character.prompt(caseId,label):prompts(caseId,label),tools:[],usage:[],runtime:[],waits:[],state:"prepared"};report.prepTrials.push(trial);save();
    const cwd=path.join(root,runId,`${sample}-${caseId}-${arm}`);fs.mkdirSync(path.join(cwd,"tasks"),{recursive:true});
    if(caseId==="upload_image"){
      const localImage=path.join(cwd,"benchmark20260508180804.jpg");fs.copyFileSync(imageFile,localImage);
      trial.prompt=`把世界角色“${label} 角色1”的头像、原型 Token 和所有已放置 Token 图片换成本地文件 ${localImage}。不要改变 Token 名称、位置、尺寸，也不要影响其他角色。`;save();
    }
    const skillPath=path.join(cwd,"skills/fvtt-native-npc/SKILL.md");
    if(nativeSkillArm){fs.mkdirSync(path.dirname(skillPath),{recursive:true});fs.copyFileSync(arm==="native_skill_baseline"?baselineSkill:path.join(__dirname,"prep-native-npc-skill/SKILL.md"),skillPath);trial.skillHash=crypto.createHash("sha256").update(fs.readFileSync(skillPath)).digest("hex");}
    if(nativeRevision){report.experiment.nativeSkillHash??=trial.skillHash;assert.equal(trial.skillHash,report.experiment.nativeSkillHash,"Native revision comparison must freeze its skill");}
    const skillPaths=nativeSkillArm?[path.dirname(skillPath)]:[];
    if(["pack-skill","rules-ablation","build-query"].includes(comparison)){
      report.experiment.nativeSkillHash??=trial.skillHash;
      assert.equal(trial.skillHash,report.experiment.nativeSkillHash,"Pack comparison must freeze the native guide");
    }
    if(["native_skill_pack","native_skill_rules","native_skill_build_js","native_skill_build_tool"].includes(arm)){
      const sourcePath=path.resolve(__dirname,"../../skills/prep/arcane-actor-update/SKILL.md");
      const injectedPath=path.join(cwd,"skills/arcane-actor-update/SKILL.md");
      fs.mkdirSync(path.dirname(injectedPath),{recursive:true});fs.copyFileSync(sourcePath,injectedPath);
      const hash=crypto.createHash("sha256").update(fs.readFileSync(injectedPath)).digest("hex");
      report.experiment.packSkillHash??=hash;assert.equal(hash,report.experiment.packSkillHash,"Production skill must stay frozen during the batch");
      trial.packSkill={sourcePath,path:injectedPath,sha256:hash};skillPaths.push(path.dirname(injectedPath));
      if(withRulesSkill||arm==="native_skill_rules"){
        const sourceDir=path.resolve(__dirname,"../../skills/prep/arcane-dnd5e-rules");
        const targetDir=path.join(cwd,"skills/arcane-dnd5e-rules");
        fs.cpSync(sourceDir,targetDir,{recursive:true,errorOnExist:true,force:false});
        const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
        const files=walk(targetDir).map(file=>({path:path.relative(targetDir,file).split(path.sep).join("/"),sha256:crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}));
        const sha256=crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
        report.experiment.rulesSkillHash??=sha256;assert.equal(sha256,report.experiment.rulesSkillHash);
        trial.rulesSkill={path:path.join(targetDir,"SKILL.md"),sha256,fileCount:files.length};skillPaths.push(targetDir);
      }
    }
    if(comparison==="build-query"){
      const sourcePath=path.join(__dirname,"prep-build-query-skill/SKILL.md");
      const targetPath=path.join(cwd,"skills/fvtt-build-query/SKILL.md");
      fs.mkdirSync(path.dirname(targetPath),{recursive:true});fs.copyFileSync(sourcePath,targetPath);skillPaths.push(path.dirname(targetPath));
      trial.buildSkill={path:targetPath,sha256:crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex")};
      trial.buildToolHash=crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname,"prep-build-query.cjs"))).digest("hex");
      report.experiment.buildSkillHash??=trial.buildSkill.sha256;assert.equal(trial.buildSkill.sha256,report.experiment.buildSkillHash);
      report.experiment.buildToolHash??=trial.buildToolHash;assert.equal(trial.buildToolHash,report.experiment.buildToolHash);
      trial.prompt=trial.prompt.replace("其他未指定选项自行合理决定", "其他未指定项沿用系统或来源默认；必要选择没有默认时做最少的合理补充");
    }
    if(characterSuite){const sourcePath=path.join(__dirname,"../character-benchmark/skill/SKILL.md"),targetPath=path.join(cwd,"skills/character-benchmark/SKILL.md");fs.mkdirSync(path.dirname(targetPath),{recursive:true});fs.copyFileSync(sourcePath,targetPath);skillPaths.push(path.dirname(targetPath));trial.characterSkill={path:targetPath,sha256:crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex")};}
    const resources=new implementation.ResourceCoordinator(),originalAcquire=resources.acquire.bind(resources);
    resources.acquire=async(keys,owner,signal,onWait=()=>{})=>{let began=null;const lease=await originalAcquire(keys,owner,signal,d=>{began??=performance.now();onWait(d);});trial.waits.push(began===null?0:performance.now()-began);return lease;};
    const runtime=new implementation.DirectFoundryRuntime({getWebContents:()=>page,runtimeSource:implementation.runtimeSource,allowedActions:implementation.allowedActions,onCallResult:r=>trial.runtime.push(r),log(){}});
    const host=new implementation.AgentHost({foundryRuntime:runtime,getFoundryView:()=>({webContents:page}),openFoundry:async url=>{if(url&&new URL(url).origin!==origin)throw Error("Only configured benchmark origin");return{ok:true,url:`${origin}/game`,summary:"Benchmark world connected, GM ready"};},
      providerStore:store,runtimeReady:Promise.resolve({nodeBinary:process.env.ARCANE_QA_NODE}),profile:{mode:"prep",getCwd:()=>cwd,builtinTools:true,systemPrompt:"append",fence:true,getSkillPaths:()=>skillPaths},getLocale:()=>"zh-CN",log(){},resources,scheduler:new implementation.ExecutionScheduler({capacity:1}),
      taskStorageDir:path.join(cwd,"tasks"),operationStorageDir:path.join(cwd,"operations"),sendToRenderer:e=>{if(e.type==="task_state"&&e.task?.state==="waiting_user")trial.waitingUser=true;}});
    if(arm==="native_skill_build_tool"){const original=host.buildTools.bind(host);host.buildTools=()=>[...original(),require("./prep-build-query.cjs").createTool(evaluate)];}
    if(arm==="native_skill_catalog_tool"){const original=host.buildTools.bind(host);host.buildTools=()=>[...original(),...require("./prep-content-catalog.cjs").createTools(evaluate)];}
    setHost(host);await host.start({fresh:true});
    if(arm==="native_skill_build_tool"){
      // Test-only addition to Pi's explicit tool allowlist; production policy stays unchanged.
      assert.ok(host.session._allowedToolNames instanceof Set);
      host.session._allowedToolNames.add("foundry_build_query");
      host.session._refreshToolRegistry();
    }
    if(arm==="native_skill_catalog_tool"){for(const n of ["foundry_content_search","foundry_content_list","foundry_content_detail"])host.session._allowedToolNames.add(n);host.session._refreshToolRegistry();}
    if(thinkingOverride)host.session.setThinkingLevel(thinkingOverride);
    trial.modelConfiguration={reasoning:host.session.model.reasoning,compat:host.session.model.compat??null};
    trial.requestModes=[];
    const priorPayload=host.session.agent.onPayload;
    host.session.agent.onPayload=async(payload,model)=>{
      const replacement=await priorPayload?.(payload,model);
      const actual=replacement??payload;
      trial.requestModes.push({enable_thinking:actual.enable_thinking??"omitted",thinking:actual.thinking??"omitted",reasoning_effort:actual.reasoning_effort??"omitted"});
      return replacement;
    };
    if(arm==="js"||arm==="native_skill_catalog_js")host.session.setActiveToolsByName(host.session.getActiveToolNames().filter(n=>!newTools.has(n)));
    if(nativeSkillArm)host.session.setActiveToolsByName(host.session.getActiveToolNames().filter(n=>!["foundry_actor_create","foundry_actor_update"].includes(n)));
    if(arm==="native_skill_build_tool")host.session.setActiveToolsByName([...new Set([...host.session.getActiveToolNames(),"foundry_build_query"])]);
    if(arm==="native_skill_catalog_tool")host.session.setActiveToolsByName([...new Set([...host.session.getActiveToolNames(),"foundry_content_search","foundry_content_list","foundry_content_detail"])]);
    trial.activeTools=host.session.getActiveToolNames();trial.thinking=host.session.thinkingLevel;
    const expectedTools=implementation.prepToolNames.filter(n=>!((arm==="js"||arm==="native_skill_catalog_js")&&newTools.has(n))&&!(nativeSkillArm&&["foundry_actor_create","foundry_actor_update"].includes(n)));
    if(arm==="native_skill_build_tool")expectedTools.push("foundry_build_query");
    if(arm==="native_skill_catalog_tool")expectedTools.push("foundry_content_search","foundry_content_list","foundry_content_detail");
    const uniqueExpectedTools=[...new Set(expectedTools)];
    assert.deepEqual([...trial.activeTools].sort(),uniqueExpectedTools.sort(),"Ablated tool set changed");
    // A deliberate test-only prompt seam. Keep the SDK's generated tool preamble
    // Neutral mode replaces both arms; production mode keeps the tools prompt.
    assert.ok(host.session.systemPrompt.includes(productionPrep),"Prep preamble anchor changed");
    let prompt=promptMode==="production"&&arm!=="js"&&arm!=="native_skill_catalog_js"?host.session.systemPrompt:host.session.systemPrompt.replace(productionPrep,common+(arm==="tools"?" 优先使用结构化工具；未覆盖的操作才使用 browser_evaluate。":" 使用 browser_evaluate 编写 JavaScript 调用原生 Document API 完成世界操作。"));
    if(nativeSkillArm){
      assert.ok(host.session.systemPrompt.includes("fvtt-native-npc"),"Skill metadata must be loaded through resource loader");
      prompt=host.session.systemPrompt.replace(productionPrep,common+" 创建或修改 NPC 前先读取可用的 fvtt-native-npc skill。使用 foundry_content_search 发现资源，普通角色创建和修改使用 browser_evaluate 原生 API；其他已开放工具按需要使用。不要调用未开放的 actor_create 或 actor_update。");
    }
    if(trial.packSkill){
      assert.ok(host.session.systemPrompt.includes("arcane-actor-update"),"Production skill metadata must be exposed by the resource loader");
      prompt+="\n查找法术、能力等合集素材前，先用 read 读取生产备团指南："+trial.packSkill.path+"。按其中的来源包优先级和中英文检索方法定位素材；NPC 创建流程仍遵循 fvtt-native-npc。";
    }
    if(trial.rulesSkill){
      assert.ok(host.session.systemPrompt.includes("arcane-dnd5e-rules"));
      prompt+="\n创建前用 read 读取规则资料索引："+trial.rulesSkill.path+"，按索引查询本次任务所需的规则依据，并用这些依据核对实际结果。";
    }
    if(trial.buildSkill)prompt+="\n创建前读取车卡查询指南："+trial.buildSkill.path+"。本指南关于未指定项走默认的约束优先于其他指南的自由补充建议。";
    if(trial.characterSkill)prompt+="\n本轮是完整职业车卡测试。先读取 "+trial.characterSkill.path+"，其中完整成长范围与默认优先于旧指南的最小NPC建议。";
    host.session._baseSystemPrompt=prompt;host.session.agent.state.systemPrompt=prompt;
    trial.systemPromptHash=crypto.createHash("sha256").update(prompt).digest("hex");trial.systemPromptChars=prompt.length;
    trial.normalizedSystemPromptHash=crypto.createHash("sha256").update(prompt.split(cwd).join("<TASK_CWD>").split(cwd.split(path.sep).join("/")).join("<TASK_CWD>")).digest("hex");
    trial.promptNormalizationVersion=2;
    const start=performance.now();let firstEvent=false;
    const unsubscribe=host.session.subscribe(e=>{
      if(!firstEvent&&["message_update","tool_execution_start"].includes(e.type)){trial.firstEventMs=performance.now()-start;firstEvent=true;}
      if(e.type==="tool_execution_start")trial.tools.push({name:e.toolName,id:e.toolCallId,start:performance.now(),argumentBytes:Buffer.byteLength(JSON.stringify(e.args??null)),javascriptChars:e.toolName==="browser_evaluate"?(e.args?.code?.length??0):0});
      if(e.type==="tool_execution_end"){const t=trial.tools.find(t=>t.id===e.toolCallId);if(t)Object.assign(t,{ms:performance.now()-t.start,isError:e.isError,status:e.result?.details?.status,bytes:Buffer.byteLength(JSON.stringify(e.result??null))});}
      if(e.type==="message_end"&&e.message?.role==="assistant"){if(e.message.usage)trial.usage.push(e.message.usage);if(e.message.errorMessage&&trial.timedOut&&/abort/i.test(e.message.errorMessage)){trial.cancellation="timeout_abort";}else if(e.message.errorMessage){trial.modelError="provider error";trial.providerFailure=/5-hour usage limit/i.test(e.message.errorMessage)?"quota_exhausted":"provider_error";}}
    });
    const timer=setTimeout(()=>{trial.timedOut=true;save();void host.abort().catch(error=>{trial.abortError=error.message;save();});},report.experiment.taskTimeoutMs);
    trial.state="submitted";save();
    try{await host.prompt(trial.prompt);}finally{clearTimeout(timer);unsubscribe();trial.ms=performance.now()-start;trial.taskState=host.task?.state;trial.taskError=host.task?.error??host.task?.failure??null;trial.agentError=host.session?.lastError??null;trial.state="returned";save();}
    assert.equal(host.session.agent.state.systemPrompt,prompt,"Prompt override was not the actual model prompt");
    if(trial.timedOut||trial.tools.some(t=>t.status==="indeterminate"))throw Error("Ambiguous run retained for inspection; no automatic retry/cleanup");
    trial.verification=await verify(caseId,f);trial.success=trial.taskState==="completed"&&trial.verification.ok;
    trial.withinExperienceTarget=trial.success&&trial.ms<=report.experiment.experienceTargetMs;
    trial.jsFallback=arm==="tools"&&trial.tools.some(t=>t.name==="browser_evaluate");save();
    host.dispose();setHost(null);if(npcCases.includes(caseId)){trial.retainedForReview=true;}else{await cleanup(f);trial.cleaned=true;}save();
    if(trial.modelError)throw Error("Provider failure; batch paused after settled trial");
  }
  report.status="prep-benchmark-completed";save();
};


