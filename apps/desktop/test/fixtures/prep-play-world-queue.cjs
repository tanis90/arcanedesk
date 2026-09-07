module.exports = async function queueChecks({ evaluate, sourceId, targetId, report, save, root, runId, revision, page }) {
  const assert = require("node:assert/strict"); const path = require("node:path"); const { pathToFileURL } = require("node:url");
  const { FoundryServices } = await import(pathToFileURL(path.resolve(__dirname,"../../src/main/foundry-services.js")));
  const { captureFoundryInputContext } = await import(pathToFileURL(path.resolve(__dirname,"../../src/main/foundry-input-context.js")));
  const resources = new revision.ResourceCoordinator(); const key = "page:qa-a-selection-check";
  report.queueObservations = []; const runtimeRecords = [];
  const runtime = new revision.DirectFoundryRuntime({getWebContents:()=>page,runtimeSource:revision.runtimeSource,allowedActions:revision.allowedActions,onCallResult:record=>runtimeRecords.push(record),log(){}});
  let waiting, queuedAt, admittedAt;
  const service = new FoundryServices({sessionId:runId,directory:path.join(root,runId,"queue-operations"),mode:"combat",
    withPage:(signal,operation)=>resources.run([key],{sessionId:runId,taskId:"queued-write"},signal,()=>{queuedAt=performance.now();waiting();},()=>{admittedAt=performance.now();return operation();}),
    call:(action,input,options)=>runtime.call(action,input,options)});
  const select = id => evaluate(`(()=>{canvas.tokens.releaseAll();const t=canvas.tokens.placeables.find(t=>t.document.actorId===${JSON.stringify(id)}&&!t.document.hidden);if(!t)throw Error("QA Token missing");t.control({releaseOthers:true});return t.document.uuid;})()`);
  const targetBefore = await evaluate(`game.actors.get(${JSON.stringify(targetId)}).statuses.has("prone")`);
  for(let i=0;i<10;i++) {
    const sourceUuid=await select(sourceId);const metadata=await captureFoundryInputContext(page);
    assert.deepEqual(metadata.selectedTokenUuids,[sourceUuid]);
    const blocker=await resources.acquire([key],{sessionId:runId,taskId:"fixture-hold"});
    const queued=new Promise(resolve=>{waiting=resolve;});const active=i%2===0;
    const row={sample:i,state:"queued",active};report.queueObservations.push(row);save();
    let result, operation;
    try {
      operation=service.setConditions({targets:[{kind:"selected"}],conditions:[{key:"prone",active}]},
        {taskId:runId,metadata:Promise.resolve(metadata)},`selection-${i}`);
      await queued;
      const selectedNow=await select(targetId);assert.notEqual(selectedNow,sourceUuid);
      blocker.release();result=await operation;
    } finally {blocker.release();if(operation)await operation;}
    assert.equal(result.status,"completed");
    assert.equal(await evaluate(`game.actors.get(${JSON.stringify(sourceId)}).statuses.has("prone")`),active);
    assert.equal(await evaluate(`game.actors.get(${JSON.stringify(targetId)}).statuses.has("prone")`),targetBefore);
    Object.assign(row,{state:"completed",queueWaitMs:admittedAt-queuedAt,runtimeMs:runtimeRecords.at(-1).durationMs,actualTarget:sourceUuid});save();
  }
  report.status="queue-selection-passed";save();
};
