// Same-revision tool ablation. Both arms run the real Prep AgentHost/Pi/model.
// Only the exposed tools and their matching routing instructions differ.
module.exports = async function benchmark({ evaluate, report, save, root, runId, store, page, origin, revision, samples, setHost, resumePath, promptMode = "production" }) {
  const assert=require("node:assert/strict"), path=require("node:path"), fs=require("node:fs"), crypto=require("node:crypto");
  const productionPrep=fs.readFileSync(path.resolve(__dirname,"../../system-prompts/prep.md"),"utf8").trim();
  const common="你是 ArcaneDesk 备团助手。遵循 DM 的明确要求。QA-A 世界已经连接且 GM 就绪。使用精确世界对象和合集来源，避免重复创建。只用公开 Foundry Document API，等待每次写入完成，返回紧凑结果并确认实际变化。不确定写入不能重放。只操作用户指定的测试对象，不修改模块文件或包。缺少必要信息才提问。成功回复简洁，用中文。";
  const newTools=new Set(["world_status","foundry_play_context","foundry_conditions_set","foundry_content_search","foundry_actor_get","foundry_actor_create","foundry_actor_update","foundry_actor_grant_items","foundry_scene_get","foundry_scene_apply"]);
  const imageFile=path.join(__dirname,"prep-benchmark-assets/benchmark20260508180804.jpg");
  const imageHash=crypto.createHash("sha256").update(fs.readFileSync(imageFile)).digest("hex");
  assert.equal(imageHash,"b95e5064ce3d221ff17615e9caeea76ff285a87d25da9d6d7dfec27f1ace6785");
  const cases=["create_npc","grant_items","edit_image","scene_layout","conditions","upload_image"];
  report.experiment={kind:"same-code tool ablation",cases,samplesPerCase:samples,model:report.model,
    promptPolicy:"same neutral Prep instructions; arm-specific route; Pi generates the matching active-tool preamble",newTools:[...newTools],connection:"warm authenticated QA-A",humanWait:"recorded; no automatic answers"};
  report.experiment.candidateCommit=require("node:child_process").execFileSync("git",["rev-parse","HEAD"],{cwd:path.resolve(__dirname,"../../../.."),encoding:"utf8"}).trim();
  assert.ok(["production","neutral"].includes(promptMode));
  report.experiment.promptMode=promptMode;
  report.experiment.kind=promptMode==="production"?"same-code production tools versus native JS":"same-code tool ablation";
  report.experiment.promptPolicy=promptMode==="production"?"Production Prep prompt for tools; neutral native-JS instructions for control":"Same neutral instructions with arm-specific routing";
  report.experiment.suiteVersion="prep-v1-draft";
  report.experiment.imageSha256=imageHash;
  report.prepTrials=[];
  if(resumePath){
    const previous=JSON.parse(fs.readFileSync(resumePath,"utf8"));
    assert.equal(previous.status,"failed");assert.equal(previous.error,"Ambiguous run retained for inspection; no automatic retry/cleanup");
    assert.equal(previous.experiment.candidateCommit,report.experiment.candidateCommit);
    assert.equal(previous.experiment.promptMode,promptMode);assert.equal(previous.experiment.suiteVersion,report.experiment.suiteVersion);assert.equal(previous.experiment.imageSha256,imageHash);
    assert.equal(previous.fixtureRun,report.fixtureRun);assert.equal(previous.experiment.samplesPerCase,samples);
    report.prepTrials=previous.prepTrials;report.experiment=previous.experiment;
    report.continuations=[...(previous.continuations??[]),{sourceReport:resumePath,reason:"Explicit continuation after read-only QA inspection; prior tasks are not replayed",at:new Date().toISOString()}];
    runId=previous.fixtureLabelRun??previous.runId;report.fixtureLabelRun=runId;
  }
  const source=await evaluate('(async()=>{const p=game.packs.get("dnd5e.monsters");const wolf=(await p.getIndex()).find(e=>e.name==="Wolf");const w=game.packs.get("arcane-dnd5e-2014-automation.basicweapons");const index=await w.getIndex();return {wolf:wolf._id,rapier:index.find(e=>/Rapier/.test(e.name))._id,bow:index.find(e=>/Longbow/.test(e.name))._id};})()');
  const setup=async label=>evaluate(`(async()=>{
    const actors=[];for(let i=0;i<3;i++)actors.push(await Actor.create({name:${JSON.stringify(label)}+" 角色"+(i+1),type:"npc",flags:{arcanedesk:{prepBenchmark:${JSON.stringify(runId)}}},prototypeToken:{name:${JSON.stringify(label)}+" Token"+(i+1),actorLink:true},system:{attributes:{hp:{value:10,max:10},ac:{calc:"flat",flat:12}}}}));
    const rapier=await game.packs.get("arcane-dnd5e-2014-automation.basicweapons").getDocument(${JSON.stringify(source.rapier)});const data=rapier.toObject();delete data._id;data.system.equipped=false;data._stats??={};data._stats.compendiumSource=rapier.uuid;data.flags??={};data.flags.arcanedesk={sourceUuid:rapier.uuid};await actors[0].createEmbeddedDocuments("Item",[data]);
    const s=await Scene.create({name:${JSON.stringify(label)}+" 场景",width:2000,height:1500,grid:{type:1,size:100,distance:5,units:"ft"},active:false,flags:{arcanedesk:{prepBenchmark:${JSON.stringify(runId)}}}});
    const tokens=[];for(let i=0;i<3;i++)tokens.push((await actors[i].getTokenDocument({x:200+i*200,y:200,actorLink:true})).toObject());await s.createEmbeddedDocuments("Token",tokens);
    return {actorIds:actors.map(a=>a.id),sceneId:s.id,label:${JSON.stringify(label)},newName:${JSON.stringify(label)}+" 霜牙",originalSceneId:canvas.scene.id};})()`);
  const prompts=(id,label)=>({
    create_npc:`在 dnd5e.monsters 合集中找到名字精确为 Wolf 的怪物，创建一个名为“${label} 霜牙”的 NPC，并把它的原型 Token 名称也设成“${label} 霜牙”。已有同名则不要重复创建。`,
    grant_items:`给“${label} 角色1”授予 arcane-dnd5e-2014-automation.basicweapons 合集的 Rapier 和 Longbow，各一件。已有同来源的物品原样跳过，不叠加数量；新授予的物品装备上。`,
    edit_image:`把“${label} 角色1”改名为“${label} 队长”，HP 设为当前8、最大18，AC设为固定14。头像、原型Token和所有已放置Token的图片统一换成已有Data路径 systems/dnd5e/tokens/beast/Wolf.webp。不要改变已放置Token的名称、位置或尺寸。`,
    scene_layout:`修改非当前场景“${label} 场景”：把“${label} Token1”移到(300,400)，“${label} Token2”移到(500,400)，删除“${label} Token3”；再放两个“${label} 角色1”的Token，分别叫“新守卫A”和“新守卫B”，位置(700,400)和(900,400)。不切换或激活场景。`,
    conditions:`给世界角色“${label} 角色1”和“${label} 角色2”都加上倒地和中毒状态，不影响“${label} 角色3”。`
  })[id];
  const verify=async(id,f)=>evaluate(`(async()=>{
    const f=${JSON.stringify(f)},kind=${JSON.stringify(id)};const a=game.actors.get(f.actorIds[0]),s=game.scenes.get(f.sceneId);let ok=false,details={};
    if(kind==="create_npc"){const found=game.actors.filter(a=>a.name===f.newName);details={count:found.length,prototype:found[0]?.prototypeToken.name,source:found[0]?._stats?.compendiumSource??found[0]?.flags.arcanedesk?.sourceUuid??null,hp:found[0]?.system.attributes.hp.max,hasBite:!!found[0]?.items.some(i=>i.name==="Bite")};ok=found.length===1&&details.prototype===f.newName&&details.hp===11&&details.hasBite;}
    if(kind==="grant_items"){const r=a.items.filter(i=>/Rapier/.test(i.name)),b=a.items.filter(i=>/Longbow/.test(i.name));details={rapiers:r.length,bows:b.length,rapierEquipped:r[0]?.system.equipped,bowEquipped:b[0]?.system.equipped,bowQuantity:b[0]?.system.quantity};ok=r.length===1&&b.length===1&&details.rapierEquipped===false&&details.bowEquipped===true&&details.bowQuantity===1;}
    if(kind==="edit_image"){const t=s.tokens.find(t=>t.actorId===a.id);details={name:a.name,hp:a.system.attributes.hp,ac:a.system.attributes.ac.value,img:a.img,prototype:a.prototypeToken.texture.src,token:t.toObject()};ok=a.name===f.label+" 队长"&&details.hp.value===8&&details.hp.max===18&&details.ac===14&&a.img==="systems/dnd5e/tokens/beast/Wolf.webp"&&a.prototypeToken.texture.src===a.img&&t.texture.src===a.img&&t.name===f.label+" Token1"&&t.x===200&&t.y===200&&t.width===1&&t.height===1;details.token={name:t.name,x:t.x,y:t.y,width:t.width,height:t.height,img:t.toObject().texture.src};}
    if(kind==="scene_layout"){details={tokens:s.tokens.map(t=>({name:t.name,x:t.x,y:t.y,actorId:t.actorId})),active:s.active,current:canvas.scene.id};const expected=[[f.label+" Token1",300,400,f.actorIds[0]],[f.label+" Token2",500,400,f.actorIds[1]],["新守卫A",700,400,f.actorIds[0]],["新守卫B",900,400,f.actorIds[0]]];ok=s.tokens.size===4&&expected.every(([n,x,y,a])=>s.tokens.some(t=>t.name===n&&t.x===x&&t.y===y&&t.actorId===a))&&!s.active&&canvas.scene.id===f.originalSceneId;}
    if(kind==="conditions"){details=f.actorIds.map(id=>({id,statuses:[...game.actors.get(id).statuses]}));ok=details.slice(0,2).every(a=>a.statuses.includes("prone")&&a.statuses.includes("poisoned"))&&!details[2].statuses.includes("prone")&&!details[2].statuses.includes("poisoned");}
    if(kind==="upload_image"){
      const img=a.img, token=s.tokens.find(t=>t.actorId===a.id);let hash=null,loadable=false;
      if(img&&!/^(?:data:|file:|https?:|[A-Za-z]:)/i.test(img)&&!img.includes("..")){
        const response=await fetch(new URL(img,location.origin+"/"),{cache:"no-store"});
        if(response.ok){const blob=await response.blob();hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))).map(b=>b.toString(16).padStart(2,"0")).join("");const bitmap=await createImageBitmap(blob);loadable=bitmap.width===231&&bitmap.height===223;bitmap.close();}
      }
      const untouched=f.actorIds.slice(1).every(id=>{const other=game.actors.get(id);return other.img===other.prototypeToken.texture.src&&other.img==="systems/dnd5e/icons/svg/actors/npc.svg";})&&s.tokens.filter(t=>t.actorId!==a.id).every(t=>t.texture.src==="systems/dnd5e/icons/svg/actors/npc.svg");
      ok=hash===${JSON.stringify(imageHash)}&&loadable&&a.prototypeToken.texture.src===img&&token.texture.src===img&&token.name===f.label+" Token1"&&token.x===200&&token.y===200&&token.width===1&&token.height===1&&untouched;
      details={imagePath:img,hash,loadable,untouched};
    }
    return {ok,details};})()`);
  const cleanup=async f=>evaluate(`(async()=>{const f=${JSON.stringify(f)};const s=game.scenes.get(f.sceneId);if(s?.flags.arcanedesk?.prepBenchmark!==${JSON.stringify(runId)})throw Error("Scene ownership mismatch");await s.delete();for(const id of f.actorIds){const a=game.actors.get(id);if(a.flags.arcanedesk?.prepBenchmark!==${JSON.stringify(runId)})throw Error("Actor ownership mismatch");await a.delete();}const extra=game.actors.filter(a=>a.name===f.newName);for(const a of extra){if(a.type!=="npc"||!a.items.some(i=>i.name==="Bite"))throw Error("Created Actor fixture mismatch");await a.delete();}return true;})()`);
  for(const trial of report.prepTrials.filter(t=>!t.cleaned)){
    assert.equal(trial.state,"returned");assert.equal(trial.taskState,"completed");assert.ok(!trial.timedOut&&trial.tools.every(t=>Number.isFinite(t.ms)));
    trial.verification=await verify(trial.caseId,trial.fixture);trial.success=trial.verification.ok;
    trial.uncertainReceiptReviewed=true;trial.jsFallback=trial.arm==="tools"&&trial.tools.some(t=>t.name==="browser_evaluate");save();
    await cleanup(trial.fixture);trial.cleaned=true;save();
  }
  for(let sample=0;sample<samples;sample++)for(const caseId of cases)for(const arm of sample%2?["tools","js"]:["js","tools"]){
    if(report.prepTrials.some(t=>t.sample===sample&&t.caseId===caseId&&t.arm===arm))continue;
    const label=`PB${runId.split("-").at(-1)}-${sample}-${caseId}`;const f=await setup(label);
    const trial={sample,caseId,arm,fixture:f,prompt:prompts(caseId,label),tools:[],usage:[],runtime:[],waits:[],state:"prepared"};report.prepTrials.push(trial);save();
    const cwd=path.join(root,runId,`${sample}-${caseId}-${arm}`);fs.mkdirSync(path.join(cwd,"tasks"),{recursive:true});
    if(caseId==="upload_image"){
      const localImage=path.join(cwd,"benchmark20260508180804.jpg");fs.copyFileSync(imageFile,localImage);
      trial.prompt=`把世界角色“${label} 角色1”的头像、原型 Token 和所有已放置 Token 图片换成本地文件 ${localImage}。不要改变 Token 名称、位置、尺寸，也不要影响其他角色。`;save();
    }
    const resources=new revision.ResourceCoordinator(),originalAcquire=resources.acquire.bind(resources);
    resources.acquire=async(keys,owner,signal,onWait=()=>{})=>{let began=null;const lease=await originalAcquire(keys,owner,signal,d=>{began??=performance.now();onWait(d);});trial.waits.push(began===null?0:performance.now()-began);return lease;};
    const runtime=new revision.DirectFoundryRuntime({getWebContents:()=>page,runtimeSource:revision.runtimeSource,allowedActions:revision.allowedActions,onCallResult:r=>trial.runtime.push(r),log(){}});
    const host=new revision.AgentHost({foundryRuntime:runtime,getFoundryView:()=>({webContents:page}),openFoundry:async url=>{if(url&&new URL(url).origin!==origin)throw Error("Only QA-A");return{ok:true,url:`${origin}/game`,summary:"QA-A connected, GM ready"};},
      providerStore:store,runtimeReady:Promise.resolve({nodeBinary:process.env.ARCANE_QA_NODE}),profile:{mode:"prep",getCwd:()=>cwd,builtinTools:true,systemPrompt:"append",fence:true,getSkillPaths:()=>[]},getLocale:()=>"zh-CN",log(){},resources,scheduler:new revision.ExecutionScheduler({capacity:1}),
      taskStorageDir:path.join(cwd,"tasks"),operationStorageDir:path.join(cwd,"operations"),sendToRenderer:e=>{if(e.type==="task_state"&&e.task?.state==="waiting_user")trial.waitingUser=true;}});
    setHost(host);await host.start({fresh:true});
    if(arm==="js")host.session.setActiveToolsByName(host.session.getActiveToolNames().filter(n=>!newTools.has(n)));
    trial.activeTools=host.session.getActiveToolNames();trial.thinking=host.session.thinkingLevel;
    assert.equal(trial.activeTools.length,arm==="tools"?18:8,"Ablated tool count changed");
    // A deliberate test-only prompt seam. Keep the SDK's generated tool preamble
    // Neutral mode replaces both arms; production mode keeps the tools prompt.
    assert.ok(host.session.systemPrompt.includes(productionPrep),"Prep preamble anchor changed");
    const prompt=promptMode==="production"&&arm==="tools"?host.session.systemPrompt:host.session.systemPrompt.replace(productionPrep,common+(arm==="tools"?" 优先使用结构化工具；未覆盖的操作才使用 browser_evaluate。":" 使用 browser_evaluate 编写 JavaScript 调用原生 Document API 完成世界操作。"));
    host.session._baseSystemPrompt=prompt;host.session.agent.state.systemPrompt=prompt;
    trial.systemPromptHash=crypto.createHash("sha256").update(prompt).digest("hex");trial.systemPromptChars=prompt.length;
    const start=performance.now();let firstEvent=false;
    const unsubscribe=host.session.subscribe(e=>{
      if(!firstEvent&&["message_update","tool_execution_start"].includes(e.type)){trial.firstEventMs=performance.now()-start;firstEvent=true;}
      if(e.type==="tool_execution_start")trial.tools.push({name:e.toolName,id:e.toolCallId,start:performance.now(),argumentBytes:Buffer.byteLength(JSON.stringify(e.args??null)),javascriptChars:e.toolName==="browser_evaluate"?(e.args?.code?.length??0):0});
      if(e.type==="tool_execution_end"){const t=trial.tools.find(t=>t.id===e.toolCallId);if(t)Object.assign(t,{ms:performance.now()-t.start,isError:e.isError,status:e.result?.details?.status,bytes:Buffer.byteLength(JSON.stringify(e.result??null))});}
      if(e.type==="message_end"&&e.message?.role==="assistant"){if(e.message.usage)trial.usage.push(e.message.usage);if(e.message.errorMessage)trial.modelError="provider error";}
    });
    const timer=setTimeout(()=>{trial.timedOut=true;host.stop();},120000);
    trial.state="submitted";save();
    try{await host.prompt(trial.prompt);}finally{clearTimeout(timer);unsubscribe();trial.ms=performance.now()-start;trial.taskState=host.task?.state;trial.state="returned";save();}
    assert.equal(host.session.agent.state.systemPrompt,prompt,"Prompt override was not the actual model prompt");
    if(trial.timedOut||trial.tools.some(t=>t.status==="indeterminate"))throw Error("Ambiguous run retained for inspection; no automatic retry/cleanup");
    trial.verification=await verify(caseId,f);trial.success=trial.taskState==="completed"&&trial.verification.ok;
    trial.jsFallback=arm==="tools"&&trial.tools.some(t=>t.name==="browser_evaluate");save();
    host.dispose();setHost(null);await cleanup(f);trial.cleaned=true;save();
  }
  report.status="prep-benchmark-completed";save();
};
